import type {
  NinjaCurrencyResponse,
  NinjaItemResponse,
  NinjaExchangeResponse,
  NinjaFetchedItem,
} from "./ninja-types";
import type { NinjaType } from "./ninja-types";
import { ALL_NINJA_TYPES, STASH_CURRENCY_FORMAT } from "./ninja-types";

const NINJA_BASE = "https://poe.ninja/poe1/api/economy";
const POECDN_BASE = "https://web.poecdn.com";

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
  if (!res.ok) return [];

  const data: NinjaCurrencyResponse = await res.json();
  if (!data.lines?.length) return [];

  const detailMap = new Map<string, { icon: string; tradeId: string }>();
  for (const detail of data.currencyDetails) {
    detailMap.set(detail.name, { icon: detail.icon, tradeId: detail.tradeId });
  }

  return data.lines.map((line) => {
    const chaos = line.chaosEquivalent;
    const detail = detailMap.get(line.currencyTypeName);
    return {
      game,
      league,
      itemName: line.currencyTypeName.toLowerCase(),
      chaosValue: chaos,
      divineValue: divineRate > 0 ? chaos / divineRate : 0,
      listingCount: line.receive?.listing_count ?? 0,
      source: "stash" as const,
      ninjaCategory: type,
      icon: detail?.icon ?? null,
      detailsId: line.detailsId,
      sparklineData: line.receiveSparkLine?.data ?? null,
      totalChange: line.receiveSparkLine?.totalChange ?? null,
    };
  });
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
  if (!res.ok) return [];

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
  if (!res.ok) return [];

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
): Promise<{ rows: NinjaFetchedItem[]; divineRate: number }> {
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

  // Step 2: Fetch all types from both stash and exchange in parallel
  const fetches: Promise<NinjaFetchedItem[]>[] = [];

  for (const type of ALL_NINJA_TYPES) {
    // Stash: use currency-format or item-format based on type
    if (STASH_CURRENCY_FORMAT.has(type)) {
      fetches.push(
        fetchStashCurrency(game, league, type, divineRate).catch(() => []),
      );
    } else {
      fetches.push(
        fetchStashItems(game, league, type, divineRate).catch(() => []),
      );
    }

    // Exchange: try every type (empty responses are free)
    fetches.push(
      fetchExchange(game, league, type, divineRate).catch(() => []),
    );
  }

  const results = await Promise.all(fetches);

  return { rows: results.flat(), divineRate };
}
