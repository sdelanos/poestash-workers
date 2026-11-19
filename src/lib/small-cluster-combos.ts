/**
 * The Small Cluster Jewel combo catalogue, and its mapping onto
 * `cluster_jewel_prices` rows.
 *
 * Medium and large clusters roll two or three notables, so their catalogue is
 * thousands of pairings that only ever get copied from one league to the next.
 * A small cluster rolls a *single* notable, so its whole combo space is one
 * notable per enchantment — 146 combos — and fits in a committed file, generated
 * from RePoE by poestash's scripts/gen-small-cluster-combos.ts.
 *
 * Each combo is priced twice, once per passive count (poestash decision 579):
 * a 2 passive small jewel (the notable for 2 points) and a 3 passive one (3
 * points, an extra small passive) sell as different items, from 10c against
 * 120c for Introspection to 50c against 20c for One with the Shield. One search
 * over both counts returned whichever was cheaper, which priced neither.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export interface SmallCombo {
  enchantmentTag: string;
  notableName: string;
  tradeStatId: string;
}

export interface SmallComboRow {
  /** Cluster jewels are PoE 1 only; part of the table's key. */
  game: "poe1";
  league: string;
  enchantment_tag: string;
  jewel_size: "small";
  combo_key: string;
  /** The passive count the row prices: 2 or 3. */
  passives: SmallPassives;
  notable_names: string[];
  trade_stat_ids: string[];
}

/** The passive counts a small cluster rolls (RePoE min_skills 2, max_skills 3). */
export const SMALL_PASSIVES = [2, 3] as const;
export type SmallPassives = (typeof SMALL_PASSIVES)[number];

const __dirname = dirname(fileURLToPath(import.meta.url));

export const SMALL_COMBOS: SmallCombo[] = JSON.parse(
  readFileSync(resolve(__dirname, "../data/small-cluster-combos.json"), "utf8"),
);

/**
 * Two catalogue rows per combo, one per passive count, ready to insert.
 *
 * `combo_key` is the notable's name and the count ("Enduring Composure|2"): the
 * table's key is the " + "-joined notable list, a small cluster's is one name
 * long, and the count keeps the two rows apart without changing the key. The
 * `passives` column carries the count for every reader. The JSONB values
 * stay plain arrays — postgres.js stringifies JSONB parameters itself, so
 * pre-stringifying stores a JSON string instead of a JSON array (the bug
 * documented in refresh-ninja-prices.ts).
 */
export function smallComboRows(
  league: string,
  combos: readonly SmallCombo[],
): SmallComboRow[] {
  return combos.flatMap((c) =>
    SMALL_PASSIVES.map((passives) => ({
      game: "poe1" as const,
      league,
      enchantment_tag: c.enchantmentTag,
      jewel_size: "small" as const,
      combo_key: `${c.notableName}|${passives}`,
      passives,
      notable_names: [c.notableName],
      trade_stat_ids: [c.tradeStatId],
    })),
  );
}
