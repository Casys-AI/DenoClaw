import type { Message, ToolDefinition } from "../shared/types.ts";
import type { AgentConfig, Skill } from "./types.ts";
import { formatDate } from "../shared/helpers.ts";

export class ContextBuilder {
  private config: AgentConfig;

  constructor(config: AgentConfig) {
    this.config = config;
  }

  buildSystemPrompt(skills: Skill[], tools: ToolDefinition[]): string {
    const parts: string[] = [];

    parts.push(this.config.systemPrompt || this.defaultPrompt());
    parts.push(`\nCurrent time: ${formatDate(new Date())}`);

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
  ): Message[] {
    return [
      { role: "system", content: this.buildSystemPrompt(skills, tools) },
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
