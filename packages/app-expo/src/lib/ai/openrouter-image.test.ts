import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/config/bundled-ai", () => ({
  bundledOpenRouterEndpoint: {
    baseUrl: "https://openrouter.ai/api/v1",
  },
  getBundledApiKey: vi.fn(() => "test-openrouter-key"),
  hasBundledOpenRouterKey: true,
}));
vi.mock("expo/fetch", () => ({ fetch: vi.fn() }));

import { fetch } from "expo/fetch";
import {
  OPENROUTER_FALLBACK_IMAGE_MODEL,
  OPENROUTER_PRIMARY_IMAGE_MODEL,
  OpenRouterImageFallbackError,
  generateOpenRouterImage,
} from "./openrouter-image";

const request = {
  model: OPENROUTER_PRIMARY_IMAGE_MODEL,
  prompt: "book illustration",
  aspectRatio: "2:3" as const,
  quality: "high" as const,
  outputFormat: "jpeg" as const,
  outputCompression: 90,
};

function response(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("generateOpenRouterImage", () => {
  it("returns GPT Image 2 output without calling Nano Banana", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      response({
        data: [{ b64_json: "data:image/jpeg;base64,/9j/AQID", media_type: "image/jpeg" }],
      }) as never,
    );

    await expect(generateOpenRouterImage(request)).resolves.toEqual({
      base64: "/9j/AQID",
      mimeType: "image/jpeg",
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0] ?? [];
    expect(url).toBe("https://openrouter.ai/api/v1/images");
    expect(JSON.parse(String(init?.body))).toEqual({
      model: OPENROUTER_PRIMARY_IMAGE_MODEL,
      prompt: request.prompt,
      aspect_ratio: "2:3",
      n: 1,
      quality: "high",
      output_format: "jpeg",
      output_compression: 90,
    });
  });

  it("trusts image bytes over a conflicting response media type", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      response({
        data: [{ b64_json: "data:image/jpeg;base64,iVBORw0KGgoPNG", media_type: "image/jpeg" }],
      }) as never,
    );

    await expect(generateOpenRouterImage(request)).resolves.toEqual({
      base64: "iVBORw0KGgoPNG",
      mimeType: "image/png",
    });
  });

  it("falls back from a permanent GPT policy error to stable Nano Banana 2", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        response(
          {
            error: {
              message: "Content policy violation",
              metadata: { error_type: "content_policy_violation" },
            },
          },
          400,
        ) as never,
      )
      .mockResolvedValueOnce(response({ data: [{ b64_json: "iVBORw0KGgoAAAANS" }] }) as never);

    await expect(generateOpenRouterImage(request)).resolves.toEqual({
      base64: "iVBORw0KGgoAAAANS",
      mimeType: "image/png",
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    const [, fallbackInit] = vi.mocked(fetch).mock.calls[1] ?? [];
    const fallbackBody = JSON.parse(String(fallbackInit?.body));
    expect(fallbackBody).toEqual({
      model: OPENROUTER_FALLBACK_IMAGE_MODEL,
      prompt: request.prompt,
      aspect_ratio: "2:3",
      n: 1,
      resolution: "1K",
      provider: { allow_fallbacks: true },
    });
    expect(fallbackBody).not.toHaveProperty("quality");
    expect(fallbackBody).not.toHaveProperty("output_format");
    expect(fallbackBody).not.toHaveProperty("output_compression");
  });

  it("honors Retry-After for a transient GPT failure before succeeding", async () => {
    vi.useFakeTimers();
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        response({ error: { message: "Provider temporarily unavailable" } }, 503, {
          "retry-after": "2",
        }) as never,
      )
      .mockResolvedValueOnce(response({ data: [{ b64_json: "/9j/AQID" }] }) as never);

    const result = generateOpenRouterImage(request);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toEqual({ base64: "/9j/AQID", mimeType: "image/jpeg" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("uses Nano Banana after GPT exhausts its transient retry", async () => {
    vi.useFakeTimers();
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({ error: { message: "Provider unavailable" } }, 503) as never)
      .mockResolvedValueOnce(
        response({ error: { message: "Provider still unavailable" } }, 503) as never,
      )
      .mockResolvedValueOnce(response({ data: [{ b64_json: "iVBORw0KGgoNANO" }] }) as never);

    const result = generateOpenRouterImage(request);
    await vi.runAllTimersAsync();

    await expect(result).resolves.toEqual({
      base64: "iVBORw0KGgoNANO",
      mimeType: "image/png",
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[2]?.[1]?.body)).model).toBe(
      OPENROUTER_FALLBACK_IMAGE_MODEL,
    );
  });

  it("falls back when GPT returns HTTP 200 with an empty image payload", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({ data: [] }) as never)
      .mockResolvedValueOnce(
        response({ data: [{ b64_json: "data:image/png;base64,iVBORw0KGgoEMPTY" }] }) as never,
      );

    await expect(generateOpenRouterImage(request)).resolves.toEqual({
      base64: "iVBORw0KGgoEMPTY",
      mimeType: "image/png",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("moves directly to Nano Banana after a full provider timeout", async () => {
    vi.mocked(fetch)
      .mockRejectedValueOnce(Object.assign(new Error("Aborted"), { name: "AbortError" }))
      .mockResolvedValueOnce(response({ data: [{ b64_json: "iVBORw0KGgoTIMEOUT" }] }) as never);

    await expect(generateOpenRouterImage(request)).resolves.toEqual({
      base64: "iVBORw0KGgoTIMEOUT",
      mimeType: "image/png",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([401, 402])("does not retry a shared account failure (%s) with Nano", async (status) => {
    vi.mocked(fetch).mockResolvedValueOnce(
      response({ error: { message: "Shared account failure" } }, status) as never,
    );

    await expect(generateOpenRouterImage(request)).rejects.toThrow("Shared account failure");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("falls back when GPT returns invalid image bytes", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({ data: [{ b64_json: "AQID" }] }) as never)
      .mockResolvedValueOnce(response({ data: [{ b64_json: "iVBORw0KGgoVALID" }] }) as never);

    await expect(generateOpenRouterImage(request)).resolves.toEqual({
      base64: "iVBORw0KGgoVALID",
      mimeType: "image/png",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("returns a diagnostic error when both models fail", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        response({ error: { message: "GPT refused the prompt" } }, 400) as never,
      )
      .mockResolvedValueOnce(
        response({ error: { message: "Nano Banana refused the prompt" } }, 400) as never,
      );

    const result = generateOpenRouterImage(request);
    await expect(result).rejects.toBeInstanceOf(OpenRouterImageFallbackError);
    await expect(result).rejects.toMatchObject({
      attempts: [
        { model: OPENROUTER_PRIMARY_IMAGE_MODEL, message: "GPT refused the prompt" },
        {
          model: OPENROUTER_FALLBACK_IMAGE_MODEL,
          message: "Nano Banana refused the prompt",
        },
      ],
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
