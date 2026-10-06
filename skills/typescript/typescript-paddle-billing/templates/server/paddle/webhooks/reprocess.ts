/**
 * Re-runs webhook events that were recorded but not processed: processing threw (database down,
 * a bug in a hook), the server stopped between recording and processing, or Paddle stopped
 * retrying (sandbox gives up after 3 attempts in 15 minutes, live after 60 over 3 days).
 *
 * Run it on a schedule in the server process or as a cron job, at least every 5 minutes:
 *
 *   const stop = startReprocessLoop(handler, store, { intervalMs: 5 * 60_000 });   // in-process
 *   // or: npx tsx scripts/paddle/paddle-jobs.ts reprocess                       // cron
 *
 * Events are applied oldest first, so a subscription's history replays in order (the handler
 * also ignores anything older than the stored row). An event that keeps failing is parked as
 * "gave_up" after `maxAttempts` and reported through onEventNeedsAttention. Several instances may
 * run the job at once: the handler's writes are idempotent.
 */
import type { PaddleStore } from "../store.js";
import type { PaddleWebhookHandler } from "./handler.js";

export interface ReprocessOptions {
  /** Attempts (failed processing runs) before an event is parked as "gave_up". Default 10. */
  maxAttempts?: number;
  /** Events per run. Default 100. */
  limit?: number;
}

export interface ReprocessReport {
  applied: number;
  ignored: number;
  undecodable: number;
  failed: number;
  gaveUp: number;
}

export async function reprocessPendingEvents(handler: PaddleWebhookHandler, store: PaddleStore, options: ReprocessOptions = {}): Promise<ReprocessReport> {
  const maxAttempts = options.maxAttempts ?? 10;
  const report: ReprocessReport = { applied: 0, ignored: 0, undecodable: 0, failed: 0, gaveUp: 0 };
  const pending = await store.listPendingEvents({ maxAttempts, limit: options.limit ?? 100 });
  for (const event of pending) {
    try {
      const result = await handler.process(event.payload);
      report[result] += 1;
    } catch (err) {
      report.failed += 1;
      // process() already counted this attempt; park the event once the attempts are used up.
      if (event.attempts + 1 >= maxAttempts) {
        await handler.park(event.eventId, event.eventType, "gave_up", err);
        report.gaveUp += 1;
      }
    }
  }
  return report;
}

/** Runs reprocessPendingEvents every `intervalMs` (default 5 minutes) until the returned function is called. */
export function startReprocessLoop(
  handler: PaddleWebhookHandler,
  store: PaddleStore,
  options: ReprocessOptions & { intervalMs?: number; onReport?: (report: ReprocessReport) => void; onError?: (err: unknown) => void } = {},
): () => void {
  let running = false;
  const tick = async () => {
    if (running) return; // a slow run is still going
    running = true;
    try {
      const report = await reprocessPendingEvents(handler, store, options);
      options.onReport?.(report);
    } catch (err) {
      options.onError?.(err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), options.intervalMs ?? 5 * 60_000);
  timer.unref?.();
  void tick();
  return () => clearInterval(timer);
}
