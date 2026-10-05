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
    const signature = req.header("paddle-signature");
    const result = await handler.receive(raw, signature);
    if (result.status !== 200) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    if (options.processInline) {
      // Simplest deployment: process before answering. Keep handlers fast (< 5 s) or switch to async.
      // A thrown error → 500 → Paddle retries later.
      if (!result.duplicate) await handler.process(result.envelope);
      res.status(200).json({ received: true });
      return;
    }

    // Default: answer first, process after. Replace setImmediate with your job queue in production
    // so a crash between the two does not lose the event (the row in paddle_webhook_events with
    // processed_at IS NULL lets a sweeper pick it up).
    res.status(200).json({ received: true, duplicate: result.duplicate });
    if (!result.duplicate) {
      setImmediate(() => {
        handler.process(result.envelope).catch(() => {
          /* already logged and recorded by handler.process */
        });
      });
    }
  };
}
