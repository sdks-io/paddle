/**
 * PaddleStore for PostgreSQL with node-postgres (`npm install pg`, `npm install -D @types/pg`),
 * against the tables in templates/db/schema.sql. Run schema.sql once (it is idempotent:
 * CREATE ... IF NOT EXISTS) with the project's migration tool, then:
 *
 *   import pg from "pg";
 *   const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
 *   pool.on("error", (err) => logger.error({ err }, "idle database connection failed")); // without it, node-postgres ends the process
 *   const store = new PgPaddleStore(pool);
 *
 * If the project uses an ORM (Drizzle, Prisma, Kysely), port these statements to it and keep
 * the semantics documented in store.ts. Several app instances may share the database: every
 * write here is a single atomic statement or a transaction, and the webhook handler's writes
 * are idempotent, so two instances running the reprocess job at once do not double-apply.
 */
import type { Pool, PoolClient } from "pg";
import type {
  ClaimResult,
  EventFinalState,
  PaddleStore,
  PendingEvent,
  PendingPlanChange,
  PlanCatalogRow,
  PurchaseItem,
  PurchaseRow,
  SubscriptionRow,
  WriteKind,
} from "./store.js";

type Row = Record<string, unknown>;

const UNIQUE_VIOLATION = "23505";

export class PgPaddleStore implements PaddleStore {
  constructor(private readonly pool: Pool) {}

  // ------------------------------------------------------------- customers

  async getCustomerIdForUser(userId: string) {
    const r = await this.pool.query("SELECT paddle_customer_id FROM paddle_customers WHERE user_id = $1", [userId]);
    return (r.rows[0] as Row | undefined)?.["paddle_customer_id"] as string | undefined;
  }

  async getUserIdForCustomer(paddleCustomerId: string) {
    const r = await this.pool.query("SELECT user_id FROM paddle_customers WHERE paddle_customer_id = $1", [paddleCustomerId]);
    return (r.rows[0] as Row | undefined)?.["user_id"] as string | undefined;
  }

  async linkCustomer(userId: string, paddleCustomerId: string, email: string | null) {
    try {
      await this.pool.query(
        `INSERT INTO paddle_customers (user_id, paddle_customer_id, email) VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE
           SET paddle_customer_id = EXCLUDED.paddle_customer_id,
               email = COALESCE(EXCLUDED.email, paddle_customers.email),
               updated_at = now()`,
        [userId, paddleCustomerId, email],
      );
    } catch (err) {
      if (pgCode(err) !== UNIQUE_VIOLATION) throw err;
      // Two events for the same customer can link the same pair at the same moment; that is not a conflict.
      if ((await this.getUserIdForCustomer(paddleCustomerId)) === userId) return;
      // UNIQUE(paddle_customer_id): the customer belongs to another user. Never move it.
      throw new Error(`${paddleCustomerId} is already linked to another user`, { cause: err });
    }
  }

  async assignUserToCustomerRows(userId: string, paddleCustomerId: string) {
    const subs = await this.pool.query("UPDATE paddle_subscriptions SET user_id = $1, updated_at = now() WHERE paddle_customer_id = $2 AND user_id IS NULL", [userId, paddleCustomerId]);
    const purchases = await this.pool.query("UPDATE paddle_purchases SET user_id = $1, updated_at = now() WHERE paddle_customer_id = $2 AND user_id IS NULL", [userId, paddleCustomerId]);
    return (subs.rowCount ?? 0) + (purchases.rowCount ?? 0);
  }

  // ------------------------------------------------------------- webhook bookkeeping

  async recordEvent(event: { eventId: string; eventType: string; occurredAt: Date; payload: unknown }) {
    const r = await this.pool.query(
      `INSERT INTO paddle_webhook_events (event_id, event_type, occurred_at, payload)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (event_id) DO UPDATE SET received_at = now()
         WHERE paddle_webhook_events.processed_at IS NULL
       RETURNING event_id`,
      [event.eventId, event.eventType, event.occurredAt, JSON.stringify(event.payload)],
    );
    return r.rowCount === 1;
  }

  async markEventProcessed(eventId: string, note?: string) {
    await this.pool.query(
      "UPDATE paddle_webhook_events SET processed_at = now(), final_state = NULL, error = $2 WHERE event_id = $1",
      [eventId, note ?? null],
    );
  }

  async markEventFailed(eventId: string, error: string) {
    await this.pool.query(
      "UPDATE paddle_webhook_events SET attempts = attempts + 1, last_attempt_at = now(), error = $2 WHERE event_id = $1 AND processed_at IS NULL",
      [eventId, error],
    );
  }

  async markEventFinal(eventId: string, state: EventFinalState, error: string) {
    await this.pool.query(
      "UPDATE paddle_webhook_events SET final_state = $2, error = $3, last_attempt_at = now() WHERE event_id = $1 AND processed_at IS NULL",
      [eventId, state, error],
    );
  }

  async leasePendingEvents(options: { maxAttempts: number; limit: number; leaseMs: number }): Promise<PendingEvent[]> {
    // One statement: pick due rows nobody else holds, and stamp them so no other caller takes them within the lease.
    const r = await this.pool.query(
      `UPDATE paddle_webhook_events SET last_attempt_at = now()
       WHERE event_id IN (
         SELECT event_id FROM paddle_webhook_events
         WHERE processed_at IS NULL AND final_state IS NULL AND attempts < $1
           AND received_at <= now() - $3 * interval '1 millisecond'
           AND (last_attempt_at IS NULL OR last_attempt_at <= now() - $3 * interval '1 millisecond')
         ORDER BY occurred_at ASC LIMIT $2
         FOR UPDATE SKIP LOCKED)
       RETURNING event_id, event_type, payload, attempts, occurred_at`,
      [options.maxAttempts, options.limit, options.leaseMs],
    );
    const rows = (r.rows as Row[]).sort((a, b) => (a["occurred_at"] as Date).getTime() - (b["occurred_at"] as Date).getTime());
    return rows.map((row) => ({
      eventId: row["event_id"] as string,
      eventType: row["event_type"] as string,
      payload: row["payload"],
      attempts: row["attempts"] as number,
    }));
  }

  async reopenEvents(state: EventFinalState | "ignored", options: { since?: Date } = {}) {
    const r =
      state === "ignored"
        ? await this.pool.query(
            `UPDATE paddle_webhook_events SET processed_at = NULL, attempts = 0, last_attempt_at = NULL
             WHERE processed_at IS NOT NULL AND error LIKE 'ignored:%'
               AND (event_type LIKE 'subscription.%' OR event_type = 'transaction.completed' OR event_type LIKE 'adjustment.%')
               AND ($1::timestamptz IS NULL OR received_at >= $1)`,
            [options.since ?? null],
          )
        : await this.pool.query(
            "UPDATE paddle_webhook_events SET final_state = NULL, attempts = 0, last_attempt_at = NULL WHERE final_state = $1 AND processed_at IS NULL",
            [state],
          );
    return r.rowCount ?? 0;
  }

  async parkExhaustedEvents(maxAttempts: number) {
    const r = await this.pool.query(
      `UPDATE paddle_webhook_events SET final_state = 'gave_up'
       WHERE processed_at IS NULL AND final_state IS NULL AND attempts >= $1
       RETURNING event_id, event_type, error`,
      [maxAttempts],
    );
    return (r.rows as Row[]).map((row) => ({ eventId: row["event_id"] as string, eventType: row["event_type"] as string, error: (row["error"] as string | null) ?? "" }));
  }

  // ------------------------------------------------------------- subscriptions

  async upsertSubscription(row: SubscriptionRow) {
    // Newer-wins: the WHERE skips the update when the stored row reflects a later event.
    await this.pool.query(
      `INSERT INTO paddle_subscriptions (id, user_id, paddle_customer_id, status, price_ids, product_ids, quantity,
         current_period_starts_at, current_period_ends_at, next_billed_at, scheduled_change_action,
         scheduled_change_effective_at, collection_mode, custom_data, last_event_occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15)
       ON CONFLICT (id) DO UPDATE SET
         user_id = COALESCE(EXCLUDED.user_id, paddle_subscriptions.user_id),
         paddle_customer_id = EXCLUDED.paddle_customer_id, status = EXCLUDED.status,
         price_ids = EXCLUDED.price_ids, product_ids = EXCLUDED.product_ids, quantity = EXCLUDED.quantity,
         current_period_starts_at = EXCLUDED.current_period_starts_at, current_period_ends_at = EXCLUDED.current_period_ends_at,
         next_billed_at = EXCLUDED.next_billed_at, scheduled_change_action = EXCLUDED.scheduled_change_action,
         scheduled_change_effective_at = EXCLUDED.scheduled_change_effective_at, collection_mode = EXCLUDED.collection_mode,
         custom_data = EXCLUDED.custom_data, last_event_occurred_at = EXCLUDED.last_event_occurred_at, updated_at = now()
       WHERE paddle_subscriptions.last_event_occurred_at <= EXCLUDED.last_event_occurred_at`,
      [
        row.id, row.userId, row.paddleCustomerId, row.status, row.priceIds, row.productIds, row.quantity,
        row.currentPeriodStartsAt, row.currentPeriodEndsAt, row.nextBilledAt, row.scheduledChangeAction,
        row.scheduledChangeEffectiveAt, row.collectionMode, row.customData === null ? null : JSON.stringify(row.customData), row.lastEventOccurredAt,
      ],
    );
  }

  async getSubscription(id: string) {
    const r = await this.pool.query("SELECT * FROM paddle_subscriptions WHERE id = $1", [id]);
    const row = r.rows[0] as Row | undefined;
    return row ? toSubscription(row) : undefined;
  }

  async listSubscriptionsForUser(userId: string) {
    const r = await this.pool.query("SELECT * FROM paddle_subscriptions WHERE user_id = $1", [userId]);
    return (r.rows as Row[]).map(toSubscription);
  }

  // ------------------------------------------------------------- one-time purchases

  async upsertPurchase(row: PurchaseRow) {
    await this.inTransaction(async (c) => {
      const r = await c.query(
        `INSERT INTO paddle_purchases (transaction_id, user_id, paddle_customer_id, custom_data, completed_at, last_event_occurred_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6)
         ON CONFLICT (transaction_id) DO UPDATE SET
           user_id = COALESCE(EXCLUDED.user_id, paddle_purchases.user_id),
           paddle_customer_id = EXCLUDED.paddle_customer_id, custom_data = EXCLUDED.custom_data,
           completed_at = EXCLUDED.completed_at, last_event_occurred_at = EXCLUDED.last_event_occurred_at, updated_at = now()
         WHERE paddle_purchases.last_event_occurred_at <= EXCLUDED.last_event_occurred_at
         RETURNING transaction_id`,
        [row.transactionId, row.userId, row.paddleCustomerId, row.customData === null ? null : JSON.stringify(row.customData), row.completedAt, row.lastEventOccurredAt],
      );
      if (r.rowCount !== 1) return; // an older event: keep what is stored
      for (const [position, item] of row.items.entries()) {
        // refunded_at is never overwritten here: refunds are recorded by markPurchaseItemsRefunded only.
        await c.query(
          `INSERT INTO paddle_purchase_items (transaction_id, position, line_item_id, price_id, product_id, quantity)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (transaction_id, position) DO UPDATE SET
             line_item_id = EXCLUDED.line_item_id, price_id = EXCLUDED.price_id,
             product_id = EXCLUDED.product_id, quantity = EXCLUDED.quantity`,
          [row.transactionId, position, item.lineItemId, item.priceId, item.productId, item.quantity],
        );
      }
      await c.query("DELETE FROM paddle_purchase_items WHERE transaction_id = $1 AND position >= $2", [row.transactionId, row.items.length]);
    });
  }

  async getPurchase(transactionId: string) {
    const r = await this.pool.query("SELECT * FROM paddle_purchases WHERE transaction_id = $1", [transactionId]);
    const row = r.rows[0] as Row | undefined;
    if (!row) return undefined;
    return (await this.withItems([row]))[0];
  }

  async listPurchasesForUser(userId: string) {
    const r = await this.pool.query("SELECT * FROM paddle_purchases WHERE user_id = $1 ORDER BY completed_at", [userId]);
    return this.withItems(r.rows as Row[]);
  }

  async markPurchaseItemsRefunded(transactionId: string, lineItemIds: string[] | "all", at: Date): Promise<PurchaseItem[]> {
    const r = await this.pool.query(
      `UPDATE paddle_purchase_items SET refunded_at = $3
       WHERE transaction_id = $1 AND refunded_at IS NULL AND ($2::text[] IS NULL OR line_item_id = ANY($2::text[]))
       RETURNING *`,
      [transactionId, lineItemIds === "all" ? null : lineItemIds, at],
    );
    return (r.rows as Row[]).map(toItem);
  }

  // ------------------------------------------------------------- write claims

  async claimWrite(claimKey: string, kind: WriteKind, userId: string | null): Promise<ClaimResult> {
    const inserted = await this.pool.query(
      "INSERT INTO paddle_write_claims (claim_key, kind, user_id) VALUES ($1, $2, $3) ON CONFLICT (claim_key) DO NOTHING RETURNING claim_key",
      [claimKey, kind, userId],
    );
    if (inserted.rowCount === 1) return { claimed: true };
    const r = await this.pool.query("SELECT result_id, created_at FROM paddle_write_claims WHERE claim_key = $1", [claimKey]);
    const row = r.rows[0] as Row | undefined;
    // Released between the two statements: claim again.
    if (!row) return this.claimWrite(claimKey, kind, userId);
    return { claimed: false, resultId: (row["result_id"] as string | null) ?? null, claimedAt: row["created_at"] as Date };
  }

  async completeClaim(claimKey: string, resultId: string) {
    await this.pool.query("UPDATE paddle_write_claims SET result_id = $2 WHERE claim_key = $1", [claimKey, resultId]);
  }

  async releaseClaim(claimKey: string) {
    await this.pool.query("DELETE FROM paddle_write_claims WHERE claim_key = $1", [claimKey]);
  }

  async retakeClaim(claimKey: string, seen: { resultId: string | null; claimedAt: Date }) {
    // Succeeds only while the row is still what the caller saw (timestamps compared to the millisecond the driver returns).
    const r = await this.pool.query(
      `UPDATE paddle_write_claims SET result_id = NULL, created_at = GREATEST(clock_timestamp(), created_at + interval '2 milliseconds')
       WHERE claim_key = $1 AND result_id IS NOT DISTINCT FROM $2 AND abs(extract(epoch FROM created_at - $3::timestamptz)) < 0.001`,
      [claimKey, seen.resultId, seen.claimedAt],
    );
    return r.rowCount === 1;
  }

  // ------------------------------------------------------------- plan catalog

  async getPlanByPriceId(priceId: string) {
    const r = await this.pool.query("SELECT * FROM plan_catalog WHERE price_id = $1", [priceId]);
    const row = r.rows[0] as Row | undefined;
    return row ? toPlan(row) : undefined;
  }

  async isClaimResult(resultId: string) {
    const r = await this.pool.query("SELECT 1 FROM paddle_write_claims WHERE result_id = $1 LIMIT 1", [resultId]);
    return r.rowCount === 1;
  }

  async listUnsettledClaims(olderThanMs: number) {
    const r = await this.pool.query(
      "SELECT claim_key, kind, user_id, created_at FROM paddle_write_claims WHERE result_id IS NULL AND created_at <= now() - $1 * interval '1 millisecond' ORDER BY created_at",
      [olderThanMs],
    );
    return (r.rows as Row[]).map((row) => ({
      claimKey: row["claim_key"] as string,
      kind: row["kind"] as WriteKind,
      userId: (row["user_id"] as string | null) ?? null,
      claimedAt: row["created_at"] as Date,
    }));
  }

  async isCatalogProduct(productId: string) {
    const r = await this.pool.query("SELECT 1 FROM plan_catalog WHERE product_id = $1 LIMIT 1", [productId]);
    return r.rowCount === 1;
  }

  async listPlans() {
    const r = await this.pool.query("SELECT * FROM plan_catalog WHERE active ORDER BY display_order, price_id");
    return (r.rows as Row[]).map(toPlan);
  }

  // ------------------------------------------------------------- credits

  async addCredits(entry: { userId: string; delta: number; reason: string; transactionId?: string; ref?: string }) {
    await this.pool.query(
      `INSERT INTO credit_ledger (user_id, delta, reason, transaction_id, ref) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (transaction_id, reason, ref) WHERE transaction_id IS NOT NULL DO NOTHING`,
      [entry.userId, entry.delta, entry.reason, entry.transactionId ?? null, entry.ref ?? ""],
    );
  }

  async getCreditBalance(userId: string) {
    const r = await this.pool.query("SELECT COALESCE(SUM(delta), 0)::int AS balance FROM credit_ledger WHERE user_id = $1", [userId]);
    return (r.rows[0] as Row)["balance"] as number;
  }

  // ------------------------------------------------------------- plan changes at the end of the term

  async savePendingPlanChange(change: PendingPlanChange) {
    await this.pool.query(
      `INSERT INTO paddle_pending_plan_changes (subscription_id, user_id, items, renewal_at, apply_after, requested_at, applied_at, canceled_at, note)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (subscription_id) DO UPDATE SET
         user_id = EXCLUDED.user_id, items = EXCLUDED.items, renewal_at = EXCLUDED.renewal_at, apply_after = EXCLUDED.apply_after,
         requested_at = EXCLUDED.requested_at, applied_at = EXCLUDED.applied_at, canceled_at = EXCLUDED.canceled_at, note = EXCLUDED.note`,
      [change.subscriptionId, change.userId, JSON.stringify(change.items), change.renewalAt, change.applyAfter, change.requestedAt, change.appliedAt, change.canceledAt, change.note],
    );
  }

  async getPendingPlanChange(subscriptionId: string) {
    const r = await this.pool.query(
      "SELECT * FROM paddle_pending_plan_changes WHERE subscription_id = $1 AND applied_at IS NULL AND canceled_at IS NULL",
      [subscriptionId],
    );
    const row = r.rows[0] as Row | undefined;
    return row ? toPlanChange(row) : undefined;
  }

  async listDuePendingPlanChanges(dueBefore: Date) {
    const r = await this.pool.query(
      "SELECT * FROM paddle_pending_plan_changes WHERE applied_at IS NULL AND canceled_at IS NULL AND apply_after <= $1 ORDER BY apply_after",
      [dueBefore],
    );
    return (r.rows as Row[]).map(toPlanChange);
  }

  async finishPendingPlanChange(subscriptionId: string, outcome: "applied" | "canceled", at: Date, note?: string) {
    const column = outcome === "applied" ? "applied_at" : "canceled_at";
    const r = await this.pool.query(
      `UPDATE paddle_pending_plan_changes SET ${column} = $2, note = $3 WHERE subscription_id = $1 AND applied_at IS NULL AND canceled_at IS NULL`,
      [subscriptionId, at, note ?? null],
    );
    return r.rowCount === 1;
  }

  async replanPendingPlanChange(subscriptionId: string, renewalAt: Date, applyAfter: Date) {
    const r = await this.pool.query(
      "UPDATE paddle_pending_plan_changes SET renewal_at = $2, apply_after = $3 WHERE subscription_id = $1 AND applied_at IS NULL AND canceled_at IS NULL",
      [subscriptionId, renewalAt, applyAfter],
    );
    return r.rowCount === 1;
  }


  // ------------------------------------------------------------- helpers

  private async withItems(rows: Row[]): Promise<PurchaseRow[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r["transaction_id"] as string);
    const items = await this.pool.query("SELECT * FROM paddle_purchase_items WHERE transaction_id = ANY($1::text[]) ORDER BY transaction_id, position", [ids]);
    const byTxn = new Map<string, PurchaseItem[]>();
    for (const item of items.rows as Row[]) {
      const id = item["transaction_id"] as string;
      byTxn.set(id, [...(byTxn.get(id) ?? []), toItem(item)]);
    }
    return rows.map((r) => ({
      transactionId: r["transaction_id"] as string,
      userId: (r["user_id"] as string | null) ?? null,
      paddleCustomerId: (r["paddle_customer_id"] as string | null) ?? null,
      items: byTxn.get(r["transaction_id"] as string) ?? [],
      customData: (r["custom_data"] as Record<string, unknown> | null) ?? null,
      completedAt: r["completed_at"] as Date,
      lastEventOccurredAt: r["last_event_occurred_at"] as Date,
    }));
  }

  private async inTransaction(fn: (c: PoolClient) => Promise<void>): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await fn(c);
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }
}

function pgCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : undefined;
}

function toSubscription(r: Row): SubscriptionRow {
  return {
    id: r["id"] as string,
    userId: (r["user_id"] as string | null) ?? null,
    paddleCustomerId: r["paddle_customer_id"] as string,
    status: r["status"] as SubscriptionRow["status"],
    priceIds: r["price_ids"] as string[],
    productIds: r["product_ids"] as string[],
    quantity: r["quantity"] as number,
    currentPeriodStartsAt: (r["current_period_starts_at"] as Date | null) ?? null,
    currentPeriodEndsAt: (r["current_period_ends_at"] as Date | null) ?? null,
    nextBilledAt: (r["next_billed_at"] as Date | null) ?? null,
    scheduledChangeAction: (r["scheduled_change_action"] as SubscriptionRow["scheduledChangeAction"]) ?? null,
    scheduledChangeEffectiveAt: (r["scheduled_change_effective_at"] as Date | null) ?? null,
    collectionMode: (r["collection_mode"] as SubscriptionRow["collectionMode"]) ?? null,
    customData: (r["custom_data"] as Record<string, unknown> | null) ?? null,
    lastEventOccurredAt: r["last_event_occurred_at"] as Date,
  };
}

function toItem(r: Row): PurchaseItem {
  return {
    lineItemId: (r["line_item_id"] as string | null) ?? null,
    priceId: r["price_id"] as string,
    productId: r["product_id"] as string,
    quantity: r["quantity"] as number,
    refundedAt: (r["refunded_at"] as Date | null) ?? null,
  };
}

function toPlan(r: Row): PlanCatalogRow {
  return {
    priceId: r["price_id"] as string,
    productId: r["product_id"] as string,
    tierKey: r["tier_key"] as string,
    displayOrder: r["display_order"] as number,
    features: (r["features"] as Record<string, unknown>) ?? {},
    active: r["active"] as boolean,
  };
}

function toPlanChange(r: Row): PendingPlanChange {
  return {
    subscriptionId: r["subscription_id"] as string,
    userId: r["user_id"] as string,
    items: r["items"] as PendingPlanChange["items"],
    renewalAt: r["renewal_at"] as Date,
    applyAfter: r["apply_after"] as Date,
    requestedAt: r["requested_at"] as Date,
    appliedAt: (r["applied_at"] as Date | null) ?? null,
    canceledAt: (r["canceled_at"] as Date | null) ?? null,
    note: (r["note"] as string | null) ?? null,
  };
}
