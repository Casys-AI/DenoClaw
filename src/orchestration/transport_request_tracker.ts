export class BrokerTransportRequestTracker<T extends { id: string }> {
  private pending = new Map<string, {
    resolve: (value: T) => void;
    reject: (reason: unknown) => void;
    timer: number;
  }>();

  create(
    id: string,
    timeoutMs: number,
    onTimeout: () => Error,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(onTimeout());
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
    });
  }

  resolve(message: T): boolean {
    const pending = this.pending.get(message.id);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    pending.resolve(message);
    return true;
  }

  reject(requestId: string, reason: unknown): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    pending.reject(reason);
    return true;
  }

  rejectAll(createReason: (requestId: string) => unknown): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(createReason(requestId));
    }
    this.pending.clear();
  }
}
