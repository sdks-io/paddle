-- Paddle Billing: tables the app keeps. PostgreSQL syntax; store.pg.ts implements PaddleStore
-- against exactly these tables. With an ORM (Drizzle, Prisma, Kysely), translate them and keep
-- the column meanings and constraints.
--
-- Rule: Paddle owns products, prices, customers, transactions, subscriptions,
-- adjustments and discounts. The app stores Paddle IDs, the mapping to its own
-- users, and the few status fields it needs to decide access without calling
-- Paddle on every request. Everything else is read from Paddle when needed.

-- Your user -> Paddle customer. One Paddle customer per user (Paddle requires unique emails).
CREATE TABLE IF NOT EXISTS paddle_customers (
  user_id             TEXT PRIMARY KEY,                 -- your app's user id
  paddle_customer_id  TEXT NOT NULL UNIQUE,             -- ctm_...
  email               TEXT,                             -- null when the link was learned from a webhook
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Mirror of the subscription fields needed for access decisions. Written ONLY by
-- the webhook handler (subscription.created / subscription.updated and friends).
CREATE TABLE IF NOT EXISTS paddle_subscriptions (
  id                          TEXT PRIMARY KEY,         -- sub_...
  user_id                     TEXT,                     -- resolved from custom_data.user_id or paddle_customers
  paddle_customer_id          TEXT NOT NULL,            -- ctm_...
  status                      TEXT NOT NULL,            -- active | trialing | past_due | paused | canceled
  price_ids                   TEXT[] NOT NULL,          -- items[].price.id (pri_...), the tier is derived from these
  product_ids                 TEXT[] NOT NULL,          -- items[].price.product_id (pro_...)
  quantity                    INTEGER NOT NULL DEFAULT 1, -- items[0].quantity, e.g. seats
  current_period_starts_at    TIMESTAMPTZ,              -- null when paused/canceled
  current_period_ends_at      TIMESTAMPTZ,
  next_billed_at              TIMESTAMPTZ,              -- null when a cancel is scheduled (and for cardless trials)
  scheduled_change_action     TEXT,                     -- cancel | pause | resume | null
  scheduled_change_effective_at TIMESTAMPTZ,
  collection_mode             TEXT,                     -- automatic | manual
  custom_data                 JSONB,
  last_event_occurred_at      TIMESTAMPTZ NOT NULL,     -- occurred_at of the last webhook applied; older events are ignored
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS paddle_subscriptions_user_idx ON paddle_subscriptions (user_id);
CREATE INDEX IF NOT EXISTS paddle_subscriptions_customer_idx ON paddle_subscriptions (paddle_customer_id);

-- One-time purchases, fulfilled from transaction.completed (never from transaction.paid or the success page).
CREATE TABLE IF NOT EXISTS paddle_purchases (
  transaction_id        TEXT PRIMARY KEY,               -- txn_...
  user_id               TEXT,
  paddle_customer_id    TEXT,
  custom_data           JSONB,
  completed_at          TIMESTAMPTZ NOT NULL,
  last_event_occurred_at TIMESTAMPTZ NOT NULL,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS paddle_purchases_user_idx ON paddle_purchases (user_id);
CREATE INDEX IF NOT EXISTS paddle_purchases_customer_idx ON paddle_purchases (paddle_customer_id);

-- The one-time lines of each purchase. A refund or chargeback marks lines, so one line of a
-- multi-item purchase can be revoked while the others stay.
CREATE TABLE IF NOT EXISTS paddle_purchase_items (
  transaction_id  TEXT NOT NULL REFERENCES paddle_purchases (transaction_id) ON DELETE CASCADE,
  position        INTEGER NOT NULL,                     -- order in the transaction
  line_item_id    TEXT,                                 -- txnitm_... (details.line_items[].id); refunds name it
  price_id        TEXT NOT NULL,                        -- pri_...
  product_id      TEXT NOT NULL,                        -- pro_...; one-time access checks are by product
  quantity        INTEGER NOT NULL,
  refunded_at     TIMESTAMPTZ,                          -- set by an approved refund or a chargeback
  PRIMARY KEY (transaction_id, position)
);

-- Every webhook event once. event_id is Paddle's deduplication key (delivery is at-least-once).
-- processed_at NULL and final_state NULL = to be processed (new, or failed and waiting for the
-- reprocess job). final_state parks an event the job must not retry until someone reopens it.
CREATE TABLE IF NOT EXISTS paddle_webhook_events (
  event_id        TEXT PRIMARY KEY,                     -- evt_... (ntfsimevt_... for simulations)
  event_type      TEXT NOT NULL,                        -- e.g. subscription.updated
  occurred_at     TIMESTAMPTZ NOT NULL,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at    TIMESTAMPTZ,                          -- null until the handler finished without error
  attempts        INTEGER NOT NULL DEFAULT 0,           -- failed processing attempts
  last_attempt_at TIMESTAMPTZ,
  final_state     TEXT,                                 -- null | 'undecodable' | 'gave_up'
  error           TEXT,                                 -- last error, or why nothing was applied; cleared on success
  payload         JSONB NOT NULL                        -- raw body as received; the reprocess job decodes it again
);
CREATE INDEX IF NOT EXISTS paddle_webhook_events_pending_idx ON paddle_webhook_events (occurred_at)
  WHERE processed_at IS NULL AND final_state IS NULL;

-- Claims for provider writes (writes.ts). Paddle documents no idempotency key, so a key every
-- caller of the same operation computes the same stops a double submit or a retried job from
-- writing twice. Insert BEFORE the SDK call; store the created id after; delete it when Paddle
-- refused the write. A unique violation on insert means "another caller has this write".
-- Key conventions (one per kind, computed on the server, never taken from the browser):
--   transaction  checkout:<user>:<price>x<qty>[,...]    (checkoutClaimKey; reused only while the transaction is open)
--   transaction  trial:<user>:<price>                  (cardless trial)
--   customer     customer:<user>
--   transaction  quote:<quote id>                       (custom price for a catalog product)
--   refund       refund:<txn>:<'full' or line=amount list>
--   credit       credit:<txn>:<'full' or line=amount list>
--   charge       charge:<sub>:<usage period or order id>
--   discount     goodwill:<sub>:<ref>                     (one-cycle goodwill discount)
-- (webhook destinations are not claimed: Paddle allows one per URL, so paddle-setup.ts lists, then creates)
CREATE TABLE IF NOT EXISTS paddle_write_claims (
  claim_key   TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,                            -- transaction | customer | refund | credit | charge | discount | destination
  user_id     TEXT,
  result_id   TEXT,                                     -- txn_ / ctm_ / adj_ / ntfset_ / sub_ once known
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The app's own attributes for every price it sells, keyed by Paddle price id. Paddle has no
-- field for "features" or display order. Keep them here, never a copy of name/amount/interval:
-- read those from Paddle. Webhook events whose prices are not listed here belong to another app
-- on the same Paddle account and are ignored.
CREATE TABLE IF NOT EXISTS plan_catalog (
  price_id       TEXT PRIMARY KEY,                      -- pri_...
  product_id     TEXT NOT NULL,                         -- pro_...
  tier_key       TEXT NOT NULL,                         -- 'starter' | 'pro' | 'credits-100' ... what the price unlocks
  display_order  INTEGER NOT NULL DEFAULT 0,
  features       JSONB NOT NULL DEFAULT '{}'::jsonb,    -- limits and flags your code reads (e.g. {"credits": 100})
  active         BOOLEAN NOT NULL DEFAULT true
);

-- Only for the prepaid-credits pattern (recipe 03). Paddle does not meter usage;
-- the app keeps the balance. Append-only ledger; balance = sum(delta).
CREATE TABLE IF NOT EXISTS credit_ledger (
  id              BIGSERIAL PRIMARY KEY,
  user_id         TEXT NOT NULL,
  delta           INTEGER NOT NULL,                     -- +credits bought, -credits used
  reason          TEXT NOT NULL,                        -- 'purchase' | 'usage' | 'refund' | 'grant'
  transaction_id  TEXT,                                 -- txn_... for purchases and refunds
  ref             TEXT NOT NULL DEFAULT '',             -- what within the transaction: the line (txnitm_...) or the adjustment (adj_...)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- A redelivered webhook adds nothing; several packs in one checkout and several refunds of one
-- transaction each get their own ref. Usage rows (no transaction) are not constrained.
CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_once_idx ON credit_ledger (transaction_id, reason, ref) WHERE transaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS credit_ledger_user_idx ON credit_ledger (user_id);

-- Only for plan changes at the end of the term (recipe 04). Paddle cannot schedule an item
-- change, so the app keeps the request and applies it shortly before the renewal.
CREATE TABLE IF NOT EXISTS paddle_pending_plan_changes (
  subscription_id  TEXT PRIMARY KEY,                    -- sub_...; one open change per subscription
  user_id          TEXT NOT NULL,
  items            JSONB NOT NULL,                      -- [{ "priceId": "pri_...", "quantity": 1 }], the complete list
  renewal_at       TIMESTAMPTZ NOT NULL,                -- next_billed_at the change was planned against
  apply_after      TIMESTAMPTZ NOT NULL,                -- start of the window before renewal_at
  requested_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at       TIMESTAMPTZ,
  canceled_at      TIMESTAMPTZ,
  note             TEXT
);
CREATE INDEX IF NOT EXISTS paddle_pending_plan_changes_due_idx ON paddle_pending_plan_changes (apply_after)
  WHERE applied_at IS NULL AND canceled_at IS NULL;
