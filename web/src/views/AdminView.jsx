import { useState } from "react";
import { Badge } from "../components/Badge.jsx";
import { DataTable } from "../components/DataTable.jsx";
import { Loaded } from "../components/Loaded.jsx";
import { MoneyForm } from "../components/MoneyForm.jsx";
import { ReconcileBanner } from "../components/ReconcileBanner.jsx";
import { Section } from "../components/Section.jsx";
import { formatTime, shortId } from "../format.js";
import { useLoad } from "../hooks.js";
import { formatRupees, parseRupeesToPaise } from "../money.js";
import { useSession } from "../session.jsx";

// What each onboarding action does on the server, shown in the confirm dialog before it runs.
const ONBOARD_EFFECT = {
  approve: "Their status becomes active and their account becomes active, so they can send and receive money. An account is created if they have none.",
  reject: "Their status becomes rejected and their account is frozen.",
  freeze: "Their status and their account become frozen. No money can move in or out until you approve them again.",
};

export function AdminView() {
  const { call } = useSession();
  const accounts = useLoad("/api/accounts");
  const users = useLoad("/api/admin/users");
  const [busyId, setBusyId] = useState(null);
  const [message, setMessage] = useState(null);
  const [newOwner, setNewOwner] = useState("");

  async function act(label, run) {
    setMessage(null);
    try {
      setMessage({ ok: true, text: await run() });
      accounts.reload();
      users.reload();
    } catch (err) {
      setMessage({ ok: false, text: `${label} failed: ${err.message}` });
    }
  }

  const setFrozen = (account, freeze) => {
    const effect = freeze
      ? "No money can move in or out of it until you unfreeze it."
      : "It becomes active and money can move in and out again.";
    if (!window.confirm(`${freeze ? "Freeze" : "Unfreeze"} account ${account.account_number}?\n\n${effect}`)) return undefined;
    setBusyId(account.id);
    return act(freeze ? "Freeze" : "Unfreeze", async () => {
      await call("POST", `/api/accounts/${account.id}/${freeze ? "freeze" : "unfreeze"}`);
      return `${account.account_number} is now ${freeze ? "frozen" : "active"}.`;
    }).finally(() => setBusyId(null));
  };

  const onboardAction = (user, action) => {
    const question = `${action[0].toUpperCase()}${action.slice(1)} ${user.email}?`;
    const current = `They are currently ${(user.status ?? "active").replace(/_/g, " ")}.`;
    if (!window.confirm(`${question}\n\n${current} ${ONBOARD_EFFECT[action]}`)) return undefined;
    setBusyId(user.id);
    return act(action, async () => {
      await call("POST", `/api/admin/users/${user.id}/${action}`);
      return `${user.email}: ${action} completed.`;
    }).finally(() => setBusyId(null));
  };

  const createAccount = (event) => {
    event.preventDefault();
    return act("Create account", async () => {
      const { data } = await call("POST", "/api/accounts", { body: { ownerId: newOwner } });
      setNewOwner("");
      return `Created account ${data.account.account_number}.`;
    });
  };

  const userActions = (u) => {
    const status = u.status?.toLowerCase();
    if (u.role !== "account_holder") return <span className="muted small">None</span>;
    return (
      <div className="filters">
        {status !== "active" && (
          <button type="button" disabled={busyId === u.id} onClick={() => onboardAction(u, "approve")}>
            Approve KYC
          </button>
        )}
        {status === "pending_kyc" && (
          <button type="button" className="secondary" disabled={busyId === u.id} onClick={() => onboardAction(u, "reject")}>
            Reject
          </button>
        )}
        {status === "active" && (
          <button type="button" className="secondary" disabled={busyId === u.id} onClick={() => onboardAction(u, "freeze")}>
            Freeze user
          </button>
        )}
      </div>
    );
  };

  return (
    <Loaded state={accounts}>
      {({ accounts: list }) => (
        <Loaded state={users}>
          {({ users: userList }) => {
            const vault = list.find((a) => a.account_type === "system_vault");
            const userAccounts = list.filter((a) => a.account_type === "user_checking");
            const emailOf = Object.fromEntries(userList.map((u) => [u.id, u.email]));
            const holders = userList.filter((u) => u.role === "account_holder");
            const pending = holders.filter((u) => u.status?.toLowerCase() === "pending_kyc");
            return (
              <>
                {message && (
                  <div className={`toast ${message.ok ? "toast-ok" : "toast-bad"}`} role={message.ok ? "status" : "alert"}>
                    <p>
                      <strong>{message.ok ? "Done." : "Failed."}</strong> {message.text}
                    </p>
                    <button type="button" className="secondary" onClick={() => setMessage(null)}>Dismiss</button>
                  </div>
                )}

                <Section title={`Pending KYC review (${pending.length})`}>
                  <DataTable
                    label="Accounts awaiting KYC review"
                    stack
                    rows={pending}
                    rowKey={(u) => u.id}
                    empty="No accounts are waiting for KYC review."
                    columns={[
                      { label: "Email", render: (u) => u.email },
                      { label: "Registered", render: (u) => formatTime(u.created_at) },
                      { label: "Id", render: (u) => <code className="ref" title={u.id}>{shortId(u.id)}</code> },
                      { label: "Review", render: userActions },
                    ]}
                  />
                </Section>

                <ReconcileBanner />

                <div className="two-col">
                  <Section title="System vault">
                    <p className="muted small">Settlement account. Every deposit is paid from here; a negative balance is money issued to customers.</p>
                    <p className="balance money">{formatRupees(vault.balance_paise)}</p>
                    <p><code>{vault.account_number}</code> <Badge value={vault.status} /></p>
                  </Section>
                  <Section title="Deposit (initial / test fund tool)">
                    <MoneyForm
                      submitLabel="Deposit"
                      fields={[
                        {
                          name: "to",
                          label: "Account",
                          options: userAccounts.map((a) => ({ value: a.id, label: `${a.account_number} · ${emailOf[a.owner_id]}` })),
                        },
                        { name: "amount", label: "Amount (₹)", placeholder: "100.50", inputMode: "decimal", maxLength: 16 },
                      ]}
                      buildRequest={(v) => {
                        const paise = parseRupeesToPaise(v.amount);
                        if (paise === null) throw new Error("Enter an amount like 100 or 100.50 (more than zero, at most two decimals).");
                        return { path: "/api/transactions/deposit", body: { toAccountId: v.to, amountPaise: paise } };
                      }}
                      onDone={accounts.reload}
                    />
                  </Section>
                </div>

                <Section title="Accounts">
                  <DataTable
                    label="Customer accounts"
                    stack
                    rows={userAccounts}
                    rowKey={(a) => a.id}
                    columns={[
                      { label: "Number", render: (a) => <code>{a.account_number}</code> },
                      { label: "Owner", render: (a) => emailOf[a.owner_id] },
                      { label: "Status", render: (a) => <Badge value={a.status} /> },
                      { label: "Balance", align: "num", render: (a) => formatRupees(a.balance_paise) },
                      {
                        label: "Action",
                        render: (a) =>
                          a.status?.toLowerCase() === "pending_kyc" ? (
                            <span className="muted small">Review in the KYC list</span>
                          ) : (
                            <button type="button" className="secondary" disabled={busyId === a.id} onClick={() => setFrozen(a, a.status?.toLowerCase() === "active")}>
                              {a.status?.toLowerCase() === "active" ? "Freeze account" : "Unfreeze account"}
                            </button>
                          ),
                      },
                    ]}
                  />
                  <form className="inline-form" onSubmit={createAccount}>
                    <label>
                      New account for
                      <select value={newOwner} onChange={(e) => setNewOwner(e.target.value)} required>
                        <option value="">Choose an account holder…</option>
                        {holders.map((u) => (
                          <option key={u.id} value={u.id}>{u.email}</option>
                        ))}
                      </select>
                    </label>
                    <button type="submit">Create account</button>
                  </form>
                </Section>

                <Section title="Users and KYC onboarding">
                  <DataTable
                    label="All users"
                    stack
                    rows={userList}
                    rowKey={(u) => u.id}
                    columns={[
                      { label: "Email", render: (u) => u.email },
                      { label: "Role", render: (u) => <Badge value={u.role} /> },
                      { label: "Status", render: (u) => <Badge value={u.status ?? "active"} /> },
                      { label: "Id", render: (u) => <code className="ref" title={u.id}>{shortId(u.id)}</code> },
                      { label: "Created", render: (u) => formatTime(u.created_at) },
                      { label: "Onboarding", render: userActions },
                    ]}
                  />
                </Section>
              </>
            );
          }}
        </Loaded>
      )}
    </Loaded>
  );
}
