import { useState } from "react";
import { Badge } from "../components/Badge.jsx";
import { DataTable } from "../components/DataTable.jsx";
import { FilterSelect } from "../components/FilterSelect.jsx";
import { Loaded } from "../components/Loaded.jsx";
import { MoneyForm } from "../components/MoneyForm.jsx";
import { Section } from "../components/Section.jsx";
import { formatTime, shortId, signed } from "../format.js";
import { useLoad } from "../hooks.js";
import { formatRupees, parseRupeesToPaise } from "../money.js";

const AMOUNT_HINT = "Enter an amount like 100 or 100.50 (more than zero, at most two decimals).";

function amountPaise(text) {
  const paise = parseRupeesToPaise(text);
  if (paise === null) throw new Error(AMOUNT_HINT);
  return paise;
}

export function HolderView() {
  const accounts = useLoad("/api/accounts");
  const [selectedId, setSelectedId] = useState(null);
  const list = accounts.data?.accounts ?? [];
  const account = list.find((a) => a.id === selectedId) ?? list[0];
  const statement = useLoad(account ? `/api/accounts/${account.id}/statement` : null);

  const refresh = () => {
    accounts.reload();
    statement.reload();
  };

  return (
    <Loaded state={accounts}>
      {() =>
        account ? (
          <>
            <section className="card balance-card" aria-labelledby="balance-title">
              <div>
                <h2 id="balance-title" className="label-title">Available balance</h2>
                <p className="balance money">{formatRupees(account.balance_paise)}</p>
              </div>
              <div className="balance-meta">
                <p className="label-title">Account number</p>
                <p><code>{account.account_number}</code> <Badge value={account.status} /></p>
                {list.length > 1 && (
                  <label className="filter">
                    Switch account
                    <select value={account.id} onChange={(e) => setSelectedId(e.target.value)}>
                      {list.map((a) => (
                        <option key={a.id} value={a.id}>{a.account_number}</option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
              {account.status?.toLowerCase() === "pending_kyc" && (
                <p className="callout callout-warn" role="status">
                  <strong>KYC pending.</strong> Your account is awaiting Admin onboarding approval. You cannot send or receive funds until approved.
                </p>
              )}
              {account.status?.toLowerCase() === "frozen" && (
                <p className="callout callout-bad" role="status">
                  <strong>Account frozen.</strong> Money cannot move until an admin unfreezes it.
                </p>
              )}
            </section>

            <div className="two-col">
              <Section title="Transfer">
                <MoneyForm
                  submitLabel="Send transfer"
                  fields={[
                    { name: "to", label: "Recipient account number", placeholder: "LP0000000002" },
                    { name: "amount", label: "Amount (₹)", placeholder: "100.50", inputMode: "decimal" },
                  ]}
                  buildRequest={(v) => ({
                    path: "/api/transactions/transfer",
                    body: { fromAccountId: account.id, toAccountNumber: v.to.trim().toUpperCase(), amountPaise: amountPaise(v.amount) },
                  })}
                  onDone={refresh}
                />
              </Section>
              <Section title="Withdraw">
                <MoneyForm
                  submitLabel="Withdraw"
                  fields={[{ name: "amount", label: "Amount (₹)", placeholder: "100.50", inputMode: "decimal" }]}
                  buildRequest={(v) => ({ path: "/api/transactions/withdraw", body: { fromAccountId: account.id, amountPaise: amountPaise(v.amount) } })}
                  onDone={refresh}
                />
              </Section>
            </div>

            <Statement state={statement} />
          </>
        ) : (
          <Section title="Your account">
            <p className="empty">You do not have an account yet. Ask an admin to create one.</p>
          </Section>
        )
      }
    </Loaded>
  );
}

function Statement({ state }) {
  const [direction, setDirection] = useState("all");
  const [type, setType] = useState("all");
  return (
    <Section
      title="Recent activity"
      actions={
        <div className="filters">
          <FilterSelect label="Entry" value={direction} onChange={setDirection} options={["all", "debit", "credit"]} />
          <FilterSelect label="Type" value={type} onChange={setType} options={["all", "deposit", "withdrawal", "transfer"]} />
        </div>
      }
    >
      <p className="muted small">Double-entry statement, newest first. Credits add to your balance (+), debits take from it (−).</p>
      <Loaded state={state}>
        {({ entries }) => (
          <DataTable
            label="Account statement"
            stack
            rows={[...entries].reverse().filter((e) => (direction === "all" || e.direction === direction) && (type === "all" || e.type === type))}
            rowKey={(e) => e.id}
            empty="No entries match."
            columns={[
              { label: "Time", render: (e) => formatTime(e.created_at) },
              { label: "Type", render: (e) => e.type },
              { label: "Entry", render: (e) => <Badge value={e.direction} /> },
              { label: "Amount", align: "num", render: (e) => <strong className={`amount amount-${e.direction}`}>{signed(e.direction)}{formatRupees(e.amount_paise)}</strong> },
              { label: "Balance after", align: "num", render: (e) => formatRupees(e.running_balance_paise) },
              { label: "Reference", render: (e) => <code className="ref" title={e.transaction_id}>{shortId(e.transaction_id)}</code> },
            ]}
          />
        )}
      </Loaded>
    </Section>
  );
}
