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
 */
import type { Request, Response } from "express";
import type { PaddleWebhookHandler } from "./handler.js";

export function paddleWebhookRoute(handler: PaddleWebhookHandler, options: { processInline?: boolean } = {}) {
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

    if (options.processInline) {
      // Simplest deployment: process before answering. Keep handlers fast (< 5 s) or switch to async.
      if (!result.duplicate) {
        try {
          await handler.process(result.payload);
        } catch {
          // handler.process already recorded the error; a 500 makes Paddle retry this event.
          res.status(500).json({ error: "processing failed" });
          return;
        }
      }
      res.status(200).json({ received: true });
      return;
    }

    // Default: answer first, process after. Replace setImmediate with your job queue in production
    // so a crash between the two does not lose the event (rows in paddle_webhook_events with
    // processed_at IS NULL are left for a scheduled job to process).
    res.status(200).json({ received: true, duplicate: result.duplicate });
    if (!result.duplicate) {
      const payload = result.payload;
      setImmediate(() => {
        handler.process(payload).catch(() => {
          /* already logged and recorded by handler.process */
        });
      });
    }
  };
}
