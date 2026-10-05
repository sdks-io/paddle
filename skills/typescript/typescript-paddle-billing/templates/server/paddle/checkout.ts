/**
 * Server-side pieces of checkout and self-service:
 *   ensureCustomer            link your user to a Paddle customer (reuse by verified email)
 *   createCheckoutTransaction create a transaction to open with Paddle.js or via checkout.url
 *   createPortalSession       customer portal links (invoices, payment method, cancel)
 *   getInvoiceUrl             Paddle-issued invoice PDF (merchant of record: Paddle's invoice)
 *   listCatalog               active prices with their products, from Paddle
 *   previewLocalizedPrices    tax-inclusive, localized amounts for a pricing page
 *
 * Signatures verified against paddle-apimatic-sdk sdk-map 1.0.0. Re-check
 * map/operations/*.md after an SDK version bump.
 */
import type { AddressPreview, CountryCodeSupported, TransactionItemCreate } from "paddle-apimatic-sdk";
import { getPaddleClient } from "./client.js";
import { paddleError } from "./errors.js";
import { listAll } from "./pagination.js";
import type { PaddleStore } from "./store.js";

/** Thrown when the email already belongs to a Paddle customer and the app has not verified that the user owns it. */
export class CustomerEmailNotVerifiedError extends Error {
  constructor() {
    super("verify your email address before billing can be set up");
    this.name = "CustomerEmailNotVerifiedError";
  }
}

/**
 * Returns the Paddle customer id for a user, creating the Paddle customer or reusing it by email.
 * Paddle requires unique customer emails, so an existing customer with this email is the only one
 * it can have. Reuse it only when the app has verified that the user owns the email; otherwise
 * anyone who signs up with someone else's address would get that customer's portal and invoices.
 */
export async function ensureCustomer(
  store: PaddleStore,
  userId: string,
  email: string,
  options: { emailVerified: boolean; name?: string },
): Promise<string> {
  const known = await store.getCustomerIdForUser(userId);
  if (known) return known;

  const client = getPaddleClient();
  const existing = await client.customers.listCustomers({ email: [email], perPage: 1 });
  let customerId = existing.data[0]?.id;
  if (customerId) {
    if (!options.emailVerified) throw new CustomerEmailNotVerifiedError();
  } else {
    const created = await client.customers.createCustomer({ body: { email, ...(options.name ? { name: options.name } : {}), customData: { user_id: userId } } });
    customerId = created.data.id;
  }
  await store.linkCustomer(userId, customerId, email);
  return customerId;
}

export interface CreateCheckoutInput {
  /** Unique per intended purchase, e.g. `order:${orderId}`. A second call with the same key returns the first transaction. */
  claimKey: string;
  userId: string;
  customerId: string;
  /** Catalog prices and quantities. All recurring items must share one billing interval. */
  items: { priceId: string; quantity: number }[];
  /** Copied by Paddle onto the transaction and, for recurring items, onto the subscription. Keep it small and flat. */
  customData?: Record<string, unknown>;
  discountId?: string;
}

export interface CreateCheckoutResult {
  transactionId: string;
  /** Hosted checkout URL (default payment link + ?_ptxn=). Needs the default payment link set in Paddle. */
  checkoutUrl: string | null;
  reused: boolean;
}

/**
 * Creates a transaction for checkout. Open it in the browser with
 * Paddle.Checkout.open({ transactionId }) or send the customer to checkoutUrl.
 *
 * Use this when the server must fix the items (cart, quote, seats) or attach
 * custom_data the browser must not control. For a simple "buy this price"
 * button, Paddle.js can open the checkout with items directly and no
 * transaction needs to exist first.
 */
export async function createCheckoutTransaction(store: PaddleStore, input: CreateCheckoutInput): Promise<CreateCheckoutResult> {
  const client = getPaddleClient();
  const customData = { ...input.customData, user_id: input.userId, claim_key: input.claimKey };

  const claim = await store.claimTransaction(input.claimKey, input.userId);
  if (!claim.claimed) {
    if (claim.transactionId) {
      const existing = await client.transactions.getTransaction({ transactionId: claim.transactionId });
      return { transactionId: existing.data.id, checkoutUrl: existing.data.checkout?.url ?? null, reused: true };
    }
    // Claimed but not linked: another request is creating it, or an earlier attempt ended with an unknown outcome.
    if (Date.now() - claim.claimedAt.getTime() < STALE_CLAIM_MS) {
      throw new Error("checkout for this claim key is being created, retry shortly");
    }
    const found = await findClaimedTransaction(input);
    if (found) return found;
    // Nothing was created under this key: take the claim again.
    await store.releaseClaim(input.claimKey);
    return createCheckoutTransaction(store, input);
  }

  const items: TransactionItemCreate[] = input.items.map((i) => ({ priceId: i.priceId, quantity: i.quantity }));
  try {
    const created = await client.transactions.createTransaction({
      body: {
        items,
        customerId: input.customerId,
        customData,
        ...(input.discountId ? { discountId: input.discountId } : {}),
      },
    });
    await store.linkClaimedTransaction(input.claimKey, created.data.id);
    return { transactionId: created.data.id, checkoutUrl: created.data.checkout?.url ?? null, reused: false };
  } catch (err) {
    const info = paddleError(err);
    if (info && info.status >= 400 && info.status < 500) {
      // Paddle refused (validation, default payment link missing, rate limit, ...): nothing was created.
      // Release the claim so the user can retry after the fix.
      await store.releaseClaim(input.claimKey);
      if (info.code === "transaction_default_checkout_url_not_set") {
        throw new Error("Paddle: set the default payment link in Paddle > Checkout > Checkout configuration before creating transactions");
      }
      throw err;
    }
    // Unknown outcome (connection lost, timeout, 5xx, or a 2xx body that could not be read):
    // Paddle may have created the transaction. Look it up by the claim key; keep the claim if not found,
    // so a later call with the same key looks again instead of creating a second transaction.
    try {
      const found = await findClaimedTransaction(input);
      if (found) return found;
    } catch {
      // lookup failed too: keep the claim
    }
    throw err;
  }

  async function findClaimedTransaction(input: CreateCheckoutInput): Promise<CreateCheckoutResult | undefined> {
    const recent = await client.transactions.listTransactions({
      customerId: [input.customerId],
      status: ["draft", "ready"],
      orderBy: "created_at[DESC]",
      perPage: 30,
    });
    const match = recent.data.find((t) => t.customData?.["claim_key"] === input.claimKey);
    if (!match) return undefined;
    await store.linkClaimedTransaction(input.claimKey, match.id);
    return { transactionId: match.id, checkoutUrl: match.checkout?.url ?? null, reused: true };
  }
}

/** A claim with no transaction after this long is treated as abandoned and looked up again. */
const STALE_CLAIM_MS = 2 * 60_000;

/** Customer portal links. Create a new session each time; the URLs are temporary and must not be stored or iframed. */
export async function createPortalSession(customerId: string, subscriptionIds: string[] = []) {
  const res = await getPaddleClient().customerPortals.createCustomerPortalSession({
    customerId,
    body: { subscriptionIds: subscriptionIds.slice(0, 25) },
  });
  return {
    overviewUrl: res.data.urls.general.overview,
    subscriptions: (res.data.urls.subscriptions ?? []).map((s) => ({
      id: s.id,
      cancelUrl: s.cancelSubscription,
      updatePaymentMethodUrl: s.updateSubscriptionPaymentMethod,
    })),
  };
}

/**
 * URL of the invoice PDF Paddle issued for a transaction. Expires after one hour: fetch on demand, never cache.
 * Allowed for completed transactions (automatic collection) and billed/completed invoices (manual collection).
 */
export async function getInvoiceUrl(transactionId: string, disposition: "inline" | "attachment" = "inline"): Promise<string> {
  const res = await getPaddleClient().transactions.getTransactionInvoice({ transactionId, disposition });
  return res.data.url;
}

/** Active prices with their product, straight from Paddle. Cache for minutes, not days; prices change in the dashboard. */
export async function listCatalog(options: { productIds?: string[]; recurring?: boolean } = {}) {
  const client = getPaddleClient();
  return listAll((after) =>
    client.prices.listPrices({
      status: ["active"],
      include: ["product"],
      productId: options.productIds,
      recurring: options.recurring,
      perPage: 200,
      after,
    }),
  );
}

/**
 * Localized, tax-aware totals for a pricing page, computed by Paddle.
 * Pass the visitor's country (and postal code where needed) or their IP.
 * Rate limit: 1,000 requests/min per IP; cache per (price, country) for a short time.
 */
export async function previewLocalizedPrices(
  items: { priceId: string; quantity: number }[],
  location: { countryCode: CountryCodeSupported; postalCode?: string } | { customerIpAddress: string },
) {
  const client = getPaddleClient();
  const res = await client.pricingPreview.previewPrices({
    body: {
      items,
      ...("customerIpAddress" in location
        ? { customerIpAddress: location.customerIpAddress }
        : {
            // postal_code is only needed in countries where tax depends on it (e.g. US, CA, AU, IN); omit it otherwise.
            address: {
              countryCode: location.countryCode,
              ...(location.postalCode ? { postalCode: location.postalCode } : {}),
            } as AddressPreview,
          }),
    },
  });
  return res.data;
}

export type CatalogPrice = Awaited<ReturnType<typeof listCatalog>>[number];
