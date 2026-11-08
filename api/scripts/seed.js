import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { hashPassword } from "../src/password.js";
import { transfer } from "../src/transfer.js";

// Demo logins for evaluators. Documented in README.md; not for a real deployment.
export const DEMO_USERS = [
  { email: "admin@ledgerline.com", password: "Admin@123", role: "admin" },
  { email: "alice@ledgerline.com", password: "Alice@123", role: "account_holder", openingPaise: 1_000_000 },
  { email: "bob@ledgerline.com", password: "Bob@123", role: "account_holder", openingPaise: 500_000 },
  { email: "auditor@ledgerline.com", password: "Auditor@123", role: "auditor" },
];

async function upsertUser(pool, { email, password, role }) {
  await pool.query(
    "INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING",
    [email, await hashPassword(password), role],
  );
  const { rows } = await pool.query("SELECT id, role FROM users WHERE email = $1", [email]);
  return rows[0];
}

async function ensureAccount(pool, ownerId) {
  await pool.query(
    `INSERT INTO accounts (account_type, owner_id)
     SELECT 'user_checking', $1 WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE owner_id = $1)`,
    [ownerId],
  );
  const { rows } = await pool.query("SELECT id FROM accounts WHERE owner_id = $1 ORDER BY created_at LIMIT 1", [ownerId]);
  return rows[0].id;
}

// Safe to run twice: users and accounts are only created once, and the opening deposits
// use fixed idempotency keys, so a second run replays them instead of paying again.
export async function seed(pool) {
  const vault = (await pool.query("SELECT id FROM accounts WHERE account_type = 'system_vault'")).rows[0].id;
  const users = {};
  for (const demo of DEMO_USERS) users[demo.email] = await upsertUser(pool, demo);
  const admin = users["admin@ledgerline.com"];
  for (const demo of DEMO_USERS.filter((u) => u.openingPaise)) {
    const accountId = await ensureAccount(pool, users[demo.email].id);
    await transfer(pool, {
      actor: admin,
      from: vault,
      to: accountId,
      amountPaise: demo.openingPaise,
      idempotencyKey: `seed-opening-deposit:${demo.email}`,
    });
  }
}

// `node scripts/seed.js`: creates the schema if the database is empty, then seeds.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const { rows } = await pool.query("SELECT to_regclass('public.users') AS users");
    if (!rows[0].users) await pool.query(readFileSync(new URL("../../db/schema.sql", import.meta.url), "utf8"));
    await seed(pool);
    console.log("Seeded demo users and opening deposits.");
  } finally {
    await pool.end();
  }
}
