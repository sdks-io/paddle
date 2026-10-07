/**
 * Billing routes (Express). Adapt to the project's router, auth middleware and
 * response conventions; keep the ownership checks and the write/read split:
 *   writes go to Paddle (create transaction, change plan, cancel, portal session),
 *   reads for access come from the webhook-maintained mirror (entitlement),
 *   reads for display come from Paddle (catalog, invoices) with short caching.
 *
 * Mount AFTER the webhook route and after express.json():
 *   app.use("/api/billing", requireAuth, billingRoutes(store));
 * `req.user` is assumed to carry { id, email, emailVerified }; replace with the project's
 * session shape. emailVerified must come from the app's own email verification.
 *
 * The browser chooses only WHICH catalog plan it wants. Prices are checked against
 * plan_catalog, quantities are bounded here, claim keys and the proration mode are decided on the
 * server. Responses are plain objects built here, never SDK models passed through.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { checkoutClaimKey, createCheckoutTransaction, createPortalSession, CustomerEmailNotVerifiedError, ensureCustomer, getInvoiceUrl, listCatalog } from "./checkout.js";
import { getPaddleClient } from "./client.js";
import { getEntitlement, PaywallError } from "./entitlements.js";
import { paddleError, toHttpAnswer, writeOutcome } from "./errors.js";
import type { PaddleStore, SubscriptionRow } from "./store.js";
import {
  cancelPlanChangeAtRenewal,
  cancelSubscription,
  changePlan,
  chooseProrationMode,
  currentSubscription,
  getUpdatePaymentMethodTransaction,
  PlanChangeNotSchedulableError,
  removeScheduledChange,
  requestPlanChangeAtRenewal,
} from "./subscriptions.js";
import { subscriptionItems } from "./webhooks/types.js";
import { WriteInProgressError } from "./writes.js";

type AuthedRequest = Request & { user: { id: string; email: string; emailVerified: boolean } };

/** Upper bound for seats or units in one request. Set it from the plan's quantity.maximum. */
const MAX_QUANTITY = 1000;

class BadRequest extends Error {}

/** The fields a billing page needs from a subscription, whatever shape the SDK returned. */
function subscriptionView(sub: { id: string; status: string; nextBilledAt?: Date | null; scheduledChange?: { action: string; effectiveAt: Date } | null; items: { status?: string | null; price: { id: string }; quantity: number }[] }) {
  return {
    id: sub.id,
    status: sub.status,
    nextBilledAt: sub.nextBilledAt ?? null,
    scheduledChange: sub.scheduledChange ? { action: sub.scheduledChange.action, effectiveAt: sub.scheduledChange.effectiveAt } : null,
    items: subscriptionItems(sub).map((i) => ({ priceId: i.price.id, quantity: i.quantity })),
  };
}

type Totals = { details: { totals: { grandTotal: string; currencyCode: string } } } | null | undefined;
type UpdateSummary = { result: { action: string; amount: string; currencyCode: string } } | null | undefined;
const totalsView = (t: Totals) => (t ? { total: t.details.totals.grandTotal, currency: t.details.totals.currencyCode } : null);
/**
 * What the customer sees before confirming. `change` is Paddle's summary of this change alone: a charge, or a
 * credit (a downgrade's unused time), which Paddle keeps on the customer's balance for later bills. The bills'
 * totals are what is due after that balance, so a credit never shows in them.
 */
function previewView(p: { immediateTransaction?: Totals; nextTransaction?: Totals; nextBilledAt?: Date | null; updateSummary?: UpdateSummary } | undefined) {
  if (!p) return null;
  const result = p.updateSummary?.result;
  return {
    change: result ? { action: result.action, amount: result.amount, currency: result.currencyCode } : null,
    chargeNow: totalsView(p.immediateTransaction),
    nextBill: totalsView(p.nextTransaction),
    nextBilledAt: p.nextBilledAt ?? null,
  };
}

export function billingRoutes(store: PaddleStore): Router {
  const r = Router();
  const wrap =
    (fn: (req: AuthedRequest, res: Response) => Promise<unknown>) =>
    (req: Request, res: Response, next: NextFunction) =>
      fn(req as AuthedRequest, res).catch(next);

  /** Loads a subscription row and refuses when it is not the signed-in user's. */
  async function ownSubscription(req: AuthedRequest): Promise<SubscriptionRow> {
    const row = await store.getSubscription(String(req.params["subscriptionId"]));
    if (!row || row.userId !== req.user.id) {
      const err = new Error("subscription not found") as Error & { status?: number };
      err.status = 404;
      throw err;
    }
    return row;
  }

  /** Accepts only a price that is an active row of plan_catalog. */
  async function catalogPrice(priceId: unknown): Promise<string> {
    const plan = typeof priceId === "string" ? await store.getPlanByPriceId(priceId) : undefined;
    if (!plan || !plan.active) throw new BadRequest("unknown priceId");
    return plan.priceId;
  }

  function boundedQuantity(quantity: unknown, fallback: number): number {
    const q = quantity === undefined ? fallback : quantity;
    if (typeof q !== "number" || !Number.isInteger(q) || q < 1 || q > MAX_QUANTITY) throw new BadRequest(`quantity must be an integer from 1 to ${MAX_QUANTITY}`);
    return q;
  }

  /**
   * The change read against Paddle's current state (the mirror can lag the previous change by a webhook):
   * the current base plan (the first catalog item), the quantity (the request's, or the current one), and the
   * complete item list with the base plan replaced; add-ons keep their quantities.
   */
  async function planChange(row: SubscriptionRow, priceId: string, requestedQuantity: unknown) {
    const now = await currentSubscription(row.id);
    let base: { priceId: string; quantity: number } | undefined;
    for (const item of now.items) {
      if (await store.getPlanByPriceId(item.priceId)) {
        base = item;
        break;
      }
    }
    if (!base) throw new BadRequest("subscription has no catalog plan to replace");
    const quantity = boundedQuantity(requestedQuantity, base.quantity);
    const items = now.items.map((item) => (item === base ? { priceId, quantity } : item));
    return { status: now.status, base, quantity, items };
  }

  const ensureUserCustomer = (req: AuthedRequest) => ensureCustomer(store, req.user.id, req.user.email, { emailVerified: req.user.emailVerified });

  // READ (mirror): what may this user do?
  r.get("/entitlement", wrap(async (req, res) => {
    const ent = await getEntitlement(store, req.user.id);
    const pending = ent.subscription ? await store.getPendingPlanChange(ent.subscription.id) : undefined;
    res.json({
      hasAccess: ent.hasAccess, tier: ent.tier, features: ent.features, quantity: ent.quantity, paymentPastDue: ent.paymentPastDue, endsAt: ent.endsAt,
      subscriptionId: ent.subscription?.id ?? null, status: ent.subscription?.status ?? null,
      changeAtRenewal: pending ? { items: pending.items, at: pending.renewalAt } : null,
    });
  }));

  // READ (Paddle): active prices for the pricing page. Cache for a few minutes in production.
  // Only this app's plans: the Paddle account can hold other products and prices.
  r.get("/catalog", wrap(async (_req, res) => {
    const sold = new Set((await store.listPlans()).filter((p) => p.active).map((p) => p.priceId));
    const prices = (await listCatalog({ recurring: true })).filter((p) => sold.has(p.id));
    res.json(prices.map((p) => ({ priceId: p.id, productId: p.productId, name: p.name ?? null, productName: p.product?.name ?? null, amount: p.unitPrice.amount, currency: p.unitPrice.currencyCode, billingCycle: p.billingCycle ?? null, trial: p.trialPeriod ?? null })));
  }));

  // WRITE (Paddle): server-created transaction for a checkout with fixed items. A double submit returns the same open transaction.
  r.post("/checkout", wrap(async (req, res) => {
    const body = req.body as { priceId?: unknown; quantity?: unknown };
    const priceId = await catalogPrice(body.priceId);
    const quantity = boundedQuantity(body.quantity, 1);
    const customerId = await ensureUserCustomer(req);
    const items = [{ priceId, quantity }];
    const result = await createCheckoutTransaction(store, { claimKey: checkoutClaimKey(req.user.id, items), userId: req.user.id, customerId, items });
    return res.status(result.reused ? 200 : 201).json(result);
  }));

  // WRITE (Paddle): customer portal session; redirect the browser to overviewUrl.
  r.post("/portal", wrap(async (req, res) => {
    const customerId = await ensureUserCustomer(req);
    const subs = await store.listSubscriptionsForUser(req.user.id);
    res.json(await createPortalSession(customerId, subs.map((s) => s.id)));
  }));

  // READ (Paddle): invoice PDF for one of the user's transactions (URL valid one hour).
  r.get("/invoices/:transactionId", wrap(async (req, res) => {
    const txnId = String(req.params["transactionId"]);
    // Ownership: the transaction's customer must be this user's Paddle customer. Never trust the id alone.
    const customerId = await store.getCustomerIdForUser(req.user.id);
    const tx = await getPaddleClient().transactions.getTransaction({ transactionId: txnId });
    if (!customerId || tx.data.customerId !== customerId) return res.status(404).json({ error: "not found" });
    return res.redirect(await getInvoiceUrl(txnId));
  }));

  // WRITE (Paddle): plan or seat change now, with preview. Replaces the base plan; add-ons stay.
  r.post("/subscription/:subscriptionId/change", wrap(async (req, res) => {
    const row = await ownSubscription(req);
    const body = req.body as { priceId?: unknown; quantity?: unknown; preview?: unknown };
    const priceId = await catalogPrice(body.priceId);
    const { status, base, quantity, items } = await planChange(row, priceId, body.quantity);
    const mode = await chooseProrationMode({ status, priceId: base.priceId, quantity: base.quantity }, { priceId, quantity });
    if (body.preview === true) {
      const preview = (await changePlan(row.id, items, mode, { preview: true })).preview;
      return res.json({ preview: previewView(preview) });
    }
    // A change now replaces any change planned for the renewal (applying the old list later would undo it).
    // Cancel it first, so the renewal job cannot apply it while this change is being made.
    const pending = await store.getPendingPlanChange(row.id);
    if (pending && !(await store.finishPendingPlanChange(row.id, "canceled", new Date(), "superseded by a change applied now"))) {
      return res.status(409).json({ error: "the change planned for your renewal is being applied right now; try again in a minute" });
    }
    let result;
    try {
      result = await changePlan(row.id, items, mode);
    } catch (err) {
      // Refused or never sent: nothing changed, so the planned change stands again.
      if (pending && writeOutcome(err) !== "unknown") await store.savePendingPlanChange(pending);
      throw err;
    }
    return res.json(result.subscription ? subscriptionView(result.subscription) : null);
  }));

  // WRITE (app): plan change at the end of the term (e.g. yearly → monthly). Applied by applyDuePlanChanges shortly before renewal.
  r.post("/subscription/:subscriptionId/change-at-renewal", wrap(async (req, res) => {
    const row = await ownSubscription(req);
    const body = req.body as { priceId?: unknown; quantity?: unknown };
    const priceId = await catalogPrice(body.priceId);
    const { items } = await planChange(row, priceId, body.quantity);
    const change = await requestPlanChangeAtRenewal(store, { subscriptionId: row.id, userId: req.user.id, items });
    res.json({ items: change.items, at: change.renewalAt });
  }));

  r.delete("/subscription/:subscriptionId/change-at-renewal", wrap(async (req, res) => {
    const row = await ownSubscription(req);
    await cancelPlanChangeAtRenewal(store, row.id);
    res.json({ canceled: true });
  }));

  // WRITE (Paddle): cancel at period end (default) or immediately (ask the user first).
  r.post("/subscription/:subscriptionId/cancel", wrap(async (req, res) => {
    const row = await ownSubscription(req);
    const when = (req.body as { when?: unknown }).when === "immediately" ? "immediately" : "next_billing_period";
    res.json(subscriptionView(await cancelSubscription(row.id, when)));
  }));

  // WRITE (Paddle): undo a scheduled cancel or pause.
  r.post("/subscription/:subscriptionId/undo-scheduled-change", wrap(async (req, res) => {
    const row = await ownSubscription(req);
    res.json(subscriptionView(await removeScheduledChange(row.id)));
  }));

  // READ (Paddle): the transaction to add or update the card; open it with openPaymentMethodCheckout (paddle-browser.ts).
  r.post("/subscription/:subscriptionId/payment-method", wrap(async (req, res) => {
    const row = await ownSubscription(req);
    res.json(await getUpdatePaymentMethodTransaction(row.id));
  }));

  // Error boundary for this router: paywall → 402, bad input → 400, conflicts → 409, Paddle failures → mapped (errors.ts).
  r.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof PaywallError) return res.status(402).json({ error: err.message, requiredTier: err.requiredTier });
    if (err instanceof BadRequest) return res.status(400).json({ error: err.message });
    if (err instanceof CustomerEmailNotVerifiedError) return res.status(409).json({ error: err.message, code: "email_not_verified" });
    if (err instanceof WriteInProgressError || err instanceof PlanChangeNotSchedulableError) return res.status(409).json({ error: err.message });
    const status = (err as { status?: number }).status;
    if (status === 404) return res.status(404).json({ error: "not found" });
    // Paddle's free-text detail goes to the log (replace console with the project's logger); the answer carries code and field messages.
    const info = paddleError(err);
    if (info) console.error("paddle request failed", { status: info.status, code: info.code, detail: info.detail, fieldErrors: info.fieldErrors, requestId: info.requestId });
    else console.error("billing route failed", err);
    const answer = toHttpAnswer(err);
    return res.status(answer.status).json(answer.body);
  });

  return r;
}
