/**
 * Minimal interactive prompt helpers — zero deps.
 * Reads from stdin, writes to stdout.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function ask(question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  await Deno.stdout.write(encoder.encode(`${question}${suffix}: `));

  const buf = new Uint8Array(1024);
  const n = await Deno.stdin.read(buf);
  if (n === null) return defaultValue || "";

  const answer = decoder.decode(buf.subarray(0, n)).trim();
  return answer || defaultValue || "";
}

export async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = await ask(`${question} ${suffix}`);
  if (!answer) return defaultYes;
  return answer.toLowerCase().startsWith("y");
}

export async function choose(question: string, options: string[]): Promise<string> {
  console.log(`\n${question}`);
  for (let i = 0; i < options.length; i++) {
    console.log(`  ${i + 1}. ${options[i]}`);
  }

  const answer = await ask("Choix (numéro)");
  const idx = parseInt(answer) - 1;

  if (idx >= 0 && idx < options.length) return options[idx];
  return options[0];
}

export function print(msg: string): void {
  console.log(msg);
}

export function success(msg: string): void {
  console.log(`✓ ${msg}`);
}

export function warn(msg: string): void {
  console.log(`⚠ ${msg}`);
}

export function error(msg: string): void {
  console.error(`✗ ${msg}`);
}
