import type { StructuredError } from "./types.ts";

/**
 * AX-compliant error base.
 * Every error carries code + context + recovery, not just a message string.
 */
export class DenoClawError extends Error {
  readonly code: string;
  readonly context?: Record<string, unknown>;
  readonly recovery?: string;

  constructor(code: string, context?: Record<string, unknown>, recovery?: string) {
    const msg = recovery ? `[${code}] ${recovery}` : `[${code}]`;
    super(msg);
    this.name = "DenoClawError";
    this.code = code;
    this.context = context;
    this.recovery = recovery;
  }

  toStructured(): StructuredError {
    return { code: this.code, context: this.context, recovery: this.recovery };
  }
}

export class ConfigError extends DenoClawError {
  constructor(code: string, context?: Record<string, unknown>, recovery?: string) {
    super(code, context, recovery);
    this.name = "ConfigError";
  }
}

export class ProviderError extends DenoClawError {
  constructor(code: string, context?: Record<string, unknown>, recovery?: string) {
    super(code, context, recovery);
    this.name = "ProviderError";
  }
}

export class ToolError extends DenoClawError {
  constructor(code: string, context?: Record<string, unknown>, recovery?: string) {
    super(code, context, recovery);
    this.name = "ToolError";
  }
}

export class ChannelError extends DenoClawError {
  constructor(code: string, context?: Record<string, unknown>, recovery?: string) {
    super(code, context, recovery);
    this.name = "ChannelError";
  }
}

export class AgentError extends DenoClawError {
  constructor(code: string, context?: Record<string, unknown>, recovery?: string) {
    super(code, context, recovery);
    this.name = "AgentError";
  }
}
