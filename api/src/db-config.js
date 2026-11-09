import { SUPABASE_CA } from "./supabase-ca.js";

// Connection settings for pg. For a Supabase host the connection is always verified against Supabase's
// root CA (chain and host name). Any ssl-related setting in the URL is dropped first, because pg lets
// the URL override this config, and "sslmode=no-verify" must never be able to weaken it.
// Other databases are used exactly as the URL says, except that with `requireTls` (set when deployed)
// only a local database may be reached without these verified settings.
const SSL_PARAMS = ["sslmode", "ssl", "sslrootcert", "sslcert", "sslkey", "uselibpqcompat"];
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function poolConfig(connectionString, extra = {}, { requireTls = false } = {}) {
  const url = new URL(connectionString);
  // new URL() keeps the case and a trailing dot of a postgres:// host, but DNS ignores both.
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (/(^|\.)supabase\.(co|com)$/.test(host)) {
    for (const param of SSL_PARAMS) url.searchParams.delete(param);
    return { connectionString: url.toString(), ssl: { ca: SUPABASE_CA }, ...extra };
  }
  if (requireTls && !LOCAL_HOSTS.has(host)) {
    throw new Error(`DATABASE_URL points to "${host}", a database this API has no verified TLS settings for; use Supabase or a local database`);
  }
  return { connectionString, ...extra };
}

// NODE_TLS_REJECT_UNAUTHORIZED=0 switches off certificate checking for the whole process, pin included.
export function assertTlsVerificationOn(env = process.env) {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new Error("NODE_TLS_REJECT_UNAUTHORIZED=0 disables TLS certificate checking; unset it");
  }
}
