/**
 * PoE 2 economy categories on poe.ninja, verified 2026-05-12 via Playwright
 * network capture against poe.ninja's live PoE 2 site (Fate of the Vaal).
 *
 * Naming twist: API `type` values often reflect the in-game **mechanic**
 * rather than the display label. Omens are Ritual-mechanic items
 * (`type=Ritual`), Abyssal Bones come from Abyss (`type=Abyss`), Liquid
 * Emotions from Delirium (`type=Delirium`), Breach Catalysts from Breach
 * (`type=Breach`). The display label is what players think of; the API
 * type is what GGG named the system. Bake both into this file so display
 * label, URL slug, and API type stay in sync.
 *
 * Counts as of 2026-05-12 (will vary by league and refresh):
 *   Currency 43, Fragments 17, Abyss 15, UncutGems 42, LineageSupportGems 50,
 *   Essences 63, SoulCores 34, Idol 18, Runes 51, Ritual 38, Expedition 5,
 *   Delirium 10, Breach 13 → ~400 items per league.
 */

export interface Poe2Category {
  /** Sidebar display label, matches poe.ninja UI. */
  label: string;
  /** URL slug on poe.ninja, for deep-linking from the app's economy page. */
  slug: string;
  /** Value passed as `type=` to the poe.ninja endpoint. */
  apiType: string;
  /**
   * Which poe.ninja feed serves this category, mirroring the
   * `availableViews` field in poe.ninja's own metadata:
   *   - "exchange": bulk Currency-Exchange feed
   *     (`exchange/current/overview`). Stackable currency-like items.
   *   - "item": named-item feed (`stash/current/item/overview`). Uniques,
   *     which carry baseType, level, corruption, and explicit mods.
   * The fetcher dispatches on this; both share the divine→chaos rate.
   */
  view: "exchange" | "item";
}

export const POE2_CATEGORIES: Poe2Category[] = [
  // GENERAL — Currency-Exchange feed.
  { label: "Currency",        slug: "currency",             apiType: "Currency",            view: "exchange" },
  { label: "Fragments",       slug: "fragments",            apiType: "Fragments",           view: "exchange" },
  { label: "Abyssal Bones",   slug: "abyssal-bones",        apiType: "Abyss",               view: "exchange" },
  { label: "Uncut Gems",      slug: "uncut-gems",           apiType: "UncutGems",           view: "exchange" },
  { label: "Lineage Gems",    slug: "lineage-support-gems", apiType: "LineageSupportGems",  view: "exchange" },
  { label: "Essences",        slug: "essences",             apiType: "Essences",            view: "exchange" },
  { label: "Soul Cores",      slug: "soul-cores",           apiType: "SoulCores",           view: "exchange" },
  { label: "Idols",           slug: "idols",                apiType: "Idol",                view: "exchange" },
  { label: "Runes",           slug: "runes",                apiType: "Runes",               view: "exchange" },
  { label: "Omens",           slug: "omens",                apiType: "Ritual",              view: "exchange" },
  { label: "Expedition",      slug: "expedition",           apiType: "Expedition",          view: "exchange" },
  { label: "Liquid Emotions", slug: "liquid-emotions",      apiType: "Delirium",            view: "exchange" },
  { label: "Catalysts",       slug: "breach-catalyst",      apiType: "Breach",              view: "exchange" },
  // EQUIPMENT — named-item feed. Verified 2026-05-27 against poe.ninja's
  // PoE 2 metadata: types are PLURAL (UniqueWeapons, not UniqueWeapon) and
  // Relics use "UniqueSanctumRelics". Don't "correct" them to the PoE 1
  // singular forms — poe.ninja returns empty for those.
  { label: "Unique Weapons",     slug: "unique-weapons",     apiType: "UniqueWeapons",       view: "item" },
  { label: "Unique Armours",     slug: "unique-armours",     apiType: "UniqueArmours",       view: "item" },
  { label: "Unique Accessories", slug: "unique-accessories", apiType: "UniqueAccessories",   view: "item" },
  { label: "Unique Flasks",      slug: "unique-flasks",      apiType: "UniqueFlasks",        view: "item" },
  { label: "Unique Charms",      slug: "unique-charms",      apiType: "UniqueCharms",        view: "item" },
  { label: "Unique Jewels",      slug: "unique-jewels",      apiType: "UniqueJewels",        view: "item" },
  { label: "Unique Maps",        slug: "unique-maps",        apiType: "UniqueMaps",          view: "item" },
  { label: "Unique Relics",      slug: "unique-relics",      apiType: "UniqueSanctumRelics", view: "item" },
];
