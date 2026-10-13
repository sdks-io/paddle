# Agent-side tooling

Copy `scripts/` to `scripts/paddle/` in the project and run with `npx tsx --env-file=.env scripts/paddle/<name>.ts` (drop `--env-file` where the platform sets the env vars itself). They read the same env vars as the app, so credentials never pass through chat; the one secret a script produces (the webhook endpoint secret) is written to `.env`, never printed.

| Script | Use |
| --- | --- |
| `paddle-inspect.ts whoami` | confirm key, environment and reachability (lists event types) |
| `paddle-setup.ts client-token [--public-var <NAME>]` | reuse or create the client-side token; writes `PADDLE_CLIENT_TOKEN` to `.env` |
| `paddle-setup.ts webhook <https url>` | reuse or create the webhook destination for that URL; writes `PADDLE_WEBHOOK_SECRET` to `.env` without printing it |
| `paddle-jobs.ts reprocess \| reopen undecodable\|gave_up\|ignored \| plan-changes` | the scheduled jobs, once: re-run unprocessed webhook events; reopen parked ones (after an SDK upgrade or a fix) or ignored ones (after adding a price to `plan_catalog`); apply end-of-term plan changes now due |
| `paddle-jobs.ts claims \| settle-claim <key> <id> \| release-claim <key>` | writes whose outcome stayed unknown: list them, then, after checking Paddle (`paddle-inspect.ts`), record what exists or release the claim so a retry may write |
| `paddle-seed-catalog.ts <catalog.json>` | create or update products and prices idempotently (`custom_data.seed_key`); prints `{ products: { key: pro_… }, prices: { key: pri_… } }` |
| `paddle-inspect.ts catalog \| customer \| subscription \| transaction \| webhooks` | read-only lookups during setup and support |
| `paddle-inspect.ts simulate <ntfset_id> <event or scenario>` | send a simulated webhook to the destination |

Read the usage block at the top of a script before running it (arguments, side effects). All scripts exit non-zero and print Paddle's `code`, `detail` and `request_id` on failure; never treat a script that printed an error as having worked. For any Paddle call the scripts do not cover, look the operation up in the SDK map before calling it.
