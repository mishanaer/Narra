import { describe, expect, it, vi } from "vitest";
import { CoverGenerationQueue } from "./cover-generation-queue";

describe("CoverGenerationQueue", () => {
  it("removes the one-shot block after a failed cover and does not reject", async () => {
    const queue = new CoverGenerationQueue();
    const failed = vi.fn(async () => {
      throw new Error("both OpenRouter image models failed");
    });

    await expect(queue.enqueue("book-1", failed)).resolves.toBeUndefined();
    expect(queue.hasAttempted("book-1")).toBe(false);

    const retried = vi.fn(async () => undefined);
    await queue.enqueue("book-1", retried);
    expect(retried).toHaveBeenCalledOnce();
    expect(queue.hasAttempted("book-1")).toBe(true);
  });

  it("keeps successful covers blocked from duplicate generation", async () => {
    const queue = new CoverGenerationQueue();
    const operation = vi.fn(async () => undefined);

    await queue.enqueue("book-1", operation);
    await queue.enqueue("book-1", operation);

    expect(operation).toHaveBeenCalledOnce();
  });
});
