/** Column lists and the ON CONFLICT clause for the ninja_prices upsert. */

// All columns in ninja_prices, in insertion order.
export const COLUMNS = [
  "game", "league", "item_name", "chaos_value", "divine_value",
  "listing_count", "source", "ninja_category", "icon", "details_id",
  "sparkline_data", "total_change", "stack_size", "explicit_modifiers",
  "variant", "base_type", "links", "item_class", "item_type",
  "corrupted", "gem_level", "gem_quality", "level_required",
  "exalted_value", "count", "volume", "mutated_modifiers",
  "flavour_text", "implicit_modifiers", "property_modifiers", "requirement_modifiers",
  "pay_value", "receive_value", "pay_listing_count", "receive_listing_count",
  "updated_at",
] as const;

// The conflict target, never updated.
const KEY_COLUMNS: readonly string[] = ["game", "league", "details_id", "source"];

/** Every column the feed can change: the ones compared to decide whether a
 *  row is rewritten. SET and WHERE are both built from this one list so they
 *  cannot drift apart. */
export const DATA_COLUMNS = COLUMNS.filter(
  (c) => !KEY_COLUMNS.includes(c) && c !== "updated_at",
);

/** Rewrites a conflicting row only when some data column actually differs.
 *
 *  Without the WHERE, every run rewrote every row (updated_at always moved),
 *  dirtying ~130MB of pages per run on a Micro Supabase instance whether or
 *  not poe.ninja had published anything new. IS DISTINCT FROM is null-safe,
 *  and every modifier/sparkline column is jsonb (which has equality), so the
 *  row comparison is exact. Built from constants only, hence safe to inline
 *  with sql.unsafe. */
export const UPSERT_CLAUSE = `ON CONFLICT (${KEY_COLUMNS.join(", ")}) DO UPDATE SET
  ${[...DATA_COLUMNS, "updated_at"].map((c) => `${c} = EXCLUDED.${c}`).join(",\n  ")}
WHERE (${DATA_COLUMNS.map((c) => `ninja_prices.${c}`).join(", ")})
  IS DISTINCT FROM (${DATA_COLUMNS.map((c) => `EXCLUDED.${c}`).join(", ")})`;
