import type { ButtonHTMLAttributes, ReactNode } from "react";

export interface LedgerProps {
  children: ReactNode;
  label?: string;
  className?: string;
}

export interface LedgerRowProps {
  leading?: ReactNode;
  primary: ReactNode;
  secondary?: ReactNode;
  trailing?: ReactNode;
  onClick?: ButtonHTMLAttributes<HTMLButtonElement>["onClick"];
  className?: string;
  "aria-label"?: string;
}

export function Ledger({ children, label, className = "" }: LedgerProps) {
  return (
    <ul aria-label={label} className={`m-0 list-none p-0 ${className}`}>
      {children}
    </ul>
  );
}

export function LedgerRow({
  leading,
  primary,
  secondary,
  trailing,
  onClick,
  className = "",
  ...ariaProps
}: LedgerRowProps) {
  const content = (
    <>
      {leading && <span className="flex shrink-0 items-center">{leading}</span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-text-primary">{primary}</span>
        {secondary && <span className="mt-0.5 block truncate text-xs text-text-muted">{secondary}</span>}
      </span>
      {trailing && <span className="tabular shrink-0 text-right text-sm font-semibold">{trailing}</span>}
    </>
  );

  return (
    <li className={`border-b border-[var(--hairline)] last:border-b-0 ${className}`}>
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          className="flex min-h-11 w-full items-center gap-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
          {...ariaProps}
        >
          {content}
        </button>
      ) : (
        <div className="flex min-h-11 items-center gap-3 py-2.5" {...ariaProps}>
          {content}
        </div>
      )}
    </li>
  );
}

export default Ledger;
