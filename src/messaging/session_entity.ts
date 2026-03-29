import type { Session } from "./types.ts";

export class SessionEntity {
  constructor(readonly session: Session) {}

  static createNew(input: {
    id: string;
    userId: string;
    channelType: string;
    now?: string;
    metadata?: Record<string, unknown>;
  }): Session {
    const now = input.now ?? new Date().toISOString();

    return {
      id: input.id,
      userId: input.userId,
      channelType: input.channelType,
      createdAt: now,
      lastActivity: now,
      metadata: input.metadata ?? {},
    };
  }

  touch(now = new Date().toISOString()): SessionEntity {
    return new SessionEntity({
      ...this.session,
      lastActivity: now,
    });
  }

  isInactiveSince(cutoffIso: string): boolean {
    return this.session.lastActivity < cutoffIso;
  }
}
