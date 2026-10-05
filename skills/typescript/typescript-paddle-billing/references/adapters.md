# Adapters: frameworks and hosting platforms

The core (`templates/server/paddle/*`) is framework-free. These notes cover what changes per framework and per hosting platform. For a platform not listed, apply the same points with that platform's secret store, database and deployment domain.

## Express (or Fastify/Koa with equivalent raw-body handling)

```ts
import express from "express";
import { paddleWebhookRoute } from "./server/paddle/webhooks/express.js";
import { PaddleWebhookHandler } from "./server/paddle/webhooks/handler.js";
import { getPaddleConfig } from "./server/paddle/client.js";

const app = express();
const handler = new PaddleWebhookHandler(getPaddleConfig(), store, hooks, (msg, extra) => logger.warn({ ...extra }, msg));

// 1. webhook first, raw body
app.post("/api/paddle/webhook", express.raw({ type: "application/json" }), paddleWebhookRoute(handler));
// 2. then JSON for everything else
app.use(express.json());
app.get("/api/billing/entitlement", requireAuth, async (req, res) => res.json(await getEntitlement(store, req.user.id)));
app.post("/api/billing/portal", requireAuth, async (req, res) => {
  const customerId = await ensureCustomer(store, req.user.id, req.user.email, { emailVerified: req.user.emailVerified });
  res.json(await createPortalSession(customerId));
});
```

Static `pay.html` at the default payment link path. Map `PaywallError` to 402 in your error middleware; use `toHttpAnswer(err)` for Paddle failures. Serve the frontend's client token from a public env var (Vite: `import.meta.env.VITE_PADDLE_CLIENT_TOKEN`).

## Next.js (App Router)

- Server modules in `lib/paddle/`; the Paddle client is used only in route handlers and server actions, never in client components.
- Webhook: `app/api/paddle/webhook/route.ts` exporting `POST` from `createPaddleWebhookRoute(() => handler)`. Node runtime (default); do not set `runtime = "edge"`. Serverless functions can be frozen after the response, so the template processes inline (fast) or you enqueue to a durable queue before returning.
- Entitlement: a route handler `app/api/billing/entitlement/route.ts`, or read `getEntitlement` directly in server components for gating pages.
- Public env: `NEXT_PUBLIC_PADDLE_CLIENT_TOKEN`, `NEXT_PUBLIC_PADDLE_ENV`. `PaddleCheckoutButton.tsx` is a client component; it starts with `"use client"`, which other React setups ignore.
- Default payment link page: `app/pay/page.tsx` rendering the Paddle.js script (or the static `pay.html` in `public/`).
- Paddle also publishes a Next.js starter kit and React components (`@paddle/inline-checkout` via the shadcn registry); they are compatible with this flow but not required.

## Replit

- Secrets: the user adds `PADDLE_API_KEY` and `PADDLE_WEBHOOK_SECRET` in Replit's Secrets tool (never in `.replit` or code); in the API key message, name that tool as the place to store it. `PADDLE_ENV` and the public `PADDLE_CLIENT_TOKEN` are plain env vars the agent sets.
- Development URL: the dev preview URL changes and is not stable; create a webhook destination for the current dev URL only while testing, and delete it afterwards (10 active destinations max). In sandbox no domain approval is needed, so checkout works from the dev URL.
- Deployment: the deployed app has a stable `*.replit.app` (or custom) domain. Use that for the production destination and default payment link. For **live**, Paddle approves each domain and subdomain individually and reviews the site content; Paddle's docs do not mention Replit or wildcard domains, so submit the exact deployment domain and expect the standard review (automatic or 5–7 business days). A custom domain avoids tying approval to the `replit.app` subdomain.
- Preview iframes can block third-party checkout frames: test the checkout in a full browser tab.
- Database: use the Replit PostgreSQL database for the tables in `schema.sql`; never an in-memory store (webhook state must survive restarts).
- Scripts: run with `npx tsx scripts/paddle/<name>.ts` from the workspace shell; they read Secrets as env vars.
