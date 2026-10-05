/**
 * Paddle configuration: one place that reads the environment and decides
 * which Paddle environment (sandbox or live) this deployment talks to.
 *
 * Fails at startup, not at the first call, when the configuration is
 * inconsistent (for example a sandbox key with PADDLE_ENV=production).
 *
 * Env vars (server only, never shipped to the browser):
 *   PADDLE_ENV             "sandbox" | "production"   (default "sandbox")
 *   PADDLE_API_KEY         pdl_sdbx_apikey_... or pdl_live_apikey_...
 *   PADDLE_WEBHOOK_SECRET  pdl_ntfset_...  (endpoint secret key of the notification destination)
 *   PADDLE_API_URL         optional override of the API base URL
 *   PADDLE_WEBHOOK_TOLERANCE_SECONDS  optional, default 5
 *
 * Public (safe in the browser; use your framework's public prefix, e.g. NEXT_PUBLIC_ / VITE_):
 *   PADDLE_CLIENT_TOKEN    test_... or live_...
 */

export type PaddleEnvironment = "sandbox" | "production";

export interface PaddleConfig {
  environment: PaddleEnvironment;
  apiKey: string;
  /** API base URL: https://sandbox-api.paddle.com or https://api.paddle.com */
  apiBaseUrl: string;
  /** Endpoint secret key of the webhook destination; undefined when webhooks are not wired yet. */
  webhookSecret: string | undefined;
  /** Max age of a webhook signature timestamp, in seconds. Paddle's SDKs default to 5. */
  webhookToleranceSeconds: number;
}

const API_BASE_URLS: Record<PaddleEnvironment, string> = {
  sandbox: "https://sandbox-api.paddle.com",
  production: "https://api.paddle.com",
};

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Paddle config: ${name} is not set`);
  }
  return value.trim();
}

export function loadPaddleConfig(env: NodeJS.ProcessEnv = process.env): PaddleConfig {
  const rawEnv = (env.PADDLE_ENV ?? "sandbox").trim();
  if (rawEnv !== "sandbox" && rawEnv !== "production") {
    throw new Error(`Paddle config: PADDLE_ENV must be "sandbox" or "production", got "${rawEnv}"`);
  }
  const environment: PaddleEnvironment = rawEnv;

  const apiKey = required("PADDLE_API_KEY");
  // Key format (Paddle docs): pdl_live_apikey_... for live, pdl_sdbx_apikey_... for sandbox.
  const keyIsSandbox = apiKey.startsWith("pdl_sdbx_");
  const keyIsLive = apiKey.startsWith("pdl_live_");
  if (!keyIsSandbox && !keyIsLive) {
    throw new Error("Paddle config: PADDLE_API_KEY does not look like a Paddle API key (pdl_sdbx_... or pdl_live_...)");
  }
  if ((environment === "sandbox" && keyIsLive) || (environment === "production" && keyIsSandbox)) {
    throw new Error(`Paddle config: PADDLE_ENV is "${environment}" but PADDLE_API_KEY is a ${keyIsLive ? "live" : "sandbox"} key`);
  }

  const webhookSecret = env.PADDLE_WEBHOOK_SECRET?.trim() || undefined;
  if (webhookSecret && !webhookSecret.startsWith("pdl_ntfset_")) {
    throw new Error("Paddle config: PADDLE_WEBHOOK_SECRET should be the destination's endpoint secret key (pdl_ntfset_...)");
  }

  const tolerance = Number(env.PADDLE_WEBHOOK_TOLERANCE_SECONDS ?? "5");
  if (!Number.isFinite(tolerance) || tolerance <= 0) {
    throw new Error("Paddle config: PADDLE_WEBHOOK_TOLERANCE_SECONDS must be a positive number");
  }

  return {
    environment,
    apiKey,
    apiBaseUrl: env.PADDLE_API_URL?.trim() || API_BASE_URLS[environment],
    webhookSecret,
    webhookToleranceSeconds: tolerance,
  };
}
