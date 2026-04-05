import { describe, it, expect, vi } from "vitest";
import {
  isRetryableError,
  sleep,
  randomJitter,
  withRetry,
} from "../src/pipeline/retry";

describe("isRetryableError", () => {
  it("returns true for 429 rate limit errors", () => {
    expect(isRetryableError(new Error("Request failed with status 429"))).toBe(true);
  });

  it("returns true for rate limit messages", () => {
    expect(isRetryableError(new Error("rate limit exceeded"))).toBe(true);
  });

  it("returns true for 500 errors", () => {
    expect(isRetryableError(new Error("500 Internal Server Error"))).toBe(true);
  });

  it("returns true for 502 errors", () => {
    expect(isRetryableError(new Error("502 Bad Gateway"))).toBe(true);
  });

  it("returns true for 503 errors", () => {
    expect(isRetryableError(new Error("503 Service Unavailable"))).toBe(true);
  });

  it("returns true for timeout errors", () => {
    expect(isRetryableError(new Error("Request timed out"))).toBe(true);
  });

  it("returns true for internal error messages", () => {
    expect(isRetryableError(new Error("internal server error"))).toBe(true);
  });

  it("returns false for validation errors", () => {
    expect(isRetryableError(new Error("Validation failed: missing field"))).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(isRetryableError("some string")).toBe(false);
    expect(isRetryableError(42)).toBe(false);
    expect(isRetryableError(null)).toBe(false);
  });
});

describe("sleep", () => {
  it("resolves after the specified delay", async () => {
    vi.useFakeTimers();
    const promise = sleep(100);
    vi.advanceTimersByTime(100);
    await expect(promise).resolves.toBeUndefined();
    vi.useRealTimers();
  });
});

describe("randomJitter", () => {
  it("returns a value >= baseMs", () => {
    for (let i = 0; i < 50; i++) {
      expect(randomJitter(1000)).toBeGreaterThanOrEqual(1000);
    }
  });

  it("returns a value <= 1.5 * baseMs", () => {
    for (let i = 0; i < 50; i++) {
      expect(randomJitter(1000)).toBeLessThanOrEqual(1500);
    }
  });
});

describe("withRetry", () => {
  it("returns the result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, { maxRetries: 3 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on retryable errors and succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("503 Service Unavailable"))
      .mockResolvedValue("recovered");

    const result = await withRetry(fn, {
      maxRetries: 3,
      initialBackoffMs: 1,
      maxBackoffMs: 2,
    });
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws immediately on non-retryable errors", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("Validation failed"));

    await expect(
      withRetry(fn, { maxRetries: 3, initialBackoffMs: 1 })
    ).rejects.toThrow("Validation failed");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws after exhausting all retries", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("503 Service Unavailable"));

    await expect(
      withRetry(fn, { maxRetries: 2, initialBackoffMs: 1, maxBackoffMs: 2 })
    ).rejects.toThrow("503");
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("calls onRetry callback before each retry", async () => {
    const onRetry = vi.fn();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("500 error"))
      .mockResolvedValue("ok");

    await withRetry(fn, {
      maxRetries: 3,
      initialBackoffMs: 1,
      maxBackoffMs: 2,
      onRetry,
    });

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error));
  });

  it("retries on validation failures when shouldRetry is provided", async () => {
    const fn = vi
      .fn()
      .mockResolvedValueOnce("bad")
      .mockResolvedValue("good");

    const result = await withRetry(fn, {
      maxRetries: 3,
      initialBackoffMs: 1,
      shouldRetry: (result) => result === "bad",
    });

    expect(result).toBe("good");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
