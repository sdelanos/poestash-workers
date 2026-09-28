/**
 * Fetches cluster jewel combo prices from the PoE trade API and stores them in Supabase.
 *
 * Usage:
 *   npx tsx src/refresh-cluster-prices.ts [league]
 *
 * Options:
 *   league    League name. With no argument the worker resolves the current
 *             challenge league at run time (see lib/trade-league.ts), so it
 *             follows league rollovers with no workflow edit. A league with no
 *             combo rows yet is seeded from the existing catalog; the small
 *             clusters are seeded from data/small-cluster-combos.json.
 *
 * Designed to be run multiple times per day via cron. Each run processes
 * combos oldest-first and stops when all are within the 24h staleness window.
 *
 * Requires DATABASE_URL and POE_CLIENT_ID environment variables.
 */

import "dotenv/config";
import postgres from "postgres";
import { SMALL_COMBOS, smallComboRows } from "./lib/small-cluster-combos";
import { resolveTradeLeague } from "./lib/trade-league";
import { buildComboSearchQuery, type JewelSize } from "./lib/cluster-query";
import { sustainableIntervalMs, describeLimits } from "./lib/rate-limit";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TRADE_BASE = "https://www.pathofexile.com/api/trade";

/**
 * Opening pace, per *request*, until the first response tells us the real one.
 * Deliberately the old per-combo figure: erring slow costs a few seconds, and
 * erring fast costs an hour (#7).
 */
const DEFAULT_INTERVAL_MS = 10_000;

const CURRENCY_SLUGS: Record<string, string> = {
  chaos: "chaos orb",
  divine: "divine orb",
  exalted: "exalted orb",
  alch: "orb of alchemy",
  fusing: "orb of fusing",
  vaal: "vaal orb",
  chisel: "cartographer's chisel",
  chance: "orb of chance",
  alteration: "orb of alteration",
  jeweller: "jeweller's orb",
  chromatic: "chromatic orb",
  scouring: "orb of scouring",
  regal: "regal orb",
  gcp: "gemcutter's prism",
  mirror: "mirror of kalandra",
};

// ---------------------------------------------------------------------------
// Trade API
// ---------------------------------------------------------------------------

const userAgent = `OAuth ${process.env.POE_CLIENT_ID ?? "poestashapp"}/1.0.0 (contact: contact@poestash.com)`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The budget is per request and a combo costs two of them — a search, then a
 * fetch for the cheapest listing's price. Pacing per combo is what ran this
 * worker at double the allowed rate (#7), so every request waits its own turn.
 */
let intervalMs = DEFAULT_INTERVAL_MS;
let limitsLogged = false;

async function pacedFetch(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init);

  const advertised = sustainableIntervalMs(res.headers);
  if (advertised != null) intervalMs = advertised;

  if (!limitsLogged) {
    console.log(`${describeLimits(res.headers)} — pacing ${(intervalMs / 1000).toFixed(1)}s/request`);
    limitsLogged = true;
  }

  // A 429 carries its own Retry-After, which the caller sleeps instead. Adding
  // the cooldown on top would just delay the retry further.
  if (res.status !== 429) await sleep(intervalMs);

  return res;
}

async function searchCombo(
  league: string,
  jewelSize: JewelSize,
  tradeStatIds: string[],
  currencyToChaos: Map<string, number>,
): Promise<{ listingCount: number; minPriceChaos: number | null; rateLimited?: number; rateLimitedEndpoint?: string }> {
  const headers: Record<string, string> = {
    "User-Agent": userAgent,
    "Content-Type": "application/json",
  };

  const query = buildComboSearchQuery(jewelSize, tradeStatIds);

  const searchRes = await pacedFetch(`${TRADE_BASE}/search/${encodeURIComponent(league)}`, {
    method: "POST",
    headers,
    body: JSON.stringify(query),
    signal: AbortSignal.timeout(15_000),
  });

  if (searchRes.status === 429) {
    const retryAfter = parseInt(searchRes.headers.get("Retry-After") ?? "60", 10);
    return { listingCount: 0, minPriceChaos: null, rateLimited: retryAfter, rateLimitedEndpoint: "search" };
  }
  if (!searchRes.ok) {
    throw new Error(`Search ${searchRes.status}: ${await searchRes.text()}`);
  }

  const searchData: { id: string; total: number; result: string[] } = await searchRes.json();

  if (searchData.total === 0 || searchData.result.length === 0) {
    return { listingCount: 0, minPriceChaos: null };
  }

  // Fetch the cheapest listing. With securable (instant buyout) status,
  // price fixing is impossible — the cheapest listing is the real market price.
  const fetchRes = await pacedFetch(
    `${TRADE_BASE}/fetch/${searchData.result[0]}?query=${searchData.id}`,
    { headers, signal: AbortSignal.timeout(15_000) },
  );

  if (fetchRes.status === 429) {
    const retryAfter = parseInt(fetchRes.headers.get("Retry-After") ?? "60", 10);
    return { listingCount: searchData.total, minPriceChaos: null, rateLimited: retryAfter, rateLimitedEndpoint: "fetch" };
  }
  if (!fetchRes.ok) {
    throw new Error(`Fetch ${fetchRes.status}: ${await fetchRes.text()}`);
  }

  const fetchData: {
    result: { listing: { price: { amount: number; currency: string } } }[];
  } = await fetchRes.json();

  const listing = fetchData.result[0];
  if (!listing?.listing?.price) {
    return { listingCount: searchData.total, minPriceChaos: null };
  }

  const { amount, currency } = listing.listing.price;
  const rate = currencyToChaos.get(currency);
  const minPriceChaos = rate != null ? amount * rate : null;

  return { listingCount: searchData.total, minPriceChaos };
}

// ---------------------------------------------------------------------------
// Combo seeding
// ---------------------------------------------------------------------------

/**
 * Make sure the league has a row per combo to refresh.
 *
 * The combo catalog — which notable pairings exist and the trade stat ids that
 * find them — is league-independent data that lives only in this table. The
 * refresh loop below only ever UPDATEs, so a league with no rows reads as
 * "nothing due" and is silently never priced. That is exactly what happened at
 * the Allflame rollover.
 *
 * Copies the catalog from the most recently refreshed other league, leaving
 * prices NULL so every combo is immediately due. Idempotent: once the league
 * is seeded this is a no-op.
 */
async function seedLeagueCombos(
  sql: postgres.Sql,
  league: string,
): Promise<void> {
  const [{ count }] = await sql<{ count: string }[]>`
    SELECT count(*) FROM cluster_jewel_prices WHERE league = ${league}
  `;
  if (Number(count) > 0) return;

  const [source] = await sql<{ league: string }[]>`
    SELECT league FROM cluster_jewel_prices
    WHERE league <> ${league}
    GROUP BY league
    ORDER BY max(last_refreshed_at) DESC NULLS LAST
    LIMIT 1
  `;
  if (!source) {
    console.warn(
      `WARN: no combo catalog to seed ${league} from — cluster_jewel_prices is empty.`,
    );
    return;
  }

  const seeded = await sql`
    INSERT INTO cluster_jewel_prices
      (league, enchantment_tag, jewel_size, combo_key, notable_names, trade_stat_ids)
    SELECT ${league}, enchantment_tag, jewel_size, combo_key, notable_names, trade_stat_ids
    FROM cluster_jewel_prices
    WHERE league = ${source.league}
    ON CONFLICT (league, enchantment_tag, combo_key) DO NOTHING
  `;
  console.log(
    `Seeded ${seeded.count} combos for ${league} from ${source.league}`,
  );
}

/**
 * Add the small-cluster rows to a league's catalog, from the committed
 * catalogue in lib/small-cluster-combos.ts (which is where the size's combo
 * space is explained).
 *
 * Runs on every invocation, not just for an unseeded league: the leagues that
 * already hold a medium/large catalog would otherwise never gain the size.
 * Idempotent — a conflict is a row that already exists.
 */
async function seedSmallCombos(
  sql: postgres.Sql,
  league: string,
): Promise<void> {
  const rows = smallComboRows(league, SMALL_COMBOS);
  const seeded = await sql`
    INSERT INTO cluster_jewel_prices ${sql(rows)}
    ON CONFLICT (league, enchantment_tag, combo_key) DO NOTHING
  `;
  if (seeded.count > 0) {
    console.log(`Seeded ${seeded.count} small combos for ${league}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let stopping = false;
process.on("SIGINT", () => {
  console.log("\nGraceful shutdown (SIGINT)...");
  stopping = true;
});
process.on("SIGTERM", () => {
  console.log("\nGraceful shutdown (SIGTERM)...");
  stopping = true;
});

async function main() {
  const args = process.argv.slice(2);
  const explicit = args.find((a) => !a.startsWith("--"));

  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }

  const sql = postgres(process.env.DATABASE_URL, {
    idle_timeout: 30,
    max_lifetime: 300,
    prepare: false,
    connect_timeout: 10,
  });

  const league = await resolveTradeLeague(sql, explicit);
  if (!league) {
    await sql.end();
    return;
  }

  await seedLeagueCombos(sql, league);
  await seedSmallCombos(sql, league);

  // Build currency conversion map
  const currencyRows = await sql`
    SELECT item_name, chaos_value, source FROM ninja_prices
    WHERE league = ${league} AND ninja_category = 'Currency'
  `;
  // Deduplicate: prefer exchange source
  const seen = new Map<string, { chaos_value: number; source: string }>();
  for (const r of currencyRows) {
    const existing = seen.get(r.item_name);
    if (!existing || r.source === "exchange") {
      seen.set(r.item_name, { chaos_value: r.chaos_value, source: r.source });
    }
  }
  const currencyToChaos = new Map<string, number>();
  currencyToChaos.set("chaos", 1);
  for (const [slug, ninjaName] of Object.entries(CURRENCY_SLUGS)) {
    const row = seen.get(ninjaName);
    if (row) currencyToChaos.set(slug, row.chaos_value);
  }
  console.log(`Currency rates loaded (${currencyToChaos.size} currencies, divine=${currencyToChaos.get("divine")?.toFixed(1)}c)`);

  // Count targets
  const [{ count: targetCount }] = await sql`
    SELECT count(*) FROM cluster_jewel_prices WHERE league = ${league}
  `;

  // No ETA: the pace comes from the rate-limit headers and retunes as they
  // change, and a combo with no listings costs one request where a priced one
  // costs two. The old banner quoted 7.8h for runs that never finished a pass.
  console.log(`Target: ${targetCount} combos, up to 2 requests each`);
  console.log(`Ctrl+C to stop gracefully\n`);

  let processed = 0;
  let withListings = 0;
  let rateLimitHits = 0;
  const startTime = Date.now();

  while (!stopping) {
    // Combos with listings: refresh every 24h
    // Combos with 0 listings: refresh every 48h
    const [combo] = await sql`
      SELECT league, enchantment_tag, jewel_size, combo_key, trade_stat_ids, listing_count, last_refreshed_at
      FROM cluster_jewel_prices
      WHERE league = ${league}
        AND (last_refreshed_at IS NULL
          OR (listing_count > 0 AND last_refreshed_at < NOW() - INTERVAL '24 hours')
          OR (listing_count = 0 AND last_refreshed_at < NOW() - INTERVAL '48 hours'))
      ORDER BY last_refreshed_at ASC NULLS FIRST
      LIMIT 1
    `;

    if (!combo) {
      console.log("All combos fresh. Done.");
      break;
    }

    try {
      const result = await searchCombo(
        league,
        combo.jewel_size,
        combo.trade_stat_ids as string[],
        currencyToChaos,
      );

      if (result.rateLimited) {
        rateLimitHits++;
        console.log(
          `  RATE LIMITED on ${result.rateLimitedEndpoint} — waiting ${result.rateLimited}s ` +
          `(hit #${rateLimitHits}, after ${processed} combos)`,
        );
        await new Promise((resolve) => setTimeout(resolve, result.rateLimited! * 1000));
        continue;
      }

      await sql`
        UPDATE cluster_jewel_prices
        SET min_price_chaos = ${result.minPriceChaos},
            listing_count = ${result.listingCount},
            last_refreshed_at = NOW()
        WHERE league = ${league}
          AND enchantment_tag = ${combo.enchantment_tag}
          AND combo_key = ${combo.combo_key}
      `;

      processed++;
      if (result.listingCount > 0) withListings++;

      const price = result.minPriceChaos != null ? `${result.minPriceChaos.toFixed(1)}c` : "—";
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const rate = processed > 0 ? (processed / ((Date.now() - startTime) / 60000)).toFixed(1) : "0";

      if (processed % 25 === 0 || result.listingCount > 50) {
        console.log(
          `[${processed}/${targetCount}] ${combo.jewel_size.padEnd(7)} ${combo.combo_key.substring(0, 48).padEnd(48)} ` +
          `${String(result.listingCount).padStart(5)} listings  ${price.padStart(10)}  (${elapsed}s, ${rate}/min)`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ERROR: ${combo.combo_key}: ${msg}`);
      // Update last_refreshed_at to avoid infinite retry on persistent errors
      // (e.g. bad combo data), but keep listing_count and min_price_chaos
      // untouched so transient API errors don't wipe good data.
      await sql`
        UPDATE cluster_jewel_prices
        SET last_refreshed_at = NOW()
        WHERE league = ${league}
          AND enchantment_tag = ${combo.enchantment_tag}
          AND combo_key = ${combo.combo_key}
      `;
      processed++;
    }
    // No pause here: pacedFetch already waited out each request's own turn.
  }

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\nDone! Processed ${processed} combos in ${elapsed} min (${withListings} with listings, ${rateLimitHits} rate limit hits)`);

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
