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
  onEvent?: (event: PaddleEventData) => void;
}

let paddlePromise: Promise<Paddle | undefined> | undefined;

/** Idempotent: Paddle.js may be initialized once per page. Call from anywhere; the first call wins. */
export function getPaddle(config: PaddleBrowserConfig): Promise<Paddle | undefined> {
  if (!paddlePromise) {
    paddlePromise = initializePaddle({
      token: config.clientToken,
      environment: config.environment,
      pwCustomer: config.customerId ? { id: config.customerId } : {},
      eventCallback: config.onEvent,
      checkout: {
        settings: {
          displayMode: "overlay",
          theme: "light",
          // successUrl is optional. Prefer handling `checkout.completed` in eventCallback:
          // show a "payment received, setting up your account" state and poll your own
          // /api/billing/entitlement until the webhook has landed. Never grant access from this event.
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
    customer: input.customer,
    customData: { user_id: input.userId },
    discountCode: input.discountCode,
    settings: input.successUrl ? { successUrl: input.successUrl } : undefined,
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
    customer: input.customer,
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
