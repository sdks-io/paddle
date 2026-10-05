/**
 * Next.js (App Router) route handler for the Paddle webhook.
 * File: app/api/paddle/webhook/route.ts
 *
 * Read the body with `req.text()` so the raw bytes reach the verifier.
 * Do not use `req.json()` here. This route must run on the Node.js runtime
 * (node:crypto), so do not mark it `export const runtime = "edge"`.
 */
import type { PaddleWebhookHandler } from "./handler.js";

export function createPaddleWebhookRoute(getHandler: () => PaddleWebhookHandler) {
  return async function POST(req: Request): Promise<Response> {
    const rawBody = await req.text();
    const signature = req.headers.get("paddle-signature");
    const handler = getHandler();
    const result = await handler.receive(rawBody, signature);
    if (result.status !== 200) {
      return Response.json({ error: result.error }, { status: result.status });
    }
    // Serverless functions may be frozen right after the response is sent, so process
    // inline here (keep it under Paddle's 5-second window) or hand the event to a queue
    // (e.g. a durable job) before returning. Do not fire-and-forget in serverless.
    if (!result.duplicate) {
      try {
        await handler.process(result.envelope);
      } catch {
        // handler.process already recorded the error; a 500 makes Paddle retry this event.
        return Response.json({ error: "processing failed" }, { status: 500 });
      }
    }
    return Response.json({ received: true, duplicate: result.duplicate }, { status: 200 });
  };
}
