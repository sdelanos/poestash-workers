/**
 * Quality bands for split-base sampling. MIRROR of the app's
 * lib/flips/data/split-quality-bands.ts. Keep the boundaries identical: the
 * worker writes `quality_band` keys the app reads back.
 *
 * A split copy keeps the original's quality, and quality above 20% can no
 * longer be crafted (Hillock is deprecated), so the 21+ bands are drop-only
 * scarcity. The 20-or-less band is commodity context for the price grid.
 */

export interface SplitQualityBandDef {
  /** Stable key / quality floor. Stored as `quality_band`. */
  key: 0 | 21 | 27 | 30;
  /** Trade-search quality minimum (null = no minimum). */
  qualityMin: number | null;
  /** Trade-search quality maximum (null = no maximum). */
  qualityMax: number | null;
}

export const SPLIT_QUALITY_BANDS: readonly SplitQualityBandDef[] = [
  { key: 0, qualityMin: null, qualityMax: 20 },
  { key: 21, qualityMin: 21, qualityMax: 26 },
  { key: 27, qualityMin: 27, qualityMax: 29 },
  { key: 30, qualityMin: 30, qualityMax: null },
];

/** Item level floor for sampled markets. High-ilvl bases are the only ones
 *  worth crafting on; a low-ilvl quality base is worthless. */
export const SPLIT_ILVL_FLOOR = 84;
