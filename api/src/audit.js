// Pass the request's transaction client for a success, so the audit row commits with the change.
// Pass the pool for a denial or failure: it runs in its own transaction, so rolling back the
// request cannot erase the record of the attempt.
export async function audit(db, { actor, action, target = null, ip = null, details = null, outcome }) {
  await db.query(
    `INSERT INTO audit_log (actor_user_id, actor_role, action, target, ip, details, outcome)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [actor?.id ?? null, actor?.role ?? null, action, target, ip, details && JSON.stringify(details), outcome],
  );
}
