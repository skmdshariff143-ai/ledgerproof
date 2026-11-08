// Renders `children(data)` once a useLoad() result has data, with loading and error states.
export function Loaded({ state, children }) {
  if (state.error) {
    return (
      <p className="error" role="alert">
        {state.error} <button type="button" className="link" onClick={state.reload}>Retry</button>
      </p>
    );
  }
  if (!state.data) return <p className="muted">Loading…</p>;
  return children(state.data);
}
