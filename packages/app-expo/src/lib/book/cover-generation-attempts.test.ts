import { describe, expect, it } from "vitest";
import { CoverGenerationAttempts } from "./cover-generation-attempts";

describe("CoverGenerationAttempts", () => {
  it("deduplicates an active or successful cover job", () => {
    const attempts = new CoverGenerationAttempts();

    expect(attempts.tryBegin("book-1")).toBe(true);
    expect(attempts.has("book-1")).toBe(true);
    expect(attempts.tryBegin("book-1")).toBe(false);
  });

  it("allows another cover job after the complete OpenRouter pipeline fails", () => {
    const attempts = new CoverGenerationAttempts();
    attempts.tryBegin("book-1");

    attempts.releaseAfterFailure("book-1");

    expect(attempts.has("book-1")).toBe(false);
    expect(attempts.tryBegin("book-1")).toBe(true);
  });
});
