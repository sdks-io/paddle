/**
 * The one Paddle API client for the whole server process.
 *
 * - SERVER ONLY. Never import this file from browser code. The API key it
 *   holds can create charges and refunds. Paddle also blocks API calls made
 *   from browsers; the browser uses a client-side token with Paddle.js instead.
 * - Built once and reused. Resources on the client are memoized getters, so
 *   rebuilding the client per request throws that away.
 * - The environment is explicit: the base URL comes from loadPaddleConfig(),
 *   which derives it from PADDLE_ENV and refuses a key that does not match.
 */
import { PaddleApiClient } from "paddle-apimatic-sdk";
import { loadPaddleConfig, type PaddleConfig } from "./config.js";

let cached: { config: PaddleConfig; client: PaddleApiClient } | undefined;

export function getPaddleConfig(): PaddleConfig {
  return getPaddle().config;
}

export function getPaddleClient(): PaddleApiClient {
  return getPaddle().client;
}

function getPaddle(): { config: PaddleConfig; client: PaddleApiClient } {
  if (!cached) {
    const config = loadPaddleConfig();
    const client = new PaddleApiClient({
      bearerAuth: config.apiKey,
      serverOptions: { baseUrl: config.apiBaseUrl },
      // Retry settings -> typescript-configuration-resilience.
      // Paddle documents no idempotency key, so POST and PATCH are deliberately
      // NOT added to httpMethodsToRetry: a repeated POST /transactions would
      // create a second transaction. See checkout.ts.
      retry: { maxRetries: 3, timeout: 30_000 },
    });
    cached = { config, client };
  }
  return cached;
}

/** For tests: drop the cached client so the next call rebuilds it from the current env. */
export function resetPaddleClientForTests(): void {
  cached = undefined;
}
