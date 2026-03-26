import { BaseChannel, type OnMessage } from "./base.ts";
import type { ChannelMessage } from "../types.ts";
import { generateId } from "../utils/helpers.ts";
import { log } from "../utils/log.ts";

/**
 * Interactive terminal channel — unique to DenoClaw.
 * Reads from stdin, writes to stdout. No external deps.
 */
export class ConsoleChannel extends BaseChannel {
  private running = false;

  constructor() {
    super("console");
    this.enabled = true;
  }

  async initialize(): Promise<void> {
    log.debug("Console channel initialisé");
    await Promise.resolve();
  }

  async start(onMessage: OnMessage): Promise<void> {
    this.onMessage = onMessage;
    this.running = true;
    log.info("Console channel démarré — tapez vos messages");

    const decoder = new TextDecoder();
    const buf = new Uint8Array(4096);

    while (this.running) {
      await Deno.stdout.write(new TextEncoder().encode("\n> "));

      const n = await Deno.stdin.read(buf);
      if (n === null) break;

      const input = decoder.decode(buf.subarray(0, n)).trim();
      if (!input) continue;
      if (input === "/quit" || input === "/exit") {
        this.running = false;
        break;
      }

      const msg: ChannelMessage = {
        id: generateId(),
        sessionId: "console-default",
        userId: "local",
        content: input,
        channelType: "console",
        timestamp: new Date().toISOString(),
      };

      this.onMessage?.(msg);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    await Promise.resolve();
  }

  async send(_userId: string, content: string): Promise<void> {
    await Deno.stdout.write(new TextEncoder().encode(`\n${content}\n`));
  }

  isConnected(): boolean {
    return this.running;
  }
}
