/**
 * PoE 2 prices fetcher. Hits poe.ninja's exchange endpoint for each of
 * the 13 verified PoE 2 categories (see ./poe2-categories.ts) and emits
 * `NinjaFetchedItem` rows ready for the same upsert path PoE 1 uses.
 *
 * Differences from PoE 1 worth knowing:
 *   - URL base is `/poe2/api/economy` (vs `/poe1/`).
 *   - Only exchange-source data exists for PoE 2. No stash-format fetch.
 *   - Primary denomination on responses is **divine**, not chaos. The
 *     `line.primaryValue` for a row is the price in divines. We multiply
 *     by `core.rates.chaos` (chaos-per-divine) to populate the canonical
 *     `chaosValue` schema column, then derive `divineValue` from chaos
 *     using the same rate, matching the PoE 1 semantics.
 *   - Categories number 13 (vs PoE 1's 40), so this issues ~14 fetches
 *     per refresh (1 for divine rate + 13 in parallel for categories).
 *     One of those is the Currency category itself, which we re-fetch
 *     during the parallel pass for consistency.
 */

import type { NinjaExchangeResponse, NinjaFetchedItem } from "./ninja-types";
import { POE2_CATEGORIES } from "./poe2-categories";

const NINJA_BASE = "https://poe.ninja/poe2/api/economy";
const POECDN_BASE = "https://web.poecdn.com";

interface RateInfo {
  /** Chaos per divine. The canonical "divineRate" used across the app. */
  divineRate: number;
  /** True when poe.ninja's response denominates `primaryValue` in divines
   *  (the PoE 2 default as of 2026-05). False would mean primary is chaos,
   *  matching PoE 1 conventions. We support both because conventions can
   *  shift, but we always require a non-zero divine rate either way. */
  primaryIsDivine: boolean;
}

/** Fetch the divine→chaos rate for a PoE 2 league. Throws if poe.ninja
 *  is down, the response is malformed, or the rate can't be determined.
 *  Critical because every PoE 2 chaos value depends on this rate — unlike
 *  PoE 1 where chaos values come straight from the response. */
async function getRateInfo(league: string): Promise<RateInfo> {
  const url = `${NINJA_BASE}/exchange/current/overview?league=${encodeURIComponent(league)}&type=Currency`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`poe.ninja Currency fetch ${res.status}: ${res.statusText}`);
  }
  const data = (await res.json()) as NinjaExchangeResponse;
  const primary = data.core?.primary;

  if (primary === "divine") {
    // `rates.chaos` is chaos-per-primary. Primary is divine, so this is
    // chaos-per-divine, matching the canonical `divineRate` semantics.
    const divineRate = data.core?.rates?.chaos ?? 0;
    if (divineRate <= 0) {
      throw new Error(`poe.ninja returned non-positive chaos rate (${divineRate}) for ${league}`);
    }
    return { divineRate, primaryIsDivine: true };
  }

  if (primary === "chaos") {
    // Fallback: if poe.ninja ever flips PoE 2's primary to chaos (matching
    // PoE 1), find Divine Orb's price the PoE 1 way.
    const idx = data.items?.findIndex((i) => i.name === "Divine Orb") ?? -1;
    const divineRate = idx >= 0 ? data.lines?.[idx]?.primaryValue ?? 0 : 0;
    if (divineRate <= 0) {
      throw new Error(`Divine Orb price not found in chaos-primary response for ${league}`);
    }
    return { divineRate, primaryIsDivine: false };
  }

  throw new Error(`Unrecognized core.primary "${primary ?? "(missing)"}" in poe.ninja response for ${league}`);
}

/** Fetch one PoE 2 category. Tolerates per-category failures (404, empty
 *  body, transient 5xx) by returning []. A single bad category should not
 *  abort the whole refresh, but a bad rate fetch upstream WILL. */
async function fetchCategory(
  league: string,
  apiType: string,
  rate: RateInfo,
): Promise<NinjaFetchedItem[]> {
  const url = `${NINJA_BASE}/exchange/current/overview?league=${encodeURIComponent(league)}&type=${apiType}`;
  const res = await fetch(url);
  if (!res.ok) return [];

  const data = (await res.json()) as NinjaExchangeResponse;
  if (!data.lines?.length || !data.items?.length) return [];

  const chaosRatio = rate.primaryIsDivine ? rate.divineRate : 1;
  const out: NinjaFetchedItem[] = [];

  for (let i = 0; i < data.lines.length; i++) {
    const line = data.lines[i];
    const item = data.items[i];
    if (!item) continue;

    // Defensive: a future schema change could reintroduce null prices.
    if (line.primaryValue == null) continue;

    const icon = item.image
      ? item.image.startsWith("http")
        ? item.image
        : `${POECDN_BASE}${item.image}`
      : null;

    const chaosValue = line.primaryValue * chaosRatio;
    const divineValue = chaosValue / rate.divineRate;

    out.push({
      game: "poe2",
      league,
      itemName: item.name.toLowerCase(),
      chaosValue,
      divineValue,
      listingCount: 0,
      source: "exchange",
      ninjaCategory: apiType,
      icon,
      detailsId: item.detailsId,
      sparklineData: line.sparkline?.data ?? null,
      totalChange: line.sparkline?.totalChange ?? null,
      volume: line.volumePrimaryValue ?? null,
    });
  }

  return out;
}

export async function fetchAllPoe2Prices(
  league: string,
): Promise<{ rows: NinjaFetchedItem[]; divineRate: number }> {
  // Rate must succeed before we touch categories — every chaos value
  // depends on it, unlike PoE 1 where chaos values are independent.
  const rate = await getRateInfo(league);

  const results = await Promise.all(
    POE2_CATEGORIES.map((cat) =>
      fetchCategory(league, cat.apiType, rate).catch(() => [] as NinjaFetchedItem[]),
    ),
  );

  return { rows: results.flat(), divineRate: rate.divineRate };
}
