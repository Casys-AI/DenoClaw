import type {
  SandboxPermission,
  ToolDefinition,
  ToolResult,
} from "../../shared/types.ts";
import type { MemoryPort } from "../memory_port.ts";
import { BaseTool } from "./registry.ts";

/**
 * MemoryTool — permet au LLM de stocker et retrouver des faits long-terme.
 * Trois actions : remember, recall, forget.
 * S'exécute in-process (pas de sandbox) — c'est de l'infra mémoire, comme SendToAgentTool.
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
        if (topics.length === 0) {
          return this.ok("No topics in long-term memory yet.");
        }
        return this.ok(
          `${topics.length} topic(s) in memory:\n${
            topics.map((t) => `- ${t}`).join("\n")
          }`,
        );
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
        return this.ok(`Fact remembered under topic "${topic}".`);
      }

      case "recall": {
        if (!topic) {
          return this.fail(
            "MISSING_TOPIC",
            { action },
            "Provide 'topic' for recall action",
          );
        }
        const facts = await this.memory.recall(topic);
        if (facts.length === 0) {
          return this.ok(`No facts found for topic "${topic}".`);
        }
        const formatted = facts.map((f, i) =>
          `[${i + 1}] ${f.content}${
            f.source ? ` (source: ${f.source})` : ""
          } — ${f.timestamp}`
        ).join("\n");
        return this.ok(
          `${facts.length} fact(s) for topic "${topic}":\n${formatted}`,
        );
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
        return this.ok(`All facts for topic "${topic}" have been forgotten.`);
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
