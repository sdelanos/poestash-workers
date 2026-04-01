/**
 * Fetches cluster jewel combo prices from the PoE trade API and stores them in Supabase.
 *
 * Usage:
 *   npx tsx src/refresh.ts [league] [--quick]
 *
 * Options:
 *   league    League name (default: Mirage)
 *   --quick   Only refresh combos that had listings on last check (12h staleness)
 *
 * Requires DATABASE_URL and POE_CLIENT_ID environment variables.
 */

import "dotenv/config";
import postgres from "postgres";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TRADE_BASE = "https://www.pathofexile.com/api/trade";
// Rate limits: 5/10s, 15/60s, 30/300s. 30/300s is the binding constraint.
const PAUSE_MS = 10_000;

const SIZE_TO_TYPE: Record<string, string> = {
  medium: "Medium Cluster Jewel",
  large: "Large Cluster Jewel",
};

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

async function searchCombo(
  league: string,
  jewelSize: string,
  tradeStatIds: string[],
  currencyToChaos: Map<string, number>,
): Promise<{ listingCount: number; minPriceChaos: number | null; rateLimited?: number }> {
  const headers: Record<string, string> = {
    "User-Agent": userAgent,
    "Content-Type": "application/json",
  };

  const query = {
    query: {
      status: { option: "available" },
      type: SIZE_TO_TYPE[jewelSize],
      stats: [{ type: "and", filters: tradeStatIds.map((id: string) => ({ id })) }],
      filters: {
        type_filters: { filters: { rarity: { option: "nonunique" } } },
        misc_filters: { filters: { corrupted: { option: "false" } } },
      },
    },
    sort: { price: "asc" },
  };

  const searchRes = await fetch(`${TRADE_BASE}/search/${encodeURIComponent(league)}`, {
    method: "POST",
    headers,
    body: JSON.stringify(query),
    signal: AbortSignal.timeout(15_000),
  });

  if (searchRes.status === 429) {
    const retryAfter = parseInt(searchRes.headers.get("Retry-After") ?? "60", 10);
    return { listingCount: 0, minPriceChaos: null, rateLimited: retryAfter };
  }
  if (!searchRes.ok) {
    throw new Error(`Search ${searchRes.status}: ${await searchRes.text()}`);
  }

  const searchData: { id: string; total: number; result: string[] } = await searchRes.json();

  if (searchData.total === 0 || searchData.result.length === 0) {
    return { listingCount: 0, minPriceChaos: null };
  }

  // Fetch cheapest 10 listings (1 API call — fetch endpoint accepts up to 10 IDs)
  const ids = searchData.result.slice(0, 10).join(",");
  const fetchRes = await fetch(
    `${TRADE_BASE}/fetch/${ids}?query=${searchData.id}`,
    { headers, signal: AbortSignal.timeout(15_000) },
  );

  if (fetchRes.status === 429) {
    const retryAfter = parseInt(fetchRes.headers.get("Retry-After") ?? "60", 10);
    return { listingCount: searchData.total, minPriceChaos: null, rateLimited: retryAfter };
  }
  if (!fetchRes.ok) {
    throw new Error(`Fetch ${fetchRes.status}: ${await fetchRes.text()}`);
  }

  const fetchData: {
    result: { listing: { price: { amount: number; currency: string } } }[];
  } = await fetchRes.json();

  // Convert all prices to chaos
  const chaosPrices: number[] = [];
  for (const item of fetchData.result) {
    const price = item?.listing?.price;
    if (!price) continue;
    const rate = currencyToChaos.get(price.currency);
    if (rate != null) chaosPrices.push(price.amount * rate);
  }

  if (chaosPrices.length === 0) {
    return { listingCount: searchData.total, minPriceChaos: null };
  }

  // Outlier-resistant pricing: skip price fixers
  const minPriceChaos = getResistantPrice(chaosPrices);
  return { listingCount: searchData.total, minPriceChaos };
}

/**
 * Get a price-fixer-resistant market price from a list of chaos prices.
 *
 * With fewer than 3 listings, just use the cheapest (can't detect fixers).
 * With 3+, compute the median and use the cheapest listing within 50% of it.
 * This skips 1c price fixers when the real market is 200c+.
 */
function getResistantPrice(prices: number[]): number {
  prices.sort((a, b) => a - b);
  if (prices.length < 3) return prices[0];

  const mid = Math.floor(prices.length / 2);
  const median = prices.length % 2 === 0
    ? (prices[mid - 1] + prices[mid]) / 2
    : prices[mid];

  const threshold = median * 0.5;
  for (const p of prices) {
    if (p >= threshold) return p;
  }
  return prices[0];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let stopping = false;
process.on("SIGINT", () => {
  console.log("\nGraceful shutdown...");
  stopping = true;
});

async function main() {
  const args = process.argv.slice(2);
  const quickMode = args.includes("--quick");
  const league = args.find((a) => !a.startsWith("--")) ?? "Mirage";

  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }

  const sql = postgres(process.env.DATABASE_URL, {
    idle_timeout: 30,
    max_lifetime: 300,
    connect_timeout: 10,
  });

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
  const baseFilter = quickMode
    ? sql`league = ${league} AND listing_count > 0`
    : sql`league = ${league}`;

  const [{ count: targetCount }] = await sql`
    SELECT count(*) FROM cluster_jewel_prices WHERE ${baseFilter}
  `;

  const maxAge = quickMode ? 12 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const mode = quickMode ? "QUICK (listings only)" : "FULL (all combos)";
  const estHours = (Number(targetCount) * PAUSE_MS / 1000 / 3600).toFixed(1);
  console.log(`Mode: ${mode}`);
  console.log(`Target: ${targetCount} combos, ~${estHours} hours at ${PAUSE_MS / 1000}s/combo`);
  console.log(`Ctrl+C to stop gracefully\n`);

  let processed = 0;
  let withListings = 0;
  const startTime = Date.now();

  while (!stopping) {
    const [combo] = await sql`
      SELECT league, enchantment_tag, jewel_size, combo_key, trade_stat_ids, listing_count, last_refreshed_at
      FROM cluster_jewel_prices
      WHERE ${baseFilter}
      ORDER BY last_refreshed_at ASC NULLS FIRST
      LIMIT 1
    `;

    if (!combo) {
      console.log("No combos to process!");
      break;
    }

    if (combo.last_refreshed_at && Date.now() - new Date(combo.last_refreshed_at).getTime() < maxAge) {
      const label = quickMode ? "12h" : "24h";
      console.log(`All target combos refreshed within ${label}. Done.`);
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
        console.log(`  RATE LIMITED — waiting ${result.rateLimited}s...`);
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
      await sql`
        UPDATE cluster_jewel_prices
        SET listing_count = 0, last_refreshed_at = NOW()
        WHERE league = ${league}
          AND enchantment_tag = ${combo.enchantment_tag}
          AND combo_key = ${combo.combo_key}
      `;
      processed++;
    }

    if (!stopping) {
      await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\nDone! Processed ${processed} combos in ${elapsed} min (${withListings} with listings)`);

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
