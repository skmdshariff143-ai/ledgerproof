import { describe, expect, test } from "vitest";
import { formatRupees, parseRupeesToPaise } from "./money.js";

describe("parseRupeesToPaise", () => {
  test.each([
    ["100", 10000],
    ["100.5", 10050],
    ["100.50", 10050],
    ["0.05", 5],
    ["0.1", 10],
    ["0.30", 30],
    ["  25 ", 2500],
    ["999999999999.99", 99999999999999],
  ])("%s becomes %i paise exactly", (text, paise) => {
    expect(parseRupeesToPaise(text)).toBe(paise);
  });

  test.each(["", "0", "0.00", "-5", "+5", "1.234", ".5", "5.", "1e3", "1,000", "abc", "Infinity", "NaN", "1 000", "9999999999999"])(
    "%j is rejected",
    (text) => {
      expect(parseRupeesToPaise(text)).toBeNull();
    },
  );

  test("results are always safe integers", () => {
    expect(Number.isSafeInteger(parseRupeesToPaise("999999999999.99"))).toBe(true);
  });
});

describe("formatRupees", () => {
  test.each([
    ["0", "₹0.00"],
    ["5", "₹0.05"],
    ["100", "₹1.00"],
    ["1000000", "₹10,000.00"],
    ["500000", "₹5,000.00"],
    ["12345678", "₹1,23,456.78"],
    ["-150000000", "-₹15,00,000.00"],
  ])("%s paise shows as %s", (paise, shown) => {
    expect(formatRupees(paise)).toBe(shown);
  });

  test("accepts numbers and bigints, and never loses precision on large values", () => {
    expect(formatRupees(10050)).toBe("₹100.50");
    expect(formatRupees(9007199254740993n)).toBe("₹9,00,71,99,25,47,409.93");
  });
});
