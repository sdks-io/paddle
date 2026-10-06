/**
 * Subscription changes, server side. Every function here changes money or
 * access, so each is called from an authenticated route that has checked the
 * subscription belongs to the signed-in user (compare paddle_subscriptions.user_id).
 *
 * The mirror in the database is NOT written here. Paddle sends
 * subscription.updated after each change and the webhook handler updates the
 * row; the UI should re-read the entitlement after the webhook has been processed
 * (poll or push), not assume the change from the API response.
 *
 * Paddle rules that apply (see recipes for the full list):
 * - Changing items or next_billed_at requires proration_billing_mode.
 * - items is the COMPLETE desired list; anything omitted is removed.
 * - No changes within 30 minutes of the next billing, none while past_due.
 * - Paused subscriptions accept only do_not_bill.
 * - Cancel defaults to the end of the period (scheduled_change); immediate cancel does not refund.
 * - Canceled subscriptions cannot be reinstated; the customer buys again.
 * - Paddle cannot schedule an item change; a plan change at the end of the term is kept by the
 *   app and applied shortly before the renewal (requestPlanChangeAtRenewal / applyDuePlanChanges).
 *
 * Updates that set a state are safe to repeat, so they take no claim. When their outcome is
 * unknown (connection lost, timeout, 5xx), the subscription is re-read: if it already shows the
 * requested state the update counts as done, otherwise OutcomeUnknownError (never "failed").
 */
import type {
  PriceWithProductCollectionIncludes,
  ProrationBillingMode,
  SubscriptionChargeItems,
  SubscriptionStatus,
  SubscriptionUpdateItems,
} from "paddle-apimatic-sdk";
import { getPaddleClient } from "./client.js";
import { OutcomeUnknownError, writeOutcome } from "./errors.js";
import type { PaddleStore, PendingPlanChange } from "./store.js";
import { claimedWrite, LOOKUP_MARGIN_MS } from "./writes.js";

type Subscription = Awaited<ReturnType<typeof readSubscription>>;

async function readSubscription(subscriptionId: string) {
  return (await getPaddleClient().subscriptions.getSubscription({ subscriptionId })).data;
}

/** Runs a state-setting update; on an unknown outcome, re-reads and accepts the update when `done(sub)` holds. */
async function settledUpdate<T>(operation: string, subscriptionId: string, update: () => Promise<T>, done: (sub: Subscription) => boolean): Promise<T | Subscription> {
  try {
    return await update();
  } catch (err) {
    if (writeOutcome(err) !== "unknown") throw err;
    let sub: Subscription;
    try {
      sub = await readSubscription(subscriptionId);
    } catch {
      throw new OutcomeUnknownError(operation, subscriptionId, { cause: err });
    }
    if (done(sub)) return sub;
    throw new OutcomeUnknownError(operation, subscriptionId, { cause: err });
  }
}

const sameItems = (sub: Subscription, items: { priceId: string; quantity?: number }[]) => {
  const active = sub.items.filter((i) => i.status !== "inactive");
  return (
    active.length === items.length &&
    items.every((want) => active.some((have) => have.price.id === want.priceId && (want.quantity === undefined || have.quantity === want.quantity)))
  );
};

/** Current subscription from Paddle, with the next transaction (upcoming renewal) and recurring totals. */
export async function getSubscriptionWithNext(subscriptionId: string) {
  const res = await getPaddleClient().subscriptions.getSubscription({
    subscriptionId,
    include: ["next_transaction", "recurring_transaction_details"],
  });
  return res.data;
}

/** The subscription's active items as the complete list an update needs (base plan and add-ons). */
export async function currentItems(subscriptionId: string): Promise<{ priceId: string; quantity: number }[]> {
  const sub = await readSubscription(subscriptionId);
  return sub.items.filter((i) => i.status !== "inactive").map((i) => ({ priceId: i.price.id, quantity: i.quantity }));
}

/**
 * Plan change (upgrade/downgrade) or seat change. Previews first so the UI can
 * show the immediate charge or credit, then applies.
 *
 * mode:
 *  - "prorated_immediately": charge/credit the difference now (typical upgrade).
 *  - "prorated_next_billing_period": apply now, settle the difference on the next invoice (typical downgrade).
 *  - "full_immediately" / "full_next_billing_period": no proration, full new price.
 *  - "do_not_bill": change items without charging (required while trialing or paused).
 * Credits that exceed the charge are added to the customer's credit balance and are used on future invoices.
 * For a change the customer asked for, take `mode` from chooseProrationMode, never from the request.
 * If an immediate charge fails, Paddle's default leaves the subscription as it was; pass
 * applyEvenIfPaymentFails only when the user asked for the change to stand regardless.
 */
export async function changePlan(
  subscriptionId: string,
  items: { priceId: string; quantity?: number }[],
  mode: ProrationBillingMode,
  options: { preview?: boolean; applyEvenIfPaymentFails?: boolean } = {},
) {
  const client = getPaddleClient();
  const body = {
    items: items.map((i): SubscriptionUpdateItems => (i.quantity === undefined ? { priceId: i.priceId } : { priceId: i.priceId, quantity: i.quantity })),
    prorationBillingMode: mode,
    ...(options.applyEvenIfPaymentFails ? { onPaymentFailure: "apply_change" as const } : {}),
  };

  if (options.preview) {
    const preview = await client.subscriptions.previewSubscriptionUpdate({ subscriptionId, body });
    return { preview: preview.data };
  }
  const subscription = await settledUpdate(
    "updateSubscription (items)",
    subscriptionId,
    async () => (await client.subscriptions.updateSubscription({ subscriptionId, body })).data,
    (sub) => sameItems(sub, items),
  );
  return { subscription };
}

/**
 * Proration mode for a plan or seat change the customer asked for, decided on the server
 * (recipe 04, "Choosing mode"). Never accept the mode from the browser: "do_not_bill" would make
 * an upgrade free. A free change as goodwill is the owner's decision; call changePlan directly for it.
 */
export async function chooseProrationMode(
  current: { status: SubscriptionStatus; priceId: string; quantity: number },
  target: { priceId: string; quantity: number },
): Promise<ProrationBillingMode> {
  // The only mode Paddle allows while trialing or paused.
  if (current.status === "trialing" || current.status === "paused") return "do_not_bill";
  const client = getPaddleClient();
  const [from, to] = await Promise.all([
    client.prices.getPrice({ priceId: current.priceId }),
    client.prices.getPrice({ priceId: target.priceId }),
  ]);
  // A change of billing frequency allows only prorated_immediately, full_immediately or do_not_bill.
  if (cycleOf(from.data) !== cycleOf(to.data)) return "prorated_immediately";
  if (from.data.unitPrice.currencyCode !== to.data.unitPrice.currencyCode) return "prorated_immediately";
  const total = (p: PriceWithProductCollectionIncludes, quantity: number) => BigInt(p.unitPrice.amount) * BigInt(quantity);
  // Upgrade: charge the difference now. Downgrade: switch now, credit the difference on the next invoice.
  return total(to.data, target.quantity) >= total(from.data, current.quantity) ? "prorated_immediately" : "prorated_next_billing_period";
}

const cycleOf = (p: { billingCycle?: { interval: string; frequency: number } | null }) =>
  p.billingCycle ? `${p.billingCycle.interval}:${p.billingCycle.frequency}` : "none";

/** Seats: same price, new quantity. The price's quantity.minimum/maximum bound what Paddle accepts. */
export async function setSeats(subscriptionId: string, priceId: string, seats: number, mode: ProrationBillingMode = "prorated_immediately") {
  return changePlan(subscriptionId, [{ priceId, quantity: seats }], mode);
}

// ------------------------------------------------------------- plan change at the end of the term

/** The job applies a pending change inside this window before the renewal (Paddle locks changes in the last 30 minutes). */
export const PLAN_CHANGE_WINDOW = { startBeforeRenewalMs: 2 * 60 * 60_000, endBeforeRenewalMs: 35 * 60_000 };

/** Thrown when a change cannot be scheduled for the end of the term (no renewal date, too close to it, or another change is scheduled). */
export class PlanChangeNotSchedulableError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = "PlanChangeNotSchedulableError";
  }
}

/**
 * Records a plan change that takes effect at the end of the current term (for example yearly →
 * monthly, or a downgrade the customer has already paid the higher tier for). Nothing changes in
 * Paddle now; applyDuePlanChanges applies it shortly before the renewal. One open change per
 * subscription: a new request replaces the open one. `items` is the complete list after the change.
 */
export async function requestPlanChangeAtRenewal(
  store: PaddleStore,
  input: { subscriptionId: string; userId: string; items: { priceId: string; quantity: number }[] },
): Promise<PendingPlanChange> {
  const sub = await readSubscription(input.subscriptionId);
  if (sub.status !== "active") throw new PlanChangeNotSchedulableError(`subscription is ${sub.status}; only active subscriptions renew`);
  if (sub.scheduledChange) throw new PlanChangeNotSchedulableError(`a ${sub.scheduledChange.action} is scheduled; remove it first`);
  if (!sub.nextBilledAt) throw new PlanChangeNotSchedulableError("subscription has no next renewal");
  const renewalAt = sub.nextBilledAt;
  if (renewalAt.getTime() - Date.now() < PLAN_CHANGE_WINDOW.endBeforeRenewalMs) {
    throw new PlanChangeNotSchedulableError("too close to the renewal; try again after it");
  }
  const change: PendingPlanChange = {
    subscriptionId: input.subscriptionId,
    userId: input.userId,
    items: input.items,
    renewalAt,
    applyAfter: new Date(renewalAt.getTime() - PLAN_CHANGE_WINDOW.startBeforeRenewalMs),
    requestedAt: new Date(),
    appliedAt: null,
    canceledAt: null,
    note: null,
  };
  await store.savePendingPlanChange(change);
  return change;
}

/** Customer changed their mind before the renewal. */
export async function cancelPlanChangeAtRenewal(store: PaddleStore, subscriptionId: string): Promise<void> {
  await store.finishPendingPlanChange(subscriptionId, "canceled", new Date(), "canceled by the customer");
}

/**
 * Applies pending end-of-term changes whose window has opened. Run it from a scheduler at least
 * every 15 minutes (the window is 2 hours wide and closes 35 minutes before the renewal).
 * - Same billing cycle: items change with do_not_bill; the renewal then bills the new price.
 * - Different billing cycle (yearly ↔ monthly): Paddle allows only immediate modes, so the change
 *   is applied with full_immediately: the new price is charged now and a new term starts now,
 *   at most two hours before the old term would have ended. Nothing is credited for those minutes.
 * A subscription that is no longer active, has a scheduled cancel or pause, or whose renewal moved
 * is skipped (canceled, or re-planned against the new renewal date).
 */
export async function applyDuePlanChanges(store: PaddleStore, now: Date = new Date()): Promise<{ applied: string[]; skipped: { subscriptionId: string; reason: string }[] }> {
  const result = { applied: [] as string[], skipped: [] as { subscriptionId: string; reason: string }[] };
  for (const change of await store.listDuePendingPlanChanges(now)) {
    const skip = async (reason: string, cancel: boolean) => {
      result.skipped.push({ subscriptionId: change.subscriptionId, reason });
      if (cancel) await store.finishPendingPlanChange(change.subscriptionId, "canceled", now, reason);
    };
    try {
      const sub = await readSubscription(change.subscriptionId);
      if (sameItems(sub, change.items)) {
        // Already in effect (an earlier run whose answer was lost, or the same change made another way).
        await store.finishPendingPlanChange(change.subscriptionId, "applied", now, "already in effect");
        result.applied.push(change.subscriptionId);
        continue;
      }
      if (sub.status !== "active") {
        await skip(`subscription is ${sub.status}`, true);
        continue;
      }
      if (sub.scheduledChange) {
        await skip(`a ${sub.scheduledChange.action} is scheduled`, true);
        continue;
      }
      if (!sub.nextBilledAt || sub.nextBilledAt.getTime() !== change.renewalAt.getTime()) {
        // The renewal date moved (trial extended, date changed, or the renewal already happened): plan against the new one.
        if (sub.nextBilledAt) {
          await store.replanPendingPlanChange(change.subscriptionId, sub.nextBilledAt, new Date(sub.nextBilledAt.getTime() - PLAN_CHANGE_WINDOW.startBeforeRenewalMs));
        }
        await skip("renewal date moved; re-planned", !sub.nextBilledAt);
        continue;
      }
      if (sub.nextBilledAt.getTime() - now.getTime() < PLAN_CHANGE_WINDOW.endBeforeRenewalMs) {
        await skip("window missed; Paddle locks changes 30 minutes before renewal", false);
        continue;
      }
      const target = change.items[0];
      const currentPrice = sub.items.find((i) => i.status !== "inactive")?.price;
      if (!target || !currentPrice) {
        await skip("no items to compare", true);
        continue;
      }
      const targetPrice = (await getPaddleClient().prices.getPrice({ priceId: target.priceId })).data;
      const mode: ProrationBillingMode = cycleOf(currentPrice) === cycleOf(targetPrice) ? "do_not_bill" : "full_immediately";
      // Still wanted? The customer may have canceled it, or made a change now (the route cancels this one first).
      if (!(await store.getPendingPlanChange(change.subscriptionId))) {
        result.skipped.push({ subscriptionId: change.subscriptionId, reason: "canceled meanwhile" });
        continue;
      }
      await changePlan(change.subscriptionId, change.items, mode);
      // Closed only once Paddle confirmed; if the answer is lost, the next run finds the items in effect and closes it.
      await store.finishPendingPlanChange(change.subscriptionId, "applied", new Date(), `applied with ${mode}`);
      result.applied.push(change.subscriptionId);
    } catch (err) {
      // Left open: the next run tries again while the window lasts. Log it.
      result.skipped.push({ subscriptionId: change.subscriptionId, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

// ------------------------------------------------------------- cancel, pause, resume, trial

/**
 * Cancel. Default: at the end of the current period — status stays active,
 * scheduled_change = { action: "cancel", effective_at }, next_billed_at becomes null.
 * immediately: status canceled now, no automatic refund (use adjustments.ts).
 */
export async function cancelSubscription(subscriptionId: string, when: "next_billing_period" | "immediately" = "next_billing_period") {
  return settledUpdate(
    "cancelSubscription",
    subscriptionId,
    async () => (await getPaddleClient().subscriptions.cancelSubscription({ subscriptionId, body: { effectiveFrom: when } })).data,
    (sub) => (when === "immediately" ? sub.status === "canceled" : sub.scheduledChange?.action === "cancel"),
  );
}

/** Undo a scheduled cancel or pause before it takes effect. */
export async function removeScheduledChange(subscriptionId: string) {
  return settledUpdate(
    "updateSubscription (scheduled_change: null)",
    subscriptionId,
    async () => (await getPaddleClient().subscriptions.updateSubscription({ subscriptionId, body: { scheduledChange: null } })).data,
    (sub) => !sub.scheduledChange,
  );
}

/**
 * Pause. Default effective at the next billing period (scheduled_change.action = "pause").
 * resumeAt schedules an automatic resume. onResume "start_new_billing_period" (Paddle's default) bills on resume;
 * "continue_existing_billing_period" resumes the paused period without a new charge.
 */
export async function pauseSubscription(
  subscriptionId: string,
  options: { when?: "next_billing_period" | "immediately"; resumeAt?: Date; onResume?: "start_new_billing_period" | "continue_existing_billing_period" } = {},
) {
  return settledUpdate(
    "pauseSubscription",
    subscriptionId,
    async () =>
      (
        await getPaddleClient().subscriptions.pauseSubscription({
          subscriptionId,
          body: {
            ...(options.when ? { effectiveFrom: options.when } : {}),
            ...(options.resumeAt ? { resumeAt: options.resumeAt } : {}),
            ...(options.onResume ? { onResume: options.onResume } : {}),
          },
        })
      ).data,
    (sub) => sub.status === "paused" || sub.scheduledChange?.action === "pause",
  );
}

/** Resume a paused subscription now, or at a date. Bills immediately when a new billing period starts. */
export async function resumeSubscription(subscriptionId: string, at: "immediately" | Date = "immediately") {
  return settledUpdate(
    "resumeSubscription",
    subscriptionId,
    async () =>
      (
        await getPaddleClient().subscriptions.resumeSubscription({
          subscriptionId,
          body: at === "immediately" ? { effectiveFrom: "immediately" } : { effectiveFrom: at },
        })
      ).data,
    (sub) => (at === "immediately" ? sub.status === "active" : sub.scheduledChange?.action === "resume"),
  );
}

/** Convert a trialing subscription to active now (charges the stored payment method). Automatic collection only. */
export async function activateTrialNow(subscriptionId: string) {
  return settledUpdate(
    "activateSubscription",
    subscriptionId,
    async () => (await getPaddleClient().subscriptions.activateSubscription({ subscriptionId })).data,
    (sub) => sub.status === "active",
  );
}

/** Extend a trial or move the renewal date. Must be at least 30 minutes in the future; while trialing, items/dates use do_not_bill. */
export async function setNextBilledAt(subscriptionId: string, nextBilledAt: Date) {
  return settledUpdate(
    "updateSubscription (next_billed_at)",
    subscriptionId,
    async () => (await getPaddleClient().subscriptions.updateSubscription({ subscriptionId, body: { nextBilledAt, prorationBillingMode: "do_not_bill" } })).data,
    (sub) => sub.nextBilledAt?.getTime() === nextBilledAt.getTime(),
  );
}

// ------------------------------------------------------------- one-off charges

export type ChargeItem =
  | { priceId: string; quantity: number }
  | { description: string; productId: string; amount: string; currencyCode: string; quantity: number };

/**
 * One-off charge on a subscription (usage, overage, add-on purchase).
 * Items must be ONE-TIME prices (billing_cycle null) — catalog or inline.
 * when "immediately": a transaction is created and charged now (limit: 20/hour, 100/day per subscription).
 * when "next_billing_period": the charge is added to the next renewal invoice.
 * Charges do not appear in subscription.items; find them on the transaction (origin subscription_charge).
 *
 * `ref` names what is being charged, the same for every attempt at the same charge: a usage period
 * ("usage:2026-10") or an order id. A second call with the same ref does not charge again.
 */
export async function chargeOneOff(
  store: PaddleStore,
  subscriptionId: string,
  items: ChargeItem[],
  when: "immediately" | "next_billing_period",
  options: { ref: string; preview?: boolean },
) {
  const client = getPaddleClient();
  const body = {
    effectiveFrom: when,
    items: items.map((i): SubscriptionChargeItems =>
      "priceId" in i
        ? { priceId: i.priceId, quantity: i.quantity }
        : {
            quantity: i.quantity,
            price: {
              description: i.description,
              productId: i.productId,
              // amount in minor units as a string, e.g. "1250" = $12.50
              unitPrice: { amount: i.amount, currencyCode: i.currencyCode as SubscriptionChargeInlineCurrency },
            },
          },
    ),
  };
  if (options.preview) {
    const preview = await client.subscriptions.previewSubscriptionCharge({ subscriptionId, body });
    return { preview: preview.data };
  }

  // Lines that show this charge was made, on the charge's own transaction or on the next renewal.
  // A catalog item matches by price; an inline item by product (and description where the line carries one).
  type Line = { priceId: string | null; productId: string | null; description?: string };
  const isChargeLine = (l: Line) =>
    items.some((i) => ("priceId" in i ? l.priceId === i.priceId : l.productId === i.productId && (l.description === undefined || l.description === i.description)));
  const matches = (lines: Line[]) => items.every((i) => lines.some((l) => isChargeLine(l) && ("priceId" in i ? l.priceId === i.priceId : l.productId === i.productId)));
  const nextLines = async (): Promise<Line[]> => {
    const next = (await client.subscriptions.getSubscription({ subscriptionId, include: ["next_transaction"] })).data.nextTransaction;
    return next ? next.details.lineItems.map((l) => ({ priceId: l.priceId ?? null, productId: l.product.id ?? null })) : [];
  };
  const chargeTransactions = async () =>
    (await client.transactions.listTransactions({ subscriptionId: [subscriptionId], origin: ["subscription_charge"], orderBy: "created_at[DESC]", perPage: 30 })).data;
  // Earlier charges for the same items may exist (on the renewal invoice, or as earlier charge transactions):
  // the write notes what exists first, and the lookup accepts only something new. Without that note (a stale
  // claim from another process) the outcome stays unknown for a person to settle (paddle-jobs.ts claims).
  let linesBefore: number | undefined;
  let chargesBefore: Set<string> | undefined;

  const claimKey = `charge:${subscriptionId}:${options.ref}`;
  const newCharges = async (since: Date) => {
    const before = chargesBefore ?? new Set<string>();
    return (await chargeTransactions()).filter(
      (t) => !before.has(t.id) && t.createdAt >= since && matches(t.items.map((i) => ({ priceId: i.price.id, productId: i.price.productId, description: i.price.description }))),
    );
  };
  // The claim records an id unique to this charge: its transaction (immediate), or the claim key itself
  // (next period, where the charge is only a line on the coming invoice). Never the subscription id,
  // which every charge on the subscription shares.
  const { reused } = await claimedWrite(store, {
    claimKey,
    kind: "charge",
    userId: null,
    operation: "createSubscriptionCharge",
    reuse: async () => subscriptionId,
    absenceIsProof: false,
    find: async (since) => {
      if (when === "immediately") {
        if (chargesBefore === undefined) return undefined; // nothing to compare with: cannot tell
        // Settle only when exactly one new matching charge exists; two mean another ref charged the same items meanwhile.
        const fresh = await newCharges(since);
        return fresh.length === 1 && fresh[0] ? { id: fresh[0].id, value: subscriptionId } : undefined;
      }
      if (linesBefore === undefined) return undefined; // nothing to compare with: cannot tell
      const after = (await nextLines()).filter(isChargeLine).length;
      return after - linesBefore === items.length ? { id: claimKey, value: subscriptionId } : undefined;
    },
    write: async () => {
      if (when === "next_billing_period") linesBefore = (await nextLines()).filter(isChargeLine).length;
      else chargesBefore = new Set((await chargeTransactions()).map((t) => t.id));
      const res = await client.subscriptions.createSubscriptionCharge({ subscriptionId, body });
      if (when === "next_billing_period") return { id: claimKey, value: subscriptionId };
      // The response is the subscription; record the charge's own transaction when it can be told apart.
      const fresh = await newCharges(new Date(Date.now() - LOOKUP_MARGIN_MS)).catch(() => []);
      return { id: fresh.length === 1 && fresh[0] ? fresh[0].id : claimKey, value: res.data.id };
    },
  });
  return { charged: true as const, subscriptionId, reused };
}
type SubscriptionChargeInlineCurrency = Extract<SubscriptionChargeItems, { price: unknown }>["price"]["unitPrice"]["currencyCode"];

// ------------------------------------------------------------- payment method

/**
 * Let the customer update their payment method inside your app: Paddle returns a
 * transaction (zero-value for active subscriptions; the failed one for past_due).
 * Open it with openPaymentMethodCheckout (paddle-browser.ts), which uses the one-page
 * checkout that cardless trials require. checkout.url (pay.html) works for other subscriptions;
 * pay.html opens the default checkout variant, which Paddle refuses for cardless trials.
 * Alternative without code: the customer portal's update-payment-method link.
 */
export async function getUpdatePaymentMethodTransaction(subscriptionId: string) {
  const res = await getPaddleClient().subscriptions.getSubscriptionUpdatePaymentMethodTransaction({ subscriptionId });
  return { transactionId: res.data.id, checkoutUrl: res.data.checkout?.url ?? null };
}
