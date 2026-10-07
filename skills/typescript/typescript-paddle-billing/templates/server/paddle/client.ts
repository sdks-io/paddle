/**
 * The one Paddle API client for the whole server process.
 *
 * - SERVER ONLY. Never import this file from browser code. The API key it
 *   holds can create charges and refunds. Paddle also blocks API calls made
 *   from browsers; the browser uses a client-side token with Paddle.js instead.
 * - Built once and reused. Client lifetime → typescript-client-initialization.
 * - The environment is explicit. PADDLE_ENV selects the SDK environment:
 *     sandbox    → ServerEnvironment.Sandbox    → https://sandbox-api.paddle.com
 *     production → ServerEnvironment.Production → https://api.paddle.com
 *   loadPaddleConfig() refuses a key that does not match PADDLE_ENV.
 *   PADDLE_API_URL, when set, overrides the base URL of the selected environment.
 * - Tests pass their own `fetch` (createPaddleClient(config, { fetch })) and install the
 *   client with usePaddleClientForTests(). Faking fetch → typescript-testing.
 */
import { PaddleApiClient, ServerEnvironment, type ClientOptions } from "paddle-apimatic-sdk";
import { loadPaddleConfig, type PaddleConfig } from "./config.js";

let cached: { config: PaddleConfig; client: PaddleApiClient } | undefined;

export function getPaddleConfig(): PaddleConfig {
  return getPaddle().config;
}

export function getPaddleClient(): PaddleApiClient {
  return getPaddle().client;
}

/** Builds a client for this configuration. The app uses getPaddleClient(); tests pass a fake `fetch`. */
export function createPaddleClient(config: PaddleConfig, options: { fetch?: typeof fetch } = {}): PaddleApiClient {
  const serverOptions = config.apiUrlOverride ? { serverOptions: { baseUrl: config.apiUrlOverride } } : {};
  const environment: ClientOptions =
    config.environment === "production"
      ? { serverEnvironment: ServerEnvironment.Production, ...serverOptions }
      : { serverEnvironment: ServerEnvironment.Sandbox, ...serverOptions };
  return new PaddleApiClient({
    ...environment,
    bearerAuth: config.apiKey,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    // Retry settings -> typescript-configuration-resilience.
    // Paddle documents no idempotency key, so POST and PATCH are deliberately
    // NOT added to httpMethodsToRetry: a repeated POST /transactions would
    // create a second transaction. Writes use the claim pattern (writes.ts).
    retry: { maxRetries: 3, timeout: 30_000 },
  });
}

function getPaddle(): { config: PaddleConfig; client: PaddleApiClient } {
  if (!cached) {
    const config = loadPaddleConfig();
    cached = { config, client: createPaddleClient(config) };
  }
  return cached;
}

/** For tests: use this config and client (for example one built with a fake fetch) until reset. */
export function usePaddleClientForTests(config: PaddleConfig, client: PaddleApiClient): void {
  cached = { config, client };
}

/** For tests: drop the cached client so the next call rebuilds it from the current env. */
export function resetPaddleClientForTests(): void {
  cached = undefined;
}
