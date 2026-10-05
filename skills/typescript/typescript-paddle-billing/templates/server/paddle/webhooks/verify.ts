/**
 * Paddle webhook signature verification (Paddle Billing).
 *
 * Header:  Paddle-Signature: ts=<unix seconds>;h1=<hex hmac>[;h1=<hex hmac during secret rotation>]
 * Check:   HMAC-SHA256( key = endpoint secret key, message = `${ts}:${rawBody}` ) as hex,
 *          compared in constant time against every h1 present.
 * Replay:  reject when |now - ts| exceeds the tolerance (Paddle's SDKs default to 5 seconds).
 *
 * The raw request body is REQUIRED, byte for byte as Paddle sent it. Any
 * JSON parsing, re-serialisation or whitespace change breaks the signature,
 * so the webhook route must read the raw body (see express.ts / nextjs.ts).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface ParsedPaddleSignature {
  ts: number;
  h1: string[];
}

export function parsePaddleSignature(header: string | null | undefined): ParsedPaddleSignature | undefined {
  if (!header) return undefined;
  let ts: number | undefined;
  const h1: string[] = [];
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === "ts") ts = Number(value);
    else if (key === "h1" && value) h1.push(value);
  }
  if (ts === undefined || !Number.isFinite(ts) || h1.length === 0) return undefined;
  return { ts, h1 };
}

export type VerifyResult =
  | { ok: true; ts: number }
  | { ok: false; reason: "missing_signature" | "malformed_signature" | "timestamp_out_of_tolerance" | "signature_mismatch" };

export function verifyPaddleSignature(
  rawBody: string | Buffer,
  signatureHeader: string | null | undefined,
  secretKey: string,
  options: { toleranceSeconds?: number; nowSeconds?: number } = {},
): VerifyResult {
  if (!signatureHeader) return { ok: false, reason: "missing_signature" };
  const parsed = parsePaddleSignature(signatureHeader);
  if (!parsed) return { ok: false, reason: "malformed_signature" };

  const tolerance = options.toleranceSeconds ?? 5;
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - parsed.ts) > tolerance) return { ok: false, reason: "timestamp_out_of_tolerance" };

  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  const expected = createHmac("sha256", secretKey)
    .update(`${parsed.ts}:`)
    .update(body)
    .digest("hex");
  const expectedBuf = Buffer.from(expected, "hex");

  for (const candidate of parsed.h1) {
    const candidateBuf = Buffer.from(candidate, "hex");
    if (candidateBuf.length === expectedBuf.length && timingSafeEqual(candidateBuf, expectedBuf)) {
      return { ok: true, ts: parsed.ts };
    }
  }
  return { ok: false, reason: "signature_mismatch" };
}

/**
 * Builds a valid Paddle-Signature header for a body, for tests and local
 * replays. Never use this in request handling.
 */
export function signForTests(rawBody: string, secretKey: string, tsSeconds = Math.floor(Date.now() / 1000)): string {
  const h1 = createHmac("sha256", secretKey).update(`${tsSeconds}:${rawBody}`).digest("hex");
  return `ts=${tsSeconds};h1=${h1}`;
}
