import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/config/bundled-ai", () => ({
  bundledOpenRouterEndpoint: { baseUrl: "https://openrouter.ai/api/v1" },
  getBundledApiKey: vi.fn(() => "test-openrouter-key"),
  hasBundledOpenRouterKey: true,
}));
vi.mock("expo/fetch", () => ({ fetch: vi.fn() }));

import { fetch } from "expo/fetch";
import {
  OPENROUTER_FALLBACK_IMAGE_MODEL,
  OPENROUTER_PRIMARY_IMAGE_MODEL,
  generateOpenRouterImage,
} from "./openrouter-image";

const request = {
  prompt: "secret book portrait prompt",
  aspectRatio: "3:4" as const,
  quality: "high" as const,
  outputFormat: "png" as const,
  outputCompression: 90,
};

function response(payload: unknown, status = 200, headers?: Record<string, string>): never {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  }) as never;
}

function modelAt(index: number): string {
  const [, init] = vi.mocked(fetch).mock.calls[index] ?? [];
  return JSON.parse(String(init?.body)).model as string;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("generateOpenRouterImage", () => {
  it("returns GPT Image 2 success without calling Nano Banana", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      response({ data: [{ b64_json: "data:image/png;base64,AQID", media_type: "image/png" }] }),
    );

    await expect(generateOpenRouterImage(request)).resolves.toEqual({
      base64: "AQID",
      mimeType: "image/png",
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(modelAt(0)).toBe(OPENROUTER_PRIMARY_IMAGE_MODEL);
  });

  it("retries a transient GPT failure and respects Retry-After before succeeding", async () => {
    vi.useFakeTimers();
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        response({ error: { message: "temporarily unavailable" } }, 503, { "retry-after": "2" }),
      )
      .mockResolvedValueOnce(response({ data: [{ b64_json: "AQID" }] }));

    const result = generateOpenRouterImage({ ...request, outputFormat: "jpeg" });
    await vi.runAllTimersAsync();

    await expect(result).resolves.toEqual({ base64: "AQID", mimeType: "image/jpeg" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(modelAt(0)).toBe(OPENROUTER_PRIMARY_IMAGE_MODEL);
    expect(modelAt(1)).toBe(OPENROUTER_PRIMARY_IMAGE_MODEL);
  });

  it("falls back to Nano Banana after a permanent GPT policy failure", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({ error: { message: "content policy refusal" } }, 422))
      .mockResolvedValueOnce(response({ data: [{ b64_json: "iVBORw0KGgoAAA" }] }));

    await expect(generateOpenRouterImage(request)).resolves.toEqual({
      base64: "iVBORw0KGgoAAA",
      mimeType: "image/png",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(modelAt(1)).toBe(OPENROUTER_FALLBACK_IMAGE_MODEL);
  });

  it("falls back to Nano Banana after GPT exhausts transient retries", async () => {
    vi.useFakeTimers();
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({ error: { message: "busy 1" } }, 503))
      .mockResolvedValueOnce(response({ error: { message: "busy 2" } }, 503))
      .mockResolvedValueOnce(response({ error: { message: "busy 3" } }, 503))
      .mockResolvedValueOnce(response({ data: [{ b64_json: "iVBORw0KGgoAAA" }] }));

    const result = generateOpenRouterImage(request);
    await vi.runAllTimersAsync();

    await expect(result).resolves.toMatchObject({ mimeType: "image/png" });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(modelAt(3)).toBe(OPENROUTER_FALLBACK_IMAGE_MODEL);
  });

  it("sends Nano only its supported image parameters", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({ data: [] }))
      .mockResolvedValueOnce(response({ data: [{ b64_json: "iVBORw0KGgoAAA" }] }));

    await generateOpenRouterImage(request);

    const [, init] = vi.mocked(fetch).mock.calls[1] ?? [];
    expect(JSON.parse(String(init?.body))).toEqual({
      model: OPENROUTER_FALLBACK_IMAGE_MODEL,
      prompt: request.prompt,
      aspect_ratio: "3:4",
      n: 1,
    });
    expect(String(init?.body)).not.toContain("quality");
    expect(String(init?.body)).not.toContain("output_format");
    expect(String(init?.body)).not.toContain("output_compression");
  });

  it("detects a Nano PNG without media_type from its base64 signature", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({ error: { message: "refused" } }, 400))
      .mockResolvedValueOnce(response({ data: [{ b64_json: "iVBORw0KGgoAAA" }] }));

    await expect(generateOpenRouterImage(request)).resolves.toMatchObject({
      mimeType: "image/png",
    });
  });

  it("includes both model failures without exposing the key or prompt", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        response({ error: { message: `invalid test-openrouter-key for ${request.prompt}` } }, 401),
      )
      .mockResolvedValueOnce(response({ error: { message: "fallback quota exhausted" } }, 400));

    const result = generateOpenRouterImage(request);
    await expect(result).rejects.toThrow(/GPT Image 2:.*Nano Banana 2:/u);
    await expect(result).rejects.not.toThrow("test-openrouter-key");
    await expect(result).rejects.not.toThrow(request.prompt);
  });
});
