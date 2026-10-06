/**
 * Agent tool: look things up in Paddle without writing code into the app.
 *
 *   npx tsx scripts/paddle/paddle-inspect.ts whoami
 *   npx tsx scripts/paddle/paddle-inspect.ts catalog
 *   npx tsx scripts/paddle/paddle-inspect.ts customer <email | ctm_...>
 *   npx tsx scripts/paddle/paddle-inspect.ts subscription <sub_...>
 *   npx tsx scripts/paddle/paddle-inspect.ts transaction <txn_...>
 *   npx tsx scripts/paddle/paddle-inspect.ts webhooks            # destinations and the last notifications
 *   npx tsx scripts/paddle/paddle-inspect.ts simulate <ntfset_...> <event type | scenario>
 *
 * Read-only except `simulate`, which creates and runs a webhook simulation
 * against a destination (needs traffic_source simulation|all). Prints JSON.
 */
import type { EventTypeName, SimulationScenarioType } from "paddle-apimatic-sdk";
import { getPaddleClient, getPaddleConfig } from "../../server/paddle/client.js";
import { paddleError } from "../../server/paddle/errors.js";
import { listAll } from "../../server/paddle/pagination.js";

const SCENARIOS: readonly string[] = ["subscription_creation", "subscription_renewal", "subscription_pause", "subscription_resume", "subscription_cancellation"];

async function main(): Promise<void> {
  const [cmd, arg1, arg2] = process.argv.slice(2);
  const client = getPaddleClient();
  const config = getPaddleConfig();
  const out = (v: unknown) => console.log(JSON.stringify(v, null, 2));

  switch (cmd) {
    case "whoami": {
      // Cheapest authenticated call: confirms key, environment and reachability.
      const types = await client.eventTypes.listEventTypes();
      out({ environment: config.environment, apiBaseUrl: config.apiBaseUrl, eventTypes: types.data.length });
      return;
    }
    case "catalog": {
      const prices = await listAll((after) => client.prices.listPrices({ status: ["active"], include: ["product"], perPage: 200, ...(after ? { after } : {}) }));
      out(
        prices.map((p) => ({
          priceId: p.id,
          productId: p.productId,
          product: p.product?.name,
          description: p.description,
          amount: p.unitPrice.amount,
          currency: p.unitPrice.currencyCode,
          billingCycle: p.billingCycle ?? null,
          trial: p.trialPeriod ?? null,
          seedKey: (p.customData as Record<string, unknown> | null)?.["seed_key"] ?? null,
        })),
      );
      return;
    }
    case "customer": {
      if (!arg1) throw new Error("customer <email | ctm_...>");
      const customer = arg1.startsWith("ctm_")
        ? (await client.customers.getCustomer({ customerId: arg1 })).data
        : (await client.customers.listCustomers({ email: [arg1], perPage: 1 })).data[0];
      if (!customer) throw new Error(`no customer for ${arg1}`);
      const subs = await client.subscriptions.listSubscriptions({ customerId: [customer.id], perPage: 50 });
      const txns = await client.transactions.listTransactions({ customerId: [customer.id], perPage: 30, orderBy: "created_at[DESC]" });
      out({
        customer: { id: customer.id, email: customer.email, name: customer.name, status: customer.status },
        subscriptions: subs.data.map((s) => ({ id: s.id, status: s.status, nextBilledAt: s.nextBilledAt ?? null, scheduledChange: s.scheduledChange ?? null, items: s.items.map((i) => ({ priceId: i.price.id, quantity: i.quantity, status: i.status })) })),
        transactions: txns.data.map((t) => ({ id: t.id, status: t.status, origin: t.origin, total: t.details?.totals?.grandTotal, currency: t.currencyCode, subscriptionId: t.subscriptionId ?? null, createdAt: t.createdAt })),
      });
      return;
    }
    case "subscription": {
      if (!arg1) throw new Error("subscription <sub_...>");
      const sub = await client.subscriptions.getSubscription({ subscriptionId: arg1, include: ["next_transaction", "recurring_transaction_details"] });
      out(sub.data);
      return;
    }
    case "transaction": {
      if (!arg1) throw new Error("transaction <txn_...>");
      const tx = await client.transactions.getTransaction({ transactionId: arg1, include: ["customer", "address", "adjustments"] });
      out(tx.data);
      return;
    }
    case "webhooks": {
      const settings = await client.notificationSettings.listNotificationSettings({ perPage: 200 });
      const recent = await client.notifications.listNotifications({ perPage: 20 });
      out({
        destinations: settings.data.map((d) => ({ id: d.id, destination: d.destination, active: d.active, trafficSource: d.trafficSource, events: d.subscribedEvents.map((e) => e.name) })),
        recentNotifications: recent.data.map((n) => ({ id: n.id, type: n.type, status: n.status, occurredAt: n.occurredAt, timesAttempted: n.timesAttempted, lastAttemptAt: n.lastAttemptAt ?? null })),
      });
      return;
    }
    case "simulate": {
      if (!arg1 || !arg2) throw new Error("simulate <ntfset_...> <event type | scenario>");
      const body = SCENARIOS.includes(arg2)
        ? { notificationSettingId: arg1, name: `agent ${arg2}`, type: arg2 as SimulationScenarioType }
        : { notificationSettingId: arg1, name: `agent ${arg2}`, type: arg2 as EventTypeName };
      const sim = await client.simulations.createSimulation({ body });
      const run = await client.simulationRuns.createSimulationRun({ simulationId: sim.data.id });
      out({ simulationId: sim.data.id, runId: run.data.id, status: run.data.status });
      console.error("Check your webhook logs; inspect delivery in Paddle > Events > Simulations.");
      return;
    }
    default:
      throw new Error("commands: whoami | catalog | customer | subscription | transaction | webhooks | simulate");
  }
}

main().catch((err) => {
  const info = paddleError(err);
  if (info) console.error(`Paddle error ${info.status} ${info.code ?? ""}: ${info.detail ?? ""} (request_id ${info.requestId ?? "n/a"})`);
  else console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
