import { assertEquals } from "@std/assert";
import type { LLMResponse } from "../../shared/types.ts";
import type { BrokerMessage } from "../types.ts";
import { BrokerLlmProxy } from "./llm_proxy.ts";

function createLlmRequest(): Extract<BrokerMessage, { type: "llm_request" }> {
  return {
    id: "llm-request-1",
    from: "agent-alpha",
    to: "broker",
    type: "llm_request",
    payload: {
      model: "openai/gpt-test",
      messages: [
        {
          role: "user",
          content: "Write a haiku",
        },
      ],
      temperature: 0.4,
      maxTokens: 64,
    },
    timestamp: new Date().toISOString(),
  };
}

Deno.test(
  "BrokerLlmProxy completes through the provider manager and replies with usage metrics",
  async () => {
    const request = createLlmRequest();
    const replies: BrokerMessage[] = [];
    const metricsCalls: Array<{
      agentId: string;
      provider: string;
      tokens: { prompt: number; completion: number };
    }> = [];
    const response: LLMResponse = {
      content: "Short poem",
      finishReason: "stop",
      usage: {
        promptTokens: 12,
        completionTokens: 7,
        totalTokens: 19,
      },
    };

    const proxy = new BrokerLlmProxy({
      providers: {
        complete: (
          messages,
          model,
          temperature,
          maxTokens,
        ) => {
          assertEquals(messages[0]?.content, "Write a haiku");
          assertEquals(model, "openai/gpt-test");
          assertEquals(temperature, 0.4);
          assertEquals(maxTokens, 64);
          return Promise.resolve(response);
        },
      },
      metrics: {
        recordLLMCall: (agentId, provider, tokens) => {
          metricsCalls.push({ agentId, provider, tokens });
          return Promise.resolve();
        },
      },
      findTunnelForProvider: () => null,
      routeToTunnel: () => {
        throw new Error(
          "routeToTunnel should not run for direct provider calls",
        );
      },
      sendReply: (reply) => {
        replies.push(reply);
        return Promise.resolve();
      },
    });

    await proxy.handleRequest(request);

    assertEquals(metricsCalls.length, 1);
    assertEquals(metricsCalls[0], {
      agentId: "agent-alpha",
      provider: "openai",
      tokens: { prompt: 12, completion: 7 },
    });
    assertEquals(replies.length, 1);
    assertEquals(replies[0]?.type, "llm_response");
    assertEquals(replies[0]?.to, "agent-alpha");
    assertEquals(replies[0]?.payload, response);
  },
);

Deno.test(
  "BrokerLlmProxy routes tunnel-backed models without calling the provider manager",
  async () => {
    const request = createLlmRequest();
    const tunnelMessages: BrokerMessage[] = [];
    const tunnel = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
    } as WebSocket;

    const proxy = new BrokerLlmProxy({
      providers: {
        complete: () => {
          throw new Error(
            "provider.complete should not run for tunnel routing",
          );
        },
      },
      metrics: {
        recordLLMCall: () => {
          throw new Error("recordLLMCall should not run for tunnel routing");
        },
      },
      findTunnelForProvider: () => tunnel,
      routeToTunnel: (_ws, message) => {
        tunnelMessages.push(message);
      },
      sendReply: () => {
        throw new Error("sendReply should not run for tunnel routing");
      },
    });

    await proxy.handleRequest(request);

    assertEquals(tunnelMessages.length, 1);
    assertEquals(tunnelMessages[0], request);
  },
);
