import { useState } from "react";
import { shortId } from "../format.js";
import { useSession } from "../session.jsx";

// A form that moves money. Each submit carries a fresh Idempotency-Key (UUID v4). With
// "Simulate network retry" on, the same request is sent twice at once with the same key,
// so you can watch the server pay once and answer the second call as a replay.
// `buildRequest(values)` returns { path, body } or throws an Error whose message is shown.
export function MoneyForm({ submitLabel, fields, buildRequest, onDone }) {
  const { call } = useSession();
  const blank = Object.fromEntries(fields.map((f) => [f.name, ""]));
  const [values, setValues] = useState(blank);
  const [simulateDuplicate, setSimulateDuplicate] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState(null);
  const [outcome, setOutcome] = useState(null);

  async function send({ path, body }) {
    try {
      const { data, status, replayed } = await call("POST", path, { body, idempotencyKey });
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
    setBusy(true);
    const attempts = await Promise.all(simulateDuplicate ? [send(request), send(request)] : [send(request)]);
    setBusy(false);
    setOutcome({ key: idempotencyKey, attempts });
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
            <select value={values[f.name]} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} required>
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
              inputMode={f.inputMode}
              autoComplete="off"
              spellCheck={false}
              required
            />
          )}
        </label>
      ))}
      <div className="retry-sim">
        <p className="retry-sim-title">Idempotency Retry Simulator</p>
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
      </div>
      <button type="submit" disabled={busy}>{busy ? "Sending…" : submitLabel}</button>
      {formError && <p className="error" role="alert">{formError}</p>}
      <div role="status" aria-live="polite">
        {outcome && (
          <ul className="attempts">
            {outcome.attempts.map((a, i) => (
              <li key={i} className={a.ok ? "attempt-ok" : "attempt-bad"}>
                {outcome.attempts.length > 1 && <strong>Request {i + 1}: </strong>}
                {a.ok
                  ? `${a.status}: transaction ${shortId(a.transactionId)} ${a.replayed ? "(replayed: answered from the first request, no second payment)" : "(new)"}`
                  : `${a.status || "no response"} ${a.code ?? ""}: ${a.message}`}
              </li>
            ))}
            {sameTransaction && (
              <li className="attempt-ok"><strong>Both requests returned the same transaction: money moved once.</strong></li>
            )}
          </ul>
        )}
      </div>
    </form>
  );
}
