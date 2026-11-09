import { useLoad } from "../hooks.js";
import { formatRupees } from "../money.js";
import { Loaded } from "./Loaded.jsx";

// Asks the server to recompute the books from the ledger rows and shows whether they balance.
export function ReconcileBanner() {
  const state = useLoad("/api/ledger/reconcile");
  return (
    <Loaded state={state}>
      {(report) => (
        <section className={`banner ${report.balanced ? "banner-ok" : "banner-bad"}`} aria-live="polite">
          <div>
            <h2>{report.balanced ? "Total Debits == Total Credits (BALANCED ✓)" : "Books do NOT balance ✗"}</h2>
            <p>
              Debits <span className="money">{formatRupees(report.totals.debits_paise)}</span> · Credits{" "}
              <span className="money">{formatRupees(report.totals.credits_paise)}</span> ·{" "}
              {report.totals.entries} ledger entries · {report.accountsChecked} accounts re-checked
            </p>
            {report.problems.length > 0 && (
              <ul>
                {report.problems.map((p, i) => (
                  <li key={i}><code>{p.type}</code> {p.accountId ?? p.transactionId}</li>
                ))}
              </ul>
            )}
          </div>
          <button type="button" onClick={state.reload}>Re-check now</button>
        </section>
      )}
    </Loaded>
  );
}
