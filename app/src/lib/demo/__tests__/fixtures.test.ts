import { describe, expect, it } from "vitest";
import { shiftAndRegroupPremiumPeriods } from "../fixtures";

describe("demo premium-request fixture shifting", () => {
  it("shifts dates and regroups usage into the resulting calendar periods", () => {
    const periods = [
      { year: 2026, month: 10, usageItems: [
        { date: "2026-10-31", sku: "model-a", grossQuantity: 2 },
        { date: "2026-10-30", sku: "model-b", grossQuantity: 3 },
      ] },
    ];

    expect(shiftAndRegroupPremiumPeriods(periods, 1)).toEqual([
      { year: 2026, month: 10, usageItems: [{ date: "2026-10-31", sku: "model-b", grossQuantity: 3 }] },
      { year: 2026, month: 11, usageItems: [{ date: "2026-11-01", sku: "model-a", grossQuantity: 2 }] },
    ]);
  });

  it("preserves original periods when the offset is zero", () => {
    const periods = [{ year: 2026, month: 10, usageItems: [{ date: "2026-10-12", sku: "model-a" }] }];
    expect(shiftAndRegroupPremiumPeriods(periods, 0)).toEqual(periods);
  });
});
