import { assert, assertMatch, assertNotMatch } from "@std/assert";
import { join } from "@std/path";

const modulePath = new URL("./log.ts", import.meta.url).href;

async function runLoggerSnippet(
  code: string,
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; output: string }> {
  // Write snippet to a temp file and run with `deno run -A`
  // (deno eval no longer accepts --allow-* flags in Deno 2.x)
  const tempFile = await Deno.makeTempFile({ suffix: ".ts" });
  await Deno.writeTextFile(tempFile, code);

  try {
    const configPath = new URL("../../deno.json", import.meta.url).pathname;
    const command = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--config", configPath, tempFile],
      env,
      stdout: "piped",
      stderr: "piped",
    });

    const { code: exitCode, stdout, stderr } = await command.output();
    const stdoutText = new TextDecoder().decode(stdout);
    const stderrText = new TextDecoder().decode(stderr);

    assert(exitCode === 0, `logger snippet failed:\n${stderrText || stdoutText}`);

    return {
      stdout: stdoutText,
      stderr: stderrText,
      output: `${stdoutText}${stderrText}`,
    };
  } finally {
    await Deno.remove(tempFile).catch(() => {});
  }
}

Deno.test("std-backed logger formats console output and preserves optional data", async () => {
  const result = await runLoggerSnippet(
    `
      const { log } = await import(${JSON.stringify(`${modulePath}?case=console`)});
      log.info("hello", { foo: "bar" });
    `,
    { LOG_LEVEL: "info" },
  );

  assertMatch(result.output, /\d{2}:\d{2}:\d{2} \[INFO\] hello \{\"foo\":\"bar\"\}/);
});

Deno.test("std-backed logger respects LOG_LEVEL threshold", async () => {
  const result = await runLoggerSnippet(
    `
      const { log } = await import(${JSON.stringify(`${modulePath}?case=level`)});
      log.info("skip me");
      log.warn("keep me");
    `,
    { LOG_LEVEL: "warn" },
  );

  assertNotMatch(result.output, /skip me/);
  assertMatch(result.output, /\[WARN\] keep me/);
});

Deno.test("std-backed logger writes to LOG_FILE when configured", async () => {
  const tempDir = await Deno.makeTempDir();
  const logFile = join(tempDir, "app.log");

  await runLoggerSnippet(
    `
      const { log } = await import(${JSON.stringify(`${modulePath}?case=file`)});
      log.error("persisted", { ok: true });
      await new Promise((resolve) => setTimeout(resolve, 25));
    `,
    {
      LOG_LEVEL: "debug",
      LOG_FILE: logFile,
    },
  );

  const contents = await Deno.readTextFile(logFile);
  assertMatch(contents, /\d{2}:\d{2}:\d{2} \[ERROR\] persisted \{\"ok\":true\}/);
});

Deno.test("std-backed logger can emit through ConsoleHandler inside a Web Worker", async () => {
  const workerFile = await Deno.makeTempFile({ suffix: ".ts" });

  await Deno.writeTextFile(
    workerFile,
    `
      const post = (level: string, args: unknown[]) => self.postMessage({ level, text: args.map(String).join(" ") });
      console.debug = (...args: unknown[]) => post("debug", args);
      console.info = (...args: unknown[]) => post("info", args);
      console.warn = (...args: unknown[]) => post("warn", args);
      console.error = (...args: unknown[]) => post("error", args);
      console.log = (...args: unknown[]) => post("log", args);

      const { log } = await import(${JSON.stringify(`${modulePath}?case=worker`)});
      log.info("worker visible", { worker: true });
      self.postMessage({ done: true });
    `,
  );

  const worker = new Worker(new URL(`file://${workerFile}`), {
    type: "module",
    // @ts-ignore -- unstable worker options
    deno: { permissions: "inherit" },
  });

  const messages: Array<{ level?: string; text?: string; done?: boolean }> = [];

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("worker did not finish")), 5_000);
      worker.onmessage = (event) => {
        messages.push(event.data);
        if (event.data?.done) {
          clearTimeout(timeout);
          resolve();
        }
      };
      worker.onerror = (event) => {
        clearTimeout(timeout);
        reject(event.error ?? new Error(event.message));
      };
    });
  } finally {
    worker.terminate();
    await Deno.remove(workerFile).catch(() => {});
  }

  const emitted = messages.find((message) => message.text?.includes("worker visible"));
  assert(emitted, `expected worker log message, got ${JSON.stringify(messages)}`);
  assertMatch(emitted.text ?? "", /\d{2}:\d{2}:\d{2} \[INFO\] worker visible \{\"worker\":true\}/);
});
