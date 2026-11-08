// Runs `work(client)` in one transaction. A failed ROLLBACK means the connection is
// broken, so the client is discarded instead of going back to the pool.
export async function inTransaction(pool, work) {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    broken = await client.query("ROLLBACK").then(() => false, () => true);
    throw err;
  } finally {
    client.release(broken);
  }
}
