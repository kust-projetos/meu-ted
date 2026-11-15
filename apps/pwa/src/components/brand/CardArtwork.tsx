import { useId, type CSSProperties } from "react";
import type { Institution } from "@/lib/institutions/catalog";
import { resolveCardNetworkLabel, type CardNetwork, type CardProduct } from "@/lib/institutions/card-products";
import { InstitutionMark } from "./InstitutionMark";
import { networkSvg } from "./network-svgs";
import { stripSvgTitle } from "./svg-markup";

interface CardArtworkProps {
  product?: CardProduct;
  productName?: string;
  institution?: Institution;
  network: CardNetwork;
  maskedNumber?: string;
  holderName?: string;
  expiry?: string;
  compact?: boolean;
  className?: string;
  style?: CSSProperties;
  onClick?: () => void;
  "aria-label"?: string;
}

const fallbackColors = { base: "#43336B", accent: "#AFA1D5", text: "#fff" };

const materialBackgrounds: Record<CardProduct["material"], (base: string, accent: string) => string> = {
  classic: (base, accent) => `linear-gradient(125deg, ${base}, ${base} 56%, ${accent})`,
  metal: (base, accent) => `linear-gradient(115deg, #151515 0%, ${base} 20%, ${accent} 43%, ${base} 58%, #111 100%)`,
  carbon: (base, accent) => `repeating-linear-gradient(135deg, ${base} 0 4px, #ffffff10 4px 6px), linear-gradient(120deg, #161616, ${accent})`,
  translucent: (base, accent) => `linear-gradient(135deg, ${base}ee, #ffffff22 48%, ${accent})`,
  gradient: (base, accent) => `radial-gradient(ellipse at 82% 0%, ${accent} 0%, transparent 45%), linear-gradient(125deg, ${base}, #171323)`,
};

const networkAsset: Partial<Record<CardNetwork, string>> = {
  visa: "visa",
  mastercard: "mastercard",
  amex: "americanexpress",
  // ELO and Hipercard intentionally remain styled text: no verified asset was vendored.
};

export function CardArtwork({
  product,
  productName,
  institution,
  network,
  maskedNumber,
  holderName,
  expiry,
  compact = false,
  className = "",
  style,
  onClick,
  "aria-label": ariaLabel,
}: CardArtworkProps) {
  const uniqueId = useId().replace(/:/g, "");
  const colors = product?.colors ?? {
    base: institution?.colors.primary ?? fallbackColors.base,
    accent: institution?.colors.secondary ?? fallbackColors.accent,
    text: fallbackColors.text,
  };
  const material = product?.material ?? "classic";
  const background = materialBackgrounds[material](colors.base, colors.accent);
  const networkLabel = resolveCardNetworkLabel(network);
  const icon = networkAsset[network] ? networkSvg[networkAsset[network]!] : undefined;

  return (
    <div
      data-testid="bank-card"
      onClick={onClick}
      onKeyDown={onClick ? (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick();
        }
      } : undefined}
      role={onClick ? "button" : undefined}
      aria-label={ariaLabel}
      tabIndex={onClick ? 0 : undefined}
      className={`relative isolate flex aspect-[85.6/53.98] min-h-[168px] flex-col justify-between overflow-hidden rounded-2xl p-4 text-white shadow-elevated ${
        onClick ? "cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary" : ""
      } ${className}`}
      style={{ background, color: colors.text, touchAction: "manipulation", ...style }}
    >
      <svg className="pointer-events-none absolute inset-0 -z-10 h-full w-full opacity-[.11]" aria-hidden="true">
        <filter id={`card-grain-${uniqueId}`}>
          <feTurbulence type="fractalNoise" baseFrequency=".72" numOctaves="2" stitchTiles="stitch" />
        </filter>
        <rect width="100%" height="100%" filter={`url(#card-grain-${uniqueId})`} />
      </svg>

      <div className="relative flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <InstitutionMark institution={institution} size="sm" />
          <div className="min-w-0">
            <div className="truncate text-xs font-bold">
              {institution?.shortName ?? institution?.name ?? "Meu TED"}
            </div>
            <div className="truncate text-[11px] opacity-80">
              {product?.name ?? productName ?? "Cartão"}
            </div>
          </div>
        </div>
        {!compact && (
          <svg data-testid="card-contactless" aria-label="Aproximação" role="img" width="24" height="22" viewBox="0 0 24 22" fill="none">
            <circle cx="4" cy="11" r="1.4" fill="currentColor" />
            <path d="M8 7.5a5 5 0 0 1 0 7M11.5 4.5a9.2 9.2 0 0 1 0 13M15 1.5a13.4 13.4 0 0 1 0 19" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
        )}
      </div>

      {!compact && (
        <div className="relative flex items-center gap-3">
          <svg data-testid="card-chip" aria-hidden="true" width="38" height="28" viewBox="0 0 38 28">
            <defs>
              <linearGradient id={`chip-gold-${uniqueId}`} x1="0" x2="1" y1="0" y2="1">
                <stop stopColor="#FFF2B2" />
                <stop offset=".48" stopColor="#D5AE54" />
                <stop offset="1" stopColor="#A57927" />
              </linearGradient>
            </defs>
            <rect x=".5" y=".5" width="37" height="27" rx="5" fill={`url(#chip-gold-${uniqueId})`} stroke="#FFF4C4" strokeOpacity=".55" />
            <rect x="4" y="3.5" width="30" height="21" rx="3" fill="none" stroke="#71521E" strokeOpacity=".65" />
            <path d="M14 4v20M24 4v20M4 10h10m10 0h10M4 18h10m10 0h10" stroke="#765820" strokeOpacity=".72" strokeWidth=".8" />
            <path d="M14 10h10v8H14z" fill="none" stroke="#FFF0B0" strokeOpacity=".7" strokeWidth=".7" />
          </svg>
          <span aria-hidden="true" className="text-xs opacity-70">•••</span>
        </div>
      )}

      <div className="relative flex items-end justify-between gap-2">
        <div className="min-w-0">
          <div className="font-mono tabular-nums text-sm tracking-[.13em]">
            {maskedNumber ?? "•••• •••• •••• ••••"}
          </div>
          {(holderName || expiry) && (
            <div className="mt-1 flex gap-3 text-[10px] font-semibold uppercase opacity-85">
              {holderName && <span className="truncate">{holderName}</span>}
              {expiry && <span className="font-mono tabular-nums">{expiry}</span>}
            </div>
          )}
        </div>
        <span data-testid="card-flag" aria-label={networkLabel} className="flex h-7 min-w-9 items-center justify-center">
          {icon ? (
            <span
              aria-hidden="true"
              className="flex max-h-6 max-w-11 items-center [&>svg]:max-h-6 [&>svg]:max-w-11"
              dangerouslySetInnerHTML={{ __html: stripSvgTitle(icon) }}
            />
          ) : (
            <span className="rounded bg-white/15 px-1.5 py-1 text-[10px] font-black italic">
              {network === "elo" ? "elo" : network === "hipercard" ? "Hiper" : "CARD"}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}
