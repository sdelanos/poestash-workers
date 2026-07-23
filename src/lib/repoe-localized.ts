/**
 * Pure post-processing for a `repoe-fork/RePoE --language all` PoE1 run.
 *
 * RePoE writes English to the output root and every other language to its own
 * `{Language}/` subfolder, one language per file. Two shapes need assembling
 * from that layout to match what PoeStash vendors under `docs/repoe-data/`:
 *
 *  1. `stat_translations.json` carries every language inline per entry, keyed
 *     by language name, with the not-yet-run languages left `null`. RePoE emits
 *     one such file per language (only that language's key populated), so we
 *     merge them by matching `ids`. See ADR 0004 in the app repo.
 *  2. Per-language name lookups (`{Language}/names.json`) — id -> localized name
 *     for bases, currency, gems, and uniques — built from that language's
 *     `base_items.json` / `gems.json` / `uniques.json`.
 *
 * Everything here is pure (data in, data out) so the assertions in
 * `repoe-localized.test.ts` can exercise it against a fixture with no IO.
 */

/** RePoE `LANGS` keys — the exact per-language output folder names. */
export const LANGS = [
  "English",
  "French",
  "German",
  "Japanese",
  "Korean",
  "Portuguese",
  "Russian",
  "Spanish",
  "Thai",
  "Traditional Chinese",
] as const;

export type Lang = (typeof LANGS)[number];

/**
 * The language key used inside the vendored `stat_translations.json`. It is the
 * folder name with spaces underscored, so RePoE's `Traditional Chinese` folder
 * becomes the `Traditional_Chinese` slot the vendored file already declares.
 */
export const vendoredStatKey = (lang: string): string => lang.replace(/ /g, "_");

/** Ordered stat-translation keys, matching the existing vendored file exactly. */
export const STAT_LANG_KEYS = LANGS.map(vendoredStatKey);

/** Non-English stat keys, in vendored order (the slots to fill from subfolders). */
export const NON_ENGLISH_STAT_KEYS = STAT_LANG_KEYS.filter((k) => k !== "English");

/**
 * Vendored stat key -> the raw language name RePoE keys its inline payload by.
 * These differ only for Traditional Chinese (`Traditional_Chinese` vs the raw
 * `Traditional Chinese`), which is exactly the case a French/Korean fixture
 * cannot surface — the merge must read by the raw name, not the vendored key.
 */
const RAW_LANG_BY_STAT_KEY: Record<string, string> = Object.fromEntries(
  LANGS.map((lang) => [vendoredStatKey(lang), lang]),
);

export interface StatEntry {
  ids: string[];
  trade_stats?: unknown[] | null;
  hidden?: boolean | null;
  // English / French / German / ... each hold an array of translation objects.
  [langKey: string]: unknown;
}

const idKey = (ids: string[]): string => ids.join("\u0000");

/**
 * Merge RePoE's per-language `stat_translations.json` files into the single
 * all-languages-inline shape PoeStash vendors.
 *
 * @param english     Entries from the root `stat_translations.json`.
 * @param perLanguage Map of vendored language key (`French`, `Traditional_Chinese`, …)
 *                    to that language's entries (each entry carries its own
 *                    language key inline, per RePoE's output).
 *
 * Every English entry is preserved; a language slot is filled when a subfolder
 * has an entry with the same `ids`, and left `null` otherwise. Key order matches
 * the vendored file: English, ids, trade_stats, hidden, then the other languages.
 */
export function mergeStatTranslations(
  english: StatEntry[],
  perLanguage: Record<string, StatEntry[]>,
): StatEntry[] {
  const indexByLang: Record<string, Map<string, StatEntry>> = {};
  for (const [langKey, entries] of Object.entries(perLanguage)) {
    const map = new Map<string, StatEntry>();
    for (const entry of entries) map.set(idKey(entry.ids), entry);
    indexByLang[langKey] = map;
  }

  return english.map((entry) => {
    const merged: StatEntry = {
      English: entry.English ?? null,
      ids: entry.ids,
      trade_stats: entry.trade_stats ?? null,
      hidden: entry.hidden ?? null,
    };
    for (const langKey of NON_ENGLISH_STAT_KEYS) {
      const match = indexByLang[langKey]?.get(idKey(entry.ids));
      // RePoE keys the payload by the raw language name (e.g. "Traditional
      // Chinese"); we store it under the underscored vendored key.
      merged[langKey] = match ? (match[RAW_LANG_BY_STAT_KEY[langKey]] ?? null) : null;
    }
    return merged;
  });
}

/** RePoE `base_items.json` value (only the fields we read). */
interface BaseItem {
  name: string;
  item_class: string;
}

/** RePoE `gems.json` value (only the fields we read). */
interface Gem {
  display_name?: string;
  active_skill?: { display_name?: string } | null;
}

/** RePoE `uniques.json` value (only the fields we read). */
interface Unique {
  /** WordsKey `Text` — the unique's English name; stays English in every
   *  language file (verified against the fork's published French output), so it
   *  is the language-invariant handle. `name` (WordsKey `Text2`) is localized. */
  id: string;
  name: string;
}

export interface NameLookup {
  /** metadata id -> localized name, non-currency base items. */
  bases: Record<string, string>;
  /** metadata id -> localized name, currency-class base items. */
  currency: Record<string, string>;
  /** stable gem key -> localized display name. */
  gems: Record<string, string>;
  /** language-invariant unique id (English WordsKey text) -> localized name. */
  uniques: Record<string, string>;
}

/**
 * Currency shares `base_items.json` with equipment; GGG models every currency
 * class name with the substring `Currency` (`StackableCurrency`, `Currency`,
 * `DelveSocketableCurrency`, `DelveStackableSocketableCurrency`).
 */
export const isCurrencyClass = (itemClass: string): boolean =>
  itemClass.includes("Currency");

/**
 * Build one language's Canonical-Id -> localized-name lookups from its RePoE
 * files (ADR 0005: game data keys on language-invariant Canonical Ids). Bases
 * and currency key on their metadata id; gems keep RePoE's stable top-level key;
 * uniques key on `id` (the English WordsKey text), which stays constant across
 * language files while `name` localizes.
 *
 * Uniques deliberately do NOT key on `visual_identity.id`: 63 art ids are
 * shared across distinct uniques (upgrade/vaal pairs like Redbeak/Dreadbeak,
 * Death's Harp/Opus reuse one base art), so keying on it would silently drop one
 * name of each pair. `id` distinguishes them and collides only across alternate
 * art of the *same* unique, where the name is identical anyway.
 */
export function buildNameLookup(
  baseItems: Record<string, BaseItem>,
  gems: Record<string, Gem>,
  uniques: Record<string, Unique>,
): NameLookup {
  const bases: Record<string, string> = {};
  const currency: Record<string, string> = {};
  for (const [id, item] of Object.entries(baseItems)) {
    (isCurrencyClass(item.item_class) ? currency : bases)[id] = item.name;
  }

  const gemsOut: Record<string, string> = {};
  for (const [key, gem] of Object.entries(gems)) {
    gemsOut[key] = gem.display_name ?? gem.active_skill?.display_name ?? key;
  }

  const uniquesOut: Record<string, string> = {};
  for (const unique of Object.values(uniques)) {
    uniquesOut[unique.id] = unique.name;
  }

  return { bases, currency, gems: gemsOut, uniques: uniquesOut };
}
