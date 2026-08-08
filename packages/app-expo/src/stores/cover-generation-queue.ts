/** Serializes background cover generation while allowing a failed book to retry later. */
export class CoverGenerationQueue {
  private readonly attempted = new Set<string>();
  private tail: Promise<void> = Promise.resolve();

  hasAttempted(bookId: string): boolean {
    return this.attempted.has(bookId);
  }

  enqueue(bookId: string, operation: () => Promise<void>): Promise<void> {
    if (this.attempted.has(bookId)) return Promise.resolve();
    this.attempted.add(bookId);

    const running = this.tail.then(operation);
    const settled = running.then(
      () => undefined,
      () => {
        this.attempted.delete(bookId);
      },
    );
    this.tail = settled;
    return settled;
  }
}
