import pg from "pg";
import { createApp } from "./app.js";
import { parseAllowedOrigins } from "./origins.js";

const { DATABASE_URL, JWT_SECRET, ALLOWED_ORIGINS = "", PORT = "3000" } = process.env;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");
if (!JWT_SECRET || JWT_SECRET.length < 32) throw new Error("JWT_SECRET must be at least 32 characters");

// Comma-separated browser origins allowed to read API responses, for example
// "http://localhost:5173,https://ledgerproof.example.com". Unset means none.
const allowedOrigins = parseAllowedOrigins(ALLOWED_ORIGINS);

const pool = new pg.Pool({ connectionString: DATABASE_URL });
createApp(pool, { jwtSecret: JWT_SECRET, allowedOrigins }).listen(Number(PORT), () => {
  console.log(`LedgerProof API listening on port ${PORT}`);
});
