/**
 * Browser side: load Paddle.js once and open checkouts.
 *
 * Uses the official wrapper `@paddle/paddle-js` (npm), which loads Paddle.js
 * from https://cdn.paddle.com and gives typed access. Paddle requires the
 * script to come from its CDN; never bundle or self-host paddle.js.
 *
 * Only the CLIENT-SIDE TOKEN (test_... / live_...) goes to the browser. It can
 * open checkouts and preview prices and nothing else. The API key never does.
 *
 * Environment: pass "sandbox" with a test_ token, "production" with a live_
 * token. A token from the other environment will not open checkouts.
 */
import { initializePaddle, type Paddle, type PaddleEventData, type CheckoutOpenOptions, type Environments } from "@paddle/paddle-js";

export interface PaddleBrowserConfig {
  clientToken: string;             // e.g. import.meta.env.VITE_PADDLE_CLIENT_TOKEN or process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN
  environment: Environments;       // "sandbox" | "production"
  /** Paddle customer id (ctm_) of the signed-in user, when known. Enables Retain features and prefills. */
  customerId?: string;
}

let paddlePromise: Promise<Paddle | undefined> | undefined;

// Paddle.js takes one eventCallback, fixed at initialization. It forwards every event to these
// listeners, so each component adds its own and removes it when it unmounts.
const listeners = new Set<(event: PaddleEventData) => void>();

/** Receive Paddle.js events (checkout.completed, checkout.closed, ...). Returns the function that removes the listener. */
export function addPaddleEventListener(listener: (event: PaddleEventData) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Idempotent: Paddle.js may be initialized once per page. Call from anywhere; the first call wins. */
export function getPaddle(config: PaddleBrowserConfig): Promise<Paddle | undefined> {
  if (!paddlePromise) {
    paddlePromise = initializePaddle({
      token: config.clientToken,
      environment: config.environment,
      pwCustomer: config.customerId ? { id: config.customerId } : {},
      eventCallback: (event) => {
        for (const listener of listeners) listener(event);
      },
      checkout: {
        settings: {
          displayMode: "overlay",
          theme: "light",
          // successUrl is optional. Prefer handling `checkout.completed` in a listener:
          // show a "payment received, setting up your account" state and poll your own
          // /api/billing/entitlement until the webhook has been processed. Never grant access from this event.
        },
      },
    });
  }
  return paddlePromise;
}

/**
 * Open an overlay checkout for catalog prices. Pass the signed-in user's id as
 * customData.user_id so the webhook can map the subscription to the user, and
 * the customer email/id so Paddle reuses the customer.
 */
export async function openCheckout(
  config: PaddleBrowserConfig,
  input: {
    items: { priceId: string; quantity?: number }[];
    userId: string;
    customer?: { id: string } | { email: string };
    discountCode?: string;
    successUrl?: string;
  },
): Promise<void> {
  const paddle = await getPaddle(config);
  if (!paddle) throw new Error("Paddle.js failed to load (blocked script or wrong token/environment)");
  const options: CheckoutOpenOptions = {
    items: input.items,
    customData: { user_id: input.userId },
    ...(input.customer ? { customer: input.customer } : {}),
    ...(input.discountCode ? { discountCode: input.discountCode } : {}),
    ...(input.successUrl ? { settings: { successUrl: input.successUrl } } : {}),
  };
  paddle.Checkout.open(options);
}

/** Open a checkout for a transaction the server created (fixed items, server-controlled custom_data). */
export async function openTransactionCheckout(config: PaddleBrowserConfig, transactionId: string): Promise<void> {
  const paddle = await getPaddle(config);
  if (!paddle) throw new Error("Paddle.js failed to load");
  paddle.Checkout.open({ transactionId });
}

/**
 * Add or update the card on a subscription: open the transaction from
 * getUpdatePaymentMethodTransaction (server) / POST /api/billing/subscription/:id/payment-method.
 * Uses the one-page checkout: Paddle requires it for cardless trials ("Cardless trial subscriptions
 * are only supported by one-page checkout variant") and it works for every other subscription too.
 */
export async function openPaymentMethodCheckout(config: PaddleBrowserConfig, transactionId: string): Promise<void> {
  const paddle = await getPaddle(config);
  if (!paddle) throw new Error("Paddle.js failed to load");
  paddle.Checkout.open({ transactionId, settings: { variant: "one-page" } });
}

/**
 * Inline checkout: renders inside a container element instead of a modal.
 * Requires the default payment link to be set in Paddle. The frame shows the
 * payment form only; render your own order summary from checkout.loaded /
 * checkout.updated event data.
 *
 *   <div class="paddle-checkout-frame"></div>
 */
export async function openInlineCheckout(
  config: PaddleBrowserConfig,
  input: { items: { priceId: string; quantity?: number }[]; userId: string; customer?: { id: string } | { email: string }; frameTargetClass?: string },
): Promise<void> {
  const paddle = await getPaddle(config);
  if (!paddle) throw new Error("Paddle.js failed to load");
  paddle.Checkout.open({
    items: input.items,
    ...(input.customer ? { customer: input.customer } : {}),
    customData: { user_id: input.userId },
    settings: {
      displayMode: "inline",
      frameTarget: input.frameTargetClass ?? "paddle-checkout-frame",
      frameInitialHeight: 450,
      frameStyle: "width: 100%; min-width: 312px; background-color: transparent; border: none;",
    },
  });
}

/**
 * Localized price preview for a pricing page, computed by Paddle from the
 * visitor's IP (or pass address.countryCode). Returns formatted totals.
 */
export async function previewPrices(config: PaddleBrowserConfig, priceIds: string[], countryCode?: string) {
  const paddle = await getPaddle(config);
  if (!paddle) throw new Error("Paddle.js failed to load");
  return paddle.PricePreview({
    items: priceIds.map((priceId) => ({ priceId, quantity: 1 })),
    ...(countryCode ? { address: { countryCode } } : {}),
  });
}
