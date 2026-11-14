// columns: [{ label, render(row), align? }]. Every cell is rendered by React, so text is escaped.
// `label` names the table for screen readers. `stack` turns each row into a small card on narrow
// screens; without it a wide table scrolls sideways inside its own box.
export function DataTable({ columns, rows, rowKey, rowClass, label, stack = false, empty = "Nothing to show." }) {
  if (rows.length === 0) return <p className="empty">{empty}</p>;
  return (
    <>
      <div className={`table-wrap${stack ? " stack" : ""}`} role="region" aria-label={label} tabIndex={0}>
        <table>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.label} scope="col" className={c.align}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={rowKey(row)} className={rowClass?.(row)}>
                {columns.map((c) => (
                  <td key={c.label} data-label={c.label} className={c.align}>{c.render(row)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!stack && <p className="muted small scroll-hint">Wide table: scroll sideways to see every column.</p>}
    </>
  );
}
