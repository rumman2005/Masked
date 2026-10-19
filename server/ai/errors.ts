import type { AiProviderId } from "./types.js";

export type AiProviderErrorCode =
  | "TIMEOUT"
  | "RATE_LIMITED"
  | "HTTP_ERROR"
  | "NETWORK_ERROR"
  | "INVALID_RESPONSE"
  | "NOT_CONFIGURED";

export class AiProviderError extends Error {
  public readonly name = "AiProviderError";

  public constructor(
    public readonly code: AiProviderErrorCode,
    public readonly provider: AiProviderId,
    message: string,
    public readonly status?: number,
    public readonly retryable = false,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export function isAiProviderError(
  error: unknown,
): error is AiProviderError {
  return error instanceof AiProviderError;
}

export function createNotConfiguredError(
  provider: AiProviderId,
): AiProviderError {
  return new AiProviderError(
    "NOT_CONFIGURED",
    provider,
    `${provider} is not configured on this server.`,
  );
}

export function createHttpError(
  provider: AiProviderId,
  status: number,
  retryAfterMs?: number,
): AiProviderError {
  if (status === 429) {
    return new AiProviderError(
      "RATE_LIMITED",
      provider,
      `${provider} rate limit reached.`,
      status,
      true,
      retryAfterMs,
    );
  }

  return new AiProviderError(
    "HTTP_ERROR",
    provider,
    `${provider} request failed with HTTP ${status}.`,
    status,
    status === 408 || status === 425 || status >= 500,
  );
}

export function createInvalidResponseError(
  provider: AiProviderId,
): AiProviderError {
  return new AiProviderError(
    "INVALID_RESPONSE",
    provider,
    `${provider} returned an invalid response.`,
  );
}

/**
 * Convert transport failures into stable, privacy-safe errors. Provider error
 * bodies and the original error message are deliberately not exposed because
 * either can contain request data or credentials echoed by an upstream.
 */
export function classifyAiError(
  error: unknown,
  provider: AiProviderId,
  timedOut = false,
): AiProviderError {
  if (isAiProviderError(error)) {
    return error;
  }

  if (
    timedOut ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "AbortError")
  ) {
    return new AiProviderError(
      "TIMEOUT",
      provider,
      `${provider} request timed out.`,
      undefined,
      true,
    );
  }

  return new AiProviderError(
    "NETWORK_ERROR",
    provider,
    `${provider} request could not be completed.`,
    undefined,
    true,
  );
}
