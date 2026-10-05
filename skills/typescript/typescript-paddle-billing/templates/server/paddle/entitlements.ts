/**
 * Server-side access checks. The ONLY place that decides whether a user has
 * paid. Reads the webhook-maintained mirror (paddle_subscriptions,
 * paddle_purchases); never trusts anything the browser sends (success URL,
 * query params, checkout.completed in the page, a typed email).
 *
 * Access by subscription status (Paddle's provisioning guidance):
 *   trialing  → full access
 *   active    → full access (a scheduled cancel keeps access until it takes effect)
 *   past_due  → full access + "update your payment method" banner (Paddle is retrying)
 *   paused    → no paid access (or read-only, your choice)
 *   canceled  → no paid access
 */
import type { PaddleStore, SubscriptionRow } from "./store.js";

export const ACCESS_GRANTING_STATUSES: ReadonlySet<SubscriptionRow["status"]> = new Set(["active", "trialing", "past_due"]);

export interface Entitlement {
  hasAccess: boolean;
  /** tier_key from plan_catalog for the subscription's price, e.g. "pro"; null when no subscription. */
  tier: string | null;
  /** Features object from plan_catalog, merged over tiers if several subscriptions. */
  features: Record<string, unknown>;
  /** Seats or units bought (items[0].quantity). */
  quantity: number;
  /** True when Paddle is retrying a failed payment; show a payment-method banner. */
  paymentPastDue: boolean;
  /** Set when the customer scheduled a cancel or pause: access ends at this time. */
  endsAt: Date | null;
  subscription: SubscriptionRow | null;
}

export async function getEntitlement(store: PaddleStore, userId: string): Promise<Entitlement> {
  const subs = await store.listSubscriptionsForUser(userId);
  // Prefer the subscription that grants access; among several, the most recently updated.
  const granting = subs
    .filter((s) => ACCESS_GRANTING_STATUSES.has(s.status))
    .sort((a, b) => b.lastEventOccurredAt.getTime() - a.lastEventOccurredAt.getTime());
  const sub = granting[0] ?? subs.sort((a, b) => b.lastEventOccurredAt.getTime() - a.lastEventOccurredAt.getTime())[0] ?? null;

  if (!sub || !ACCESS_GRANTING_STATUSES.has(sub.status)) {
    return { hasAccess: false, tier: null, features: {}, quantity: 0, paymentPastDue: false, endsAt: null, subscription: sub };
  }

  let tier: string | null = null;
  let features: Record<string, unknown> = {};
  for (const priceId of sub.priceIds) {
    const plan = await store.getPlanByPriceId(priceId);
    if (plan) {
      tier = tier ?? plan.tierKey;
      features = { ...features, ...plan.features };
    }
  }
  return {
    hasAccess: true,
    tier,
    features,
    quantity: sub.quantity,
    paymentPastDue: sub.status === "past_due",
    endsAt: sub.scheduledChangeAction === "cancel" || sub.scheduledChangeAction === "pause" ? sub.scheduledChangeEffectiveAt : null,
    subscription: sub,
  };
}

/** One-time purchases: has this user a completed transaction containing the product? */
export async function hasPurchased(store: PaddleStore, userId: string, productId: string): Promise<boolean> {
  const purchases = await store.listPurchasesForUser(userId);
  return purchases.some((p) => p.status === "completed" && p.productIds.includes(productId));
}

/**
 * Guard for a paid route. Throws a typed error your HTTP layer maps to 402/403.
 * Check the tier the feature needs, not merely "has any subscription".
 */
export class PaywallError extends Error {
  constructor(public readonly requiredTier: string | undefined, public readonly entitlement: Entitlement) {
    super(requiredTier ? `Requires the ${requiredTier} plan` : "Requires an active subscription");
    this.name = "PaywallError";
  }
}

export async function requireTier(store: PaddleStore, userId: string, requiredTier?: string, tierOrder: string[] = []): Promise<Entitlement> {
  const ent = await getEntitlement(store, userId);
  if (!ent.hasAccess) throw new PaywallError(requiredTier, ent);
  if (requiredTier) {
    const have = tierOrder.indexOf(ent.tier ?? "");
    const need = tierOrder.indexOf(requiredTier);
    const ok = tierOrder.length === 0 ? ent.tier === requiredTier : have >= need && need !== -1;
    if (!ok) throw new PaywallError(requiredTier, ent);
  }
  return ent;
}
