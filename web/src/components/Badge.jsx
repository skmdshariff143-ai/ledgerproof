const TONES = {
  success: "ok", active: "ok", credit: "ok",
  denied: "bad", debit: "bad",
  error: "warn", frozen: "warn",
};

// Small colored label; the text always says what it means, color is only a hint.
export function Badge({ value }) {
  return <span className={`badge badge-${TONES[value] ?? "neutral"}`}>{value.replace("_", " ")}</span>;
}
