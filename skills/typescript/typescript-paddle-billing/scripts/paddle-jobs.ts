/**
 * Agent and cron tool: the scheduled Paddle jobs, run once per call.
 *
 *   npx tsx --env-file=.env scripts/paddle/paddle-jobs.ts reprocess               # re-run unprocessed webhook events
 *   npx tsx --env-file=.env scripts/paddle/paddle-jobs.ts reopen undecodable      # after an SDK upgrade: reopen and re-run parked events
 *   npx tsx --env-file=.env scripts/paddle/paddle-jobs.ts reopen gave_up          # after fixing the cause of repeated failures
 *   npx tsx --env-file=.env scripts/paddle/paddle-jobs.ts plan-changes            # apply end-of-term plan changes now due (recipe 04)
 *
 * Schedule `reprocess` every 5 minutes and `plan-changes` every 15 minutes (cron, the platform's
 * scheduler, or startReprocessLoop in the server process). Reads DATABASE_URL and the Paddle env
 * vars. Uses the PostgreSQL store; if the project implements PaddleStore another way, build that
 * store here instead, and pass the app's real hooks to the handler so a re-run event sends the same
 * emails and grants the same credits as a live one.
 * Prints a JSON report; exits non-zero on failure.
 */
import pg from "pg";
import { getPaddleConfig } from "../../server/paddle/client.js";
import { paddleError } from "../../server/paddle/errors.js";
import { PgPaddleStore } from "../../server/paddle/store.pg.js";
import { applyDuePlanChanges } from "../../server/paddle/subscriptions.js";
import { PaddleWebhookHandler } from "../../server/paddle/webhooks/handler.js";
import { reprocessPendingEvents } from "../../server/paddle/webhooks/reprocess.js";

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const store = new PgPaddleStore(pool);
  const handler = new PaddleWebhookHandler(
    getPaddleConfig(),
    store,
    {
      // Replace with the app's hooks (webhook setup) so re-runs behave like live deliveries.
      async onEventNeedsAttention(info) {
        console.error(`ATTENTION ${info.state}: ${info.eventType} ${info.eventId}: ${info.error}`);
      },
    },
    (msg, extra) => console.error(msg, extra ?? ""),
  );
  try {
    switch (cmd) {
      case "reprocess":
        console.log(JSON.stringify(await reprocessPendingEvents(handler, store), null, 2));
        return;
      case "reopen": {
        if (arg !== "undecodable" && arg !== "gave_up") throw new Error("reopen undecodable | gave_up");
        const reopened = await store.reopenEvents(arg);
        console.log(JSON.stringify({ reopened, run: await reprocessPendingEvents(handler, store) }, null, 2));
        return;
      }
      case "plan-changes":
        console.log(JSON.stringify(await applyDuePlanChanges(store), null, 2));
        return;
      default:
        throw new Error("commands: reprocess | reopen undecodable|gave_up | plan-changes");
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  const info = paddleError(err);
  if (info) console.error(`Paddle error ${info.status} ${info.code ?? ""}: ${info.detail ?? ""} (request_id ${info.requestId ?? "n/a"})`);
  else console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
