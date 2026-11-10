import { useState } from "react";
import { shortId } from "../format.js";
import { useLoad } from "../hooks.js";
import { formatRupees } from "../money.js";
import { useSession } from "../session.jsx";
import { Badge } from "./Badge.jsx";
import { Loaded } from "./Loaded.jsx";

// Asks the server to recompute the books from the ledger rows and verify the SHA-256 audit hash chain.
export function ReconcileBanner() {
  const { call } = useSession();
  const state = useLoad("/api/ledger/reconcile");
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

  return (
    <Loaded state={state}>
      {(report) => (
        <section className={`banner ${report.balanced && chain?.verified !== false ? "banner-ok" : "banner-bad"}`} aria-live="polite">
          <div>
            <h2>{report.balanced ? "Total Debits == Total Credits (BALANCED ✓)" : "Books do NOT balance ✗"}</h2>
            <p>
              Debits <span className="money">{formatRupees(report.totals.debits_paise)}</span> · Credits{" "}
              <span className="money">{formatRupees(report.totals.credits_paise)}</span> ·{" "}
              {report.totals.entries} ledger entries · {report.accountsChecked} accounts re-checked
            </p>
            {chain && (
              <p className="small">
                <strong>SHA-256 Audit Chain: </strong>
                <Badge value={chain.verified ? "VERIFIED" : "TAMPERED"} />{" "}
                {chain.verified
                  ? `${chain.totalEntries} linked entries · Head hash ${shortId(chain.headHash)}…`
                  : chain.error ?? `Tampered at seq #${chain.tamperedSeq}`}
              </p>
            )}
            {report.problems.length > 0 && (
              <ul>
                {report.problems.map((p, i) => (
                  <li key={i}><code>{p.type}</code> {p.accountId ?? p.transactionId}</li>
                ))}
              </ul>
            )}
          </div>
          <div className="filters">
            <button type="button" onClick={verifyChain} disabled={verifying}>
              {verifying ? "Verifying…" : "Verify Ledger & Audit Chain Integrity"}
            </button>
            <button type="button" className="secondary" onClick={state.reload}>Re-check books</button>
          </div>
        </section>
      )}
    </Loaded>
  );
}
