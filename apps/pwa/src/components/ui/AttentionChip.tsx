import type { ButtonHTMLAttributes, ReactNode } from "react";

export type AttentionTone = "danger" | "warning" | "neutral";
export interface AttentionChipProps {
  tone: AttentionTone;
  label: string;
  value?: ReactNode;
  icon?: ReactNode;
  onClick?: ButtonHTMLAttributes<HTMLButtonElement>["onClick"];
  className?: string;
}

const toneClasses: Record<AttentionTone, string> = {
  danger: "bg-[var(--attention-danger-bg)] border-[var(--attention-danger-border)] text-[var(--attention-danger-text)]",
  warning: "bg-[var(--attention-warning-bg)] border-[var(--attention-warning-border)] text-[var(--attention-warning-text)]",
  neutral: "bg-[var(--attention-neutral-bg)] border-[var(--attention-neutral-border)] text-[var(--attention-neutral-text)]",
};

export function AttentionChip({ tone, label, value, icon, onClick, className = "" }: AttentionChipProps) {
  const content = (
    <>
      {icon && <span className="shrink-0" aria-hidden="true">{icon}</span>}
      <span className="min-w-0 truncate text-sm font-medium lg:overflow-visible lg:text-clip lg:whitespace-normal">
        {label}
      </span>
      {value !== undefined && <span className="tabular ml-auto shrink-0 text-sm font-semibold">{value}</span>}
    </>
  );
  const shared = `inline-flex min-h-11 items-center gap-2 rounded-full border px-3 ${toneClasses[tone]} ${className}`;

  return onClick ? (
    <button type="button" onClick={onClick} className={`${shared} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2`}>
      {content}
    </button>
  ) : (
    <span data-tone={tone} className={shared}>{content}</span>
  );
}

export default AttentionChip;
