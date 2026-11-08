export const shortId = (id) => (id ? id.slice(0, 8) : "-");

export const formatTime = (iso) => new Date(iso).toLocaleString();

// The API sends money as integer-paise strings; a debit leaves an account, a credit arrives.
export const signed = (direction) => (direction === "credit" ? "+" : "−");
