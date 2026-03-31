import type {
  SandboxBackend,
  SandboxConfig,
  ToolResult,
} from "../../shared/types.ts";
import { log } from "../../shared/log.ts";
import type {
  ExecuteToolRequest,
  SandboxOwnershipScope,
  ToolExecutionContext,
} from "../tool_execution_port.ts";

export interface BrokerSandboxManagerOptions {
  createBackend(
    config: SandboxConfig,
    context: Required<Pick<ToolExecutionContext, "agentId">> & {
      ownershipScope: SandboxOwnershipScope;
    },
    labels: Record<string, string>,
  ): SandboxBackend;
  idleTimeoutMs?: number;
  maxSandboxes?: number;
  now?: () => number;
}

interface ManagedSandboxEntry {
  ownerKey: string;
  envelopeKey: string;
  backend: SandboxBackend;
  inUseCount: number;
  createdAtMs: number;
  lastReleasedAtMs: number | null;
}

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MAX_SANDBOXES = 5;

export class BrokerSandboxManager {
  private readonly createBackend: BrokerSandboxManagerOptions["createBackend"];
  private readonly idleTimeoutMs: number;
  private readonly maxSandboxes: number;
  private readonly now: () => number;
  private readonly sandboxes = new Map<string, ManagedSandboxEntry>();
  private managerQueue = Promise.resolve();
  private readonly ownerQueues = new Map<string, Promise<void>>();

  constructor(options: BrokerSandboxManagerOptions) {
    this.createBackend = options.createBackend;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxSandboxes = options.maxSandboxes ?? DEFAULT_MAX_SANDBOXES;
    this.now = options.now ?? (() => Date.now());
  }

  async executeTool(request: ExecuteToolRequest): Promise<ToolResult> {
    const ownedContext = this.requireOwnedContext(request.executionContext);
    const ownerKey = this.createOwnerKey(ownedContext);
    return await this.withOwnerLock(ownerKey, async () => {
      const config = this.createSandboxConfig(request);
      const entryOrError = await this.withManagerLock(async () => {
        await this.evictIdleLocked();

        const envelopeKey = this.createEnvelopeKey(config);
        let entry = this.sandboxes.get(ownerKey);

        if (entry && entry.envelopeKey !== envelopeKey) {
          if (entry.inUseCount > 0) {
            throw new Error(
              `cannot recycle sandbox for ${ownerKey} while it is active`,
            );
          }
          log.info(
            `SandboxManager: recycling sandbox for ${ownerKey} due to policy change`,
          );
          await entry.backend.close();
          this.sandboxes.delete(ownerKey);
          entry = undefined;
        }

        if (!entry) {
          if (this.sandboxes.size >= this.maxSandboxes) {
            return {
              success: false,
              output: "",
              error: {
                code: "SANDBOX_CAPACITY_REACHED",
                context: {
                  ownerKey,
                  activeSandboxes: this.sandboxes.size,
                  maxSandboxesPerBroker: this.maxSandboxes,
                },
                recovery:
                  "Evict idle sandboxes, wait for capacity, or raise MAX_SANDBOXES_PER_BROKER",
              },
            } satisfies ToolResult;
          }
          const labels = this.createLabels(ownedContext);
          entry = {
            ownerKey,
            envelopeKey,
            backend: this.createBackend(config, ownedContext, labels),
            inUseCount: 0,
            createdAtMs: this.now(),
            lastReleasedAtMs: null,
          };
          this.sandboxes.set(ownerKey, entry);
          log.info(`SandboxManager: created sandbox for ${ownerKey}`);
        } else {
          log.debug(`SandboxManager: reusing sandbox for ${ownerKey}`);
        }

        entry.inUseCount++;
        return entry;
      });

      if ("success" in entryOrError) {
        return entryOrError;
      }

      const entry = entryOrError;
      try {
        return await entry.backend.execute({
          tool: request.tool,
          args: request.args,
          permissions: request.permissions ?? [],
          networkAllow: request.networkAllow,
          timeoutSec: request.timeoutSec,
          execPolicy: request.execPolicy ?? {
            security: "deny",
            ask: "off",
          },
          shell: request.shell,
          toolsConfig: request.toolsConfig,
        });
      } finally {
        await this.withManagerLock(() => {
          entry.inUseCount = Math.max(0, entry.inUseCount - 1);
          entry.lastReleasedAtMs = this.now();
        });
      }
    });
  }

  async close(): Promise<void> {
    const entries = [...this.sandboxes.values()];
    this.sandboxes.clear();
    await Promise.all(entries.map(async ({ backend, ownerKey }) => {
      try {
        await backend.close();
      } catch (error) {
        log.warn(
          `SandboxManager: failed to close sandbox for ${ownerKey}`,
          error,
        );
      }
    }));
  }

  private requireOwnedContext(
    context?: ToolExecutionContext,
  ): Required<Pick<ToolExecutionContext, "agentId">> & {
    ownershipScope: SandboxOwnershipScope;
  } {
    const agentId = context?.agentId?.trim();
    if (!agentId) {
      throw new Error("SandboxManager requires executionContext.agentId");
    }
    return {
      agentId,
      ownershipScope: context?.ownershipScope ?? "agent",
    };
  }

  private createSandboxConfig(request: ExecuteToolRequest): SandboxConfig {
    return {
      backend: "cloud",
      allowedPermissions: request.permissions ?? [],
      networkAllow: this.normalizeNetworkAllow(request.networkAllow),
      maxDurationSec: request.timeoutSec,
      execPolicy: request.execPolicy,
    };
  }

  private createOwnerKey(
    context: Required<Pick<ToolExecutionContext, "agentId">> & {
      ownershipScope: SandboxOwnershipScope;
    },
  ): string {
    return `${context.ownershipScope}:${context.agentId}`;
  }

  private createEnvelopeKey(config: SandboxConfig): string {
    return JSON.stringify({
      backend: config.backend ?? "cloud",
      networkAllow: this.normalizeNetworkAllow(config.networkAllow),
      maxDurationSec: config.maxDurationSec ?? null,
    });
  }

  private createLabels(
    context: Required<Pick<ToolExecutionContext, "agentId">> & {
      ownershipScope: SandboxOwnershipScope;
    },
  ): Record<string, string> {
    return {
      app: "denoclaw",
      runtime: "broker",
      backend: "cloud",
      owner_scope: context.ownershipScope,
      owner_id: this.truncateLabelValue(context.agentId),
    };
  }

  private async evictIdleLocked(): Promise<void> {
    const now = this.now();
    const expired: ManagedSandboxEntry[] = [];

    for (const [ownerKey, entry] of this.sandboxes.entries()) {
      if (entry.inUseCount > 0) continue;
      const lastReleasedAtMs = entry.lastReleasedAtMs ?? entry.createdAtMs;
      if (now - lastReleasedAtMs < this.idleTimeoutMs) continue;
      this.sandboxes.delete(ownerKey);
      expired.push(entry);
    }

    await Promise.all(expired.map(async (entry) => {
      try {
        await entry.backend.close();
        log.info(`SandboxManager: evicted idle sandbox for ${entry.ownerKey}`);
      } catch (error) {
        log.warn(
          `SandboxManager: failed to evict sandbox for ${entry.ownerKey}`,
          error,
        );
      }
    }));
  }

  private normalizeNetworkAllow(values?: string[]): string[] {
    if (!values?.length) return [];
    return [...new Set(values)].sort();
  }

  private truncateLabelValue(value: string): string {
    return value.length <= 128 ? value : value.slice(0, 128);
  }

  private async withManagerLock<T>(fn: () => Promise<T> | T): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.managerQueue;
    this.managerQueue = previous.then(() => next);
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async withOwnerLock<T>(
    ownerKey: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.ownerQueues.get(ownerKey) ?? Promise.resolve();
    const current = previous.then(() => next);
    this.ownerQueues.set(ownerKey, current);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.ownerQueues.get(ownerKey) === current) {
        this.ownerQueues.delete(ownerKey);
      }
    }
  }
}
