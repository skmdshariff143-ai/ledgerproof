// A payment whose answer never arrived may or may not have gone through. Sending it again must reuse the
// same Idempotency-Key, so the server pays at most once and answers the retry as a replay.

// Same path and same body means the same payment.
export const fingerprint = ({ path, body }) => `${path} ${JSON.stringify(body)}`;

// Unknown outcome: no attempt succeeded and one never got an answer (network failure) or got a server error.
// A 4xx answer is a definite refusal, and a turned-off preview never sent anything, so neither counts.
export const isAmbiguous = (attempts) =>
  !attempts.some((a) => a.ok) && attempts.some((a) => a.code === "NETWORK" || a.status >= 500);

// Reuse the key of an unanswered attempt only for the identical request; anything else gets the fresh key.
export const keyFor = (pending, request, freshKey) => (pending?.fingerprint === fingerprint(request) ? pending.key : freshKey);
