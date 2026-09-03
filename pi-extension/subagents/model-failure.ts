const MESSAGE_FIELDS = ["message", "errorMessage", "detail", "reason"] as const;
const NESTED_ERROR_FIELDS = ["error", "cause", "response"] as const;
const STATUS_FIELDS = ["status", "statusCode", "httpStatus", "code"] as const;

interface FailureSignals {
  messages: string[];
  statuses: Array<number | string>;
}

function collectFailureSignals(value: unknown): FailureSignals {
  const signals: FailureSignals = { messages: [], statuses: [] };
  const seen = new Set<object>();

  function visit(candidate: unknown, depth: number): void {
    if (typeof candidate === "string") {
      signals.messages.push(candidate);
      return;
    }
    if (!candidate || typeof candidate !== "object" || depth > 3 || seen.has(candidate)) return;
    seen.add(candidate);

    const record = candidate as Record<string, unknown>;
    for (const field of MESSAGE_FIELDS) {
      if (typeof record[field] === "string") signals.messages.push(record[field]);
    }
    for (const field of STATUS_FIELDS) {
      const status = record[field];
      if (typeof status === "number" || typeof status === "string") signals.statuses.push(status);
    }
    for (const field of NESTED_ERROR_FIELDS) visit(record[field], depth + 1);
  }

  visit(value, 0);
  return signals;
}

function numericStatus(status: number | string): number | null {
  if (typeof status === "number") return status;
  const match = status.match(/(?:^|\D)(\d{3})(?:\D|$)/);
  return match ? Number(match[1]) : null;
}

const REDACTED = "[REDACTED]";

/**
 * Remove credential values while preserving provider, model, status, and
 * surrounding error context. This is the owning boundary for diagnostics that
 * can be persisted or delivered to a parent session.
 */
export function redactCredentialValues(message: string): string {
  return message
    .replace(
      /(\bauthorization\b\s*[:=]\s*(?:bearer|basic)\s+)(?!\[REDACTED\])(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,
      `$1${REDACTED}`,
    )
    .replace(
      /(\b(?:x-api-key|api[_-]?key|access_token|token)\b["']?\s*[:=]\s*)(?!\[REDACTED\])(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,
      `$1${REDACTED}`,
    )
    .replace(/\bsk-[a-z0-9_-]{16,}\b/gi, REDACTED);
}

/**
 * Identify failures that cannot succeed by retrying the same provider/model.
 * Matching is intentionally limited to authentication, authorization, and
 * model-identifier failures. Capacity, transport, serialization, and user
 * cancellation failures remain outside this classification.
 */
export function isPermanentModelOrAuthFailure(failure: unknown): boolean {
  const { messages, statuses } = collectFailureSignals(failure);
  const normalized = messages.join("\n").toLowerCase();
  const numericStatuses = statuses.map(numericStatus).filter((status): status is number => status !== null);

  if (numericStatuses.some((status) => status === 429 || status >= 500)) return false;
  if (/(?:^|[^a-z0-9])(?:429|5\d{2})(?=$|[^a-z0-9])/.test(normalized)) return false;
  if (/\b(?:overload(?:ed)?|rate[ -]?limit(?:ed)?|throttl(?:e|ed|ing)|capacity)\b/.test(normalized)) {
    return false;
  }
  if (/\b(?:fetch failed|network error|connection (?:failed|reset)|serialize|serialization)\b/.test(normalized)) {
    return false;
  }
  if (/\b(?:aborterror|user (?:abort|aborted|cancel)|cancelled by (?:the )?user)\b/.test(normalized)) {
    return false;
  }

  if (numericStatuses.some((status) => status === 401 || status === 403)) return true;
  if (/(?:^|[^a-z0-9])(?:401|403)(?=$|[^a-z0-9])/.test(normalized)) return true;
  if (/\bno (?:api key|credential)s? (?:found|available|configured)\b/.test(normalized)) return true;
  if (/\b(?:invalid|rejected) (?:x-)?(?:api[ -]?key|credential)s?\b/.test(normalized)) return true;
  if (/\b(?:unauthori[sz]ed|authentication (?:failed|required|rejected))\b/.test(normalized)) return true;
  if (/\b(?:access|permission) denied\b/.test(normalized) && /\bmodel\b/.test(normalized)) return true;

  return /\bmodel\b/.test(normalized) &&
    /\b(?:not found|does not exist|unknown|unavailable|inaccessible|not accessible|invalid (?:model )?identifier|(?:model )?identifier (?:is )?invalid)\b/.test(normalized);
}
