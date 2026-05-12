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
  /** Value passed as `type=` to the poe.ninja exchange endpoint. */
  apiType: string;
}

export const POE2_CATEGORIES: Poe2Category[] = [
  { label: "Currency",        slug: "currency",             apiType: "Currency" },
  { label: "Fragments",       slug: "fragments",            apiType: "Fragments" },
  { label: "Abyssal Bones",   slug: "abyssal-bones",        apiType: "Abyss" },
  { label: "Uncut Gems",      slug: "uncut-gems",           apiType: "UncutGems" },
  { label: "Lineage Gems",    slug: "lineage-support-gems", apiType: "LineageSupportGems" },
  { label: "Essences",        slug: "essences",             apiType: "Essences" },
  { label: "Soul Cores",      slug: "soul-cores",           apiType: "SoulCores" },
  { label: "Idols",           slug: "idols",                apiType: "Idol" },
  { label: "Runes",           slug: "runes",                apiType: "Runes" },
  { label: "Omens",           slug: "omens",                apiType: "Ritual" },
  { label: "Expedition",      slug: "expedition",           apiType: "Expedition" },
  { label: "Liquid Emotions", slug: "liquid-emotions",      apiType: "Delirium" },
  { label: "Catalysts",       slug: "breach-catalyst",      apiType: "Breach" },
];
