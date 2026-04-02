import type { ToolDefinition, ToolResult } from "../../shared/types.ts";
import { BaseTool } from "./registry.ts";

export class WebFetchTool extends BaseTool {
  name = "web_fetch";
  description = "Fetch content from a URL";
  permissions = ["net" as const];

  getDefinition(): ToolDefinition {
    return {
      type: "function",
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "URL to fetch" },
            method: {
              type: "string",
              description: "HTTP method: GET, POST, PUT, DELETE (default: GET)",
            },
          },
          required: ["url"],
        },
      },
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const url = args.url as string;
    const method = (args.method as string) || "GET";

    if (!url) return this.fail("MISSING_ARG", { arg: "url" }, "Provide a URL");

    try {
      new URL(url); // validate
    } catch {
      return this.fail(
        "INVALID_URL",
        { url },
        "Provide a valid URL (e.g. https://example.com)",
      );
    }

    try {
      const res = await fetch(url, {
        method,
        signal: AbortSignal.timeout(30_000),
      });

      const text = await res.text();
      const truncated = text.length > 10_000
        ? text.slice(0, 10_000) + "\n...(truncated)"
        : text;

      return this.ok(JSON.stringify({
        status: res.status,
        body: truncated,
        truncated: text.length > 10_000,
      }));
    } catch (e) {
      if (
        (e instanceof DOMException && e.name === "TimeoutError") ||
        (e instanceof Error && e.name === "AbortError")
      ) {
        return this.fail(
          "FETCH_TIMEOUT",
          { url, method },
          "URL took >30s to respond, try again or use a different URL",
        );
      }
      const msg = e instanceof Error ? e.message : String(e);
      return this.fail(
        "FETCH_FAILED",
        { url, method, message: msg },
        "Check the URL and network access",
      );
    }
  }
}
