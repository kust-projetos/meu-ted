import type { ReactNode } from "react";
import { TedMark } from "@/components/brand/TedMark";

export interface InsightLineProps {
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function InsightLine({ children, action, className = "" }: InsightLineProps) {
  return (
    <aside className={`hairline-t flex items-center gap-3 py-3 ${className}`}>
      <span aria-hidden="true" className="shrink-0"><TedMark size={32} label="" /></span>
      <p className="min-w-0 flex-1 text-sm leading-relaxed text-text-secondary">{children}</p>
      {action && <span className="shrink-0">{action}</span>}
    </aside>
  );
}

export default InsightLine;
