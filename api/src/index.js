import pg from "pg";
import { createApp } from "./app.js";
import { parseAllowedOrigins } from "./origins.js";
import { assertRestrictedRole } from "./role-check.js";

const { DATABASE_URL, JWT_SECRET, ALLOWED_ORIGINS = "" } = process.env;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");
if (!JWT_SECRET || JWT_SECRET.length < 32) throw new Error("JWT_SECRET must be at least 32 characters");

// Comma-separated browser origins allowed to read API responses, for example
// "http://localhost:5173,https://ledgerproof.example.com". Unset means none.
const allowedOrigins = parseAllowedOrigins(ALLOWED_ORIGINS);

// Small pool: on serverless every instance has its own, and the database pooler shares the real connections.
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 5 });
// An idle connection dropped by the pooler emits "error"; unhandled, it would crash the instance.
pool.on("error", (err) => console.error("idle database client error:", err.message));

// On Vercel the platform sets X-Forwarded-For to the real client address, so trust that one hop and
// audit rows record it. Anywhere else the header is ignored, so a client cannot forge its address.
const onVercel = process.env.VERCEL === "1";

// Deployed, the database role must be the restricted one. Locally the owner role is allowed for convenience.
const ready = onVercel ? assertRestrictedRole(pool) : Promise.resolve();
ready.catch((err) => console.error(err.message));

export default createApp(pool, { jwtSecret: JWT_SECRET, allowedOrigins, trustProxy: onVercel ? 1 : false, ready });
