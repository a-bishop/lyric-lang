export function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes("429") || message.includes("rate")) return true;
    if (message.includes("500") || message.includes("502") || message.includes("503")) return true;
    if (message.includes("timeout") || message.includes("timed out")) return true;
    if (message.includes("internal") && message.includes("error")) return true;
  }
  return false;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function randomJitter(baseMs: number): number {
  return baseMs + Math.random() * baseMs * 0.5;
}

export interface RetryOptions<T> {
  maxRetries: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  onRetry?: (attempt: number, error: Error) => void;
  shouldRetry?: (result: T) => boolean;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions<T>,
): Promise<T> {
  const {
    maxRetries,
    initialBackoffMs = 1000,
    maxBackoffMs = 10000,
    onRetry,
    shouldRetry,
  } = opts;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const backoffMs = Math.min(initialBackoffMs * Math.pow(2, attempt - 1), maxBackoffMs);
      const delayMs = randomJitter(backoffMs);
      await sleep(delayMs);
    }

    try {
      const result = await fn();

      if (shouldRetry && shouldRetry(result)) {
        lastError = new Error("Result rejected by shouldRetry");
        if (attempt < maxRetries) {
          onRetry?.(attempt + 1, lastError as Error);
          continue;
        }
        return result;
      }

      return result;
    } catch (error) {
      lastError = error;
      const retryable = isRetryableError(error);

      if (!retryable || attempt === maxRetries) {
        throw error;
      }

      onRetry?.(attempt + 1, error as Error);
    }
  }

  throw lastError;
}
