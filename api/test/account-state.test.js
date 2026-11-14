import { test } from "node:test";
import assert from "node:assert/strict";
import { call, pool, tokenFor, useSeededServer } from "./helpers.js";

useSeededServer();

const statusOf = async (id) => (await pool.query("SELECT status FROM accounts WHERE id = $1", [id])).rows[0].status.toLowerCase();

test("THREAT KYC bypass through freeze and unfreeze: an admin cannot activate a pending-KYC account except by approving the user", async () => {
  const admin = await tokenFor("admin");
  const reg = await call("POST", "/api/auth/register", { body: { email: "pending.person@example.com", password: "Pending@12345" } });
  assert.equal(reg.status, 201);
  const accountId = reg.body.account.id;
  assert.equal(await statusOf(accountId), "pending_kyc");

  // Unfreezing a pending account would make it active while the user stays pending.
  const unfreeze = await call("POST", `/api/accounts/${accountId}/unfreeze`, { token: admin });
  assert.equal(unfreeze.status, 403);
  assert.equal(unfreeze.body.error.code, "KYC_PENDING");
  assert.equal(await statusOf(accountId), "pending_kyc");

  // So would freezing it first and unfreezing afterwards.
  const freeze = await call("POST", `/api/accounts/${accountId}/freeze`, { token: admin });
  assert.equal(freeze.status, 403);
  assert.equal(await statusOf(accountId), "pending_kyc");

  // The supported route still works, and the freeze and unfreeze of an approved account still work.
  const approve = await call("POST", `/api/admin/users/${reg.body.user.id}/approve`, { token: admin });
  assert.equal(approve.status, 200);
  assert.equal(await statusOf(accountId), "active");
  assert.equal((await call("POST", `/api/accounts/${accountId}/freeze`, { token: admin })).status, 200);
  assert.equal(await statusOf(accountId), "frozen");
  assert.equal((await call("POST", `/api/accounts/${accountId}/unfreeze`, { token: admin })).status, 200);
  assert.equal(await statusOf(accountId), "active");
});

test("THREAT KYC bypass through a rejected or frozen user: unfreezing the account does not reactivate a user who is not active", async () => {
  const admin = await tokenFor("admin");
  for (const [email, action] of [["rejected.person@example.com", "reject"], ["frozen.person@example.com", "freeze"]]) {
    const reg = await call("POST", "/api/auth/register", { body: { email, password: "Pending@12345" } });
    const accountId = reg.body.account.id;
    assert.equal((await call("POST", `/api/admin/users/${reg.body.user.id}/${action}`, { token: admin })).status, 200);
    assert.equal(await statusOf(accountId), "frozen");

    const unfreeze = await call("POST", `/api/accounts/${accountId}/unfreeze`, { token: admin });
    assert.equal(unfreeze.status, 422, `${action}: unfreeze must be refused`);
    assert.equal(await statusOf(accountId), "frozen", `${action}: the account stays frozen`);
  }
});
