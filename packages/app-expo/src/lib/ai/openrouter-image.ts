import {
  bundledOpenRouterEndpoint,
  getBundledApiKey,
  hasBundledOpenRouterKey,
} from "@/config/bundled-ai";
import { fetch } from "expo/fetch";

const REQUEST_TIMEOUT_MS = 120_000;
const MAX_REQUEST_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [750, 2_000] as const;
const MAX_RETRY_AFTER_MS = 8_000;
const RETRY_JITTER_RATIO = 0.2;
const PRIMARY_TIME_BUDGET_MS = 180_000;
const TOTAL_TIME_BUDGET_MS = 300_000;

export const OPENROUTER_PRIMARY_IMAGE_MODEL = "openai/gpt-image-2";
export const OPENROUTER_FALLBACK_IMAGE_MODEL = "google/gemini-3.1-flash-image";

class OpenRouterImageRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "OpenRouterImageRequestError";
  }
}

export class OpenRouterImageGenerationError extends Error {
  readonly primaryFailure: string;
  readonly fallbackFailure: string;

  constructor(primaryError: unknown, fallbackError: unknown, apiKey: string, prompt: string) {
    const primaryFailure = safeErrorSummary(primaryError, apiKey, prompt);
    const fallbackFailure = safeErrorSummary(fallbackError, apiKey, prompt);
    super(
      `OpenRouter image generation failed: GPT Image 2: ${primaryFailure}; Nano Banana 2: ${fallbackFailure}`,
    );
    this.name = "OpenRouterImageGenerationError";
    this.primaryFailure = primaryFailure;
    this.fallbackFailure = fallbackFailure;
  }
}

function isRetryableImageError(cause: unknown): boolean {
  if (cause instanceof OpenRouterImageRequestError) {
    return cause.status === 408 || cause.status === 429 || cause.status >= 500;
  }
  return cause instanceof TypeError || (cause instanceof Error && cause.name === "AbortError");
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const parsedMs = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(value) - now;
  if (!Number.isFinite(parsedMs) || parsedMs < 0) return undefined;
  return Math.min(parsedMs, MAX_RETRY_AFTER_MS);
}

function retryDelayMs(cause: unknown, attempt: number): number {
  const base =
    cause instanceof OpenRouterImageRequestError && cause.retryAfterMs != null
      ? cause.retryAfterMs
      : (RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS.at(-1) ?? 0);
  const jitter = base * RETRY_JITTER_RATIO * (Math.random() * 2 - 1);
  return Math.max(0, Math.min(MAX_RETRY_AFTER_MS, Math.round(base + jitter)));
}

function safeErrorSummary(cause: unknown, apiKey: string, prompt: string): string {
  const raw = cause instanceof Error ? cause.message : String(cause);
  const redacted = raw
    .replaceAll(apiKey, "[redacted]")
    .replaceAll(prompt, "[prompt redacted]")
    .replace(/Bearer\s+[^\s]+/giu, "Bearer [redacted]")
    .replace(/\s+/gu, " ")
    .trim();
  return (redacted || "unknown error").slice(0, 300);
}

export interface OpenRouterGeneratedImage {
  base64: string;
  mimeType: string;
}

export interface OpenRouterImageRequest {
  prompt: string;
  aspectRatio: "1:1" | "2:3" | "3:2" | "3:4";
  outputFormat: "jpeg" | "png";
  quality?: "high" | "medium" | "low";
  outputCompression?: number;
}

interface OpenRouterImageResponse {
  data?: Array<{ b64_json?: string; media_type?: string }>;
  error?: { message?: string };
}

function imageMimeType(
  originalValue: string,
  base64: string,
  mediaType: string | undefined,
  defaultMimeType: string,
): string {
  const dataUrlMimeType = originalValue.match(/^data:(image\/[^;,]+)[;,]/iu)?.[1];
  if (dataUrlMimeType) return dataUrlMimeType.toLowerCase();
  if (mediaType?.startsWith("image/")) return mediaType.toLowerCase();
  if (base64.startsWith("iVBORw0KGgo")) return "image/png";
  if (base64.startsWith("/9j/")) return "image/jpeg";
  if (base64.startsWith("UklGR")) return "image/webp";
  if (base64.startsWith("R0lGOD")) return "image/gif";
  return defaultMimeType;
}

function requestBody(
  model: string,
  request: OpenRouterImageRequest,
): Record<string, string | number> {
  const common = {
    model,
    prompt: request.prompt,
    aspect_ratio: request.aspectRatio,
    n: 1,
  };
  if (model === OPENROUTER_FALLBACK_IMAGE_MODEL) return common;
  return {
    ...common,
    quality: request.quality ?? "high",
    output_format: request.outputFormat,
    ...(request.outputCompression != null ? { output_compression: request.outputCompression } : {}),
  };
}

async function requestImage(
  model: string,
  request: OpenRouterImageRequest,
  apiKey: string,
  baseUrl: string,
  deadline: number,
): Promise<OpenRouterGeneratedImage> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_REQUEST_ATTEMPTS; attempt += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw lastError ?? new Error("request time budget exhausted");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(REQUEST_TIMEOUT_MS, remainingMs));

    try {
      const response = await fetch(`${baseUrl}/images`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody(model, request)),
        signal: controller.signal,
      });
      const payload = (await response.json().catch(() => ({}))) as OpenRouterImageResponse;
      if (!response.ok) {
        throw new OpenRouterImageRequestError(
          payload.error?.message || `request failed (${response.status})`,
          response.status,
          parseRetryAfter(response.headers.get("retry-after")),
        );
      }

      const image = payload.data?.[0];
      if (!image?.b64_json) {
        throw new OpenRouterImageRequestError(
          payload.error?.message || "successful response contained no image",
          200,
        );
      }
      const originalValue = image.b64_json;
      const base64 = originalValue.includes(",")
        ? originalValue.slice(originalValue.indexOf(",") + 1)
        : originalValue;
      return {
        base64,
        mimeType: imageMimeType(
          originalValue,
          base64,
          image.media_type,
          model === OPENROUTER_FALLBACK_IMAGE_MODEL ? "image/png" : `image/${request.outputFormat}`,
        ),
      };
    } catch (cause) {
      lastError = cause;
      if (attempt === MAX_REQUEST_ATTEMPTS - 1 || !isRetryableImageError(cause)) throw cause;
      await wait(Math.min(retryDelayMs(cause, attempt), Math.max(0, deadline - Date.now())));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError;
}

/** Единый OpenRouter Images-клиент: GPT Image 2 с fallback на Nano Banana 2. */
export async function generateOpenRouterImage(
  request: OpenRouterImageRequest,
): Promise<OpenRouterGeneratedImage> {
  if (!hasBundledOpenRouterKey) {
    throw new Error("OpenRouter image generation is not configured");
  }

  const apiKey = getBundledApiKey(bundledOpenRouterEndpoint);
  const baseUrl = bundledOpenRouterEndpoint.baseUrl.replace(/\/+$/, "");
  const startedAt = Date.now();
  let primaryError: unknown;
  try {
    return await requestImage(
      OPENROUTER_PRIMARY_IMAGE_MODEL,
      request,
      apiKey,
      baseUrl,
      startedAt + PRIMARY_TIME_BUDGET_MS,
    );
  } catch (cause) {
    primaryError = cause;
  }

  try {
    return await requestImage(
      OPENROUTER_FALLBACK_IMAGE_MODEL,
      request,
      apiKey,
      baseUrl,
      startedAt + TOTAL_TIME_BUDGET_MS,
    );
  } catch (fallbackError) {
    throw new OpenRouterImageGenerationError(primaryError, fallbackError, apiKey, request.prompt);
  }
}
