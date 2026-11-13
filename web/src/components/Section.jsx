import { useId } from "react";

export function Section({ title, actions, children }) {
  const headingId = useId();
  return (
    <section className="card" aria-labelledby={headingId}>
      <header className="card-head">
        <h2 id={headingId}>{title}</h2>
        {actions}
      </header>
      {children}
    </section>
  );
}
