import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { poolConfig } from "../src/db-config.js";

// Uses DIRECT_URL (port 5432) or OWNER_DATABASE_URL for DDL migrations, falling back to DATABASE_URL locally.
export async function migrate(pool) {
  const { rows } = await pool.query("SELECT to_regclass('public.users') AS users");
  if (!rows[0].users) {
    for (const file of ["schema.sql", "roles.sql"]) {
      await pool.query(readFileSync(new URL(`../../db/${file}`, import.meta.url), "utf8"));
    }
    return { applied: true };
  }
  await pool.query(readFileSync(new URL("../../db/roles.sql", import.meta.url), "utf8"));
  return { applied: false };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const connectionString = process.env.DIRECT_URL ?? process.env.OWNER_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DIRECT_URL, OWNER_DATABASE_URL or DATABASE_URL is required");
  const pool = new pg.Pool(poolConfig(connectionString));
  try {
    const result = await migrate(pool);
    console.log(result.applied ? "Applied database schema and roles." : "Database schema already present; refreshed roles.");
  } finally {
    await pool.end();
  }
}
