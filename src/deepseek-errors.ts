export type DeepSeekErrorCategory =
  | "invalid_format"
  | "authentication"
  | "insufficient_balance"
  | "invalid_parameters"
  | "rate_limit"
  | "server_error"
  | "server_overloaded"
  | "network"
  | "unknown";

export interface DeepSeekErrorDiagnostic {
  category: DeepSeekErrorCategory;
  statusCode?: number;
  retryable: boolean;
  action: string;
}

const STATUS_DIAGNOSTICS: Record<number, DeepSeekErrorDiagnostic> = {
  400: {
    category: "invalid_format",
    statusCode: 400,
    retryable: false,
    action: "Review the request body, tool schema, and reasoning-content replay before retrying.",
  },
  401: {
    category: "authentication",
    statusCode: 401,
    retryable: false,
    action: "Check the local DEEPSEEK_API_KEY or Pi DeepSeek credential configuration.",
  },
  402: {
    category: "insufficient_balance",
    statusCode: 402,
    retryable: false,
    action: "Check the DeepSeek account balance and add funds before retrying.",
  },
  422: {
    category: "invalid_parameters",
    statusCode: 422,
    retryable: false,
    action: "Review the model ID and request parameters using the provider error detail.",
  },
  429: {
    category: "rate_limit",
    statusCode: 429,
    retryable: true,
    action: "Wait for Pi's backoff; reduce request concurrency if rate limits persist.",
  },
  500: {
    category: "server_error",
    statusCode: 500,
    retryable: true,
    action: "Retry after a short wait; contact DeepSeek if the server error persists.",
  },
  503: {
    category: "server_overloaded",
    statusCode: 503,
    retryable: true,
    action: "Retry after a short wait because the DeepSeek service is overloaded.",
  },
};

function extractStatusCode(message: string): number | undefined {
  const explicit = message.match(/(?:status(?:\s+code)?|http(?:\s+error)?|api\s+error)\s*[:=(]?\s*(400|401|402|422|429|500|503)\b/i);
  if (explicit) return Number(explicit[1]);
  const leading = message.match(/^\s*(400|401|402|422|429|500|503)\s*(?::|-|\b)/);
  return leading ? Number(leading[1]) : undefined;
}

export function classifyDeepSeekError(error: unknown): DeepSeekErrorDiagnostic {
  const message = error instanceof Error ? error.message : String(error);
  const statusCode = extractStatusCode(message);
  if (statusCode !== undefined) return STATUS_DIAGNOSTICS[statusCode]!;

  if (/incorrect api key|invalid api key|authentication fail|unauthori[sz]ed/i.test(message)) {
    return STATUS_DIAGNOSTICS[401]!;
  }
  if (/insufficient balance|account balance|payment required/i.test(message)) {
    return STATUS_DIAGNOSTICS[402]!;
  }
  if (/too many requests|rate.?limit/i.test(message)) return STATUS_DIAGNOSTICS[429]!;
  if (/overloaded|service unavailable/i.test(message)) return STATUS_DIAGNOSTICS[503]!;
  if (/server error|internal error/i.test(message)) return STATUS_DIAGNOSTICS[500]!;
  if (/invalid parameter|unprocessable/i.test(message)) return STATUS_DIAGNOSTICS[422]!;
  if (/invalid (?:request|format)|reasoning_content|request body/i.test(message)) return STATUS_DIAGNOSTICS[400]!;
  if (/network|fetch failed|connection|socket|timed? out|timeout|terminated/i.test(message)) {
    return {
      category: "network",
      retryable: true,
      action: "Check network, proxy, and DNS connectivity, then retry when the connection is stable.",
    };
  }
  return {
    category: "unknown",
    retryable: false,
    action: "Inspect the sanitized provider detail and retry only after confirming the failure is transient.",
  };
}

export function describeDeepSeekError(
  error: unknown,
  sanitize: (value: unknown) => string,
  retryableOverride?: boolean,
): string {
  const diagnostic = classifyDeepSeekError(error);
  const status = diagnostic.statusCode === undefined ? "unknown" : String(diagnostic.statusCode);
  const detail = sanitize(error).slice(0, 1000);
  const retryable = retryableOverride ?? diagnostic.retryable;
  return `category=${diagnostic.category} status=${status} retryable=${retryable ? "yes" : "no"} action=${JSON.stringify(diagnostic.action)} detail=${JSON.stringify(detail)}`;
}
