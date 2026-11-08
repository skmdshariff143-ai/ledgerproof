import { useState } from "react";
import { Badge } from "../components/Badge.jsx";
import { DataTable } from "../components/DataTable.jsx";
import { Loaded } from "../components/Loaded.jsx";
import { MoneyForm } from "../components/MoneyForm.jsx";
import { Section } from "../components/Section.jsx";
import { formatTime, shortId } from "../format.js";
import { useLoad } from "../hooks.js";
import { formatRupees, parseRupeesToPaise } from "../money.js";
import { useSession } from "../session.jsx";

export function AdminView() {
  const { call } = useSession();
  const accounts = useLoad("/api/accounts");
  const users = useLoad("/api/users");
  const [busyId, setBusyId] = useState(null);
  const [message, setMessage] = useState(null);
  const [newOwner, setNewOwner] = useState("");

  async function act(label, run) {
    setMessage(null);
    try {
      setMessage({ ok: true, text: await run() });
      accounts.reload();
    } catch (err) {
      setMessage({ ok: false, text: `${label} failed: ${err.message}` });
    }
  }

  const setFrozen = (account, freeze) => {
    setBusyId(account.id);
    return act(freeze ? "Freeze" : "Unfreeze", async () => {
      await call("POST", `/api/accounts/${account.id}/${freeze ? "freeze" : "unfreeze"}`);
      return `${account.account_number} is now ${freeze ? "frozen" : "active"}.`;
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

  return (
    <Loaded state={accounts}>
      {({ accounts: list }) => (
        <Loaded state={users}>
          {({ users: userList }) => {
            const vault = list.find((a) => a.account_type === "system_vault");
            const userAccounts = list.filter((a) => a.account_type === "user_checking");
            const emailOf = Object.fromEntries(userList.map((u) => [u.id, u.email]));
            const holders = userList.filter((u) => u.role === "account_holder");
            return (
              <>
                {message && <p className={message.ok ? "notice" : "error"} role="status">{message.text}</p>}

                <div className="two-col">
                  <Section title="System vault">
                    <p className="muted small">Settlement account. Every deposit is paid from here; a negative balance is money issued to customers.</p>
                    <p className="balance">{formatRupees(vault.balance_paise)}</p>
                    <p><code>{vault.account_number}</code> <Badge value={vault.status} /></p>
                  </Section>
                  <Section title="Deposit">
                    <MoneyForm
                      submitLabel="Deposit"
                      fields={[
                        {
                          name: "to",
                          label: "Account",
                          options: userAccounts.map((a) => ({ value: a.id, label: `${a.account_number} · ${emailOf[a.owner_id]}` })),
                        },
                        { name: "amount", label: "Amount (₹)", placeholder: "100.50", inputMode: "decimal" },
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
                    rows={userAccounts}
                    rowKey={(a) => a.id}
                    columns={[
                      { label: "Number", render: (a) => <code>{a.account_number}</code> },
                      { label: "Owner", render: (a) => emailOf[a.owner_id] },
                      { label: "Status", render: (a) => <Badge value={a.status} /> },
                      { label: "Balance", align: "num", render: (a) => formatRupees(a.balance_paise) },
                      {
                        label: "Action",
                        render: (a) => (
                          <button type="button" className="secondary" disabled={busyId === a.id} onClick={() => setFrozen(a, a.status === "active")}>
                            {a.status === "active" ? "Freeze" : "Unfreeze"}
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

                <Section title="Users (read-only)">
                  <DataTable
                    rows={userList}
                    rowKey={(u) => u.id}
                    columns={[
                      { label: "Email", render: (u) => u.email },
                      { label: "Role", render: (u) => <Badge value={u.role} /> },
                      { label: "Id", render: (u) => <code title={u.id}>{shortId(u.id)}</code> },
                      { label: "Created", render: (u) => formatTime(u.created_at) },
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
