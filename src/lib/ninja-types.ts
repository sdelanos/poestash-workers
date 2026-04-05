// poe.ninja types — extracted from poestash main app (lib/poe-ninja/api-types.ts + types.ts)
// Only includes types needed by the fetcher and refresh script.

// ---------------------------------------------------------------------------
// Source types
// ---------------------------------------------------------------------------

export type NinjaSource = "stash" | "exchange";

// ---------------------------------------------------------------------------
// poe.ninja type categories
// ---------------------------------------------------------------------------

export const ALL_NINJA_TYPES = [
  "Currency",
  "Fragment",
  "DivinationCard",
  "SkillGem",
  "UniqueWeapon",
  "UniqueArmour",
  "UniqueAccessory",
  "UniqueFlask",
  "UniqueJewel",
  "UniqueRelic",
  "UniqueTincture",
  "UniqueMap",
  "Map",
  "BlightedMap",
  "BlightRavagedMap",
  "ValdoMap",
  "Scarab",
  "Essence",
  "Fossil",
  "Oil",
  "Incubator",
  "DeliriumOrb",
  "Omen",
  "Invitation",
  "Resonator",
  "Beast",
  "Vial",
  "ClusterJewel",
  "ForbiddenJewel",
  "BaseType",
  "Tattoo",
  "AllflameEmber",
  "Artifact",
  "DjinnCoin",
  "Runegraft",
  "ShrineBelt",
  "Wombgift",
  "Memory",
  "Astrolabe",
  "Temple",
] as const;

export type NinjaType = (typeof ALL_NINJA_TYPES)[number];

/** Types that use the currency-format stash endpoint (pay/receive structure).
 *  All other types use the item-format stash endpoint. */
export const STASH_CURRENCY_FORMAT = new Set<NinjaType>(["Currency", "Fragment"]);

// ---------------------------------------------------------------------------
// Stash endpoint response types
// ---------------------------------------------------------------------------

export interface NinjaCurrencyLine {
  currencyTypeName: string;
  chaosEquivalent: number;
  pay: { value: number; listing_count: number } | null;
  receive: { value: number; listing_count: number } | null;
  paySparkLine: { totalChange: number; data: (number | null)[] };
  receiveSparkLine: { totalChange: number; data: (number | null)[] };
  lowConfidencePaySparkLine: { totalChange: number; data: (number | null)[] };
  lowConfidenceReceiveSparkLine: { totalChange: number; data: (number | null)[] };
  detailsId: string;
}

export interface NinjaCurrencyDetail {
  id: number;
  icon: string;
  name: string;
  tradeId: string;
}

export interface NinjaCurrencyResponse {
  lines: NinjaCurrencyLine[];
  currencyDetails: NinjaCurrencyDetail[];
}

export interface NinjaItemLine {
  id: number;
  name: string;
  baseType: string;
  icon: string;
  chaosValue: number;
  divineValue: number;
  exaltedValue: number;
  count: number;
  listingCount: number;
  detailsId: string;
  sparkLine: { totalChange: number; data: (number | null)[] };
  lowConfidenceSparkLine: { totalChange: number; data: (number | null)[] };
  implicitModifiers?: { text: string; optional: boolean }[];
  explicitModifiers?: { text: string; optional: boolean }[];
  flavourText?: string;
  itemType?: string;
  itemClass?: number;
  levelRequired?: number;
  variant?: string;
  links?: number;
  gemLevel?: number;
  gemQuality?: number;
  corrupted?: boolean;
  stackSize?: number;
  mutatedModifiers?: { text: string; optional: boolean }[];
  tradeInfo?: { mod: string; min: number; max: number }[];
}

export interface NinjaItemResponse {
  lines: NinjaItemLine[];
}

// ---------------------------------------------------------------------------
// Exchange endpoint response types
// ---------------------------------------------------------------------------

export interface NinjaExchangeItem {
  id: string;
  name: string;
  image: string;
  category: string;
  detailsId: string;
}

export interface NinjaExchangeLine {
  id: string;
  primaryValue: number;
  volumePrimaryValue: number;
  maxVolumeCurrency: string;
  maxVolumeRate: number;
  sparkline: { totalChange: number; data: (number | null)[] };
}

export interface NinjaExchangeResponse {
  core: {
    items: NinjaExchangeItem[];
    rates: Record<string, number>;
    primary: string;
    secondary: string;
  };
  lines: NinjaExchangeLine[];
  items: NinjaExchangeItem[];
}

// ---------------------------------------------------------------------------
// Enriched row for DB insertion (returned by fetcher)
// ---------------------------------------------------------------------------

export interface NinjaFetchedItem {
  game: string;
  league: string;
  itemName: string;
  chaosValue: number;
  divineValue: number;
  listingCount: number;
  source: NinjaSource;
  ninjaCategory: string;
  icon: string | null;
  detailsId: string;
  sparklineData: (number | null)[] | null;
  totalChange: number | null;
  stackSize?: number | null;
  explicitModifiers?: { text: string; optional: boolean }[] | null;
  variant?: string | null;
  baseType?: string | null;
  links?: number | null;
  itemClass?: number | null;
  itemType?: string | null;
  corrupted?: boolean | null;
  gemLevel?: number | null;
  gemQuality?: number | null;
  levelRequired?: number | null;
  exaltedValue?: number | null;
  count?: number | null;
  volume?: number | null;
  mutatedModifiers?: { text: string; optional: boolean; statId?: string }[] | null;
}
