# Credentials and environment

*Read this before the first Paddle call (build step 0), and again at go-live.*

Four values connect the app to Paddle. Who creates each one, and where it goes:

| Credential | Created by | Stored as | Stored by |
| --- | --- | --- | --- |
| API key (`pdl_sdbx_apikey_…`) | **The user**, in the Paddle dashboard. Paddle has no API that creates API keys, and the agent has no key before this step. | `PADDLE_API_KEY` in the platform's secret store | **The user** |
| Client-side token (`test_…`) | **The agent**, once the API key works: `paddle-setup.ts client-token` reuses or creates it (`client.clientTokens`; fields: `map/operations/client-tokens.md`) | `PADDLE_CLIENT_TOKEN` in `.env`, plus the frontend's public name (`--public-var`) | **The agent** (the script). The token is public by design: it can only open checkouts and preview prices |
| Webhook secret (`pdl_ntfset_…`) | **The agent**, once the webhook URL is public: `paddle-setup.ts webhook <url>` reuses the destination for that URL or creates it, with `trafficSource: "all"` and the event list in `references/webhooks.md` (`client.notificationSettings`; fields: `map/operations/notification-settings.md`) | `PADDLE_WEBHOOK_SECRET` in `.env` (git-ignored, owner-only permissions). On a platform that reads secrets only from its own store, move it there (`references/adapters.md`) | **The agent** (the script). The script writes the secret and never prints it; never echo, `cat` or log `.env`, and never paste the secret into chat |
| Environment (`sandbox` / `production`) | **The agent** | `PADDLE_ENV`, a plain env var | **The agent**. Starts as `sandbox` |

Order: (1) send the user the API key message from `references/user-messages.md` and wait for "done"; (2) run `paddle-inspect.ts whoami`, which proves the key works without the agent ever seeing it; (3) run `paddle-setup.ts client-token`; (4) once the webhook URL exists (SKILL.md section 9 step 4), run `paddle-setup.ts webhook <url>` and restart the server so it reads the secret.

API key permissions (the user ticks these when creating the key; write includes read):

| Permission | Needed for |
| --- | --- |
| `product.write`, `price.write` | the seed script creates and updates the catalog |
| `customer.write`, `address.write` | `ensureCustomer`, addresses for invoices and cardless trials |
| `transaction.write` | server-created checkouts, invoice PDFs, previews |
| `subscription.write` | plan changes, cancel, pause, one-off charges |
| `customer_portal_session.write`, `customer_auth_token.write` | portal links, saved payment methods at checkout |
| `client_token.write` | the agent creates the client-side token |
| `notification_setting.write`, `notification.read`, `notification_simulation.write` | webhook destination, delivery checks, simulations |
| `adjustment.write` (refunds), `discount.write` (discount codes), `report.write` and `metrics.read` (back-office) | only when those recipes are in scope |

A missing permission returns 403 `forbidden`; the fix is a new key with that permission, created by the user.

Server env vars (names are fixed; `templates/server/paddle/config.ts` reads them and fails fast on a mismatch; wiring the base URL into the client → `typescript-configuration-resilience`, failing on a missing key → `typescript-authentication`):

| Var | Value |
| --- | --- |
| `PADDLE_ENV` | `sandbox` or `production`; `client.ts` maps it to `ServerEnvironment.Sandbox` (`https://sandbox-api.paddle.com`) or `ServerEnvironment.Production` (`https://api.paddle.com`) |
| `PADDLE_API_KEY` | `pdl_sdbx_apikey_…` in sandbox, `pdl_live_apikey_…` in production; a key from the other environment is refused at startup |
| `PADDLE_WEBHOOK_SECRET` | `pdl_ntfset_…` of the destination for this deployment |
| `PADDLE_API_URL` | optional override of the base URL of the selected environment |
| `PADDLE_WEBHOOK_TOLERANCE_SECONDS` | optional; maximum age of a webhook signature (default 5) |
| `DATABASE_URL` | the PostgreSQL database `store.pg.ts` and `paddle-jobs.ts` use (or the project's own connection setting) |

Browser var (public, with the framework's public prefix): `PADDLE_CLIENT_TOKEN` = `test_…` or `live_…`, plus `PADDLE_ENV` for `initializePaddle({ environment })`.

Rules: secrets are read from the environment or the platform's secret store at runtime, never written in source, config files, chat messages or logs; the API key never reaches the browser bundle (Paddle also blocks API calls from browsers); sandbox and live are separate accounts with separate keys, tokens, catalog and destinations; API keys expire, so subscribe to `api_key.expiring` or put a calendar reminder, and rotate by creating the new key, deploying it, then revoking the old one.
