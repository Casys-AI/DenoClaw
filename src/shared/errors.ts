import type { StructuredError } from "./types.ts";

/**
 * AX-compliant error base.
 * Every error carries code + context + recovery, not just a message string.
 */
export class DenoClawError extends Error {
  readonly code: string;
  readonly context?: Record<string, unknown>;
  readonly recovery?: string;

  constructor(
    code: string,
    context?: Record<string, unknown>,
    recovery?: string,
  ) {
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
  constructor(
    code: string,
    context?: Record<string, unknown>,
    recovery?: string,
  ) {
    super(code, context, recovery);
    this.name = "ConfigError";
  }
}

export class ProviderError extends DenoClawError {
  constructor(
    code: string,
    context?: Record<string, unknown>,
    recovery?: string,
  ) {
    super(code, context, recovery);
    this.name = "ProviderError";
  }
}

export class ToolError extends DenoClawError {
  constructor(
    code: string,
    context?: Record<string, unknown>,
    recovery?: string,
  ) {
    super(code, context, recovery);
    this.name = "ToolError";
  }
}

export class ChannelError extends DenoClawError {
  constructor(
    code: string,
    context?: Record<string, unknown>,
    recovery?: string,
  ) {
    super(code, context, recovery);
    this.name = "ChannelError";
  }
}

export class AgentError extends DenoClawError {
  constructor(
    code: string,
    context?: Record<string, unknown>,
    recovery?: string,
  ) {
    super(code, context, recovery);
    this.name = "AgentError";
  }
}

export class OrchestrationError extends DenoClawError {
  constructor(
    code: string,
    context?: Record<string, unknown>,
    recovery?: string,
  ) {
    super(code, context, recovery);
    this.name = "OrchestrationError";
  }
}

export class FederationError extends DenoClawError {
  constructor(
    code: string,
    context?: Record<string, unknown>,
    recovery?: string,
  ) {
    super(code, context, recovery);
    this.name = "FederationError";
  }
}

/** Safely extract a message string from an unknown thrown value. */
export function toErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return String(e);
}

/** Wrap an unknown thrown value into a DenoClawError. */
export function wrapError(
  e: unknown,
  code: string,
  recovery?: string,
): DenoClawError {
  const message = toErrorMessage(e);
  return new DenoClawError(code, { cause: message }, recovery);
}
