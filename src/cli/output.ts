/**
 * AX-compatible output layer.
 * --json → structured JSON, --yes → skip confirmations, non-TTY → auto non-interactive.
 */

export interface CliFlags {
  json: boolean;
  yes: boolean;
  interactive: boolean;
}

export class CliError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}

let _flags: CliFlags = { json: false, yes: false, interactive: true };

export function initCliFlags(
  args: { json?: boolean; yes?: boolean },
  options?: { isTTY?: boolean },
): void {
  const isTTY = options?.isTTY ?? Deno.stdin.isTerminal();
  _flags = {
    json: args.json ?? !isTTY,
    yes: args.yes ?? !isTTY,
    interactive: isTTY && !args.json,
  };
}

export function cliFlags(): CliFlags {
  return _flags;
}

export function humanLog(message: string): void {
  if (!_flags.json) console.log(message);
}

export function humanPrint(message: string): void {
  if (!_flags.json) console.log(message);
}

export function humanWarn(message: string): void {
  if (!_flags.json) console.log(message);
}

export function humanSuccess(message: string): void {
  if (!_flags.json) console.log(`✓ ${message}`);
}

export function humanError(message: string): void {
  if (!_flags.json) console.error(`✗ ${message}`);
}

export function requireInteractive(action: string): void {
  if (!_flags.interactive) {
    throw new CliError(
      "NON_INTERACTIVE_UNSUPPORTED",
      `${action} requires an interactive terminal`,
    );
  }
}

/** Output a result — JSON object in AX mode, human text otherwise. */
export function output(
  data: Record<string, unknown>,
  humanText?: string,
): void {
  if (_flags.json) {
    console.log(JSON.stringify(data));
  } else if (humanText) {
    console.log(humanText);
  }
}

/** Output an error — JSON in AX mode, stderr otherwise. */
export function outputError(code: string, message: string): void {
  if (_flags.json) {
    console.log(JSON.stringify({ error: message, code }));
  } else {
    console.error(`✗ ${message}`);
  }
}
