// Money is integer paise everywhere. Nothing here uses a float: amounts are parsed and
// formatted with string maths and BigInt, so 0.1 + 0.2 style rounding cannot happen.

function groupIndian(digits) {
  if (digits.length <= 3) return digits;
  const lastThree = digits.slice(-3);
  const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${rest},${lastThree}`;
}

// `paise` is an integer string (as the API sends it), a number or a bigint.
export function formatRupees(paise) {
  const value = BigInt(paise);
  const abs = value < 0n ? -value : value;
  const rupees = groupIndian((abs / 100n).toString());
  const rest = (abs % 100n).toString().padStart(2, "0");
  return `${value < 0n ? "-" : ""}₹${rupees}.${rest}`;
}

const RUPEE_AMOUNT = /^(\d{1,12})(?:\.(\d{1,2}))?$/;

// "100" -> 10000, "100.5" -> 10050. Returns null for anything else: zero, negatives,
// more than two decimals, exponents, commas, or too many digits to be a safe integer.
export function parseRupeesToPaise(text) {
  const match = RUPEE_AMOUNT.exec(text.trim());
  if (!match) return null;
  const paise = BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  return paise > 0n ? Number(paise) : null;
}
