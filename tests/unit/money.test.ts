import { describe, expect, it } from "vitest";
import { computeGoal, formatCents, parseDollarsToCents, suggestedAmounts } from "@/lib/money";

const cents = (r: number) => suggestedAmounts(r).map((s) => s.cents);
const kinds = (r: number) => suggestedAmounts(r).map((s) => s.kind);

describe("computeGoal", () => {
  it("adds price, shipping, tax and install", () => {
    expect(computeGoal({ priceCents: 10000, shippingCents: 500, taxCents: 800, installCents: 1000 })).toBe(12300);
  });
  it("treats missing parts as zero", () => {
    expect(computeGoal({ priceCents: 4999 })).toBe(4999);
  });
  it("rejects fractional, negative, zero and huge values", () => {
    expect(() => computeGoal({ priceCents: 10.5 })).toThrow(RangeError);
    expect(() => computeGoal({ priceCents: -1 })).toThrow(RangeError);
    expect(() => computeGoal({ priceCents: 0 })).toThrow(RangeError);
    expect(() => computeGoal({ priceCents: 100_000_000, shippingCents: 1 })).toThrow(RangeError);
    expect(() => computeGoal({ priceCents: NaN })).toThrow(RangeError);
  });
});

describe("suggestedAmounts", () => {
  it("under $60: one button for the whole remainder", () => {
    expect(cents(4100)).toEqual([4100]);
    expect(kinds(4100)).toEqual(["finish"]);
    expect(cents(5999)).toEqual([5999]);
    expect(cents(1)).toEqual([1]);
  });

  it("$60 to $150: a quarter, a half and Finish it", () => {
    expect(cents(6000)).toEqual([1500, 3000, 6000]);
    expect(kinds(6000)).toEqual(["amount", "amount", "finish"]);
    expect(cents(10000)).toEqual([2500, 5000, 10000]);
    expect(cents(15000)).toEqual([3800, 7500, 15000]); // $37.50 rounds half up to $38
  });

  it("$150.01 to $300: $25 / $50 / $100 / Finish it", () => {
    expect(cents(15001)).toEqual([2500, 5000, 10000, 15001]);
    expect(cents(30000)).toEqual([2500, 5000, 10000, 30000]);
    expect(kinds(20000)).toEqual(["amount", "amount", "amount", "finish"]);
  });

  it("above $300: $25 / $50 / $100 / $250", () => {
    expect(cents(30001)).toEqual([2500, 5000, 10000, 25000]);
    expect(cents(500000)).toEqual([2500, 5000, 10000, 25000]);
  });

  it("never suggests more than the remainder", () => {
    for (let r = 1; r <= 40000; r += 37) {
      for (const s of suggestedAmounts(r)) expect(s.cents).toBeLessThanOrEqual(r);
    }
  });

  it("always offers a way to finish when the remainder is $300 or less", () => {
    for (let r = 1; r <= 30000; r += 41) {
      expect(suggestedAmounts(r).some((s) => s.kind === "finish" && s.cents === r)).toBe(true);
    }
  });

  it("has no duplicate buttons", () => {
    for (let r = 1; r <= 40000; r += 13) {
      const c = cents(r);
      expect(new Set(c).size).toBe(c.length);
    }
  });

  it("returns nothing when nothing remains or input is invalid", () => {
    expect(cents(0)).toEqual([]);
    expect(cents(-5)).toEqual([]);
    expect(cents(12.5)).toEqual([]);
  });
});

describe("formatCents / parseDollarsToCents", () => {
  it("formats", () => {
    expect(formatCents(2500)).toBe("$25");
    expect(formatCents(123456)).toBe("$1,234.56");
    expect(formatCents(5)).toBe("$0.05");
    expect(formatCents(-150)).toBe("-$1.50");
  });
  it("parses typed amounts exactly, without floats", () => {
    expect(parseDollarsToCents("25")).toBe(2500);
    expect(parseDollarsToCents("$25.5")).toBe(2550);
    expect(parseDollarsToCents("1,200.00")).toBe(120000);
    expect(parseDollarsToCents("0.29")).toBe(29);
    expect(parseDollarsToCents("19.99")).toBe(1999);
  });
  it("rejects junk", () => {
    for (const bad of ["", "abc", "-5", "1.234", "1,00", "1e3", "$", "25 dollars", "1000000.01"]) {
      expect(parseDollarsToCents(bad), bad).toBeNull();
    }
  });
});
