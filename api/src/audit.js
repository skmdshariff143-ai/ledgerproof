import { createHash } from "node:crypto";

export const GENESIS_HASH = "GENESIS_LEDGERPROOF_2026";

export function canonicalJson(value) {
  if (value === null || value === undefined) return "{}";
  if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? "null" : canonicalJsonValue(item))).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}: ${canonicalJsonValue(value[k])}`).join(", ")}}`;
  }
  return JSON.stringify(value);
}

function canonicalJsonValue(val) {
  if (val === null || val === undefined) return "null";
  if (Array.isArray(val)) return `[${val.map((item) => canonicalJsonValue(item)).join(", ")}]`;
  if (typeof val === "object") return canonicalJson(val);
  return JSON.stringify(val);
}

export function computeAuditEntryHash({
  previousHash = GENESIS_HASH,
  seq,
  actorId,
  actorRole,
  action,
  targetId,
  metadata,
  createdAtIso,
}) {
  const payload = [
    previousHash || GENESIS_HASH,
    String(seq),
    actorId ?? "ANONYMOUS",
    actorRole ?? "ANONYMOUS",
    action,
    targetId ?? "",
    typeof metadata === "string" ? metadata : canonicalJson(metadata),
    createdAtIso,
  ].join("|");
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

// Pass the request's transaction client for a success, so the audit row commits with the change.
// Pass the pool for a denial or failure: it runs in its own transaction, so rolling back the
// request cannot erase the record of the attempt.
export async function audit(db, { actor, action, target = null, ip = null, details = null, outcome = "success" }) {
  await db.query(
    `INSERT INTO audit_log (actor_user_id, actor_role, action, target, ip, details, outcome)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      actor?.id ?? null,
      actor?.role ?? null,
      action,
      target,
      ip,
      details ? JSON.stringify(details) : null,
      outcome,
    ],
  );
}

export async function verifyAuditChain(db) {
  let rows;
  try {
    ({ rows } = await db.query(
      `SELECT id,
              seq,
              actor_user_id,
              actor_role,
              action,
              target,
              details::text AS details_text,
              previous_hash,
              entry_hash,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at_iso
         FROM audit_log
        ORDER BY id ASC`,
    ));
  } catch (err) {
    if (err.code !== "42703") throw err;
    const legacy = await db.query("SELECT count(*)::int AS total FROM audit_log");
    return {
      verified: false,
      schemaMigrated: false,
      reason: "MISSING_HASH_COLUMNS",
      totalEntries: legacy.rows[0].total,
      headHash: null,
    };
  }

  let expectedPrevious = GENESIS_HASH;
  for (const row of rows) {
    const expectedHash = computeAuditEntryHash({
      previousHash: expectedPrevious,
      seq: row.seq ?? row.id,
      actorId: row.actor_user_id,
      actorRole: row.actor_role,
      action: row.action,
      targetId: row.target,
      metadata: row.details_text ?? "{}",
      createdAtIso: row.created_at_iso,
    });
    if (row.previous_hash !== expectedPrevious || row.entry_hash !== expectedHash) {
      return {
        verified: false,
        schemaMigrated: true,
        totalEntries: rows.length,
        tamperedSeq: Number(row.seq ?? row.id),
        expectedHash,
        actualHash: row.entry_hash,
        headHash: rows.at(-1)?.entry_hash ?? GENESIS_HASH,
      };
    }
    expectedPrevious = row.entry_hash;
  }

  return {
    verified: true,
    schemaMigrated: true,
    totalEntries: rows.length,
    headHash: expectedPrevious,
  };
}
