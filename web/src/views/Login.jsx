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

  return (
    <main className="login">
      <h1>LedgerProof</h1>
      <p className="muted">Money movement with a ledger you can prove.</p>

      {API_DISABLED && (
        <section className="banner banner-bad" role="status">
          <p className="small">Preview build: no isolated API is configured, so sign-in, registration and money actions are turned off. This preview never calls the production API.</p>
        </section>
      )}

      {!initialized && (
        <section className="banner banner-bad" aria-live="polite">
          <div>
            <h2>System Uninitialized (No Admin Found)</h2>
            <p className="small">Run First-Admin Bootstrap below to initialize the first ADMIN and system treasury account.</p>
          </div>
          <button type="button" onClick={() => setMode("bootstrap")}>Bootstrap Admin</button>
        </section>
      )}

      <div className="filters">
        <button type="button" className={mode === "login" ? "" : "secondary"} onClick={() => { setMode("login"); setError(null); }}>
          Sign in
        </button>
        <button type="button" className={mode === "register" ? "" : "secondary"} onClick={() => { setMode("register"); setError(null); }}>
          Register (KYC)
        </button>
        {!initialized && (
          <button type="button" className={mode === "bootstrap" ? "" : "secondary"} onClick={() => { setMode("bootstrap"); setError(null); }}>
            Bootstrap First Admin
          </button>
        )}
      </div>

      {notice && <p className="notice" role="status">{notice}</p>}

      {mode === "login" && (
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
      )}

      {mode === "register" && (
        <form className="card" onSubmit={submitRegister}>
          <h2>Register New Account Holder</h2>
          <p className="muted small">New accounts start in PENDING_KYC status with ₹0.00 balance until approved by an Admin.</p>
          <label>
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
          </label>
          <label>
            Password (min 8 chars)
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={8} required />
          </label>
          <button type="submit" disabled={busy}>Create Account (PENDING_KYC)</button>
          {error && <p className="error" role="alert">{error}</p>}
        </form>
      )}

      {mode === "bootstrap" && (
        <form className="card" onSubmit={submitBootstrap}>
          <h2>First-Admin Bootstrap</h2>
          <p className="muted small">Guarded by BOOTSTRAP_SECRET. Works only when zero admins exist in the database.</p>
          <label>
            Admin Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="admin@ledgerline.com" />
          </label>
          <label>
            Admin Password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Admin@123" />
          </label>
          <label>
            Bootstrap Secret
            <input type="password" value={bootstrapSecret} onChange={(e) => setBootstrapSecret(e.target.value)} required />
          </label>
          <button type="submit" disabled={busy}>Initialize Admin &amp; Vault</button>
          {error && <p className="error" role="alert">{error}</p>}
        </form>
      )}

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
