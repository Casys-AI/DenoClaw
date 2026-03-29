import { DenoClawError } from "../shared/errors.ts";

export interface AgentPeerPolicy {
  agentId: string;
  peers?: string[];
  acceptFrom?: string[];
}

function includesOrWildcard(values: string[] | undefined, candidate: string): boolean {
  const effective = values ?? [];
  return effective.includes(candidate) || effective.includes("*");
}

export class AgentPolicyEntity {
  static assertCanSendTask(
    sender: AgentPeerPolicy,
    target: AgentPeerPolicy,
  ): void {
    if (!includesOrWildcard(sender.peers, target.agentId)) {
      throw new DenoClawError(
        "PEER_NOT_ALLOWED",
        {
          from: sender.agentId,
          to: target.agentId,
          senderPeers: sender.peers ?? [],
        },
        `Add "${target.agentId}" to ${sender.agentId}.peers`,
      );
    }

    if (!includesOrWildcard(target.acceptFrom, sender.agentId)) {
      throw new DenoClawError(
        "PEER_REJECTED",
        {
          from: sender.agentId,
          to: target.agentId,
          targetAcceptFrom: target.acceptFrom ?? [],
        },
        `Add "${sender.agentId}" to ${target.agentId}.acceptFrom`,
      );
    }
  }
}
