import type {
  NinjaCurrencyResponse,
  NinjaItemResponse,
  NinjaExchangeResponse,
  NinjaFetchedItem,
} from "./ninja-types";
import type { NinjaType } from "./ninja-types";
import {
  ALL_NINJA_TYPES,
  STASH_CURRENCY_FORMAT,
  EXCHANGE_CANONICAL_TYPES,
} from "./ninja-types";
import { mapStashCurrencyRows } from "./stash-currency-rows";

const NINJA_BASE = "https://poe.ninja/poe1/api/economy";
const POECDN_BASE = "https://web.poecdn.com";

/** poe.ninja serves flavour as either a single string or a string[] depending
 *  on the feed; normalize to trimmed, non-empty lines for the tooltip card. */
function normalizeFlavour(
  raw: string | string[] | null | undefined,
): string[] | null {
  if (!raw) return null;
  const text = Array.isArray(raw) ? raw.join("\n") : raw;
  const lines = text
    .split(/\r\n|\r|\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  return lines.length ? lines : null;
}

/** A 404 is poe.ninja saying the category isn't on this feed — 14 stash
 *  categories answer 404 on every league, every run, because poe.ninja only
 *  serves them on the exchange feed now. That is an empty answer, not an
 *  outage. Anything else non-2xx is a real failure and has to reach the
 *  caller, which used to swallow it and leave the run green. */
export function notOnFeed(res: Response, url: string): NinjaFetchedItem[] {
  if (res.status === 404) return [];
  throw new Error(`${res.status} on ${url}`);
}

// ---------------------------------------------------------------------------
// Stash: currency-format endpoint (Currency, Fragment)
// ---------------------------------------------------------------------------

async function fetchStashCurrency(
  game: string,
  league: string,
  type: NinjaType,
  divineRate: number,
): Promise<NinjaFetchedItem[]> {
  const url = `${NINJA_BASE}/stash/current/currency/overview?league=${encodeURIComponent(league)}&type=${type}`;
  const res = await fetch(url);
  if (!res.ok) return notOnFeed(res, url);

  const data: NinjaCurrencyResponse = await res.json();
  if (!data.lines?.length) return [];

  return mapStashCurrencyRows(data, { game, league, type, divineRate });
}

// ---------------------------------------------------------------------------
// Stash: item-format endpoint (everything except Currency/Fragment)
// ---------------------------------------------------------------------------

async function fetchStashItems(
  game: string,
  league: string,
  type: NinjaType,
  divineRate: number,
): Promise<NinjaFetchedItem[]> {
  const url = `${NINJA_BASE}/stash/current/item/overview?league=${encodeURIComponent(league)}&type=${type}`;
  const res = await fetch(url);
  if (!res.ok) return notOnFeed(res, url);

  const data: NinjaItemResponse = await res.json();
  if (!data.lines?.length) return [];

  return data.lines.map((line) => ({
    game,
    league,
    itemName: line.name.toLowerCase(),
    chaosValue: line.chaosValue,
    divineValue: line.divineValue ?? (divineRate > 0 && line.chaosValue != null ? line.chaosValue / divineRate : 0),
    listingCount: line.listingCount,
    source: "stash" as const,
    ninjaCategory: type,
    icon: line.icon ?? null,
    detailsId: line.detailsId,
    sparklineData: line.sparkLine?.data ?? null,
    totalChange: line.sparkLine?.totalChange ?? null,
    stackSize: line.stackSize ?? null,
    explicitModifiers: line.explicitModifiers ?? null,
    implicitModifiers: line.implicitModifiers ?? null,
    flavourText: normalizeFlavour(line.flavourText),
    variant: line.variant ?? null,
    baseType: line.baseType ?? null,
    links: line.links ?? null,
    itemClass: line.itemClass ?? null,
    itemType: line.itemType ?? null,
    corrupted: line.corrupted ?? null,
    gemLevel: line.gemLevel ?? null,
    gemQuality: line.gemQuality ?? null,
    levelRequired: line.levelRequired ?? null,
    exaltedValue: line.exaltedValue ?? null,
    count: line.count ?? null,
    mutatedModifiers: line.mutatedModifiers?.map((m, i) => ({
      ...m,
      statId: line.tradeInfo?.[i]?.mod,
    })) ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Exchange endpoint (bulk trade prices)
// ---------------------------------------------------------------------------

async function fetchExchange(
  game: string,
  league: string,
  type: NinjaType,
  divineRate: number,
): Promise<NinjaFetchedItem[]> {
  const url = `${NINJA_BASE}/exchange/current/overview?league=${encodeURIComponent(league)}&type=${type}`;
  const res = await fetch(url);
  if (!res.ok) return notOnFeed(res, url);

  const data: NinjaExchangeResponse = await res.json();
  if (!data.lines?.length || !data.items?.length) return [];

  return data.lines.map((line, i) => {
    const item = data.items[i];
    // Exchange icons are relative paths — prefix with CDN base
    const icon = item.image
      ? (item.image.startsWith("http") ? item.image : `${POECDN_BASE}${item.image}`)
      : null;

    return {
      game,
      league,
      itemName: item.name.toLowerCase(),
      chaosValue: line.primaryValue,
      divineValue: divineRate > 0 ? line.primaryValue / divineRate : 0,
      listingCount: 0, // exchange has volume, not listing count
      source: "exchange" as const,
      ninjaCategory: type,
      icon,
      detailsId: item.detailsId,
      sparklineData: line.sparkline?.data ?? null,
      totalChange: line.sparkline?.totalChange ?? null,
      volume: line.volumePrimaryValue ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// Public: fetch all prices for a league from both stash and exchange
// ---------------------------------------------------------------------------

export async function fetchAllNinjaPrices(
  game: string,
  league: string,
  /** The rate stored by the last run, used when both lookups below miss. */
  previousDivineRate = 0,
): Promise<{ rows: NinjaFetchedItem[]; divineRate: number; failedCategories: string[] }> {
  // Step 1: Get divine rate from exchange (most accurate bulk price)
  let divineRate = 0;
  try {
    const url = `${NINJA_BASE}/exchange/current/overview?league=${encodeURIComponent(league)}&type=Currency`;
    const res = await fetch(url);
    if (res.ok) {
      const data: NinjaExchangeResponse = await res.json();
      const divineIdx = data.items.findIndex((item) => item.name === "Divine Orb");
      if (divineIdx >= 0) {
        divineRate = data.lines[divineIdx].primaryValue;
      }
    }
  } catch {
    // Fall back to stash divine rate below
  }

  // Fallback: if exchange didn't give us a divine rate, try stash
  if (divineRate === 0) {
    try {
      const url = `${NINJA_BASE}/stash/current/currency/overview?league=${encodeURIComponent(league)}&type=Currency`;
      const res = await fetch(url);
      if (res.ok) {
        const data: NinjaCurrencyResponse = await res.json();
        const divine = data.lines.find((l) => l.currencyTypeName === "Divine Orb");
        divineRate = divine?.chaosEquivalent ?? 0;
      }
    } catch {
      // Continue without divine rate
    }
  }

  // Both miss on permanent Hardcore in roughly 4 runs out of 10. Writing 0
  // there overwrote a good stored rate and zeroed every row's divineValue,
  // so the last known rate stands in until a lookup succeeds again.
  if (divineRate === 0 && previousDivineRate > 0) {
    console.log(`  no divine rate from poe.ninja, keeping last known ${previousDivineRate.toFixed(1)}c`);
    divineRate = previousDivineRate;
  }

  // Step 2: Fetch all types in parallel.
  //
  // Stash feed: always fetch (the app uses stash data even for
  // exchange-canonical types — to display poe.ninja-hidden items as
  // dimmed/struck-through "Not counted" rows in the personal stash view).
  //
  // Exchange feed: only fetch for the 16 types where poe.ninja's UI
  // actually consumes it (EXCHANGE_CANONICAL_TYPES). The other 24 types
  // return empty exchange responses — fetching them was 24 wasted requests
  // per refresh.
  const fetches: Promise<NinjaFetchedItem[]>[] = [];
  const failedCategories: string[] = [];
  const recordFailure = (category: string) => (err: unknown) => {
    console.error(`  ${category} failed: ${err instanceof Error ? err.message : err}`);
    failedCategories.push(category);
    return [] as NinjaFetchedItem[];
  };

  for (const type of ALL_NINJA_TYPES) {
    // Stash: use currency-format or item-format based on type
    if (STASH_CURRENCY_FORMAT.has(type)) {
      fetches.push(
        fetchStashCurrency(game, league, type, divineRate).catch(recordFailure(`stash:${type}`)),
      );
    } else {
      fetches.push(
        fetchStashItems(game, league, type, divineRate).catch(recordFailure(`stash:${type}`)),
      );
    }

    // Exchange: only worth firing for canonical-exchange types
    if (EXCHANGE_CANONICAL_TYPES.has(type)) {
      fetches.push(
        fetchExchange(game, league, type, divineRate).catch(recordFailure(`exchange:${type}`)),
      );
    }
  }

  const results = await Promise.all(fetches);

  return { rows: results.flat(), divineRate, failedCategories };
}
