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
 * plan_catalog, quantities are bounded here, and the proration mode is decided on the server.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { createCheckoutTransaction, createPortalSession, CustomerEmailNotVerifiedError, ensureCustomer, getInvoiceUrl, listCatalog } from "./checkout.js";
import { getPaddleClient } from "./client.js";
import { getEntitlement, PaywallError } from "./entitlements.js";
import { paddleError, toHttpAnswer } from "./errors.js";
import type { PaddleStore } from "./store.js";
import { cancelSubscription, changePlan, chooseProrationMode, removeScheduledChange } from "./subscriptions.js";

type AuthedRequest = Request & { user: { id: string; email: string; emailVerified: boolean } };

/** Upper bound for seats or units in one request. Set it from the plan's quantity.maximum. */
const MAX_QUANTITY = 1000;

class BadRequest extends Error {}

export function billingRoutes(store: PaddleStore): Router {
  const r = Router();
  const wrap =
    (fn: (req: AuthedRequest, res: Response) => Promise<unknown>) =>
    (req: Request, res: Response, next: NextFunction) =>
      fn(req as AuthedRequest, res).catch(next);

  /** Loads a subscription row and refuses when it is not the signed-in user's. */
  async function ownSubscription(req: AuthedRequest) {
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

  const ensureUserCustomer = (req: AuthedRequest) => ensureCustomer(store, req.user.id, req.user.email, { emailVerified: req.user.emailVerified });

  // READ (mirror): what may this user do?
  r.get("/entitlement", wrap(async (req, res) => {
    const ent = await getEntitlement(store, req.user.id);
    res.json({ hasAccess: ent.hasAccess, tier: ent.tier, features: ent.features, quantity: ent.quantity, paymentPastDue: ent.paymentPastDue, endsAt: ent.endsAt, subscriptionId: ent.subscription?.id ?? null, status: ent.subscription?.status ?? null });
  }));

  // READ (Paddle): active prices for the pricing page. Cache for a few minutes in production.
  r.get("/catalog", wrap(async (_req, res) => {
    const prices = await listCatalog({ recurring: true });
    res.json(prices.map((p) => ({ priceId: p.id, productId: p.productId, name: p.name, productName: p.product?.name, amount: p.unitPrice.amount, currency: p.unitPrice.currencyCode, billingCycle: p.billingCycle ?? null, trial: p.trialPeriod ?? null })));
  }));

  // WRITE (Paddle): server-created transaction for a checkout with fixed items.
  r.post("/checkout", wrap(async (req, res) => {
    const body = req.body as { priceId?: unknown; quantity?: unknown; claimKey?: unknown };
    if (typeof body.claimKey !== "string" || !body.claimKey) return res.status(400).json({ error: "claimKey is required" });
    const priceId = await catalogPrice(body.priceId);
    const quantity = boundedQuantity(body.quantity, 1);
    const customerId = await ensureUserCustomer(req);
    const result = await createCheckoutTransaction(store, {
      claimKey: `${req.user.id}:${body.claimKey}`,
      userId: req.user.id,
      customerId,
      items: [{ priceId, quantity }],
    });
    return res.status(201).json(result);
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

  // WRITE (Paddle): plan or seat change, with preview. Replaces the first item; list add-ons too if the plan has them.
  r.post("/subscription/:subscriptionId/change", wrap(async (req, res) => {
    const row = await ownSubscription(req);
    const body = req.body as { priceId?: unknown; quantity?: unknown; preview?: unknown };
    const priceId = await catalogPrice(body.priceId);
    const quantity = boundedQuantity(body.quantity, row.quantity);
    const currentPriceId = row.priceIds[0];
    if (!currentPriceId) return res.status(409).json({ error: "subscription has no active item" });
    const mode = await chooseProrationMode({ status: row.status, priceId: currentPriceId, quantity: row.quantity }, { priceId, quantity });
    return res.json(await changePlan(row.id, [{ priceId, quantity }], mode, { preview: body.preview === true }));
  }));

  // WRITE (Paddle): cancel at period end (default) or immediately (ask the user first).
  r.post("/subscription/:subscriptionId/cancel", wrap(async (req, res) => {
    const row = await ownSubscription(req);
    const when = (req.body as { when?: "next_billing_period" | "immediately" }).when ?? "next_billing_period";
    const sub = await cancelSubscription(row.id, when);
    res.json({ status: sub.status, scheduledChange: sub.scheduledChange ?? null });
  }));

  // WRITE (Paddle): undo a scheduled cancel or pause.
  r.post("/subscription/:subscriptionId/undo-scheduled-change", wrap(async (req, res) => {
    const row = await ownSubscription(req);
    const sub = await removeScheduledChange(row.id);
    res.json({ status: sub.status, scheduledChange: sub.scheduledChange ?? null });
  }));

  // Error boundary for this router: paywall → 402, bad input → 400, Paddle failures → mapped status (errors.ts).
  r.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof PaywallError) return res.status(402).json({ error: err.message, requiredTier: err.requiredTier });
    if (err instanceof BadRequest) return res.status(400).json({ error: err.message });
    if (err instanceof CustomerEmailNotVerifiedError) return res.status(409).json({ error: err.message, code: "email_not_verified" });
    const status = (err as { status?: number }).status;
    if (status === 404) return res.status(404).json({ error: "not found" });
    // Paddle's detail goes to the log (replace console with the project's logger), never to the browser.
    const info = paddleError(err);
    if (info) console.error("paddle request failed", { status: info.status, code: info.code, detail: info.detail, fieldErrors: info.fieldErrors, requestId: info.requestId });
    const answer = toHttpAnswer(err);
    return res.status(answer.status).json(answer.body);
  });

  return r;
}
