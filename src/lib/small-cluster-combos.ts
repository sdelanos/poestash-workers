/**
 * The Small Cluster Jewel combo catalogue, and its mapping onto
 * `cluster_jewel_prices` rows.
 *
 * Medium and large clusters roll two or three notables, so their catalogue is
 * thousands of pairings that only ever get copied from one league to the next.
 * A small cluster rolls a *single* notable, so its whole combo space is one
 * notable per enchantment — 146 rows — and fits in a committed file, generated
 * from RePoE by poestash's scripts/gen-small-cluster-combos.ts.
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
  notable_names: string[];
  trade_stat_ids: string[];
}

const __dirname = dirname(fileURLToPath(import.meta.url));

export const SMALL_COMBOS: SmallCombo[] = JSON.parse(
  readFileSync(resolve(__dirname, "../data/small-cluster-combos.json"), "utf8"),
);

/**
 * One catalogue row per combo, ready to insert.
 *
 * `combo_key` is the notable's name: the table's key is the " + "-joined
 * notable list and a small cluster's list is one name long. The JSONB values
 * stay plain arrays — postgres.js stringifies JSONB parameters itself, so
 * pre-stringifying stores a JSON string instead of a JSON array (the bug
 * documented in refresh-ninja-prices.ts).
 */
export function smallComboRows(
  league: string,
  combos: readonly SmallCombo[],
): SmallComboRow[] {
  return combos.map((c) => ({
    game: "poe1",
    league,
    enchantment_tag: c.enchantmentTag,
    jewel_size: "small",
    combo_key: c.notableName,
    notable_names: [c.notableName],
    trade_stat_ids: [c.tradeStatId],
  }));
}
