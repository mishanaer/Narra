import {
  bundledOpenRouterEndpoint,
  getBundledApiKey,
  hasBundledOpenRouterKey,
} from "@/config/bundled-ai";
import { fetch } from "expo/fetch";

export const OPENROUTER_PRIMARY_IMAGE_MODEL = "openai/gpt-image-2";
export const OPENROUTER_FALLBACK_IMAGE_MODEL = "google/gemini-3.1-flash-image";

const REQUEST_TIMEOUT_MS = 180_000;
const PRIMARY_REQUEST_ATTEMPTS = 2;
const FALLBACK_REQUEST_ATTEMPTS = 1;
const EXPLICIT_MODEL_REQUEST_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;

interface OpenRouterProviderError {
  message?: string;
  code?: string | number;
  metadata?: {
    error_type?: string;
    provider_name?: string;
  };
}

class OpenRouterImageRequestError extends Error {
  constructor(
    message: string,
    readonly model: string,
    readonly status: number,
    readonly retryAfterMs?: number,
    readonly providerCode?: string | number,
    readonly providerErrorType?: string,
  ) {
    super(message);
    this.name = "OpenRouterImageRequestError";
  }
}

export class OpenRouterImageFallbackError extends Error {
  readonly attempts: ReadonlyArray<{ model: string; message: string }>;

  constructor(attempts: ReadonlyArray<{ model: string; cause: unknown }>) {
    const safeAttempts = attempts.map(({ model, cause }) => ({
      model,
      message: errorSummary(cause),
    }));
    super(
      `OpenRouter image generation failed: ${safeAttempts
        .map(({ model, message }) => `${model}: ${message}`)
        .join("; ")}`,
    );
    this.name = "OpenRouterImageFallbackError";
    this.attempts = safeAttempts;
  }
}

function isRetryableImageError(cause: unknown): boolean {
  if (cause instanceof OpenRouterImageRequestError) {
    return cause.status === 408 || cause.status === 429 || cause.status >= 500;
  }
  // A provider timeout already consumed the full request budget. Move to the
  // fallback model instead of waiting for the same model for another 3 minutes.
  return cause instanceof TypeError;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(MAX_RETRY_DELAY_MS, Math.round(seconds * 1_000));
  }

  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, date - Date.now()));
}

function retryDelay(cause: unknown, attempt: number): number {
  const localDelay = Math.min(MAX_RETRY_DELAY_MS, DEFAULT_RETRY_DELAY_MS * 2 ** attempt);
  if (cause instanceof OpenRouterImageRequestError && cause.retryAfterMs != null) {
    return Math.max(localDelay, cause.retryAfterMs);
  }
  return localDelay;
}

function errorSummary(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message
    .replace(/sk-[a-z0-9_-]{12,}/giu, "<redacted>")
    .replace(/\s+/gu, " ")
    .slice(0, 240);
}

export interface OpenRouterGeneratedImage {
  base64: string;
  mimeType: string;
}

export interface OpenRouterImageRequest {
  model: string;
  prompt: string;
  aspectRatio: "1:1" | "2:3" | "3:2" | "3:4";
  outputFormat: "jpeg" | "png";
  quality?: "high" | "medium" | "low";
  outputCompression?: number;
}

interface OpenRouterImageResponse {
  data?: Array<{ b64_json?: string; media_type?: string }>;
  error?: OpenRouterProviderError;
}

function isNanoBananaModel(model: string): boolean {
  return model === OPENROUTER_FALLBACK_IMAGE_MODEL;
}

function requestBody(request: OpenRouterImageRequest, model: string): Record<string, unknown> {
  const common = {
    model,
    prompt: request.prompt,
    aspect_ratio: request.aspectRatio,
    n: 1,
  };

  if (isNanoBananaModel(model)) {
    return {
      ...common,
      resolution: "1K",
      provider: { allow_fallbacks: true },
    };
  }

  return {
    ...common,
    quality: request.quality ?? "high",
    output_format: request.outputFormat,
    ...(request.outputCompression != null ? { output_compression: request.outputCompression } : {}),
  };
}

class OpenRouterImageResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenRouterImageResponseError";
  }
}

function normalizedImageBase64(value?: string): string {
  if (!value) throw new OpenRouterImageResponseError("OpenRouter image response is empty");
  const comma = value.startsWith("data:") ? value.indexOf(",") : -1;
  const normalized = (comma >= 0 ? value.slice(comma + 1) : value).replace(/\s+/gu, "");
  if (!normalized) throw new OpenRouterImageResponseError("OpenRouter image response is empty");
  return normalized;
}

function sniffImageMimeType(base64: string): "image/png" | "image/jpeg" {
  let prefix: string;
  try {
    prefix = atob(base64.slice(0, 16));
  } catch {
    throw new OpenRouterImageResponseError(
      "OpenRouter image response has unsupported or invalid bytes",
    );
  }
  const byte = (index: number) => prefix.charCodeAt(index);
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (pngSignature.every((expected, index) => byte(index) === expected)) return "image/png";
  if (byte(0) === 0xff && byte(1) === 0xd8 && byte(2) === 0xff) return "image/jpeg";
  throw new OpenRouterImageResponseError(
    "OpenRouter image response has unsupported or invalid bytes",
  );
}

function normalizedImagePayload(image: { b64_json?: string }): OpenRouterGeneratedImage {
  const base64 = normalizedImageBase64(image.b64_json);
  return { base64, mimeType: sniffImageMimeType(base64) };
}

async function requestImageOnce(
  request: OpenRouterImageRequest,
  model: string,
  apiKey: string,
  baseUrl: string,
): Promise<OpenRouterGeneratedImage> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl}/images`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody(request, model)),
      signal: controller.signal,
    });
    const payload = (await response.json().catch(() => ({}))) as OpenRouterImageResponse;
    if (!response.ok || payload.error) {
      const providerError = payload.error;
      throw new OpenRouterImageRequestError(
        providerError?.message || `OpenRouter image request failed (${response.status})`,
        model,
        response.status,
        retryAfterMs(response),
        providerError?.code,
        providerError?.metadata?.error_type,
      );
    }

    return normalizedImagePayload(payload.data?.[0] ?? {});
  } finally {
    clearTimeout(timeout);
  }
}

async function requestImageWithRetry(
  request: OpenRouterImageRequest,
  model: string,
  attempts: number,
  apiKey: string,
  baseUrl: string,
): Promise<OpenRouterGeneratedImage> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await requestImageOnce(request, model, apiKey, baseUrl);
    } catch (cause) {
      lastError = cause;
      if (attempt === attempts - 1 || !isRetryableImageError(cause)) throw cause;
      await wait(retryDelay(cause, attempt));
    }
  }
  throw lastError;
}

/**
 * Единый OpenRouter Images-клиент для обложек, портретов и сцен.
 * Сначала пробует запрошенную GPT Image-модель, затем — stable Nano Banana 2.
 */
export async function generateOpenRouterImage(
  request: OpenRouterImageRequest,
): Promise<OpenRouterGeneratedImage> {
  if (!hasBundledOpenRouterKey) {
    throw new Error("OpenRouter image generation is not configured");
  }

  const apiKey = getBundledApiKey(bundledOpenRouterEndpoint);
  const baseUrl = bundledOpenRouterEndpoint.baseUrl.replace(/\/+$/, "");
  if (request.model !== OPENROUTER_PRIMARY_IMAGE_MODEL) {
    return requestImageWithRetry(
      request,
      request.model,
      EXPLICIT_MODEL_REQUEST_ATTEMPTS,
      apiKey,
      baseUrl,
    );
  }

  let primaryError: unknown;
  try {
    return await requestImageWithRetry(
      request,
      OPENROUTER_PRIMARY_IMAGE_MODEL,
      PRIMARY_REQUEST_ATTEMPTS,
      apiKey,
      baseUrl,
    );
  } catch (cause) {
    primaryError = cause;
  }

  // Authentication and account-credit failures are shared by both models.
  // A second request cannot recover them and only delays the actionable error.
  if (
    primaryError instanceof OpenRouterImageRequestError &&
    (primaryError.status === 401 || primaryError.status === 402)
  ) {
    throw primaryError;
  }

  if (
    primaryError instanceof OpenRouterImageRequestError &&
    primaryError.retryAfterMs != null &&
    (primaryError.status === 429 || primaryError.status === 503)
  ) {
    await wait(primaryError.retryAfterMs);
  }

  try {
    return await requestImageWithRetry(
      request,
      OPENROUTER_FALLBACK_IMAGE_MODEL,
      FALLBACK_REQUEST_ATTEMPTS,
      apiKey,
      baseUrl,
    );
  } catch (fallbackError) {
    throw new OpenRouterImageFallbackError([
      { model: OPENROUTER_PRIMARY_IMAGE_MODEL, cause: primaryError },
      { model: OPENROUTER_FALLBACK_IMAGE_MODEL, cause: fallbackError },
    ]);
  }
}
