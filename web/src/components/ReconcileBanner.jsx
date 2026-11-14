import { useState } from "react";
import { useLoad } from "../hooks.js";
import { formatRupees } from "../money.js";
import { useSession } from "../session.jsx";
import { Badge } from "./Badge.jsx";
import { Loaded } from "./Loaded.jsx";
import { Section } from "./Section.jsx";

// Two separate checks, each with its own status: the books (ledger rows) and the stored audit hash chain.
export function ReconcileBanner() {
  return (
    <div className="two-col">
      <LedgerReconciliation />
      <ChainVerification />
    </div>
  );
}

function LedgerReconciliation() {
  const state = useLoad("/api/ledger/reconcile");
  return (
    <Section title="Ledger reconciliation" actions={<button type="button" className="secondary" onClick={state.reload}>Re-check books</button>}>
      <p className="muted small">The server recomputes the books from the ledger rows. Runs when this page opens.</p>
      <Loaded state={state}>
        {(report) => (
          <div aria-live="polite">
            <p className={`status ${report.balanced ? "status-ok" : "status-bad"}`}>
              <Badge value={report.balanced ? "balanced" : "not_balanced"} />
              <strong>{report.balanced ? "Total debits equal total credits." : "Books do not balance."}</strong>
            </p>
            <dl className="facts">
              <div><dt>Debits</dt><dd className="money">{formatRupees(report.totals.debits_paise)}</dd></div>
              <div><dt>Credits</dt><dd className="money">{formatRupees(report.totals.credits_paise)}</dd></div>
              <div><dt>Ledger entries</dt><dd>{report.totals.entries}</dd></div>
              <div><dt>Accounts re-checked</dt><dd>{report.accountsChecked}</dd></div>
            </dl>
            {report.problems.length > 0 && (
              <ul className="problems">
                {report.problems.map((p, i) => (
                  <li key={i}><code>{p.type}</code> {p.accountId ?? p.transactionId}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Loaded>
    </Section>
  );
}

function ChainVerification() {
  const { call } = useSession();
  const [chain, setChain] = useState(null);
  const [verifying, setVerifying] = useState(false);

  async function verifyChain() {
    setVerifying(true);
    try {
      const { data } = await call("GET", "/api/admin/audit-logs/verify");
      setChain(data);
    } catch (err) {
      setChain({ verified: false, error: err.message });
    } finally {
      setVerifying(false);
    }
  }

  const cannotCheck = chain && (chain.error || chain.reason);
  return (
    <Section
      title="Stored audit-chain verification"
      actions={
        <button type="button" onClick={verifyChain} disabled={verifying}>
          {verifying ? "Verifying…" : chain ? "Verify again" : "Verify audit chain"}
        </button>
      }
    >
      <p className="muted small">Re-computes the SHA-256 hash chain stored with the security audit log. Runs only when you ask.</p>
      <div aria-live="polite">
        {!chain && (
          <p className="status">
            <Badge value="not_verified" />
            <strong>Not checked yet.</strong>
          </p>
        )}
        {chain?.verified && (
          <p className="status status-ok">
            <Badge value="verified" />
            <strong>Every stored entry links to the one before it.</strong>
          </p>
        )}
        {chain && !chain.verified && !cannotCheck && (
          <p className="status status-bad">
            <Badge value="tampered" />
            <strong>The chain breaks at entry #{chain.tamperedSeq}.</strong>
          </p>
        )}
        {cannotCheck && (
          <p className="status status-warn">
            <Badge value="check_failed" />
            <strong>{chain.error ?? chain.reason}</strong>
          </p>
        )}
        {chain && chain.totalEntries !== undefined && (
          <dl className="facts">
            <div><dt>Stored entries</dt><dd>{chain.totalEntries}</dd></div>
            {chain.headHash && <div className="wide"><dt>Head hash</dt><dd><code className="ref">{chain.headHash}</code></dd></div>}
            {chain.expectedHash && <div className="wide"><dt>Expected hash</dt><dd><code className="ref">{chain.expectedHash}</code></dd></div>}
            {chain.tamperedSeq !== undefined && <div className="wide"><dt>Stored hash</dt><dd><code className="ref">{chain.actualHash ?? "missing"}</code></dd></div>}
          </dl>
        )}
      </div>
    </Section>
  );
}
