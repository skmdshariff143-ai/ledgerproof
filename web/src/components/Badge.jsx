const TONES = {
  success: "ok", active: "ok", credit: "ok", verified: "ok", balanced: "ok",
  denied: "bad", debit: "bad", rejected: "bad", tampered: "bad", not_balanced: "bad",
  error: "warn", frozen: "warn", pending_kyc: "warn", check_failed: "warn",
};

// Small colored label; the text always says what it means, color is only a hint.
export function Badge({ value }) {
  const normalized = (value ?? "").toLowerCase();
  return <span className={`badge badge-${TONES[normalized] ?? "neutral"}`}>{String(value ?? "").replace(/_/g, " ")}</span>;
}
