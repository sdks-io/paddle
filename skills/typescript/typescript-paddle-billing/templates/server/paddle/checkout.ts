/**
 * Server-side pieces of checkout and self-service:
 *   ensureCustomer            link your user to a Paddle customer (reuse by verified email)
 *   checkoutClaimKey          the one claim key for a server-created checkout
 *   createCheckoutTransaction create a transaction to open with Paddle.js or via checkout.url
 *   createCardlessTrial       start a cardless trial (a billed transaction, no checkout)
 *   createPortalSession       customer portal links (invoices, payment method, cancel)
 *   getInvoiceUrl             Paddle-issued invoice PDF (merchant of record: Paddle's invoice)
 *   listCatalog               active prices with their products, from Paddle
 *   previewLocalizedPrices    tax-inclusive, localized amounts for a pricing page
 *
 * Creates go through claimedWrite (writes.ts). Signatures verified against paddle-apimatic-sdk
 * 0.0.3 (sdk-map 0.0.3). Re-check map/operations/*.md after an SDK version bump.
 */
import type { AddressPreview, CountryCodeSupported, CurrencyCode, TransactionItemCreate } from "paddle-apimatic-sdk";
import { getPaddleClient } from "./client.js";
import { paddleError } from "./errors.js";
import { listAll } from "./pagination.js";
import type { PaddleStore } from "./store.js";
import { claimedWrite } from "./writes.js";

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
 * it can have. Reuse it only when the app has verified that the user owns the email (or the
 * customer was created for this user); otherwise anyone who signs up with someone else's address
 * would get that customer's portal and invoices.
 * After linking, rows a webhook stored without a user (no custom_data.user_id) are given to the user.
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
  const byEmail = async () => {
    const existing = (await client.customers.listCustomers({ email: [email], perPage: 1 })).data[0];
    if (!existing) return undefined;
    const ours = existing.customData?.["user_id"] === userId;
    if (!ours && !options.emailVerified) throw new CustomerEmailNotVerifiedError();
    return { id: existing.id, value: existing.id };
  };

  const { value: customerId } = await claimedWrite(store, {
    claimKey: `customer:${userId}`,
    kind: "customer",
    userId,
    operation: "createCustomer",
    reuse: async (id) => id,
    find: byEmail,
    write: async () => {
      const existing = await byEmail();
      if (existing) return existing;
      try {
        const created = await client.customers.createCustomer({
          body: { email, ...(options.name ? { name: options.name } : {}), customData: { user_id: userId } },
        });
        return { id: created.data.id, value: created.data.id };
      } catch (err) {
        // Created by someone else between the list and the create (Paddle requires unique emails).
        if (paddleError(err)?.code === "customer_already_exists") {
          const found = await byEmail();
          if (found) return found;
        }
        throw err;
      }
    },
  });
  await store.linkCustomer(userId, customerId, email);
  await store.assignUserToCustomerRows(userId, customerId);
  return customerId;
}

/**
 * The one claim key for a server-created checkout, computed on the server: the same user buying the
 * same price and quantity gets the same open transaction back (a double click creates one). Once that
 * transaction is paid or canceled, the next purchase gets a new one. Never take the key from the browser.
 */
export function checkoutClaimKey(userId: string, items: { priceId: string; quantity: number }[]): string {
  const parts = [...items].sort((a, b) => a.priceId.localeCompare(b.priceId)).map((i) => `${i.priceId}x${i.quantity}`);
  return `checkout:${userId}:${parts.join(",")}`;
}

export interface CreateCheckoutInput {
  /** checkoutClaimKey(userId, items), or `order:<orderId>` when the app has its own order. */
  claimKey: string;
  userId: string;
  customerId: string;
  /**
   * Catalog prices and quantities, or a custom one-time price for a product listed in plan_catalog
   * (a quote or a negotiated amount: Paddle creates a hidden price for that product). All recurring
   * items must share one billing interval.
   */
  items: CheckoutItem[];
  /** Copied by Paddle onto the transaction and, for recurring items, onto the subscription. Keep it small and flat. */
  customData?: Record<string, unknown>;
  discountId?: string;
}

export type CheckoutItem =
  | { priceId: string; quantity: number }
  | { customPrice: { description: string; productId: string; amount: string; currencyCode: CurrencyCode }; quantity: number };

export interface CreateCheckoutResult {
  transactionId: string;
  /** Hosted checkout URL (default payment link + ?_ptxn=). Needs the default payment link set in Paddle. */
  checkoutUrl: string | null;
  reused: boolean;
}

/** Transactions a buyer can still pay; any other status means the claim's purchase is finished. */
const OPEN_STATUSES: readonly string[] = ["draft", "ready"];

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
  const toResult = (t: { id: string; checkout?: { url?: string | null } | null }) => ({ transactionId: t.id, checkoutUrl: t.checkout?.url ?? null });

  const { value, reused } = await claimedWrite(store, {
    claimKey: input.claimKey,
    kind: "transaction",
    userId: input.userId,
    operation: "createTransaction",
    reuse: async (transactionId) => {
      const existing = (await client.transactions.getTransaction({ transactionId })).data;
      return OPEN_STATUSES.includes(existing.status) ? toResult(existing) : undefined;
    },
    find: async () => {
      const recent = await client.transactions.listTransactions({
        customerId: [input.customerId],
        status: ["draft", "ready"],
        orderBy: "created_at[DESC]",
        perPage: 30,
      });
      const match = recent.data.find((t) => t.customData?.["claim_key"] === input.claimKey);
      return match ? { id: match.id, value: toResult(match) } : undefined;
    },
    write: async () => {
      const items: TransactionItemCreate[] = input.items.map((i) =>
        "priceId" in i
          ? { priceId: i.priceId, quantity: i.quantity }
          : {
              quantity: i.quantity,
              price: {
                description: i.customPrice.description,
                productId: i.customPrice.productId,
                unitPrice: { amount: i.customPrice.amount, currencyCode: i.customPrice.currencyCode },
              },
            },
      );
      try {
        const created = await client.transactions.createTransaction({
          body: { items, customerId: input.customerId, customData, ...(input.discountId ? { discountId: input.discountId } : {}) },
        });
        return { id: created.data.id, value: toResult(created.data) };
      } catch (err) {
        if (paddleError(err)?.code === "transaction_default_checkout_url_not_set") {
          throw new Error("Paddle: set the default payment link (Paddle > Checkout > Checkout settings) before creating transactions", { cause: err });
        }
        throw err;
      }
    },
  });
  return { ...value, reused };
}

/**
 * Starts a cardless trial: Paddle's checkout does not support them, so the server creates a billed,
 * automatically-collected transaction; Paddle completes it (nothing to pay) and creates a trialing
 * subscription. The price needs trial_period.requires_payment_method false (recipe 01). One trial per
 * user and price: a repeat returns the first transaction.
 */
export async function createCardlessTrial(
  store: PaddleStore,
  input: { userId: string; customerId: string; addressId: string; priceId: string; quantity?: number },
): Promise<{ transactionId: string; reused: boolean }> {
  const client = getPaddleClient();
  const claimKey = `trial:${input.userId}:${input.priceId}`;
  const { value, reused } = await claimedWrite(store, {
    claimKey,
    kind: "transaction",
    userId: input.userId,
    operation: "createTransaction (cardless trial)",
    reuse: async (transactionId) => transactionId,
    find: async () => {
      const recent = await client.transactions.listTransactions({ customerId: [input.customerId], orderBy: "created_at[DESC]", perPage: 30 });
      const match = recent.data.find((t) => t.customData?.["claim_key"] === claimKey);
      return match ? { id: match.id, value: match.id } : undefined;
    },
    write: async () => {
      const created = await client.transactions.createTransaction({
        body: {
          items: [{ priceId: input.priceId, quantity: input.quantity ?? 1 }],
          status: "billed",
          collectionMode: "automatic",
          customerId: input.customerId,
          addressId: input.addressId,
          customData: { user_id: input.userId, claim_key: claimKey },
        },
      });
      return { id: created.data.id, value: created.data.id };
    },
  });
  return { transactionId: value, reused };
}

/** Customer portal links. Create a new session each time; the URLs are temporary and must not be stored or iframed. */
export async function createPortalSession(customerId: string, subscriptionIds: string[] = []) {
  const res = await getPaddleClient().customerPortals.createCustomerPortalSession({
    customerId,
    body: subscriptionIds.length > 0 ? { subscriptionIds: subscriptionIds.slice(0, 25) } : {},
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
export async function getInvoiceUrl(transactionId: string): Promise<string> {
  const res = await getPaddleClient().transactions.getTransactionInvoice({ transactionId });
  return res.data.url;
}

/** Active prices with their product, straight from Paddle. Cache for minutes, not days; prices change in the dashboard. */
export async function listCatalog(options: { productIds?: string[]; recurring?: boolean } = {}) {
  const client = getPaddleClient();
  return listAll((after) =>
    client.prices.listPrices({
      status: ["active"],
      include: ["product"],
      perPage: 200,
      ...(options.productIds ? { productId: options.productIds } : {}),
      ...(options.recurring !== undefined ? { recurring: options.recurring } : {}),
      ...(after ? { after } : {}),
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
