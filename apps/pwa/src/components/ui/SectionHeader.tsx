import type { ReactNode } from "react";

export interface SectionHeaderProps {
  title: string;
  meta?: string;
  action?: ReactNode;
  className?: string;
}

export function SectionHeader({ title, meta, action, className = "" }: SectionHeaderProps) {
  return (
    <header className={`flex min-w-0 items-baseline justify-between gap-3 ${className}`}>
      <div className="min-w-0">
        <h2 className="text-lg font-semibold tracking-tight text-text-primary">{title}</h2>
        {meta && <p className="mt-0.5 text-sm text-text-muted">{meta}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </header>
  );
}

export default SectionHeader;
