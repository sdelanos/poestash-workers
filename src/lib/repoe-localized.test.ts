import { describe, it, expect } from "vitest";
import {
  STAT_LANG_KEYS,
  vendoredStatKey,
  mergeStatTranslations,
  buildNameLookup,
  isCurrencyClass,
  type StatEntry,
} from "./repoe-localized";

describe("vendoredStatKey", () => {
  it("underscores spaces so the Traditional Chinese folder maps to the vendored slot", () => {
    expect(vendoredStatKey("Traditional Chinese")).toBe("Traditional_Chinese");
    expect(vendoredStatKey("French")).toBe("French");
  });

  it("STAT_LANG_KEYS matches the vendored stat_translations key set and order", () => {
    expect(STAT_LANG_KEYS).toEqual([
      "English",
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
});

describe("mergeStatTranslations", () => {
  const english: StatEntry[] = [
    { English: [{ string: "a" }], ids: ["a"], trade_stats: [{ id: "x" }], hidden: null },
    { English: [{ string: "b" }], ids: ["b"], trade_stats: null, hidden: true },
  ];

  it("fills the matching language slot and leaves unmatched ids null", () => {
    const merged = mergeStatTranslations(english, {
      French: [{ ids: ["a"], French: [{ string: "aa" }] }],
    });
    expect(merged[0].French).toEqual([{ string: "aa" }]);
    expect(merged[1].French).toBeNull();
  });

  it("emits every language slot, null when the language was not run", () => {
    const merged = mergeStatTranslations(english, {});
    expect(Object.keys(merged[0])).toEqual([
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
    expect(merged[0].German).toBeNull();
    expect(merged[0].Traditional_Chinese).toBeNull();
  });

  it("preserves English payload, ids, trade_stats and hidden from the root file", () => {
    const merged = mergeStatTranslations(english, {});
    expect(merged[0].English).toEqual([{ string: "a" }]);
    expect(merged[0].trade_stats).toEqual([{ id: "x" }]);
    expect(merged[1].hidden).toBe(true);
    expect(merged[1].trade_stats).toBeNull();
  });

  it("reads the Traditional Chinese payload by RePoE's raw name, writes the underscored slot", () => {
    // RePoE keys the inline payload "Traditional Chinese" (space); the vendored
    // slot is "Traditional_Chinese" (underscore). Regression guard for the bug
    // that a French/Korean-only fixture could never surface.
    const merged = mergeStatTranslations(english, {
      Traditional_Chinese: [{ ids: ["a"], "Traditional Chinese": [{ string: "快" }] }],
    });
    expect(merged[0].Traditional_Chinese).toEqual([{ string: "快" }]);
  });

  it("matches entries by their full ids list, not just the first id", () => {
    const multi: StatEntry[] = [{ English: [], ids: ["a", "b"] }];
    const merged = mergeStatTranslations(multi, {
      French: [
        { ids: ["a"], French: [{ string: "wrong" }] },
        { ids: ["a", "b"], French: [{ string: "right" }] },
      ],
    });
    expect(merged[0].French).toEqual([{ string: "right" }]);
  });
});

describe("isCurrencyClass", () => {
  it("treats every GGG currency item class as currency", () => {
    expect(isCurrencyClass("StackableCurrency")).toBe(true);
    expect(isCurrencyClass("Currency")).toBe(true);
    expect(isCurrencyClass("DelveStackableSocketableCurrency")).toBe(true);
    expect(isCurrencyClass("Dagger")).toBe(false);
  });
});

describe("buildNameLookup", () => {
  it("splits bases from currency, and keys uniques by their language-invariant id", () => {
    const lookup = buildNameLookup(
      {
        "Metadata/.../Dagger1": { name: "Stylet en verre", item_class: "Dagger" },
        "Metadata/.../Alch": { name: "Orbe d'alchimie", item_class: "StackableCurrency" },
      },
      { Fireball: { display_name: "Boule de feu" } },
      // The French file keeps the English `id` and localizes only `name`.
      { "0": { id: "Kaom's Primacy", name: "Primauté de Kaom" } },
    );
    expect(lookup.bases).toEqual({ "Metadata/.../Dagger1": "Stylet en verre" });
    expect(lookup.currency).toEqual({ "Metadata/.../Alch": "Orbe d'alchimie" });
    expect(lookup.gems).toEqual({ Fireball: "Boule de feu" });
    expect(lookup.uniques).toEqual({ "Kaom's Primacy": "Primauté de Kaom" });
  });

  it("keeps upgrade pairs that share one visual identity distinct", () => {
    // Redbeak and Dreadbeak both render as UniqueOneHandSword1; keying on `id`
    // (not visual_identity.id) must retain both names.
    const lookup = buildNameLookup(
      {},
      {},
      {
        "0": { id: "Redbeak", name: "Redbeak" },
        "1": { id: "Dreadbeak", name: "Dreadbeak" },
      },
    );
    expect(lookup.uniques).toEqual({ Redbeak: "Redbeak", Dreadbeak: "Dreadbeak" });
  });

  it("falls back to the active-skill display name for gems without a top-level one", () => {
    const lookup = buildNameLookup({}, { Spark: { active_skill: { display_name: "Étincelle" } } }, {});
    expect(lookup.gems.Spark).toBe("Étincelle");
  });
});
