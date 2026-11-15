import type { ReactNode } from "react";

export interface StatementPanelProps {
  eyebrow?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}

export function StatementPanel({ eyebrow, children, footer, className = "" }: StatementPanelProps) {
  return (
    <section className={`statement-sheen overflow-hidden rounded-[var(--card-radius)] border border-[var(--statement-border)] p-5 text-[var(--statement-text)] ${className}`}>
      {eyebrow && <p className="mb-2 text-xs font-semibold tracking-wide text-[var(--statement-muted)]">{eyebrow}</p>}
      <div>{children}</div>
      {footer && <div className="mt-4 border-t border-[var(--statement-border)] pt-3 text-sm text-[var(--statement-muted)]">{footer}</div>}
    </section>
  );
}

export default StatementPanel;
