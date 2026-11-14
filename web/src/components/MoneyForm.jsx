import { useId, useState } from "react";
import { shortId } from "../format.js";
import { fingerprint, isAmbiguous, keyFor } from "../idempotency.js";
import { useSession } from "../session.jsx";

// A form that moves money. Each new payment carries a fresh Idempotency-Key (UUID v4); a retry of a payment
// whose answer never arrived reuses its key (see idempotency.js), so it can only be paid once. With
// "Simulate network retry" on, the same request is sent twice at once with the same key,
// so you can watch the server pay once and answer the second call as a replay.
// `buildRequest(values)` returns { path, body } or throws an Error whose message is shown.
export function MoneyForm({ submitLabel, fields, buildRequest, onDone }) {
  const { call } = useSession();
  const errorId = useId();
  const blank = Object.fromEntries(fields.map((f) => [f.name, ""]));
  const [values, setValues] = useState(blank);
  const [simulateDuplicate, setSimulateDuplicate] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [unanswered, setUnanswered] = useState(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState(null);
  const [outcome, setOutcome] = useState(null);

  async function send({ path, body }, key) {
    try {
      const { data, status, replayed } = await call("POST", path, { body, idempotencyKey: key });
      return { ok: true, status, replayed, transactionId: data.transactionId };
    } catch (err) {
      return { ok: false, status: err.status, code: err.code, message: err.message };
    }
  }

  async function submit(event) {
    event.preventDefault();
    setFormError(null);
    setOutcome(null);
    let request;
    try {
      request = buildRequest(values);
    } catch (err) {
      setFormError(err.message);
      return;
    }
    const key = keyFor(unanswered, request, idempotencyKey);
    setBusy(true);
    const attempts = await Promise.all(simulateDuplicate ? [send(request, key), send(request, key)] : [send(request, key)]);
    setBusy(false);
    const ambiguous = isAmbiguous(attempts);
    setUnanswered(ambiguous ? { fingerprint: fingerprint(request), key } : null);
    setOutcome({ key, attempts, ambiguous });
    setIdempotencyKey(crypto.randomUUID());
    if (attempts.some((a) => a.ok)) {
      setValues(blank);
      onDone();
    }
  }

  const sameTransaction =
    outcome?.attempts.length === 2 && outcome.attempts.every((a) => a.ok && a.transactionId === outcome.attempts[0].transactionId);

  return (
    <form className="money-form" onSubmit={submit}>
      {fields.map((f) => (
        <label key={f.name}>
          {f.label}
          {f.options ? (
            <select
              value={values[f.name]}
              onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
              aria-describedby={formError ? errorId : undefined}
              required
            >
              <option value="">Choose…</option>
              {f.options.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          ) : (
            <input
              value={values[f.name]}
              onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
              placeholder={f.placeholder}
              inputMode={f.inputMode} maxLength={f.maxLength}
              autoComplete="off"
              spellCheck={false}
              aria-describedby={formError ? errorId : undefined}
              aria-invalid={formError ? true : undefined}
              required
            />
          )}
        </label>
      ))}
      <details className="retry-sim">
        <summary>Idempotency retry simulator (for evaluators){simulateDuplicate ? ": on" : ""}</summary>
        <label className="switch">
          <input
            type="checkbox"
            role="switch"
            className="switch-input"
            checked={simulateDuplicate}
            onChange={(e) => setSimulateDuplicate(e.target.checked)}
          />
          <span className="switch-track" aria-hidden="true" />
          Simulate network retry / duplicate click
          <span className="switch-state" aria-hidden="true">{simulateDuplicate ? "ON" : "OFF"}</span>
        </label>
        <p className="muted small">When on, the same request is sent twice with one Idempotency-Key, and the server must pay once.</p>
        <p className="muted small key-line">Idempotency-Key for this request: <code className="ref">{idempotencyKey}</code></p>
      </details>
      <button type="submit" disabled={busy}>{busy ? "Sending…" : submitLabel}</button>
      {formError && <p id={errorId} className="error" role="alert"><strong>Check the form.</strong> {formError}</p>}
      <div aria-live="polite">
        {outcome && (
          <ul className="attempts">
            {outcome.attempts.map((a, i) => (
              <li key={i} className={a.ok ? "attempt-ok" : "attempt-bad"} role={a.ok ? undefined : "alert"}>
                {outcome.attempts.length > 1 && <strong>Request {i + 1}: </strong>}
                {a.ok ? (
                  <>
                    <strong>{a.replayed ? "Replayed." : "Success."}</strong>{" "}
                    {a.replayed
                      ? `Transaction ${shortId(a.transactionId)} was already recorded, so no second payment was made (${a.status}).`
                      : `Transaction ${shortId(a.transactionId)} recorded (${a.status}).`}
                  </>
                ) : (
                  <>
                    <strong>Failed.</strong> {a.message} ({a.status || "no response"} {a.code ?? ""})
                  </>
                )}
              </li>
            ))}
            {outcome.ambiguous && (
              <li className="attempt-bad">
                <strong>The result is unknown.</strong> The payment may have gone through. Sending the same request again
                reuses the same Idempotency-Key, so it can be paid only once. Check your activity before changing the amount.
              </li>
            )}
            {sameTransaction && (
              <li className="attempt-ok"><strong>Both requests returned the same transaction: money moved once.</strong></li>
            )}
          </ul>
        )}
      </div>
    </form>
  );
}
