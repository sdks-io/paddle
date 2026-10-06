/**
 * Agent tool: one-time Paddle setup for this deployment. Run from the project root once the
 * user has stored PADDLE_API_KEY (and PADDLE_ENV is set):
 *
 *   npx tsx --env-file=.env scripts/paddle/paddle-setup.ts client-token [--name "<app> web"] [--public-var VITE_PADDLE_CLIENT_TOKEN]
 *   npx tsx --env-file=.env scripts/paddle/paddle-setup.ts webhook https://<host>/api/paddle/webhook [--name "<app>"]
 *
 * client-token  Reuses the active client-side token with this name, or creates one. Writes it to
 *               the env file as PADDLE_CLIENT_TOKEN (and --public-var, the name the frontend reads).
 *               The token is public by design; the script prints it.
 * webhook       Reuses the notification destination for this URL (Paddle allows one per URL),
 *               or creates it, with the event list from references/webhooks.md and traffic_source
 *               "all". Writes its secret to the env file as PADDLE_WEBHOOK_SECRET.
 *               THE SECRET IS NEVER PRINTED OR LOGGED.
 *
 * Options: --env-file <path> (default .env). The env file is created with owner-only permissions
 * and added to .gitignore. Platforms that read secrets only from their own secret store: see
 * references/adapters.md for moving the value there.
 * Exits non-zero and prints Paddle's code and request_id on failure.
 */
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type { EventTypeName } from "paddle-apimatic-sdk";
import { getPaddleClient, getPaddleConfig } from "../../server/paddle/client.js";
import { paddleError, writeOutcome } from "../../server/paddle/errors.js";

/** The events the webhook handler uses (references/webhooks.md). */
const EVENTS: EventTypeName[] = [
  "subscription.created",
  "subscription.updated",
  "subscription.activated",
  "subscription.trialing",
  "subscription.past_due",
  "subscription.paused",
  "subscription.resumed",
  "subscription.canceled",
  "transaction.completed",
  "transaction.payment_failed",
  "adjustment.created",
  "adjustment.updated",
];

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Sets NAME=value in the env file (replacing an existing line), owner-only permissions, git-ignored. */
function writeEnv(file: string, name: string, value: string): void {
  const lines = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/) : [];
  const kept = lines.filter((l) => !l.startsWith(`${name}=`) && l !== "");
  kept.push(`${name}=${value}`);
  writeFileSync(file, kept.join("\n") + "\n", { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // not supported on this file system
  }
  const ignore = existsSync(".gitignore") ? readFileSync(".gitignore", "utf8").split(/\r?\n/) : [];
  if (!ignore.includes(file) && !ignore.includes(`/${file}`)) appendFileSync(".gitignore", `${ignore.length && ignore.at(-1) !== "" ? "\n" : ""}${file}\n`);
}

async function clientToken(args: string[], envFile: string): Promise<void> {
  const client = getPaddleClient();
  const name = option(args, "--name") ?? "web checkout";
  const list = await client.clientTokens.listClientTokens({ status: ["active"], perPage: 200 });
  let token = list.data.find((t) => t.name === name);
  if (!token) {
    token = (await client.clientTokens.createClientToken({ body: { name, description: "Paddle.js in the app's frontend" } })).data;
    console.error(`+ client-side token ${token.id} (${name})`);
  } else {
    console.error(`= client-side token ${token.id} (${name}, reused)`);
  }
  writeEnv(envFile, "PADDLE_CLIENT_TOKEN", token.token);
  const publicVar = option(args, "--public-var");
  if (publicVar) writeEnv(envFile, publicVar, token.token);
  console.log(JSON.stringify({ clientTokenId: token.id, token: token.token, writtenTo: envFile }, null, 2));
}

async function webhook(args: string[], envFile: string): Promise<void> {
  const url = args[1];
  if (!url || !url.startsWith("https://")) throw new Error("webhook <https://host/api/paddle/webhook>: the URL must be public HTTPS");
  const client = getPaddleClient();
  const description = `${option(args, "--name") ?? "app"} webhooks`;
  const findExisting = async () => {
    const all = await client.notificationSettings.listNotificationSettings({ perPage: 200 });
    return all.data.find((d) => d.destination === url);
  };

  let destination = await findExisting();
  if (destination) {
    destination = (
      await client.notificationSettings.updateNotificationSetting({
        notificationSettingId: destination.id,
        body: { active: true, subscribedEvents: EVENTS, trafficSource: "all" },
      })
    ).data;
    console.error(`= destination ${destination.id} (updated events)`);
  } else {
    try {
      destination = (
        await client.notificationSettings.createNotificationSetting({
          body: { description, type: "url", destination: url, subscribedEvents: EVENTS, trafficSource: "all" },
        })
      ).data;
      console.error(`+ destination ${destination.id}`);
    } catch (err) {
      // Paddle allows one destination per URL: a duplicate, or a create whose answer was lost, is found by listing again.
      const duplicate = paddleError(err)?.code === "notification_setting_cannot_be_duplicate";
      if (!duplicate && writeOutcome(err) !== "unknown") throw err;
      destination = await findExisting();
      if (!destination) throw err;
      console.error(`= destination ${destination.id} (found after ${duplicate ? "duplicate" : "unknown outcome"})`);
    }
  }
  writeEnv(envFile, "PADDLE_WEBHOOK_SECRET", destination.endpointSecretKey);
  // The secret is written, never printed.
  console.log(JSON.stringify({ notificationSettingId: destination.id, destination: destination.destination, events: EVENTS.length, secretWrittenTo: envFile }, null, 2));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const envFile = option(args, "--env-file") ?? ".env";
  const config = getPaddleConfig();
  console.error(`Paddle ${config.environment} (${config.apiBaseUrl})`);
  switch (args[0]) {
    case "client-token":
      return clientToken(args, envFile);
    case "webhook":
      return webhook(args, envFile);
    default:
      throw new Error("commands: client-token [--name <name>] [--public-var <NAME>] | webhook <https url> [--name <app>]  (both take --env-file <path>)");
  }
}

main().catch((err) => {
  const info = paddleError(err);
  if (info) {
    console.error(`Paddle error ${info.status} ${info.code ?? ""}: ${info.detail ?? ""} (request_id ${info.requestId ?? "n/a"})`);
    for (const fe of info.fieldErrors) console.error(`  - ${fe.field}: ${fe.message}`);
  } else {
    console.error(err instanceof Error ? err.message : String(err));
  }
  process.exit(1);
});
