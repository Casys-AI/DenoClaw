import type {
  SandboxPermission,
  ToolDefinition,
  ToolResult,
} from "../../shared/types.ts";
import type { MemoryPort } from "../memory/port.ts";
import { BaseTool } from "./registry.ts";

/**
 * MemoryTool — allows the LLM to store and retrieve long-term facts.
 * Three actions: remember, recall, forget.
 * Runs in-process (no sandbox) — this is memory infrastructure, like SendToAgentTool.
 */
export class MemoryTool extends BaseTool {
  name = "memory";
  description =
    "Manage long-term memory. Actions: 'remember' (save a fact), 'recall' (retrieve facts by topic), 'list_topics' (see all topics), 'forget' (clear a topic).";
  permissions: SandboxPermission[] = [];
  private memory: MemoryPort;

  constructor(memory: MemoryPort) {
    super();
    this.memory = memory;
  }

  getDefinition(): ToolDefinition {
    return {
      type: "function",
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["remember", "recall", "list_topics", "forget"],
              description:
                "Action: 'remember' saves a fact, 'recall' retrieves facts, 'list_topics' shows all memory topics, 'forget' deletes facts for a topic",
            },
            topic: {
              type: "string",
              description:
                "Topic/category for the fact (e.g. 'user_preferences', 'project_context'). Not required for list_topics.",
            },
            content: {
              type: "string",
              description:
                "The fact to remember (required for 'remember' action)",
            },
            source: {
              type: "string",
              enum: ["user", "agent", "tool"],
              description: "Origin of the fact (default: 'agent')",
            },
          },
          required: ["action"],
        },
      },
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const action = args.action as string;
    const topic = args.topic as string;

    if (!action) {
      return this.fail("MISSING_ARGS", { action }, "Provide 'action'");
    }

    switch (action) {
      case "list_topics": {
        const topics = await this.memory.listTopics();
        return this.ok(JSON.stringify({ topics }));
      }
      case "remember": {
        if (!topic) {
          return this.fail(
            "MISSING_TOPIC",
            { action },
            "Provide 'topic' for remember action",
          );
        }
        const content = args.content as string;
        if (!content) {
          return this.fail(
            "MISSING_CONTENT",
            { action },
            "Provide 'content' for remember action",
          );
        }
        const source = (args.source as "user" | "agent" | "tool") || "agent";
        await this.memory.remember({ topic, content, source });
        return this.ok(JSON.stringify({ ok: true, topic }));
      }

      case "recall": {
        if (!topic) {
          return this.fail(
            "MISSING_TOPIC",
            { action },
            "Provide 'topic' for recall action",
          );
        }
        const facts = await this.memory.recallTopic(topic);
        return this.ok(JSON.stringify({
          topic,
          facts: facts.map((f) => ({
            content: f.content,
            source: f.source,
            timestamp: f.timestamp,
          })),
        }));
      }

      case "forget": {
        if (!topic) {
          return this.fail(
            "MISSING_TOPIC",
            { action },
            "Provide 'topic' for forget action",
          );
        }
        await this.memory.forgetTopic(topic);
        return this.ok(JSON.stringify({ ok: true, topic }));
      }

      default:
        return this.fail(
          "UNKNOWN_ACTION",
          { action },
          "Use 'remember', 'recall', or 'forget'",
        );
    }
  }
}
