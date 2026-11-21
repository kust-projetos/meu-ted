import type { ReactNode } from "react";

export interface InsightLineProps {
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function InsightLine({ children, action, className = "" }: InsightLineProps) {
  return (
    <aside className={`hairline-t flex items-center gap-3 py-3 ${className}`}>
      <span aria-hidden="true" className="h-8 w-8 shrink-0 overflow-hidden rounded-full ring-1 ring-primary/25">
        <img
          src="/brand/ted-launcher.png"
          alt=""
          width={32}
          height={32}
          className="h-full w-full object-cover"
        />
      </span>
      <p className="min-w-0 flex-1 text-sm leading-relaxed text-text-secondary">{children}</p>
      {action && <span className="shrink-0">{action}</span>}
    </aside>
  );
}

export default InsightLine;
