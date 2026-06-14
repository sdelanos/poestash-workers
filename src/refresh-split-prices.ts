/**
 * Samples split-base prices from the PoE trade API into `split_base_prices`,
 * powering the Base Splitting flip strategy.
 *
 * For each (base, quality band) market it runs two searches: the clean
 * splittable base (split=false, the buy side) and the split-tagged comparable
 * (split=true, the sell side). Each side's cheapest listings are converted to
 * chaos and junk-trimmed to a floor (see lib/split-ladder). Uses any-status
 * listings: online-only ladders are too thin for quality bases outside league
 * launch weeks.
 *
 * Universe: every eligible weapon/armour base (src/data/split-bases.json) x 4
 * quality bands. Self-seeding via upsert, no separate seed step. Staleness
 * rotation with value pruning: a market whose split floor can clear the split
 * cost refreshes every 24h, everything else rotates every 72h, so the daily
 * trade-API budget concentrates where the flip can actually fire.
 *
 * Usage:
 *   npx tsx src/refresh-split-prices.ts [league]
 *
 * Designed to run every 6h via cron, processing oldest-first until the run
 * times out. Requires DATABASE_URL and POE_CLIENT_ID.
 */

import "dotenv/config";
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  SPLIT_QUALITY_BANDS,
  SPLIT_ILVL_FLOOR,
  type SplitQualityBandDef,
} from "./lib/split-quality-bands";
import { ladderFloorChaos, type ListingPrice } from "./lib/split-ladder";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TRADE_BASE = "https://www.pathofexile.com/api/trade";
// Rate limits: 5/10s, 15/60s, 30/300s. 30/300s binds. One request per ~10s.
const PAUSE_MS = 10_000;
const SAMPLE_SIZE = 10;

const userAgent = `OAuth ${process.env.POE_CLIENT_ID ?? "poestashapp"}/1.0.0 (contact: contact@poestash.com)`;

const CURRENCY_SLUGS: Record<string, string> = {
  chaos: "chaos orb",
  divine: "divine orb",
  exalted: "exalted orb",
  mirror: "mirror of kalandra",
};

/** Ingredient names (poe.ninja item_name) for the split-cost estimate that
 *  drives value pruning. */
const SPLIT_INGREDIENTS = {
  beast: "fenumal plagued arachnid",
  fossil: "fractured fossil",
  resonator: "primitive chaotic resonator",
};

const INFLUENCE_EXCLUSIONS = [
  "shaper_item",
  "elder_item",
  "crusader_item",
  "redeemer_item",
  "hunter_item",
  "warlord_item",
];

interface SplitBase {
  name: string;
  itemClass: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASES: SplitBase[] = JSON.parse(
  readFileSync(resolve(__dirname, "data/split-bases.json"), "utf8"),
);

// ---------------------------------------------------------------------------
// Trade API
// ---------------------------------------------------------------------------

interface SideResult {
  listingCount: number;
  floorChaos: number | null;
  rateLimited?: number;
}

function buildQuery(
  baseType: string,
  band: SplitQualityBandDef,
  side: "buy" | "sell",
) {
  const quality: Record<string, number> = {};
  if (band.qualityMin != null) quality.min = band.qualityMin;
  if (band.qualityMax != null) quality.max = band.qualityMax;

  const miscFilters: Record<string, unknown> = {
    ilvl: { min: SPLIT_ILVL_FLOOR },
    quality,
    split: { option: side === "sell" ? "true" : "false" },
    corrupted: { option: "false" },
    mirrored: { option: "false" },
    fractured_item: { option: "false" },
    synthesised_item: { option: "false" },
  };
  for (const key of INFLUENCE_EXCLUSIONS) miscFilters[key] = { option: "false" };

  return {
    query: {
      status: { option: "any" },
      type: baseType,
      filters: {
        type_filters: { filters: { rarity: { option: "nonunique" } } },
        misc_filters: { filters: miscFilters },
      },
    },
    sort: { price: "asc" },
  };
}

async function sampleSide(
  league: string,
  baseType: string,
  band: SplitQualityBandDef,
  side: "buy" | "sell",
  currencyToChaos: Map<string, number>,
): Promise<SideResult> {
  const headers = { "User-Agent": userAgent, "Content-Type": "application/json" };

  const searchRes = await fetch(`${TRADE_BASE}/search/${encodeURIComponent(league)}`, {
    method: "POST",
    headers,
    body: JSON.stringify(buildQuery(baseType, band, side)),
    signal: AbortSignal.timeout(15_000),
  });

  if (searchRes.status === 429) {
    return { listingCount: 0, floorChaos: null, rateLimited: parseInt(searchRes.headers.get("Retry-After") ?? "60", 10) };
  }
  if (!searchRes.ok) throw new Error(`Search ${searchRes.status}: ${await searchRes.text()}`);

  const searchData: { id: string; total: number; result: string[] } = await searchRes.json();
  if (searchData.total === 0 || searchData.result.length === 0) {
    return { listingCount: 0, floorChaos: null };
  }

  await sleep(PAUSE_MS);

  const ids = searchData.result.slice(0, SAMPLE_SIZE).join(",");
  const fetchRes = await fetch(`${TRADE_BASE}/fetch/${ids}?query=${searchData.id}`, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });

  if (fetchRes.status === 429) {
    return { listingCount: searchData.total, floorChaos: null, rateLimited: parseInt(fetchRes.headers.get("Retry-After") ?? "60", 10) };
  }
  if (!fetchRes.ok) throw new Error(`Fetch ${fetchRes.status}: ${await fetchRes.text()}`);

  const fetchData: { result: ({ listing?: { price?: ListingPrice } } | null)[] } = await fetchRes.json();
  const listings: ListingPrice[] = [];
  for (const r of fetchData.result ?? []) {
    const price = r?.listing?.price;
    if (price?.amount != null && price.currency) listings.push(price);
  }

  return { listingCount: searchData.total, floorChaos: ladderFloorChaos(listings, currencyToChaos) };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

let stopping = false;
process.on("SIGINT", () => { console.log("\nGraceful shutdown (SIGINT)..."); stopping = true; });
process.on("SIGTERM", () => { console.log("\nGraceful shutdown (SIGTERM)..."); stopping = true; });

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface MarketState {
  base: SplitBase;
  band: SplitQualityBandDef;
  lastRefreshedAt: Date | null;
  /** Last sampled clean + split floors, for value pruning. The resale floor
   *  the app surfaces on is min(clean, split), so the pruning mirrors that. */
  cleanPriceChaos: number | null;
  splitPriceChaos: number | null;
}

async function main() {
  const args = process.argv.slice(2);
  const league = args.find((a) => !a.startsWith("--")) ?? "Mirage";
  // Optional cap on markets processed this run (operational safety + testing).
  const limitArg = args.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? parseInt(limitArg.split("=")[1], 10) : Infinity;

  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }

  const sql = postgres(process.env.DATABASE_URL, { idle_timeout: 30, max_lifetime: 300, connect_timeout: 10 });

  // Currency conversion + split-cost estimate from ninja_prices. Pull only the
  // currencies (for chaos conversion) and the three split ingredients, not the
  // whole ~40k-row league feed. PoE 1 only: this feature has no PoE 2 path.
  const ingredientNames = Object.values(SPLIT_INGREDIENTS);
  const priceRows = await sql<{ item_name: string; chaos_value: number; source: string }[]>`
    SELECT item_name, chaos_value, source FROM ninja_prices
    WHERE game = 'poe1' AND league = ${league}
      AND (ninja_category = 'Currency' OR item_name = ANY(${ingredientNames}))
  `;
  const best = new Map<string, number>();
  for (const r of priceRows) {
    // Prefer exchange source when both exist (matches app dedup).
    if (!best.has(r.item_name) || r.source === "exchange") best.set(r.item_name, r.chaos_value);
  }
  const currencyToChaos = new Map<string, number>([["chaos", 1]]);
  for (const [slug, ninjaName] of Object.entries(CURRENCY_SLUGS)) {
    const v = best.get(ninjaName);
    if (v) currencyToChaos.set(slug, v);
  }

  const beast = best.get(SPLIT_INGREDIENTS.beast);
  const fossil = best.get(SPLIT_INGREDIENTS.fossil);
  const resonator = best.get(SPLIT_INGREDIENTS.resonator);
  const costs: number[] = [];
  if (beast) costs.push(beast);
  if (fossil && resonator) costs.push(fossil + resonator);
  const splitCost = costs.length ? Math.min(...costs) : 80;
  if (costs.length === 0) {
    console.warn(
      `WARN: no split-ingredient prices in ninja_prices for ${league}; ` +
        `falling back to ${splitCost}c for value pruning (cadence only, not stored).`,
    );
  }
  console.log(`Split cost estimate: ${splitCost.toFixed(0)}c (divine=${currencyToChaos.get("divine")?.toFixed(0)}c)`);

  // Existing rows for staleness + value pruning.
  const existing = await sql<
    {
      base_type: string;
      quality_band: number;
      clean_price_chaos: number | null;
      split_price_chaos: number | null;
      last_refreshed_at: Date | null;
    }[]
  >`
    SELECT base_type, quality_band, clean_price_chaos, split_price_chaos, last_refreshed_at
    FROM split_base_prices WHERE league = ${league}
  `;
  const stateByKey = new Map<string, { clean: number | null; split: number | null; at: Date | null }>();
  for (const r of existing) {
    stateByKey.set(`${r.base_type}|${r.quality_band}`, {
      clean: r.clean_price_chaos,
      split: r.split_price_chaos,
      at: r.last_refreshed_at,
    });
  }

  // Full universe = bases x bands. DB base_type is the lowercased name (what
  // the app joins on); the proper-case name is reserved for the trade query.
  const markets: MarketState[] = [];
  for (const base of BASES) {
    for (const band of SPLIT_QUALITY_BANDS) {
      const st = stateByKey.get(`${base.name.toLowerCase()}|${band.key}`);
      markets.push({
        base,
        band,
        lastRefreshedAt: st?.at ?? null,
        cleanPriceChaos: st?.clean ?? null,
        splitPriceChaos: st?.split ?? null,
      });
    }
  }

  // Due if never sampled; viable markets refresh every 24h, the rest every
  // 72h. "Viable" mirrors the app's surfacing rule exactly: the resale floor,
  // min(clean, split), must beat the split cost. Using min keeps a base whose
  // only cheap side is clean from being mis-rotated by a high crafted-rare
  // split price (and vice versa).
  const now = Date.now();
  const FRESH_VIABLE = 24 * 3600_000;
  const FRESH_DEAD = 72 * 3600_000;
  const resaleFloor = (m: MarketState): number | null => {
    const sides = [m.cleanPriceChaos, m.splitPriceChaos].filter(
      (v): v is number => v != null && v > 0,
    );
    return sides.length ? Math.min(...sides) : null;
  };
  const isViable = (m: MarketState) => {
    const r = resaleFloor(m);
    return r != null && r > splitCost;
  };
  const isDue = (m: MarketState) => {
    if (!m.lastRefreshedAt) return true;
    const age = now - m.lastRefreshedAt.getTime();
    return age > (isViable(m) ? FRESH_VIABLE : FRESH_DEAD);
  };

  const due = markets
    .filter(isDue)
    .sort((a, b) => (a.lastRefreshedAt?.getTime() ?? 0) - (b.lastRefreshedAt?.getTime() ?? 0));

  console.log(`Universe: ${markets.length} markets, ${due.length} due. ~${(due.length * 2 * PAUSE_MS / 3600_000).toFixed(1)}h to clear at ${PAUSE_MS / 1000}s/request.`);

  let processed = 0;
  let withSplit = 0;
  let rateLimitHits = 0;
  const startTime = Date.now();

  for (const m of due) {
    if (stopping || processed >= limit) break;

    // Proper-case name for the case-sensitive trade `type`; lowercase for the
    // DB key the app joins on.
    const dbBaseType = m.base.name.toLowerCase();

    try {
      const buy = await sampleSide(league, m.base.name, m.band, "buy", currencyToChaos);
      if (buy.rateLimited) {
        rateLimitHits++;
        console.log(`  RATE LIMITED — waiting ${buy.rateLimited}s (hit #${rateLimitHits})`);
        await sleep((buy.rateLimited + 2) * 1000);
        continue;
      }
      await sleep(PAUSE_MS);

      const sell = await sampleSide(league, m.base.name, m.band, "sell", currencyToChaos);
      if (sell.rateLimited) {
        rateLimitHits++;
        console.log(`  RATE LIMITED — waiting ${sell.rateLimited}s (hit #${rateLimitHits})`);
        await sleep((sell.rateLimited + 2) * 1000);
        continue;
      }

      await sql`
        INSERT INTO split_base_prices
          (league, base_type, item_class, ilvl_floor, quality_band,
           clean_price_chaos, clean_listing_count, split_price_chaos, split_listing_count, last_refreshed_at)
        VALUES
          (${league}, ${dbBaseType}, ${m.base.itemClass}, ${SPLIT_ILVL_FLOOR}, ${m.band.key},
           ${buy.floorChaos}, ${buy.listingCount}, ${sell.floorChaos}, ${sell.listingCount}, NOW())
        ON CONFLICT (league, base_type, ilvl_floor, quality_band) DO UPDATE SET
          item_class = EXCLUDED.item_class,
          clean_price_chaos = EXCLUDED.clean_price_chaos,
          clean_listing_count = EXCLUDED.clean_listing_count,
          split_price_chaos = EXCLUDED.split_price_chaos,
          split_listing_count = EXCLUDED.split_listing_count,
          last_refreshed_at = NOW()
      `;

      processed++;
      if (sell.floorChaos != null) withSplit++;

      if (processed % 25 === 0 || (sell.floorChaos != null && 2 * sell.floorChaos - splitCost > 500)) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        const label = `${m.base.name} q${m.band.key}`.padEnd(40);
        const buyStr = buy.floorChaos != null ? `${buy.floorChaos.toFixed(0)}c` : "—";
        const sellStr = sell.floorChaos != null ? `${sell.floorChaos.toFixed(0)}c` : "—";
        console.log(`[${processed}/${due.length}] ${label} buy ${buyStr.padStart(8)} (${buy.listingCount}) | split ${sellStr.padStart(8)} (${sell.listingCount})  ${elapsed}s`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ERROR: ${m.base.name} q${m.band.key}: ${msg}`);
      // Bump the timestamp so a persistent error doesn't trap the rotation,
      // but only if a row exists. Leave prices untouched (transient errors
      // shouldn't wipe good data).
      await sql`
        UPDATE split_base_prices SET last_refreshed_at = NOW()
        WHERE league = ${league} AND base_type = ${dbBaseType}
          AND ilvl_floor = ${SPLIT_ILVL_FLOOR} AND quality_band = ${m.band.key}
      `;
      processed++;
    }

    if (!stopping) await sleep(PAUSE_MS);
  }

  const mins = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\nDone. ${processed} markets in ${mins} min (${withSplit} with split listings, ${rateLimitHits} rate limit hits).`);

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
