/**
 * Express adapter for the Paddle webhook route.
 *
 * ORDER MATTERS: this route must receive the RAW body. Register it BEFORE
 * `app.use(express.json())`, or give it its own `express.raw()` parser as below.
 * A body that has been parsed and re-serialised fails signature verification.
 *
 *   import express from "express";
 *   const app = express();
 *   app.post("/api/paddle/webhook", express.raw({ type: "application/json" }), paddleWebhookRoute(handler));
 *   app.use(express.json());           // everything else, after the webhook route
 *
 * Default: process the event, then answer. A failure answers 500, so Paddle retries; the
 * reprocess job (reprocess.ts) picks up whatever is still unprocessed when Paddle stops.
 * Keep hooks fast (Paddle waits 5 seconds). `processAfterResponse: true` answers first and
 * processes after; use it only with the reprocess job running, since a crash or a failure
 * after the answer is then recovered only by that job.
 */
import type { Request, Response } from "express";
import type { PaddleWebhookHandler } from "./handler.js";

export function paddleWebhookRoute(handler: PaddleWebhookHandler, options: { processAfterResponse?: boolean } = {}) {
  return async (req: Request, res: Response): Promise<void> => {
    const raw = req.body as unknown;
    if (!Buffer.isBuffer(raw)) {
      // express.raw() was not applied; refuse rather than verify a mangled body.
      res.status(500).json({ error: "webhook route must receive the raw body (use express.raw)" });
      return;
    }

    let result: Awaited<ReturnType<PaddleWebhookHandler["receive"]>>;
    try {
      result = await handler.receive(raw, req.header("paddle-signature"));
    } catch {
      // The store could not record the event: answer 500 so Paddle retries.
      res.status(500).json({ error: "could not record the event" });
      return;
    }
    if (result.status !== 200) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    if (result.duplicate || result.parked) {
      // Already processed, or recorded as undecodable for a person to look at: retrying would not help.
      res.status(200).json({ received: true, duplicate: result.duplicate });
      return;
    }

    if (options.processAfterResponse) {
      res.status(200).json({ received: true });
      const payload = result.payload;
      setImmediate(() => {
        handler.process(payload).catch(() => {
          /* recorded by handler.process; the reprocess job retries it */
        });
      });
      return;
    }

    try {
      await handler.process(result.payload); // "applied", "ignored" or "undecodable": all answered 200
    } catch {
      // handler.process recorded the error; a 500 makes Paddle retry this event.
      res.status(500).json({ error: "processing failed" });
      return;
    }
    res.status(200).json({ received: true });
  };
}
