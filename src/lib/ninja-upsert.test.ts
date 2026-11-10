import { describe, expect, it } from "vitest";
import { COLUMNS, DATA_COLUMNS, UPSERT_CLAUSE } from "./ninja-upsert";

describe("ninja_prices upsert clause", () => {
  it("compares every column except the conflict key and updated_at", () => {
    expect(DATA_COLUMNS).toHaveLength(COLUMNS.length - 5);
    for (const key of ["game", "league", "details_id", "source", "updated_at"]) {
      expect(DATA_COLUMNS).not.toContain(key);
    }
  });

  it("sets every data column plus updated_at, and guards on all data columns", () => {
    const [setPart, wherePart] = UPSERT_CLAUSE.split("WHERE");
    for (const c of [...DATA_COLUMNS, "updated_at"]) {
      expect(setPart).toContain(`${c} = EXCLUDED.${c}`);
    }
    for (const c of DATA_COLUMNS) {
      expect(wherePart).toContain(`ninja_prices.${c}`);
      expect(wherePart).toContain(`EXCLUDED.${c}`);
    }
    expect(wherePart).not.toContain("updated_at");
  });

  // A marked row that poe.ninja lists again must differ from the incoming
  // (unmarked) one, or the WHERE would skip it and leave it marked.
  it("writes delisted_at like a data column, so a row listed again is unmarked", () => {
    expect(DATA_COLUMNS).toContain("delisted_at");
    const [setPart, wherePart] = UPSERT_CLAUSE.split("WHERE");
    expect(setPart).toContain("delisted_at = EXCLUDED.delisted_at");
    expect(wherePart).toContain("ninja_prices.delisted_at");
  });
});
