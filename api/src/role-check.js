// The deployed API must connect as the restricted role from db/roles.sql. If it were pointed at the
// schema owner or a superuser, every database-level protection would be silently off, so refuse to serve.
export async function assertRestrictedRole(pool) {
  const { rows } = await pool.query(
    `SELECT current_user AS name,
            r.rolsuper AS is_superuser,
            r.rolbypassrls AS bypasses_rls,
            COALESCE((SELECT tableowner = current_user FROM pg_tables WHERE schemaname = 'public' AND tablename = 'accounts'), false) AS owns_tables,
            has_column_privilege(current_user, 'public.accounts', 'balance_paise', 'UPDATE') AS can_edit_balances,
            has_table_privilege(current_user, 'public.users', 'UPDATE') AS can_edit_users,
            has_table_privilege(current_user, 'public.ledger_entries', 'DELETE') AS can_delete_history
       FROM pg_roles r WHERE r.rolname = current_user`,
  );
  const role = rows[0];
  const excess = ["is_superuser", "bypasses_rls", "owns_tables", "can_edit_balances", "can_edit_users", "can_delete_history"].filter((flag) => role[flag]);
  if (excess.length > 0) {
    throw new Error(`database role "${role.name}" has more rights than the API needs (${excess.join(", ")}); connect as ledgerproof_app (see db/roles.sql)`);
  }
}
