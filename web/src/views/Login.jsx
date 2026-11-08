import { useState } from "react";
import { DEMO_LOGINS } from "../demoLogins.js";
import { useSession } from "../session.jsx";

export function Login() {
  const { login } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function attempt(emailValue, passwordValue) {
    setBusy(true);
    setError(null);
    try {
      await login(emailValue, passwordValue);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <h1>LedgerProof</h1>
      <p className="muted">Money movement with a ledger you can prove.</p>

      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          attempt(email, password);
        }}
      >
        <h2>Sign in</h2>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        <button type="submit" disabled={busy}>Sign in</button>
        {error && <p className="error" role="alert">{error}</p>}
      </form>

      <section className="card">
        <h2>Demo evaluator quick login</h2>
        <p className="muted small">One click signs in as a seeded demo user (see README).</p>
        <div className="quick-logins">
          {DEMO_LOGINS.map((demo) => (
            <button key={demo.email} type="button" className="secondary" disabled={busy} onClick={() => attempt(demo.email, demo.password)}>
              Login as {demo.label}
              <span className="small muted">{demo.role}</span>
            </button>
          ))}
        </div>
      </section>
    </main>
  );
}
