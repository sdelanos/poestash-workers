/**
 * Ladder pricing for split-base sampling. Pure functions, no IO, so they are
 * unit-testable in isolation. Given the cheapest few trade listings (already
 * converted to chaos), this returns a robust market floor: junk price-fixing
 * outliers trimmed off the bottom, then a low-quartile pick rather than the
 * single cheapest listing.
 *
 * Why trim: a quality base ladder routinely starts with a 1c "noise" listing
 * (mispriced, bait, or a typo) sitting under the real floor. We drop a leading
 * listing only when it is a small fraction of the next one up, the signature
 * of junk rather than a genuinely cheap real listing.
 *
 * Why a low quartile rather than the absolute minimum: a single dumped listing
 * shouldn't define the whole market floor. After trimming junk, we take the
 * lower-quartile listing of the cheapest sample, which reflects the cheap
 * cluster a buyer actually competes with. With only a couple of listings this
 * collapses back to the cheapest, which is the honest answer for a thin market.
 */

/** A listing's price split into amount + trade-API currency slug. */
export interface ListingPrice {
  amount: number;
  currency: string;
}

/** Below this fraction of its neighbour, a bottom listing is treated as junk
 *  and dropped. A real cheap listing is rarely under a quarter of the next. */
const JUNK_FLOOR_RATIO = 0.25;

/** Convert a listing price to chaos using a currency-slug -> chaos-rate map.
 *  Returns null for currencies with no known rate (skip, don't guess). */
export function toChaos(
  price: ListingPrice,
  currencyToChaos: Map<string, number>,
): number | null {
  if (price.amount == null || price.amount <= 0) return null;
  const rate = currencyToChaos.get(price.currency);
  if (rate == null) return null;
  return price.amount * rate;
}

/**
 * Drop leading junk-floor outliers from an ascending price list. A bottom
 * listing under JUNK_FLOOR_RATIO of the next one up is removed, repeatedly,
 * so a stack of bait listings all clears. Input need not be pre-sorted.
 */
export function trimLadder(prices: number[]): number[] {
  const sorted = prices.filter((p) => p > 0).sort((a, b) => a - b);
  let start = 0;
  while (
    start < sorted.length - 1 &&
    sorted[start] < JUNK_FLOOR_RATIO * sorted[start + 1]
  ) {
    start++;
  }
  return sorted.slice(start);
}

/** Lower-quartile index of an n-length sorted list. n=1..4 -> 0, n=5 -> 1,
 *  n=10 -> 2. Resists a single outlier without drifting toward the median. */
function lowQuartileIndex(n: number): number {
  return Math.floor((n - 1) * 0.25);
}

/**
 * The robust market floor: trim junk, then take the low-quartile listing of
 * what remains. Returns null when there are no usable listings.
 */
export function robustFloor(prices: number[]): number | null {
  const trimmed = trimLadder(prices);
  if (trimmed.length === 0) return null;
  return trimmed[lowQuartileIndex(trimmed.length)];
}

/**
 * End-to-end: take raw listing prices, convert each to chaos, trim junk, and
 * return the robust floor. Listings in unknown currencies are dropped.
 */
export function ladderFloorChaos(
  listings: ListingPrice[],
  currencyToChaos: Map<string, number>,
): number | null {
  const chaos = listings
    .map((l) => toChaos(l, currencyToChaos))
    .filter((v): v is number => v != null);
  return robustFloor(chaos);
}
