import { useEffect, useState } from "react";
import { API_DISABLED, request } from "../api.js";
import { DEMO_LOGINS } from "../demoLogins.js";
import { useSession } from "../session.jsx";

export function Login() {
  const { login, register } = useSession();
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [bootstrapSecret, setBootstrapSecret] = useState("");
  const [initialized, setInitialized] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    request("GET", "/api/system/status")
      .then(({ data }) => {
        if (data && typeof data.initialized === "boolean") setInitialized(data.initialized);
      })
      .catch(() => {});
  }, []);

  async function attempt(emailValue, passwordValue) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await login(emailValue, passwordValue);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function submitRegister(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await register(email, password);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function submitBootstrap(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { data } = await request("POST", "/api/system/bootstrap", {
        body: { email: email || "admin@ledgerline.com", password: password || "Admin@123", bootstrapSecret },
      });
      setInitialized(true);
      setNotice(`Bootstrapped first admin (${data.admin.email}). You can now sign in.`);
      setMode("login");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function switchMode(next) {
    setMode(next);
    setError(null);
    setNotice(null);
  }

  return (
    <main className="login">
      <header className="login-head">
        <h1>LedgerProof</h1>
        <p className="muted">Money movement with a ledger you can prove.</p>
      </header>

      {API_DISABLED && (
        <section className="banner banner-bad" role="status">
          <p className="small"><strong>Preview build.</strong> No isolated API is configured, so sign-in, registration and money actions are turned off. This preview never calls the production API.</p>
        </section>
      )}

      {!initialized && (
        <section className="banner banner-bad" aria-live="polite">
          <div>
            <h2>System uninitialized: no admin found</h2>
            <p className="small">Run the first-admin bootstrap to create the first admin and the system treasury account.</p>
          </div>
          <button type="button" onClick={() => switchMode("bootstrap")}>Bootstrap admin</button>
        </section>
      )}

      {notice && <p className="notice" role="status">{notice}</p>}

      {mode === "login" && (
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            attempt(email, password);
          }}
        >
          <h2>Welcome back</h2>
          <label>
            Email
            <input name="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
          </label>
          <label>
            Password
            <input name="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
          </label>
          <button type="submit" className="primary-wide" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
          {error && <p className="error" role="alert"><strong>Could not sign in.</strong> {error}</p>}
        </form>
      )}

      {mode === "register" && (
        <form className="card" onSubmit={submitRegister}>
          <h2>Register a new account holder</h2>
          <p className="muted small">New accounts start in PENDING_KYC status with ₹0.00 balance until approved by an Admin.</p>
          <label>
            Email
            <input name="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
          </label>
          <label>
            Password (min 8 chars)
            <input name="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={8} required />
          </label>
          <button type="submit" className="primary-wide" disabled={busy}>{busy ? "Creating…" : "Create account (PENDING_KYC)"}</button>
          {error && <p className="error" role="alert"><strong>Could not register.</strong> {error}</p>}
        </form>
      )}

      {mode === "bootstrap" && (
        <form className="card" onSubmit={submitBootstrap}>
          <h2>First-admin bootstrap</h2>
          <p className="muted small">Guarded by BOOTSTRAP_SECRET. Works only when zero admins exist in the database.</p>
          <label>
            Admin email
            <input name="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="admin@ledgerline.com" />
          </label>
          <label>
            Admin password
            <input name="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Admin@123" />
          </label>
          <label>
            Bootstrap secret
            <input name="bootstrapSecret" autoComplete="off" type="password" value={bootstrapSecret} onChange={(e) => setBootstrapSecret(e.target.value)} required />
          </label>
          <button type="submit" className="primary-wide" disabled={busy}>{busy ? "Working…" : "Initialize admin & vault"}</button>
          {error && <p className="error" role="alert"><strong>Could not bootstrap.</strong> {error}</p>}
        </form>
      )}

      <p className="mode-switch">
        {mode === "login" ? (
          <button type="button" className="link" onClick={() => switchMode("register")}>New here? Register for an account (KYC)</button>
        ) : (
          <button type="button" className="link" onClick={() => switchMode("login")}>Back to sign in</button>
        )}
        {!initialized && mode !== "bootstrap" && (
          <button type="button" className="link" onClick={() => switchMode("bootstrap")}>Bootstrap first admin</button>
        )}
      </p>

      <section className="demo" aria-labelledby="demo-title">
        <h2 id="demo-title">For evaluators: demo logins</h2>
        <p className="muted small">One click signs in as a seeded demo user (see README). Not for real use.</p>
        <div className="quick-logins">
          {DEMO_LOGINS.map((demo) => (
            <button key={demo.email} type="button" className="secondary" disabled={busy} onClick={() => attempt(demo.email, demo.password)}>
              {demo.label}
              <span className="small">{demo.role}</span>
            </button>
          ))}
        </div>
      </section>
    </main>
  );
}
