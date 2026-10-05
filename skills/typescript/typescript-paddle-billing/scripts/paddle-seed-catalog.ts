/**
 * Agent tool: create (or reuse) the products and prices the app sells.
 *
 * Run from the project root after the Paddle env vars are set:
 *   npx tsx scripts/paddle/paddle-seed-catalog.ts ./paddle-catalog.json
 *
 * Input file (edit with the user's real plans before running):
 * {
 *   "products": [
 *     { "key": "pro", "name": "Pro", "taxCategory": "saas", "description": "Pro plan",
 *       "prices": [
 *         { "key": "pro-monthly", "description": "Pro monthly", "amount": "1900", "currencyCode": "USD",
 *           "billingCycle": { "interval": "month", "frequency": 1 },
 *           "trialPeriod": { "interval": "day", "frequency": 14 } },
 *         { "key": "pro-yearly", "description": "Pro yearly", "amount": "19000", "currencyCode": "USD",
 *           "billingCycle": { "interval": "year", "frequency": 1 } }
 *       ] },
 *     { "key": "credits-100", "name": "100 credits", "taxCategory": "standard",
 *       "prices": [ { "key": "credits-100", "description": "100 credits", "amount": "1000", "currencyCode": "USD", "billingCycle": null } ] }
 *   ]
 * }
 *
 * Idempotent: each product/price carries custom_data.seed_key; a rerun finds
 * them by that key and updates instead of duplicating. Paddle cannot delete
 * catalog entities, so duplicates would be permanent clutter.
 *
 * Output: prints a JSON map { "<key>": "pri_..." | "pro_..." } and writes it to
 * paddle-catalog.ids.json. Store the price ids in plan_catalog (or env vars).
 * Exits non-zero on any failure.
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { Duration, PriceTrialDuration1, TaxCategory, CurrencyCode } from "paddle-apimatic-sdk";
import { getPaddleClient, getPaddleConfig } from "../../server/paddle/client.js";
import { paddleError } from "../../server/paddle/errors.js";
import { listAll } from "../../server/paddle/pagination.js";

interface SeedPrice {
  key: string;
  description: string;
  name?: string;
  amount: string;
  currencyCode: CurrencyCode;
  billingCycle: Duration | null;
  trialPeriod?: PriceTrialDuration1;
  taxMode?: "account_setting" | "internal" | "external" | "location";
  quantity?: { minimum?: number; maximum?: number };
}
interface SeedProduct {
  key: string;
  name: string;
  description?: string;
  taxCategory: TaxCategory;
  imageUrl?: string;
  prices: SeedPrice[];
}

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) throw new Error("usage: paddle-seed-catalog.ts <catalog.json>");
  const catalog = JSON.parse(readFileSync(file, "utf8")) as { products: SeedProduct[] };
  const config = getPaddleConfig();
  const client = getPaddleClient();
  console.error(`Seeding Paddle catalog in ${config.environment} (${config.apiBaseUrl})`);

  const existingProducts = await listAll((after) => client.products.listProducts({ status: ["active", "archived"], perPage: 200, after }));
  const existingPrices = await listAll((after) => client.prices.listPrices({ status: ["active", "archived"], perPage: 200, after }));
  const seedKey = (customData: Record<string, unknown> | null | undefined) =>
    typeof customData?.["seed_key"] === "string" ? (customData["seed_key"] as string) : undefined;

  const ids: Record<string, string> = {};

  for (const p of catalog.products) {
    let product = existingProducts.find((e) => seedKey(e.customData) === p.key);
    if (product) {
      const updated = await client.products.updateProduct({
        productId: product.id,
        body: { name: p.name, description: p.description, taxCategory: p.taxCategory, imageUrl: p.imageUrl, status: "active" },
      });
      product = updated.data;
      console.error(`= product ${p.key} ${product.id} (updated)`);
    } else {
      const created = await client.products.createProduct({
        body: { name: p.name, description: p.description, taxCategory: p.taxCategory, imageUrl: p.imageUrl, customData: { seed_key: p.key } },
      });
      product = created.data;
      console.error(`+ product ${p.key} ${product.id}`);
    }
    ids[p.key] = product.id;

    for (const pr of p.prices) {
      const found = existingPrices.find((e) => seedKey(e.customData) === pr.key && e.productId === product!.id);
      if (found) {
        // Advice: when a plan already has subscribers, prefer creating a new price and archiving the old one over
        // editing unit_price/billing_cycle/trial_period in place, so existing terms are unambiguous.
        const updated = await client.prices.updatePrice({
          priceId: found.id,
          body: {
            description: pr.description,
            name: pr.name,
            unitPrice: { amount: pr.amount, currencyCode: pr.currencyCode },
            billingCycle: pr.billingCycle ?? undefined,
            trialPeriod: pr.trialPeriod,
            taxMode: pr.taxMode,
            quantity: pr.quantity,
            status: "active",
          },
        });
        ids[pr.key] = updated.data.id;
        console.error(`  = price ${pr.key} ${updated.data.id} (updated)`);
      } else {
        const created = await client.prices.createPrice({
          body: {
            productId: product.id,
            description: pr.description,
            name: pr.name,
            unitPrice: { amount: pr.amount, currencyCode: pr.currencyCode },
            billingCycle: pr.billingCycle ?? undefined, // omit for one-time prices
            trialPeriod: pr.trialPeriod,
            taxMode: pr.taxMode,
            quantity: pr.quantity,
            customData: { seed_key: pr.key },
          },
        });
        ids[pr.key] = created.data.id;
        console.error(`  + price ${pr.key} ${created.data.id}`);
      }
    }
  }

  writeFileSync("paddle-catalog.ids.json", JSON.stringify(ids, null, 2));
  console.log(JSON.stringify(ids, null, 2));
}

main().catch((err) => {
  const info = paddleError(err);
  if (info) {
    console.error(`Paddle error ${info.status} ${info.code ?? ""}: ${info.detail ?? ""} (request_id ${info.requestId ?? "n/a"})`);
    for (const fe of info.fieldErrors) console.error(`  - ${fe.field}: ${fe.message}`);
    if (info.code === "product_tax_category_not_approved") {
      console.error("  Only 'standard' and 'saas' tax categories are enabled by default. Ask the account owner to request others under Paddle > Settings > Taxable categories, or use 'saas'/'standard'.");
    }
  } else {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  }
  process.exit(1);
});
