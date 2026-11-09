import { test } from "node:test";
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { assertTlsVerificationOn, poolConfig } from "../src/db-config.js";
import { SUPABASE_CA } from "../src/supabase-ca.js";

const POOLER = "postgresql://ledgerproof_app.ifudxxxtuntvgsiuuhxi:p%40ss%2Fword@aws-0-ap-south-1.pooler.supabase.com:6543/postgres";
const DIRECT = "postgresql://postgres:secret@db.ifudxxxtuntvgsiuuhxi.supabase.co:5432/postgres";

test("THREAT unverified database TLS: Supabase hosts always get the pinned CA, whatever the URL says", () => {
  for (const url of [POOLER, DIRECT]) {
    const config = poolConfig(url, { max: 5 });
    assert.equal(config.ssl.ca, SUPABASE_CA);
    assert.notEqual(config.ssl.rejectUnauthorized, false, "certificate checking must stay on");
    assert.equal(config.max, 5);
  }
  for (const weaker of ["sslmode=no-verify", "sslmode=disable", "ssl=false", "sslmode=require&uselibpqcompat=true"]) {
    const config = poolConfig(`${POOLER}?${weaker}`);
    assert.ok(!config.connectionString.includes("ssl"), `"${weaker}" must be dropped from the URL`);
    assert.equal(config.ssl.ca, SUPABASE_CA);
  }
});

test("THREAT unverified database TLS: upper case and trailing-dot Supabase host names cannot skip the pin", () => {
  for (const host of ["DB.X.SUPABASE.CO", "db.x.supabase.co.", "A.Pooler.Supabase.Com", "A.POOLER.SUPABASE.COM."]) {
    const config = poolConfig(`postgres://u:p@${host}/d?sslmode=no-verify`);
    assert.equal(config.ssl.ca, SUPABASE_CA, `${host} must get the pinned CA`);
    assert.ok(!config.connectionString.includes("sslmode"));
  }
});

test("poolConfig keeps the user, password and database intact, including encoded characters", () => {
  const parsed = new URL(poolConfig(POOLER).connectionString);
  assert.equal(parsed.username, "ledgerproof_app.ifudxxxtuntvgsiuuhxi");
  assert.equal(decodeURIComponent(parsed.password), "p@ss/word");
  assert.equal(parsed.host, "aws-0-ap-south-1.pooler.supabase.com:6543");
  assert.equal(parsed.pathname, "/postgres");
});

test("a local database is left exactly as configured, with no TLS added", () => {
  const local = "postgres://ledger:ledger@localhost:5432/ledgerproof";
  assert.deepEqual(poolConfig(local, { max: 3 }), { connectionString: local, max: 3 });
  assert.ok(!("ssl" in poolConfig("postgres://u:p@evil-supabase.co.example.com:5432/db")), "only real supabase.co / supabase.com hosts match");
});

test("the pinned certificate is Supabase's root CA, unchanged and still valid", () => {
  const cert = new X509Certificate(SUPABASE_CA);
  assert.match(cert.subject, /CN=Supabase Root 2021 CA/);
  assert.equal(cert.ca, true);
  assert.equal(cert.fingerprint256, "80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA");
  const daysLeft = (new Date(cert.validTo) - Date.now()) / 86_400_000;
  assert.ok(daysLeft > 90, `the pinned CA expires in ${Math.floor(daysLeft)} days; replace it`);
});

test("a deployed API refuses a database host it has no verified TLS settings for, and a process with TLS checking disabled", () => {
  const deployed = { requireTls: true };
  assert.throws(() => poolConfig("postgres://u:p@db.example.com:5432/d", {}, deployed), /no verified TLS settings/);
  assert.throws(() => poolConfig("postgres://u:p@db.example.com:5432/d?sslmode=no-verify", {}, deployed), /no verified TLS settings/);
  assert.doesNotThrow(() => poolConfig("postgres://u:p@localhost:5432/d", {}, deployed));
  assert.doesNotThrow(() => poolConfig("postgres://u:p@127.0.0.1:5432/d", {}, deployed));
  assert.doesNotThrow(() => poolConfig(POOLER, {}, deployed));
  assert.throws(() => assertTlsVerificationOn({ NODE_TLS_REJECT_UNAUTHORIZED: "0" }), /disables TLS certificate checking/);
  assert.doesNotThrow(() => assertTlsVerificationOn({}));
});
