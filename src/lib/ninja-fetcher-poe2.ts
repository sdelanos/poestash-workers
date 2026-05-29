/**
 * PoE 2 prices fetcher. Hits poe.ninja's PoE 2 economy feeds for each
 * category in ./poe2-categories.ts and emits `NinjaFetchedItem` rows ready
 * for the same upsert path PoE 1 uses.
 *
 * Two feeds, dispatched by each category's `view`:
 *   - "exchange" (the 13 GENERAL categories): the Currency-Exchange
 *     `exchange/current/overview` feed. Stackable currency-like items.
 *   - "item" (the 8 EQUIPMENT/unique categories): the named-item
 *     `stash/current/item/overview` feed. Carries baseType, level,
 *     corruption, and explicit mods; source is "stash" like PoE 1 uniques.
 *
 * Differences from PoE 1 worth knowing:
 *   - URL base is `/poe2/api/economy` (vs `/poe1/`).
 *   - Primary denomination on responses is **divine**, not chaos. The
 *     `primaryValue` for a row is the price in divines. We multiply by
 *     `core.rates.chaos` (chaos-per-divine) to populate the canonical
 *     `chaosValue` schema column, then derive `divineValue` from chaos
 *     using the same rate, matching the PoE 1 semantics. Both feeds share
 *     the one divine rate fetched up front from Currency.
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
 *  is down or the response is malformed. Returns `null` when poe.ninja
 *  lists the league but has not priced it yet (the pre-launch window — see
 *  below); the caller treats that as a clean skip.
 *  Critical because every PoE 2 chaos value depends on this rate — unlike
 *  PoE 1 where chaos values come straight from the response. */
async function getRateInfo(league: string): Promise<RateInfo | null> {
  const url = `${NINJA_BASE}/exchange/current/overview?league=${encodeURIComponent(league)}&type=Currency`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`poe.ninja Currency fetch ${res.status}: ${res.statusText}`);
  }
  const data = (await res.json()) as NinjaExchangeResponse;

  // poe.ninja flags a new league `indexed: true` in index-state the moment
  // it is announced, but the economy feed stays empty until the first trades
  // land. That pre-launch window returns primary "chaos", empty rates, and
  // zero items — no divine rate exists yet because nothing has been sold.
  // Treat it as "not priced yet" (null) rather than a malformed response: it
  // self-heals the instant real trades populate the feed, with no code change.
  const hasItems = (data.items?.length ?? 0) > 0;
  const hasChaosRate = (data.core?.rates?.chaos ?? 0) > 0;
  if (!hasItems && !hasChaosRate) {
    return null;
  }

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

// ---------------------------------------------------------------------------
// Named-item feed (uniques): stash/current/item/overview
// ---------------------------------------------------------------------------

/** One row from the PoE 2 named-item feed. Same `primaryValue` + shared
 *  `core` rates as the exchange feed, plus item identity fields. */
interface Poe2ItemLine {
  detailsId: string;
  name: string;
  baseType?: string;
  icon?: string;
  levelRequired?: number;
  primaryValue: number | null;
  listingCount?: number;
  corrupted?: boolean;
  sparkLine?: { totalChange: number; data: (number | null)[] };
  explicitModifiers?: { text: string; optional: boolean }[];
}

interface Poe2ItemResponse {
  lines?: Poe2ItemLine[];
}

/** poe.ninja wraps mod text in wiki markup: `[Display]` and `[Key|Display]`.
 *  Strip it to the plain text players read so the stored data is clean for
 *  any consumer. `[ElementalDamage|Elemental Damage]` → "Elemental Damage",
 *  `[Gain]` → "Gain". */
function cleanModText(text: string): string {
  return text
    .replace(/\[[^\]|]+\|([^\]]+)\]/g, "$1")
    .replace(/\[([^\]]+)\]/g, "$1");
}

/** Fetch one PoE 2 named-item category (uniques). Same per-category
 *  fault tolerance as `fetchCategory`. */
async function fetchItemCategory(
  league: string,
  apiType: string,
  rate: RateInfo,
): Promise<NinjaFetchedItem[]> {
  const url = `${NINJA_BASE}/stash/current/item/overview?league=${encodeURIComponent(league)}&type=${apiType}`;
  const res = await fetch(url);
  if (!res.ok) return [];

  const data = (await res.json()) as Poe2ItemResponse;
  if (!data.lines?.length) return [];

  const chaosRatio = rate.primaryIsDivine ? rate.divineRate : 1;
  const out: NinjaFetchedItem[] = [];

  for (const line of data.lines) {
    if (line.primaryValue == null) continue;

    const chaosValue = line.primaryValue * chaosRatio;
    const divineValue = chaosValue / rate.divineRate;

    out.push({
      game: "poe2",
      league,
      itemName: line.name.toLowerCase(),
      chaosValue,
      divineValue,
      listingCount: line.listingCount ?? 0,
      // PoE 2 uniques have a single source on poe.ninja (the named-item
      // feed), so "stash" is their canonical source — same as PoE 1 uniques.
      source: "stash",
      ninjaCategory: apiType,
      icon: line.icon ?? null,
      detailsId: line.detailsId,
      sparklineData: line.sparkLine?.data ?? null,
      totalChange: line.sparkLine?.totalChange ?? null,
      baseType: line.baseType ?? null,
      corrupted: line.corrupted ?? null,
      levelRequired: line.levelRequired ?? null,
      explicitModifiers:
        line.explicitModifiers?.map((m) => ({
          text: cleanModText(m.text),
          optional: m.optional,
        })) ?? null,
    });
  }

  return out;
}

export async function fetchAllPoe2Prices(
  league: string,
): Promise<{ rows: NinjaFetchedItem[]; divineRate: number } | null> {
  // Rate must succeed before we touch categories — every chaos value
  // depends on it, unlike PoE 1 where chaos values are independent.
  // `null` means poe.ninja lists the league but has not priced it yet
  // (pre-launch); propagate that so the caller skips it cleanly.
  const rate = await getRateInfo(league);
  if (rate == null) return null;

  const results = await Promise.all(
    POE2_CATEGORIES.map((cat) =>
      (cat.view === "item"
        ? fetchItemCategory(league, cat.apiType, rate)
        : fetchCategory(league, cat.apiType, rate)
      ).catch(() => [] as NinjaFetchedItem[]),
    ),
  );

  return { rows: results.flat(), divineRate: rate.divineRate };
}
