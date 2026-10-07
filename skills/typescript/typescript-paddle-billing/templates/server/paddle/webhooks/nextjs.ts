/**
 * Next.js (App Router) route handler for the Paddle webhook.
 * File: app/api/paddle/webhook/route.ts
 *
 * Read the body with `req.text()` so the raw bytes reach the verifier.
 * Do not use `req.json()` here. This route must run on the Node.js runtime
 * (node:crypto), so do not mark it `export const runtime = "edge"`.
 *
 * Serverless functions may be frozen right after the response is sent, so this processes
 * before answering (keep hooks under Paddle's 5-second window). A failure answers 500 so Paddle
 * retries; run the reprocess job (scripts/paddle/paddle-jobs.ts reprocess) on a schedule for what is
 * still unprocessed when Paddle stops.
 */
import type { PaddleWebhookHandler } from "./handler.js";

export function createPaddleWebhookRoute(getHandler: () => PaddleWebhookHandler) {
  return async function POST(req: Request): Promise<Response> {
    const rawBody = await req.text();
    const signature = req.headers.get("paddle-signature");
    const handler = getHandler();
    let result: Awaited<ReturnType<PaddleWebhookHandler["receive"]>>;
    try {
      result = await handler.receive(rawBody, signature);
    } catch {
      // The store could not record the event: a 500 makes Paddle retry.
      return Response.json({ error: "could not record the event" }, { status: 500 });
    }
    if (result.status !== 200) {
      return Response.json({ error: result.error }, { status: result.status });
    }
    if (!result.duplicate && !result.parked) {
      try {
        await handler.process(result.payload);
      } catch {
        // handler.process recorded the error; a 500 makes Paddle retry this event.
        return Response.json({ error: "processing failed" }, { status: 500 });
      }
    }
    return Response.json({ received: true, duplicate: result.duplicate }, { status: 200 });
  };
}
