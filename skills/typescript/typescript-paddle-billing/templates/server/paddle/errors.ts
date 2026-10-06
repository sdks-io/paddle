/**
 * Reading Paddle errors out of the SDK's error family (→ typescript-error-handling).
 *
 * The body Paddle returns on an error is
 *   { error: { type, code, detail, documentation_url, errors?: [{field, message}] }, meta: { request_id } }
 * and arrives as the `ErrorResponse` model.
 *
 * Use `paddleError(err)` in a catch to get status, code, detail and request_id
 * without caring which operation threw. Narrow on `code` (a stable string
 * such as "subscription_locked_renewal"), never on `detail` (free text).
 */
import { ApiError, PaddleApiError, type ErrorResponse } from "paddle-apimatic-sdk";

export interface PaddleErrorInfo {
  /** HTTP status Paddle answered with. */
  status: number;
  /** Paddle error code, e.g. "not_found", "subscription_update_when_past_due". Undefined when the body was not Paddle's error shape. */
  code: string | undefined;
  /** Free-text detail from Paddle. Log it with requestId; the API answers the caller with code and fieldErrors instead. */
  detail: string | undefined;
  /** Field-level validation messages (code "invalid_field"). */
  fieldErrors: { field: string; message: string }[];
  /** Log this and quote it to Paddle support. */
  requestId: string | undefined;
  /** Paddle's documentation page for this code. */
  documentationUrl: string | undefined;
}

/**
 * Returns Paddle's error details when `err` is an API error from the SDK; otherwise undefined.
 * Every operation of this SDK declares the same two error arms (`errorResponse` and `undeclared`,
 * per the SDK map), so one reader serves them all.
 */
export function paddleError(err: unknown): PaddleErrorInfo | undefined {
  if (!(err instanceof ApiError)) return undefined;
  const payload = err.payload as { kind: string; body?: unknown };
  const body = payload.kind === "errorResponse" ? (payload.body as ErrorResponse) : undefined;
  return {
    status: err.status,
    code: body?.error.code,
    detail: body?.error.detail,
    fieldErrors: (body?.error.errors ?? []).map((e) => ({ field: e.field, message: e.message })),
    requestId: body?.meta.requestId,
    documentationUrl: body?.error.documentationUrl,
  };
}

/** True when the failure is a transport problem (connection dropped or the attempt timed out) rather than an answer from Paddle. */
export function isTransportFailure(err: unknown): boolean {
  return err instanceof PaddleApiError && (err.kind === "connection" || err.kind === "timeout");
}

/** True when Paddle answered 429. Retry settings → typescript-configuration-resilience. */
export function isRateLimited(err: unknown): boolean {
  return err instanceof ApiError && err.status === 429;
}

/**
 * How a failed write ended. Decides what the write's own catch does (writes.ts):
 * - "refused":  Paddle answered 4xx; nothing changed. Release the claim, tell the caller why.
 * - "unknown":  Paddle may have acted (connection lost, timeout, 5xx, or a 2xx whose body could not
 *               be read). Re-read by the reference that was sent before reporting anything.
 * - "not_sent": the request never left (credential not obtained, a value that would not encode,
 *               or an error in our own code). Nothing to re-read; release the claim.
 */
export type WriteOutcome = "refused" | "unknown" | "not_sent";

export function writeOutcome(err: unknown): WriteOutcome {
  if (err instanceof ApiError) return err.status >= 500 ? "unknown" : "refused";
  if (err instanceof PaddleApiError) {
    return err.kind === "connection" || err.kind === "timeout" || err.kind === "decode" ? "unknown" : "not_sent";
  }
  return "not_sent";
}

/**
 * A write whose outcome could not be settled: Paddle may or may not have applied it, and a
 * re-read did not find it (or failed too). The claim stays, so a repeat does not write twice.
 * Never report this as "failed".
 */
export class OutcomeUnknownError extends Error {
  constructor(
    public readonly operation: string,
    public readonly reference: string,
    options?: { cause?: unknown },
  ) {
    super(`${operation}: Paddle did not confirm the outcome (reference ${reference}); it may have been applied`, options);
    this.name = "OutcomeUnknownError";
  }
}

export interface HttpAnswer {
  status: number;
  body: {
    error: string;
    code?: string;
    /** Paddle's field-level messages, for the caller to fix what they sent. */
    fields?: { field: string; message: string }[];
    /** "unknown" when a write may or may not have been applied. */
    outcome?: "unknown";
    requestId?: string;
  };
}

/**
 * Map a Paddle failure to the HTTP answer your own API gives (the routing skill's table 1b.4).
 * Log `paddleError(err)` (including `detail`) with the requestId before answering.
 * - 4xx other than 401/403/429: the same status, Paddle's `code` and field messages, so the caller
 *   learns what to change. Paddle's free-text `detail` stays in the log.
 * - 401/403 → 502 (our credentials); 429 → 503 (our quota); 5xx → 502.
 * - A write whose outcome is unknown (OutcomeUnknownError) → 502 with outcome "unknown", never "failed".
 * - No response on a read → 502.
 */
export function toHttpAnswer(err: unknown): HttpAnswer {
  if (err instanceof OutcomeUnknownError) {
    return {
      status: 502,
      body: { error: "The payment provider did not confirm the outcome. It may have been applied; check before trying again.", outcome: "unknown" },
    };
  }
  const info = paddleError(err);
  if (!info) {
    return isTransportFailure(err)
      ? { status: 502, body: { error: "Payment provider unreachable" } }
      : { status: 500, body: { error: "Unexpected error" } };
  }
  const ids = { ...(info.code ? { code: info.code } : {}), ...(info.requestId ? { requestId: info.requestId } : {}) };
  if (info.status === 401 || info.status === 403) {
    return { status: 502, body: { error: "Payment provider credentials are not valid for this operation", ...ids } };
  }
  if (info.status === 429) {
    return { status: 503, body: { error: "Payment provider rate limit reached, retry shortly", ...ids } };
  }
  if (info.status >= 500) {
    return { status: 502, body: { error: "Payment provider error", ...ids } };
  }
  const reason = info.fieldErrors.length > 0 ? info.fieldErrors.map((f) => `${f.field}: ${f.message}`).join("; ") : info.code ?? "rejected";
  return {
    status: info.status,
    body: { error: `Rejected by the payment provider: ${reason}`, ...ids, ...(info.fieldErrors.length > 0 ? { fields: info.fieldErrors } : {}) },
  };
}
