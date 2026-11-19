/**
 * The trade search that prices one cluster jewel combo (poestash #212).
 *
 * What this prices is **the jewel the craft produces**: the target notables on
 * a base of the passive count the craft is worth doing at. The passive count is
 * a filter and not an afterthought — a Medium with the same two notables and 6
 * passives, or a Large with 12, is a different item that lists for a fraction
 * of the price, and taking the cheapest listing without the filter hands the
 * app that fraction as the revenue side of a profit it computed against a
 * 4-5 (or 8) passive base. The result is a systematic understatement of profit.
 *
 * The query *shape* deliberately matches `clusterCraftTradeUrl` in the app
 * (`lib/trade/build-trade-url.ts`), which is the link the player clicks from the
 * row this price feeds. Cross-repo, so nothing can assert the two agree — the
 * test below pins this shape so a change to it is a deliberate one, and the app
 * side has to be checked by hand.
 */

export type JewelSize = "small" | "medium" | "large";

const SIZE_TO_TYPE: Record<JewelSize, string> = {
  small: "Small Cluster Jewel",
  medium: "Medium Cluster Jewel",
  large: "Large Cluster Jewel",
};

/**
 * "Adds # Passive Skills", the enchant every cluster jewel carries. The window
 * matches DESIRED_PASSIVE_COUNT in the app: a Medium is worth crafting at 4 or
 * 5, a Large only at 8.
 *
 * A small row priced on one count (poestash decision 569, `passives` 2 or 3)
 * searches that count exactly: Cluster craft crafts each, and PoB Trader prices
 * a pasted small jewel by its own. A small row from before the split carries no
 * count and keeps the size's whole legal range (RePoE min_skills 2, max_skills
 * 3). Stated rather than skipped: an absent entry throws below, and a size that
 * opts out of the filter is the understatement bug this module exists to
 * prevent.
 */
const PASSIVE_COUNT_STAT = "enchant.stat_3086156145";

const DESIRED_PASSIVE_COUNT: Record<JewelSize, { min: number; max: number }> = {
  small: { min: 2, max: 3 },
  medium: { min: 4, max: 5 },
  large: { min: 8, max: 8 },
};

export function buildComboSearchQuery(
  jewelSize: JewelSize,
  tradeStatIds: string[],
  smallPassives?: number | null,
): unknown {
  const window = DESIRED_PASSIVE_COUNT[jewelSize];
  const passives =
    window && jewelSize === "small" && smallPassives
      ? { min: smallPassives, max: smallPassives }
      : window;
  // jewel_size comes off an untyped postgres row. An unexpected value would
  // otherwise leave `value` undefined, which JSON.stringify drops — quietly
  // restoring the unfiltered search this module exists to prevent. The refresh
  // loop catches and logs per combo, so failing is the containable outcome.
  if (!passives) throw new Error(`Unknown jewel size: ${jewelSize}`);

  return {
    query: {
      // Instant buyout only: price fixing is impossible, so the cheapest
      // listing is the real market price.
      status: { option: "securable" },
      type: SIZE_TO_TYPE[jewelSize],
      stats: [
        {
          type: "and",
          filters: [
            ...tradeStatIds.map((id) => ({ id })),
            { id: PASSIVE_COUNT_STAT, value: passives },
          ],
        },
      ],
      filters: {
        type_filters: { filters: { rarity: { option: "nonunique" } } },
        misc_filters: { filters: { corrupted: { option: "false" } } },
      },
    },
    sort: { price: "asc" },
  };
}
