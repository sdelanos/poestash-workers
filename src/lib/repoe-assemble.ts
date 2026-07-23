/**
 * Filesystem assembly + validation for a RePoE `--language all` PoE1 run.
 *
 * `assembleVendoredData` turns RePoE's output tree (English at root, one
 * `{Language}/` subfolder per language) into the tree PoeStash vendors under
 * `docs/repoe-data/`: the refreshed English root files, a `stat_translations.json`
 * with every language slot filled, and per-language `{Language}/names.json`
 * lookups. `checkVendoredOutput` is the schema gate the CI run and the tests
 * both call. All the shape logic lives in `repoe-localized.ts`.
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

import {
  LANGS,
  vendoredStatKey,
  STAT_LANG_KEYS,
  mergeStatTranslations,
  buildNameLookup,
  type StatEntry,
  type NameLookup,
} from "./repoe-localized";

const NON_ENGLISH_LANGS = LANGS.filter((l) => l !== "English");

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const writeJson = (path: string, value: unknown): void =>
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");

export interface AssembleSummary {
  /** Non-English language folders found in the RePoE output. */
  languages: string[];
  /** Total merged stat-translation entries. */
  statEntries: number;
  /** Per language: how many stat slots got a non-null value. */
  filledStatSlots: Record<string, number>;
  /** Per language: name-lookup counts by category. */
  names: Record<string, { bases: number; currency: number; gems: number; uniques: number }>;
}

/**
 * Assemble the vendored tree from a RePoE output directory.
 *
 * Copies every root `*.json` (the refreshed English data), overwrites
 * `stat_translations.json` with the all-languages merge, and writes a
 * `{Language}/names.json` lookup for every non-English language present.
 */
export function assembleVendoredData(srcDir: string, outDir: string): AssembleSummary {
  mkdirSync(outDir, { recursive: true });

  // 1. Refresh the English root files verbatim. RePoE emits a `.min.json`
  //    alongside every file; the vendored set keeps only the pretty ones.
  for (const file of readdirSync(srcDir)) {
    if (file.endsWith(".json") && !file.endsWith(".min.json")) {
      writeFileSync(join(outDir, file), readFileSync(join(srcDir, file)));
    }
  }

  // 2. Merge stat_translations across every language subfolder.
  const english = readJson<StatEntry[]>(join(srcDir, "stat_translations.json"));
  const perLanguage: Record<string, StatEntry[]> = {};
  const languages: string[] = [];
  for (const lang of NON_ENGLISH_LANGS) {
    const path = join(srcDir, lang, "stat_translations.json");
    if (existsSync(path)) {
      perLanguage[vendoredStatKey(lang)] = readJson<StatEntry[]>(path);
      languages.push(lang);
    }
  }
  const merged = mergeStatTranslations(english, perLanguage);
  writeJson(join(outDir, "stat_translations.json"), merged);

  const filledStatSlots: Record<string, number> = {};
  for (const lang of languages) {
    const key = vendoredStatKey(lang);
    filledStatSlots[lang] = merged.filter((e) => e[key] != null).length;
  }

  // 3. Per-language name lookups.
  const names: AssembleSummary["names"] = {};
  for (const lang of languages) {
    const dir = join(srcDir, lang);
    const lookup = buildNameLookup(
      readJson(join(dir, "base_items.json")),
      readJson(join(dir, "gems.json")),
      readJson(join(dir, "uniques.json")),
    );
    mkdirSync(join(outDir, lang), { recursive: true });
    writeJson(join(outDir, lang, "names.json"), lookup);
    names[lang] = {
      bases: Object.keys(lookup.bases).length,
      currency: Object.keys(lookup.currency).length,
      gems: Object.keys(lookup.gems).length,
      uniques: Object.keys(lookup.uniques).length,
    };
  }

  return { languages, statEntries: merged.length, filledStatSlots, names };
}

const EXPECTED_STAT_KEYS = new Set(["ids", "trade_stats", "hidden", ...STAT_LANG_KEYS]);

/**
 * Schema gate over an assembled vendored tree: the merged stat file keeps the
 * vendored shape and has filled slots for each requested language, and every
 * requested language has non-empty name lookups in all four categories.
 * Returns the list of problems; empty means the output is good.
 */
export function checkVendoredOutput(
  outDir: string,
  languages: string[],
): string[] {
  const errors: string[] = [];

  const stats = readJson<StatEntry[]>(join(outDir, "stat_translations.json"));
  if (!Array.isArray(stats) || stats.length === 0) {
    errors.push("stat_translations.json is not a non-empty array");
    return errors;
  }
  // Top-level schema unchanged: sample a handful of entries.
  for (const entry of stats.slice(0, 50)) {
    for (const key of Object.keys(entry)) {
      if (!EXPECTED_STAT_KEYS.has(key)) {
        errors.push(`stat_translations entry has unexpected key "${key}"`);
      }
    }
    if (!("English" in entry) || !Array.isArray(entry.ids)) {
      errors.push("stat_translations entry missing English/ids");
    }
  }

  for (const lang of languages) {
    const key = vendoredStatKey(lang);
    const filled = stats.filter((e) => e[key] != null).length;
    if (filled === 0) {
      errors.push(`stat_translations has no filled "${key}" slots (was all null)`);
    }

    const namesPath = join(outDir, lang, "names.json");
    if (!existsSync(namesPath)) {
      errors.push(`missing ${lang}/names.json`);
      continue;
    }
    const names = readJson<NameLookup>(namesPath);
    for (const category of ["bases", "currency", "gems", "uniques"] as const) {
      if (!names[category] || Object.keys(names[category]).length === 0) {
        errors.push(`${lang}/names.json has empty "${category}" lookup`);
      }
    }
  }

  return errors;
}
