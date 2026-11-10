import { pathToFileURL } from "node:url";
import pg from "pg";
import { audit } from "../src/audit.js";
import { poolConfig } from "../src/db-config.js";
import { inTransaction } from "../src/db.js";
import { hashPassword } from "../src/password.js";

// Idempotent First-Admin Bootstrap: creates the first admin user and ensures the system treasury
// account exists ONLY if zero admins currently exist in the database.
export async function bootstrapAdmin(pool, { email = "admin@ledgerline.com", password = "Admin@123" } = {}) {
  const cleanEmail = email.trim().toLowerCase();
  const passwordHash = await hashPassword(password);
  return inTransaction(pool, async (client) => {
    const existing = await client.query("SELECT id, email, role FROM users WHERE lower(role) = 'admin' LIMIT 1");
    const vaultRes = await client.query("SELECT id, account_number FROM accounts WHERE account_type = 'system_vault' LIMIT 1");
    if (existing.rows.length > 0) {
      return { created: false, admin: existing.rows[0], vault: vaultRes.rows[0] };
    }
    const { rows } = await client.query(
      "INSERT INTO users (email, password_hash, role, status) VALUES ($1, $2, 'admin', 'active') RETURNING id, email, role, status, created_at",
      [cleanEmail, passwordHash],
    );
    const admin = rows[0];
    await audit(client, {
      actor: admin,
      action: "ADMIN_BOOTSTRAP",
      targetType: "user",
      target: `user:${admin.id}`,
      details: { email: admin.email, vaultId: vaultRes.rows[0]?.id },
      outcome: "success",
    });
    return { created: true, admin, vault: vaultRes.rows[0] };
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const connectionString = process.env.DIRECT_URL ?? process.env.OWNER_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DIRECT_URL, OWNER_DATABASE_URL or DATABASE_URL is required");
  const pool = new pg.Pool(poolConfig(connectionString));
  try {
    const email = process.env.BOOTSTRAP_ADMIN_EMAIL ?? "admin@ledgerline.com";
    const password = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "Admin@123";
    const result = await bootstrapAdmin(pool, { email, password });
    if (result.created) {
      console.log(`Bootstrapped first admin: ${result.admin.email} (vault: ${result.vault?.account_number})`);
    } else {
      console.log(`Admin already exists (${result.admin.email}); skipped bootstrap.`);
    }
  } finally {
    await pool.end();
  }
}
