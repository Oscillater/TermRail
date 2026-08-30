export class SessionOperationQueue {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(sessionId, tail);

    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(sessionId) === tail) {
        this.tails.delete(sessionId);
      }
    }
  }
}
