/**
 * Reading Paddle errors out of the SDK's error family.
 *
 * Every operation rejects with its own subclass of ApiError (for example
 * `Subscriptions.UpdateSubscriptionError`). The body Paddle returns is
 *   { error: { type, code, detail, documentation_url, errors?: [{field, message}] }, meta: { request_id } }
 * and the SDK decodes it (camelCase) into payload.kind === "errorResponse".
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
  /** Human-readable detail from Paddle. Show to operators, not to end users verbatim. */
  detail: string | undefined;
  /** Field-level validation messages (code "invalid_field"). */
  fieldErrors: { field: string; message: string }[];
  /** Log this and quote it to Paddle support. */
  requestId: string | undefined;
  /** Paddle's documentation page for this code. */
  documentationUrl: string | undefined;
}

/** Returns Paddle's error details when `err` is an API error from the SDK; otherwise undefined. */
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

/** True when Paddle answered 429. The SDK already retried GETs; writes reach here. */
export function isRateLimited(err: unknown): boolean {
  return err instanceof ApiError && err.status === 429;
}

/**
 * Map a Paddle failure to the HTTP answer your own API should give.
 * - Validation and state errors (4xx other than 401/403/429): pass the status
 *   and Paddle's `detail` through, so the caller learns what to change.
 * - 401/403: your key is wrong or lacks a permission → 502 with a fixed message.
 * - 429 → 503; 5xx or transport → 502.
 */
export function toHttpAnswer(err: unknown): { status: number; body: { error: string; code?: string; requestId?: string } } {
  const info = paddleError(err);
  if (!info) {
    return isTransportFailure(err)
      ? { status: 502, body: { error: "Payment provider unreachable" } }
      : { status: 500, body: { error: "Unexpected error" } };
  }
  if (info.status === 401 || info.status === 403) {
    return { status: 502, body: { error: "Payment provider credentials are not valid for this operation", code: info.code, requestId: info.requestId } };
  }
  if (info.status === 429) {
    return { status: 503, body: { error: "Payment provider rate limit reached, retry shortly", code: info.code, requestId: info.requestId } };
  }
  if (info.status >= 500) {
    return { status: 502, body: { error: "Payment provider error", code: info.code, requestId: info.requestId } };
  }
  return { status: info.status, body: { error: info.detail ?? "Request rejected by payment provider", code: info.code, requestId: info.requestId } };
}
