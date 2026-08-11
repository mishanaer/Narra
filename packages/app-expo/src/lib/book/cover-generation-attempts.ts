/**
 * Session-local deduplication for background cover jobs.
 * Successful jobs stay latched; a failed job is released so repair can retry it.
 */
export class CoverGenerationAttempts {
  private readonly attempted = new Set<string>();

  has(bookId: string): boolean {
    return this.attempted.has(bookId);
  }

  tryBegin(bookId: string): boolean {
    if (this.attempted.has(bookId)) return false;
    this.attempted.add(bookId);
    return true;
  }

  releaseAfterFailure(bookId: string): void {
    this.attempted.delete(bookId);
  }
}
