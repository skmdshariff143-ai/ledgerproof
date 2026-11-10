import { useState } from "react";
import { Badge } from "../components/Badge.jsx";
import { DataTable } from "../components/DataTable.jsx";
import { FilterSelect } from "../components/FilterSelect.jsx";
import { Loaded } from "../components/Loaded.jsx";
import { ReconcileBanner } from "../components/ReconcileBanner.jsx";
import { Section } from "../components/Section.jsx";
import { formatTime, shortId, signed } from "../format.js";
import { useLoad } from "../hooks.js";
import { formatRupees } from "../money.js";

export function AuditorView() {
  return (
    <>
      <ReconcileBanner />
      <LedgerExplorer />
      <AuditLog />
    </>
  );
}

function LedgerExplorer() {
  const state = useLoad("/api/ledger/entries");
  const [direction, setDirection] = useState("all");
  const [type, setType] = useState("all");
  return (
    <Section
      title="Double-entry ledger (latest 200, append-only)"
      actions={
        <div className="filters">
          <FilterSelect label="Entry" value={direction} onChange={setDirection} options={["all", "debit", "credit"]} />
          <FilterSelect label="Type" value={type} onChange={setType} options={["all", "deposit", "withdrawal", "transfer"]} />
        </div>
      }
    >
      <Loaded state={state}>
        {({ entries }) => (
          <DataTable
            rows={entries.filter((e) => (direction === "all" || e.direction === direction) && (type === "all" || e.type === type))}
            rowKey={(e) => e.id}
            empty="No entries match."
            columns={[
              { label: "Time", render: (e) => formatTime(e.created_at) },
              { label: "Account", render: (e) => <code>{e.account_number}</code> },
              { label: "Type", render: (e) => e.type },
              { label: "Entry", render: (e) => <Badge value={e.direction} /> },
              { label: "Amount", align: "num", render: (e) => `${signed(e.direction)}${formatRupees(e.amount_paise)}` },
              { label: "Balance after", align: "num", render: (e) => formatRupees(e.running_balance_paise) },
              { label: "Initiated by", render: (e) => e.initiated_by },
              { label: "Reference", render: (e) => <code className="ref" title={e.transaction_id}>{shortId(e.transaction_id)}</code> },
            ]}
          />
        )}
      </Loaded>
    </Section>
  );
}

function AuditLog() {
  const state = useLoad("/api/audit-logs");
  const [outcome, setOutcome] = useState("all");
  const [search, setSearch] = useState("");
  const needle = search.trim().toLowerCase();
  return (
    <Section
      title="Security audit log (latest 200, append-only)"
      actions={
        <div className="filters">
          <FilterSelect label="Outcome" value={outcome} onChange={setOutcome} options={["all", "success", "denied", "error"]} />
          <label className="filter">
            Search
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="action, target, role…" />
          </label>
          <button type="button" className="secondary" onClick={state.reload}>Refresh</button>
        </div>
      }
    >
      <Loaded state={state}>
        {({ entries }) => (
          <DataTable
            rows={entries.filter(
              (e) =>
                (outcome === "all" || e.outcome === outcome) &&
                (!needle || [e.action, e.target, e.actor_role].some((field) => field?.toLowerCase().includes(needle))),
            )}
            rowKey={(e) => e.id}
            rowClass={(e) => (e.outcome === "denied" ? "row-denied" : undefined)}
            empty="No audit entries match."
            columns={[
              { label: "Time", render: (e) => formatTime(e.created_at) },
              { label: "Outcome", render: (e) => <Badge value={e.outcome} /> },
              { label: "Role", render: (e) => e.actor_role ?? "anonymous" },
              { label: "User", render: (e) => <code className="ref" title={e.actor_user_id ?? ""}>{shortId(e.actor_user_id)}</code> },
              { label: "Action", render: (e) => e.action },
              { label: "Target", render: (e) => e.target ?? "" },
              { label: "IP", render: (e) => e.ip ?? "" },
              { label: "Hash", render: (e) => <code className="ref" title={e.entry_hash ?? ""}>{shortId(e.entry_hash)}</code> },
              { label: "Details", render: (e) => <code className="details" title={JSON.stringify(e.details)}>{e.details ? JSON.stringify(e.details) : ""}</code> },
            ]}
          />
        )}
      </Loaded>
    </Section>
  );
}
