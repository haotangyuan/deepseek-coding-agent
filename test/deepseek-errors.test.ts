import assert from "node:assert/strict";
import test from "node:test";
import { classifyDeepSeekError, describeDeepSeekError } from "../src/deepseek-errors.ts";

test("classifies official DeepSeek HTTP errors with correct retry boundaries", () => {
  const cases = [
    ["400: invalid request body", "invalid_format", false],
    ["401 Authentication Fails", "authentication", false],
    ["DeepSeek API error (402): insufficient balance", "insufficient_balance", false],
    ["HTTP error 422 invalid parameters", "invalid_parameters", false],
    ["429 status code (no body)", "rate_limit", true],
    ["500: internal server error", "server_error", true],
    ["503 Service Unavailable", "server_overloaded", true],
  ] as const;
  for (const [message, category, retryable] of cases) {
    const result = classifyDeepSeekError(message);
    assert.equal(result.category, category);
    assert.equal(result.retryable, retryable);
  }
});

test("classifies status-free network and credential messages", () => {
  assert.equal(classifyDeepSeekError("fetch failed: socket hang up").category, "network");
  assert.equal(classifyDeepSeekError("Incorrect API key provided").category, "authentication");
  assert.equal(classifyDeepSeekError("unexpected local failure").category, "unknown");
});

test("describes errors without exposing key-shaped values", () => {
  const description = describeDeepSeekError(`401: invalid key ${"sk-" + "test-secret-value"}`, (value) =>
    String(value).replace(/sk-[A-Za-z0-9_-]{8,}/g, "[REDACTED]"));
  assert.match(description, /category=authentication status=401 retryable=no/);
  assert.match(description, /\[REDACTED\]/);
  assert.doesNotMatch(description, /test-secret-value/);
});

test("retry events can reflect Pi's actual retry decision for unknown provider text", () => {
  const description = describeDeepSeekError("Provider returned error", String, true);
  assert.match(description, /category=unknown.*retryable=yes/);
});
