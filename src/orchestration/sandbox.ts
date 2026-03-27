import { DenoClawError } from "../shared/errors.ts";
import { log } from "../shared/log.ts";

/**
 * Deno Sandbox API client.
 *
 * Runs untrusted code (skills, LLM-generated code) in isolated
 * Deno Sandbox microVMs via the REST API.
 *
 * Requires DENO_SANDBOX_API_TOKEN env var.
 * API docs: https://docs.deno.com/sandbox/
 */

interface SandboxConfig {
  apiToken: string;
  apiBase?: string;
  region?: "amsterdam" | "chicago";
  memoryMb?: number;
  timeoutSec?: number;
  networkAllow?: string[];
}

interface SandboxInstance {
  id: string;
  status: string;
  sshUrl?: string;
  httpUrl?: string;
}

interface SandboxExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class SandboxManager {
  private apiBase: string;
  private apiToken: string;
  private defaults: {
    region: string;
    memoryMb: number;
    timeoutSec: number;
    networkAllow: string[];
  };

  constructor(config?: Partial<SandboxConfig>) {
    this.apiToken = config?.apiToken || Deno.env.get("DENO_SANDBOX_API_TOKEN") || "";
    this.apiBase = config?.apiBase || "https://api.deno.com/v1/sandbox";
    this.defaults = {
      region: config?.region || "amsterdam",
      memoryMb: config?.memoryMb || 768,
      timeoutSec: config?.timeoutSec || 60,
      networkAllow: config?.networkAllow || [],
    };
  }

  private async request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    if (!this.apiToken) {
      throw new DenoClawError("SANDBOX_NO_TOKEN", {}, "Set DENO_SANDBOX_API_TOKEN env var or pass apiToken in config");
    }

    const res = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        "Authorization": `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new DenoClawError("SANDBOX_API_ERROR", { status: res.status, body: text.slice(0, 500) }, "Check Sandbox API token and endpoint");
    }

    return await res.json() as T;
  }

  /**
   * Create an isolated sandbox instance.
   */
  async create(options?: {
    memoryMb?: number;
    networkAllow?: string[];
  }): Promise<SandboxInstance> {
    log.info("Création sandbox...");

    const instance = await this.request<SandboxInstance>("/instances", "POST", {
      region: this.defaults.region,
      memory_mb: options?.memoryMb || this.defaults.memoryMb,
      network_allow: options?.networkAllow || this.defaults.networkAllow,
    });

    log.info(`Sandbox créée : ${instance.id}`);
    return instance;
  }

  /**
   * Execute code in a sandbox instance.
   */
  async exec(instanceId: string, code: string, options?: {
    timeoutSec?: number;
    env?: Record<string, string>;
  }): Promise<SandboxExecResult> {
    log.info(`Exécution dans sandbox ${instanceId}`);

    const result = await this.request<SandboxExecResult>(
      `/instances/${instanceId}/exec`,
      "POST",
      {
        code,
        timeout_sec: options?.timeoutSec || this.defaults.timeoutSec,
        env: options?.env || {},
      },
    );

    log.debug(`Sandbox exec: exit=${result.exitCode} stdout=${result.stdout.length}B`);
    return result;
  }

  /**
   * Run code in a one-shot sandbox: create → exec → destroy.
   */
  async run(code: string, options?: {
    memoryMb?: number;
    timeoutSec?: number;
    networkAllow?: string[];
    env?: Record<string, string>;
  }): Promise<SandboxExecResult> {
    const instance = await this.create({
      memoryMb: options?.memoryMb,
      networkAllow: options?.networkAllow,
    });

    try {
      return await this.exec(instance.id, code, {
        timeoutSec: options?.timeoutSec,
        env: options?.env,
      });
    } finally {
      await this.destroy(instance.id);
    }
  }

  /**
   * Destroy a sandbox instance.
   */
  async destroy(instanceId: string): Promise<void> {
    log.info(`Destruction sandbox ${instanceId}`);
    await this.request(`/instances/${instanceId}`, "DELETE");
  }

  /**
   * List active sandbox instances.
   */
  async list(): Promise<SandboxInstance[]> {
    return await this.request<SandboxInstance[]>("/instances");
  }
}
