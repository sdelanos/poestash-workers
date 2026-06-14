import { describe, it, expect } from "vitest";
import { toChaos, trimLadder, robustFloor, ladderFloorChaos } from "./split-ladder";

const rates = new Map<string, number>([
  ["chaos", 1],
  ["divine", 200],
  ["exalted", 0.1],
]);

describe("toChaos", () => {
  it("converts a divine listing to chaos", () => {
    expect(toChaos({ amount: 34, currency: "divine" }, rates)).toBe(6800);
  });
  it("passes chaos through unchanged", () => {
    expect(toChaos({ amount: 50, currency: "chaos" }, rates)).toBe(50);
  });
  it("returns null for an unknown currency (never guesses a rate)", () => {
    expect(toChaos({ amount: 5, currency: "mirror" }, rates)).toBeNull();
  });
  it("returns null for a non-positive amount", () => {
    expect(toChaos({ amount: 0, currency: "chaos" }, rates)).toBeNull();
  });
});

describe("trimLadder", () => {
  it("drops a single junk floor under the real ladder", () => {
    // 2c bait under a 34/45/50-div (x200) real ladder.
    expect(trimLadder([2, 6800, 9000, 10000])).toEqual([6800, 9000, 10000]);
  });

  it("multi-drops a cascade of per-neighbour gaps", () => {
    // Each step is a >4x jump, so the whole bottom cascade clears.
    expect(trimLadder([1, 10, 5000, 5200])).toEqual([5000, 5200]);
  });

  it("keeps a genuinely cheap ladder with no big jump", () => {
    expect(trimLadder([30, 40, 50, 60])).toEqual([30, 40, 50, 60]);
  });

  it("never discards real cheap listings sitting under a high outlier", () => {
    // 30/40/50 are real; the 5000 is a lone high listing. The bottom stays.
    expect(trimLadder([30, 40, 50, 5000])).toEqual([30, 40, 50, 5000]);
  });

  it("sorts unsorted input before trimming", () => {
    expect(trimLadder([9000, 2, 6800])).toEqual([6800, 9000]);
  });

  it("returns the single listing unchanged", () => {
    expect(trimLadder([500])).toEqual([500]);
  });

  it("filters out zero and negative prices", () => {
    expect(trimLadder([0, -5, 100, 120])).toEqual([100, 120]);
  });

  it("returns empty for an empty ladder", () => {
    expect(trimLadder([])).toEqual([]);
  });
});

describe("robustFloor", () => {
  it("trims junk before taking the floor", () => {
    expect(robustFloor([2, 6800, 9000])).toBe(6800);
  });

  it("takes the low quartile, not the absolute minimum, on a deep ladder", () => {
    // 8 listings, no junk to trim. Lower-quartile index = floor(7*0.25) = 1,
    // so a single 20c dump under the cluster doesn't define the floor.
    expect(robustFloor([20, 25, 50, 75, 100, 100, 100, 100])).toBe(25);
  });

  it("collapses to the cheapest on a thin market", () => {
    expect(robustFloor([200])).toBe(200);
    expect(robustFloor([200, 250])).toBe(200); // n=2 -> index 0
  });

  it("returns null when there are no usable listings", () => {
    expect(robustFloor([])).toBeNull();
    expect(robustFloor([0, -1])).toBeNull();
  });
});

describe("ladderFloorChaos", () => {
  it("converts, trims, and returns the chaos floor", () => {
    const listings = [
      { amount: 2, currency: "chaos" }, // junk
      { amount: 34, currency: "divine" }, // 6800c real floor
      { amount: 45, currency: "divine" },
    ];
    expect(ladderFloorChaos(listings, rates)).toBe(6800);
  });

  it("skips unknown-currency listings entirely", () => {
    const listings = [
      { amount: 1, currency: "mirror" }, // unknown -> dropped
      { amount: 500, currency: "chaos" },
    ];
    expect(ladderFloorChaos(listings, rates)).toBe(500);
  });

  it("returns null when nothing is priceable", () => {
    expect(ladderFloorChaos([{ amount: 1, currency: "mirror" }], rates)).toBeNull();
    expect(ladderFloorChaos([], rates)).toBeNull();
  });
});
