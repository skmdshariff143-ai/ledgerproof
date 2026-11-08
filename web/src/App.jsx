import { Badge } from "./components/Badge.jsx";
import { useSession } from "./session.jsx";
import { AdminView } from "./views/AdminView.jsx";
import { AuditorView } from "./views/AuditorView.jsx";
import { HolderView } from "./views/HolderView.jsx";
import { Login } from "./views/Login.jsx";

// What each role sees. The server enforces the same limits; hiding a view is only convenience.
const VIEWS = { account_holder: HolderView, auditor: AuditorView, admin: AdminView };

export default function App() {
  const { ready, user, logout } = useSession();
  if (!ready) return <p className="boot muted">Loading…</p>;
  if (!user) return <Login />;
  const View = VIEWS[user.role];
  return (
    <>
      <header className="topbar">
        <strong className="brand">LedgerProof</strong>
        <span className="who">
          {user.email} <Badge value={user.role} />
        </span>
        <button type="button" className="secondary" onClick={logout}>Sign out</button>
      </header>
      <main className="page">
        <View />
      </main>
    </>
  );
}
