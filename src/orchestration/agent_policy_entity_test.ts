import { assertThrows } from "@std/assert";
import { AgentPolicyEntity } from "./agent_policy_entity.ts";

Deno.test("AgentPolicyEntity enforces peers + acceptFrom", () => {
  AgentPolicyEntity.assertCanSendTask(
    { agentId: "agent-a", peers: ["agent-b"] },
    { agentId: "agent-b", acceptFrom: ["agent-a"] },
  );

  assertThrows(() => {
    AgentPolicyEntity.assertCanSendTask(
      { agentId: "agent-a", peers: [] },
      { agentId: "agent-b", acceptFrom: ["agent-a"] },
    );
  });

  assertThrows(() => {
    AgentPolicyEntity.assertCanSendTask(
      { agentId: "agent-a", peers: ["agent-b"] },
      { agentId: "agent-b", acceptFrom: [] },
    );
  });
});
