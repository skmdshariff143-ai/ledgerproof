import pg from "pg";
import { createApp } from "./app.js";

const { DATABASE_URL, JWT_SECRET, PORT = "3000" } = process.env;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");
if (!JWT_SECRET || JWT_SECRET.length < 32) throw new Error("JWT_SECRET must be at least 32 characters");

const pool = new pg.Pool({ connectionString: DATABASE_URL });
createApp(pool, { jwtSecret: JWT_SECRET }).listen(Number(PORT), () => {
  console.log(`LedgerProof API listening on port ${PORT}`);
});
