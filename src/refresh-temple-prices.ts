/**
 * Fetches Temple of Atzoatl gem-room t3 ("Doryani's Institute" / double-corrupt
 * gem room) prices from the PoE trade API and stores them in `temple_prices`.
 *
 * Powers the Lapidary Lens (LQD) strategy on the gem-leveling page so the
 * default temple cost is live market data instead of a hardcoded constant.
 *
 * Usage:
 *   npx tsx src/refresh-temple-prices.ts [league]
 *
 * Designed to run hourly via GitHub Actions cron. Each run does ONE search
 * call + ONE fetch call per (league, room) — currently 1 room (gem_room_3),
 * so 2 trade API calls per league per run. Well under the 30/300s ceiling.
 *
 * Requires DATABASE_URL and POE_CLIENT_ID environment variables.
 */

import "dotenv/config";
import postgres from "postgres";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TRADE_BASE = "https://www.pathofexile.com/api/trade";

/** Number of cheapest listings to consider when computing the median. */
const SAMPLE_SIZE = 10;

/** Pause between rooms (only relevant if more rooms get added later). */
const PAUSE_MS = 10_000;

const userAgent = `OAuth ${process.env.POE_CLIENT_ID ?? "poestashapp"}/1.0.0 (contact: contact@poestash.com)`;

interface TempleRoom {
  /** Stable key stored in the DB row (composite PK with league). */
  roomKey: string;
  /** Trade pseudo stat id used in the search query. */
  tradeStatId: string;
  /** Human label for logs. */
  label: string;
}

const ROOMS: TempleRoom[] = [
  {
    roomKey: "gem_room_3",
    tradeStatId: "pseudo.pseudo_temple_gem_room_3",
    label: "Doryani's Institute (gem room t3, double corrupt)",
  },
];

/**
 * poe.ninja currency names mapped to the trade API's currency slugs. We use
 * the same set as `refresh-cluster-prices.ts` so the conversion table stays
 * consistent across workers.
 */
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

interface ListingPrice {
  amount: number;
  currency: string;
}

interface FetchResult {
  /** Total number of listings the search reported. */
  total: number;
  /** Cheapest listings returned by /fetch (at most SAMPLE_SIZE). */
  prices: ListingPrice[];
  rateLimited?: number;
  rateLimitedEndpoint?: string;
}

async function searchRoom(league: string, room: TempleRoom): Promise<FetchResult> {
  const headers: Record<string, string> = {
    "User-Agent": userAgent,
    "Content-Type": "application/json",
  };

  // status:online keeps the median honest — offline sellers' prices skew
  // low because nobody answers the whisper. We don't go all the way to
  // securable because temples are rarely listed for instant buyout.
  const query = {
    query: {
      status: { option: "online" },
      stats: [
        { type: "and", filters: [{ id: room.tradeStatId }] },
      ],
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
    return { total: 0, prices: [], rateLimited: retryAfter, rateLimitedEndpoint: "search" };
  }
  if (!searchRes.ok) {
    throw new Error(`Search ${searchRes.status}: ${await searchRes.text()}`);
  }

  const searchData: { id: string; total: number; result: string[] } = await searchRes.json();

  if (searchData.total === 0 || searchData.result.length === 0) {
    return { total: 0, prices: [] };
  }

  // /fetch accepts up to 10 ids per request. Take the cheapest SAMPLE_SIZE.
  const ids = searchData.result.slice(0, SAMPLE_SIZE).join(",");
  const fetchRes = await fetch(
    `${TRADE_BASE}/fetch/${ids}?query=${searchData.id}`,
    { headers, signal: AbortSignal.timeout(15_000) },
  );

  if (fetchRes.status === 429) {
    const retryAfter = parseInt(fetchRes.headers.get("Retry-After") ?? "60", 10);
    return { total: searchData.total, prices: [], rateLimited: retryAfter, rateLimitedEndpoint: "fetch" };
  }
  if (!fetchRes.ok) {
    throw new Error(`Fetch ${fetchRes.status}: ${await fetchRes.text()}`);
  }

  const fetchData: {
    result: { listing: { price: { amount: number; currency: string } | null } | null }[];
  } = await fetchRes.json();

  const prices: ListingPrice[] = [];
  for (const row of fetchData.result ?? []) {
    const price = row?.listing?.price;
    if (price && typeof price.amount === "number" && typeof price.currency === "string") {
      prices.push({ amount: price.amount, currency: price.currency });
    }
  }

  return { total: searchData.total, prices };
}

// ---------------------------------------------------------------------------
// Stats helpers
// ---------------------------------------------------------------------------

function toChaos(price: ListingPrice, currencyToChaos: Map<string, number>): number | null {
  const rate = currencyToChaos.get(price.currency);
  if (rate == null) return null;
  return price.amount * rate;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
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

  const start = Date.now();

  // 1. Build currency conversion map (exchange source wins over stash).
  const currencyRows = await sql<
    { item_name: string; chaos_value: number; source: string }[]
  >`
    SELECT item_name, chaos_value, source FROM ninja_prices
    WHERE league = ${league} AND ninja_category = 'Currency'
  `;
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
  const divineRate = currencyToChaos.get("divine");
  console.log(
    `[${league}] Currency rates loaded (${currencyToChaos.size} currencies` +
      (divineRate ? `, divine=${divineRate.toFixed(1)}c` : "") +
      `)`,
  );

  // 2. For each room, search trade and upsert.
  let updated = 0;

  for (const [i, room] of ROOMS.entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, PAUSE_MS));

    try {
      const result = await searchRoom(league, room);

      if (result.rateLimited) {
        console.log(
          `  RATE LIMITED on ${result.rateLimitedEndpoint} — skipping ${room.roomKey} ` +
            `(retry-after ${result.rateLimited}s)`,
        );
        continue;
      }

      const chaosPrices = result.prices
        .map((p) => toChaos(p, currencyToChaos))
        .filter((v): v is number => v != null);

      const medianChaos = median(chaosPrices);
      const minChaos = chaosPrices.length > 0 ? Math.min(...chaosPrices) : null;

      await sql`
        INSERT INTO temple_prices ${sql({
          league,
          room_key: room.roomKey,
          trade_stat_id: room.tradeStatId,
          median_price_chaos: medianChaos,
          min_price_chaos: minChaos,
          listing_count: result.total,
          sample_size: chaosPrices.length,
          last_refreshed_at: new Date(),
        })}
        ON CONFLICT (league, room_key) DO UPDATE SET
          trade_stat_id = EXCLUDED.trade_stat_id,
          median_price_chaos = EXCLUDED.median_price_chaos,
          min_price_chaos = EXCLUDED.min_price_chaos,
          listing_count = EXCLUDED.listing_count,
          sample_size = EXCLUDED.sample_size,
          last_refreshed_at = EXCLUDED.last_refreshed_at
      `;

      updated++;

      const medianStr = medianChaos != null ? `${medianChaos.toFixed(1)}c` : "none";
      const minStr = minChaos != null ? `${minChaos.toFixed(1)}c` : "none";
      console.log(
        `  ${room.label}: ${result.total} listings, sampled ${chaosPrices.length}, ` +
          `median=${medianStr} min=${minStr}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ERROR on ${room.roomKey}: ${msg}`);
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[${league}] Done in ${elapsed}s — ${updated}/${ROOMS.length} rooms updated`);

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
