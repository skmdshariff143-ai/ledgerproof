// Renders `children(data)` once a useLoad() result has data, with loading and error states.
export function Loaded({ state, children }) {
  if (state.error) {
    return (
      <div className="error-row" role="alert">
        <p className="error"><strong>Could not load.</strong> {state.error}</p>
        <button type="button" className="secondary" onClick={state.reload}>Try again</button>
      </div>
    );
  }
  if (!state.data) return <p className="muted" role="status">Loading…</p>;
  return children(state.data);
}
