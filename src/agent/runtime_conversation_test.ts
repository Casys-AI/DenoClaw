import { assertEquals, assertStringIncludes } from "@std/assert";
import { ContextBuilder } from "./context.ts";
import { executeAgentConversation } from "./runtime_conversation.ts";
import type { MemoryPort } from "./memory_port.ts";
import type { SkillLoader } from "./skills.ts";
import type { Task } from "../messaging/a2a/types.ts";
import type {
  AgentLlmToolPort,
  LLMResponse,
  Message,
  ToolDefinition,
  ToolResult,
} from "../shared/types.ts";

class ConversationMemoryStub implements MemoryPort {
  private messages: Message[] = [];

  get count(): number {
    return this.messages.length;
  }

  load(): Promise<void> {
    return Promise.resolve();
  }

  close(): void {}

  addMessage(message: Message): Promise<void> {
    this.messages.push(message);
    return Promise.resolve();
  }

  getMessages(): Message[] {
    return [...this.messages];
  }

  getRecentMessages(count: number): Message[] {
    return this.messages.slice(-count);
  }

  clear(): Promise<void> {
    this.messages = [];
    return Promise.resolve();
  }

  remember(): Promise<void> {
    return Promise.resolve();
  }

  recall(): Promise<[]> {
    return Promise.resolve([]);
  }

  listTopics(): Promise<string[]> {
    return Promise.resolve([]);
  }

  forgetTopic(): Promise<void> {
    return Promise.resolve();
  }
}

class ReloadingSkillLoader implements SkillLoader {
  private skills: Array<{
    name: string;
    description: string;
    content: string;
    path: string;
  }> = [];
  private pendingSkill:
    | {
      name: string;
      description: string;
      content: string;
      path: string;
    }
    | undefined;

  loadSkills(): Promise<void> {
    return Promise.resolve();
  }

  getSkills() {
    return [...this.skills];
  }

  getSkill(name: string) {
    return this.skills.find((skill) => skill.name === name);
  }

  queuePendingSkill(name: string, description: string): void {
    this.pendingSkill = {
      name,
      description,
      content: `# ${name}\n${description}\n`,
      path: `skills/${name.toLowerCase().replaceAll(" ", "-")}.md`,
    };
  }

  reload(): Promise<void> {
    if (this.pendingSkill) {
      this.skills = [this.pendingSkill];
      this.pendingSkill = undefined;
    }
    return Promise.resolve();
  }
}

Deno.test("executeAgentConversation reloads skills after write_file during the same task", async () => {
  const memory = new ConversationMemoryStub();
  const skills = new ReloadingSkillLoader();
  const seenSystemPrompts: string[] = [];
  let completeCalls = 0;
  const llmToolPort: AgentLlmToolPort = {
    startListening(): Promise<void> {
      return Promise.resolve();
    },
    complete(
      messages: Message[],
      _model: string,
      _temperature?: number,
      _maxTokens?: number,
      _tools?: ToolDefinition[],
    ): Promise<LLMResponse> {
      completeCalls++;
      seenSystemPrompts.push(messages[0]?.content ?? "");

      if (completeCalls === 1) {
        return Promise.resolve({
          content: "",
          toolCalls: [
            {
              id: "tool-write-skill",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({
                  path: "skills/generated.md",
                  content: "# Generated Skill\nLoaded after write.\n",
                  dry_run: false,
                }),
              },
            },
          ],
        });
      }

      return Promise.resolve({ content: "done" });
    },
    execTool(
      tool: string,
      args: Record<string, unknown>,
    ): Promise<ToolResult> {
      if (tool === "write_file" && args.path === "skills/generated.md") {
        skills.queuePendingSkill("Generated Skill", "Loaded after write.");
        return Promise.resolve({
          success: true,
          output: "Written 38 chars to skills/generated.md",
        });
      }

      return Promise.resolve({
        success: false,
        output: "",
        error: {
          code: "UNEXPECTED_TOOL",
          context: { tool, args },
          recovery: "Use the expected tool in this test",
        },
      });
    },
    close(): void {},
  };
  const reportedTasks: Task[] = [];
  const canonicalTask: Task = {
    id: "task-skill-reload",
    contextId: "ctx-skill-reload",
    status: {
      state: "WORKING",
      timestamp: new Date().toISOString(),
    },
    history: [],
    artifacts: [],
  };

  await executeAgentConversation({
    config: {
      model: "test/model",
      systemPrompt: "test",
      temperature: 0.2,
      maxTokens: 256,
    },
    llmToolPort,
    tools: [],
    context: new ContextBuilder({
      model: "test/model",
      systemPrompt: "test",
      temperature: 0.2,
      maxTokens: 256,
    }),
    skills,
    memory,
    fromAgentId: "agent-alpha",
    inputText: "Create a skill then use it",
    canonicalTask,
    reportWorkingTransition: false,
    maxIterations: 3,
    reportTaskResult: (task) => {
      reportedTasks.push(task);
      return Promise.resolve();
    },
  });

  assertEquals(completeCalls, 2);
  assertStringIncludes(seenSystemPrompts[1] ?? "", "Generated Skill");
  assertEquals(reportedTasks.at(-1)?.status.state, "COMPLETED");
});
