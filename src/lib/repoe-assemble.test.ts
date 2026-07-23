import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { assembleVendoredData, checkVendoredOutput } from "./repoe-assemble";
import type { StatEntry, NameLookup } from "./repoe-localized";

const FIXTURE = fileURLToPath(new URL("./__fixtures__/repoe-out", import.meta.url));

/**
 * The output-schema assertions from issue #12: assemble a RePoE `--language all`
 * fixture and confirm the vendored tree has filled language slots and per-language
 * name lookups, with the top-level stat schema unchanged.
 */
describe("assembleVendoredData (output-schema assertions on a fixture)", () => {
  let out: string;
  let summary: ReturnType<typeof assembleVendoredData>;

  beforeAll(() => {
    out = mkdtempSync(join(tmpdir(), "repoe-vendored-"));
    summary = assembleVendoredData(FIXTURE, out);
  });

  afterAll(() => rmSync(out, { recursive: true, force: true }));

  const readJson = <T>(rel: string): T => JSON.parse(readFileSync(join(out, rel), "utf8")) as T;

  it("discovers the non-English language folders in the run", () => {
    expect(summary.languages).toEqual(["French", "Korean", "Traditional Chinese"]);
  });

  it("keeps the exact vendored stat_translations top-level schema", () => {
    const stats = readJson<StatEntry[]>("stat_translations.json");
    expect(stats).toHaveLength(2);
    expect(Object.keys(stats[0])).toEqual([
      "English",
      "ids",
      "trade_stats",
      "hidden",
      "French",
      "German",
      "Japanese",
      "Korean",
      "Portuguese",
      "Russian",
      "Spanish",
      "Thai",
      "Traditional_Chinese",
    ]);
  });

  it("fills previously-null language slots for the languages that ran", () => {
    const stats = readJson<StatEntry[]>("stat_translations.json");
    // attack_speed ran in French, Korean and Traditional Chinese.
    expect(stats[0].French).not.toBeNull();
    expect(stats[0].Korean).not.toBeNull();
    // Traditional Chinese exercises the space-vs-underscore key: RePoE emits
    // "Traditional Chinese" inline, we store it under "Traditional_Chinese".
    expect(stats[0].Traditional_Chinese).not.toBeNull();
    // the hidden stat only ran in Korean -> the others stay null.
    expect(stats[1].French).toBeNull();
    expect(stats[1].Korean).not.toBeNull();
    expect(stats[1].Traditional_Chinese).toBeNull();
    // a language that never ran stays null everywhere.
    expect(stats[0].German).toBeNull();
    expect(summary.filledStatSlots).toEqual({
      French: 1,
      Korean: 2,
      "Traditional Chinese": 1,
    });
  });

  it("emits per-language name lookups for bases, currency, gems and uniques", () => {
    for (const lang of ["French", "Korean", "Traditional Chinese"]) {
      expect(existsSync(join(out, lang, "names.json"))).toBe(true);
      const names = readJson<NameLookup>(join(lang, "names.json"));
      expect(Object.keys(names.bases).length).toBeGreaterThan(0);
      expect(Object.keys(names.currency).length).toBeGreaterThan(0);
      expect(Object.keys(names.gems).length).toBeGreaterThan(0);
      expect(Object.keys(names.uniques).length).toBeGreaterThan(0);
    }
  });

  it("localizes sampled names and keys uniques on the language-invariant id", () => {
    const fr = readJson<NameLookup>(join("French", "names.json"));
    expect(fr.bases["Metadata/Items/Weapons/OneHandWeapons/Daggers/Dagger1"]).toBe("Stylet en verre");
    expect(fr.currency["Metadata/Items/Currency/CurrencyUpgradeToRare"]).toBe("Orbe d'alchimie");
    expect(fr.gems.Fireball).toBe("Boule de feu");
    expect(fr.uniques["Kaom's Primacy"]).toBe("Primauté de Kaom");
  });

  it("refreshes the English root files verbatim", () => {
    expect(existsSync(join(out, "base_items.json"))).toBe(true);
    expect(existsSync(join(out, "gems.json"))).toBe(true);
    expect(existsSync(join(out, "uniques.json"))).toBe(true);
  });

  it("passes the checkVendoredOutput schema gate for the sampled languages", () => {
    expect(checkVendoredOutput(out, ["French", "Korean", "Traditional Chinese"])).toEqual([]);
  });

  it("checkVendoredOutput flags a language whose slots never filled", () => {
    const errors = checkVendoredOutput(out, ["German"]);
    expect(errors).toContain('stat_translations has no filled "German" slots (was all null)');
  });
});
