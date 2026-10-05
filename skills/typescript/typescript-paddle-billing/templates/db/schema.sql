-- Paddle Billing: tables the app keeps. PostgreSQL syntax; translate to your ORM
-- (Drizzle, Prisma, Kysely) or database, keeping the column meanings.
--
-- Rule: Paddle owns products, prices, customers, transactions, subscriptions,
-- adjustments and discounts. The app stores Paddle IDs, the mapping to its own
-- users, and the few status fields it needs to decide access without calling
-- Paddle on every request. Everything else is read from Paddle when needed.

-- Your user -> Paddle customer. One Paddle customer per user (Paddle requires unique emails).
CREATE TABLE paddle_customers (
  user_id             TEXT PRIMARY KEY,                 -- your app's user id
  paddle_customer_id  TEXT NOT NULL UNIQUE,             -- ctm_...
  email               TEXT,                             -- null when the link was learned from a webhook
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Mirror of the subscription fields needed for access decisions. Written ONLY by
-- the webhook handler (subscription.created / subscription.updated and friends).
CREATE TABLE paddle_subscriptions (
  id                          TEXT PRIMARY KEY,         -- sub_...
  user_id                     TEXT,                     -- resolved from custom_data.user_id or paddle_customers
  paddle_customer_id          TEXT NOT NULL,            -- ctm_...
  status                      TEXT NOT NULL,            -- active | trialing | past_due | paused | canceled
  price_ids                   TEXT[] NOT NULL,          -- items[].price.id (pri_...), the tier is derived from these
  product_ids                 TEXT[] NOT NULL,          -- items[].price.product_id (pro_...)
  quantity                    INTEGER NOT NULL DEFAULT 1, -- items[0].quantity, e.g. seats
  current_period_starts_at    TIMESTAMPTZ,              -- null when paused/canceled
  current_period_ends_at      TIMESTAMPTZ,
  next_billed_at              TIMESTAMPTZ,              -- null when a cancel is scheduled (and for cardless trials); check the payload for paused/canceled
  scheduled_change_action     TEXT,                     -- cancel | pause | resume | null
  scheduled_change_effective_at TIMESTAMPTZ,
  collection_mode             TEXT,                       -- automatic | manual
  custom_data                 JSONB,
  last_event_occurred_at      TIMESTAMPTZ NOT NULL,     -- occurred_at of the last webhook applied; older events are ignored
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX paddle_subscriptions_user_idx ON paddle_subscriptions (user_id);
CREATE INDEX paddle_subscriptions_customer_idx ON paddle_subscriptions (paddle_customer_id);

-- One-time purchases, fulfilled from transaction.completed (never from transaction.paid or the success page).
CREATE TABLE paddle_purchases (
  transaction_id        TEXT PRIMARY KEY,               -- txn_...
  user_id               TEXT,
  paddle_customer_id    TEXT,
  status                TEXT NOT NULL,                  -- completed (only completed rows grant anything)
  price_ids             TEXT[] NOT NULL,
  product_ids           TEXT[] NOT NULL,
  custom_data           JSONB,
  completed_at          TIMESTAMPTZ,
  last_event_occurred_at TIMESTAMPTZ NOT NULL,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX paddle_purchases_user_idx ON paddle_purchases (user_id);

-- Every webhook event once. event_id is Paddle's deduplication key (delivery is at-least-once).
-- A row with processed_at NULL is new or failed; a redelivery or a scheduled job processes it again.
CREATE TABLE paddle_webhook_events (
  event_id      TEXT PRIMARY KEY,                       -- evt_...
  event_type    TEXT NOT NULL,                          -- e.g. subscription.updated
  occurred_at   TIMESTAMPTZ NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at  TIMESTAMPTZ,                            -- null until the handler finished without error
  error         TEXT,                                   -- last processing error; cleared on success
  payload       JSONB NOT NULL
);
CREATE INDEX paddle_webhook_events_unprocessed_idx ON paddle_webhook_events (received_at) WHERE processed_at IS NULL;

-- Claim rows for server-created transactions. Paddle documents no idempotency key, so
-- a unique key the caller computes (e.g. order id) stops a double submit from
-- creating two transactions. Insert BEFORE calling createTransaction; store the
-- transaction id after; a unique-violation on insert means "already created".
CREATE TABLE paddle_transaction_claims (
  claim_key       TEXT PRIMARY KEY,                     -- e.g. 'order:1234' or 'user:42:price:pri_...:2026-10'
  user_id         TEXT NOT NULL,
  transaction_id  TEXT,                                 -- txn_... once known
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The app's own attributes per plan, keyed by Paddle price id. Paddle has no field
-- for "features" or display order. Keep them here (or in custom_data on the price
-- for small flags), never a copy of name/amount/interval: read those from Paddle.
CREATE TABLE plan_catalog (
  price_id       TEXT PRIMARY KEY,                      -- pri_...
  product_id     TEXT NOT NULL,                         -- pro_...
  tier_key       TEXT NOT NULL,                         -- 'starter' | 'pro' | ... used by access checks
  display_order  INTEGER NOT NULL DEFAULT 0,
  features       JSONB NOT NULL DEFAULT '{}'::jsonb,    -- limits and flags your code reads
  active         BOOLEAN NOT NULL DEFAULT true
);

-- Only for the prepaid-credits pattern (recipe 03). Paddle does not meter usage;
-- the app keeps the balance. Append-only ledger; balance = sum(delta).
CREATE TABLE credit_ledger (
  id              BIGSERIAL PRIMARY KEY,
  user_id         TEXT NOT NULL,
  delta           INTEGER NOT NULL,                     -- +credits bought, -credits used
  reason          TEXT NOT NULL,                        -- 'purchase' | 'usage' | 'refund' | 'grant'
  transaction_id  TEXT,                                 -- txn_... for purchases/refunds; UNIQUE per transaction+reason
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (transaction_id, reason)
);
CREATE INDEX credit_ledger_user_idx ON credit_ledger (user_id);
