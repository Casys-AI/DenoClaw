import type { Message, ToolDefinition } from "../shared/types.ts";
import type { AgentConfig, Skill } from "./types.ts";
import { formatDate } from "../shared/helpers.ts";

export class ContextBuilder {
  private config: AgentConfig;

  constructor(config: AgentConfig) {
    this.config = config;
  }

  /**
   * @param now — explicit timestamp for AX-6 determinism. Defaults to current time.
   * @param memoryTopics — topics in long-term memory, injected so the agent knows what it remembers.
   * @param memoryFiles — workspace memory .md files the agent can read/write.
   */
  buildSystemPrompt(
    skills: Skill[],
    tools: ToolDefinition[],
    now: Date = new Date(),
    memoryTopics?: string[],
    memoryFiles?: string[],
  ): string {
    const parts: string[] = [];

    parts.push(this.config.systemPrompt || this.defaultPrompt());
    parts.push(`\nCurrent time: ${formatDate(now)}`);

    if (memoryTopics && memoryTopics.length > 0) {
      parts.push("\n## Long-term Memory");
      parts.push(
        `You have ${memoryTopics.length} topic(s) in memory: ${
          memoryTopics.join(", ")
        }`,
      );
      parts.push(
        "Use the memory tool with action 'recall' to retrieve facts, or 'remember' to store new ones.",
      );
    }

    if (memoryFiles && memoryFiles.length > 0) {
      parts.push("\n## Memory Files");
      parts.push(
        `You have ${memoryFiles.length} memory file(s): ${
          memoryFiles.join(", ")
        }`,
      );
      parts.push(
        "Use read_file/write_file to access them (e.g., read_file({path: \"memories/project.md\"})).",
      );
    }

    if (skills.length > 0) {
      parts.push("\n## Available Skills\n");
      for (const skill of skills) {
        parts.push(`### ${skill.name}\n${skill.description}\n`);
      }
    }

    if (tools.length > 0) {
      parts.push("\n## Available Tools\n");
      for (const tool of tools) {
        parts.push(`- **${tool.function.name}**: ${tool.function.description}`);
      }
    }

    return parts.join("\n");
  }

  private defaultPrompt(): string {
    return `You are a helpful AI assistant powered by DenoClaw.

Your capabilities:
- Answer questions accurately and concisely
- Execute tasks using available tools
- Remember context from the conversation
- Use skills to enhance your knowledge

Guidelines:
- Be honest if you don't know something
- Use tools when they can help accomplish the task
- Keep responses clear and well-structured`;
  }

  buildContextMessages(
    conversation: Message[],
    skills: Skill[],
    tools: ToolDefinition[],
    memoryTopics?: string[],
    memoryFiles?: string[],
  ): Message[] {
    return [
      {
        role: "system",
        content: this.buildSystemPrompt(
          skills,
          tools,
          new Date(),
          memoryTopics,
          memoryFiles,
        ),
      },
      ...conversation,
    ];
  }

  truncateContext(messages: Message[], maxLength: number): Message[] {
    const system = messages.filter((m) => m.role === "system");
    const others = messages.filter((m) => m.role !== "system");

    let total = 0;
    for (const m of messages) total += m.content.length;
    if (total <= maxLength) return messages;

    let used = system.reduce((s, m) => s + m.content.length, 0);
    if (used >= maxLength) return system;

    const kept: Message[] = [];
    for (let i = others.length - 1; i >= 0; i--) {
      if (used + others[i].content.length > maxLength) break;
      kept.unshift(others[i]);
      used += others[i].content.length;
    }

    return [...system, ...kept];
  }
}
