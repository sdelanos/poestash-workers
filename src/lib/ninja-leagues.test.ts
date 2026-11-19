import { describe, it, expect } from "vitest";
import { poe2LeaguesToPrice } from "./ninja-leagues";

/** poe.ninja's `/poe2/api/economy/leagues` as it answered on 2026-11-19:
 *  the live league, the previous one its feed still prices, their HC
 *  variants, and the permanent leagues. */
const NOV_2026 = [
  { id: "Forbidden Rites", name: "Forbidden Rites" },
  { id: "Runes of Aldur", name: "Runes of Aldur" },
  { id: "HC Forbidden Rites", name: "HC Forbidden Rites" },
  { id: "HC Runes of Aldur", name: "HC Runes of Aldur" },
  { id: "Standard", name: "Standard" },
  { id: "Hardcore", name: "Hardcore" },
];

const league = (name: string) => ({ id: name, name });

describe("poe2LeaguesToPrice", () => {
  it("prices every softcore challenge league listed", () => {
    expect(poe2LeaguesToPrice(NOV_2026)).toEqual(["Forbidden Rites", "Runes of Aldur"]);
  });

  it("between leagues: only permanent leagues listed -> nothing", () => {
    expect(poe2LeaguesToPrice([league("Standard"), league("Hardcore")])).toEqual([]);
  });

  it("leaves out hardcore, private leagues and SSF/Ruthless variants", () => {
    expect(
      poe2LeaguesToPrice([
        league("Forbidden Rites"),
        league("Hardcore Forbidden Rites"),
        league("My Private League (PL123)"),
        league("SSF Forbidden Rites"),
        league("Ruthless Forbidden Rites"),
      ]),
    ).toEqual(["Forbidden Rites"]);
  });

  it("answers the id, the overview endpoints' league parameter", () => {
    expect(poe2LeaguesToPrice([{ id: "runes-of-aldur", name: "Runes of Aldur" }])).toEqual([
      "runes-of-aldur",
    ]);
  });
});
