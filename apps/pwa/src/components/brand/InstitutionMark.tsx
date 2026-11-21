import type { Institution } from "@/lib/institutions/catalog";
import { institutionSvg } from "./institution-svgs";
import { stripSvgTitle } from "./svg-markup";

export interface InstitutionMarkProps {
  institution?: Institution;
  size?: "sm" | "md" | "lg";
  className?: string;
  label?: string;
}

export function InstitutionMark({
  institution,
  size = "md",
  className = "",
  label,
}: InstitutionMarkProps) {
  const pixels = { sm: 32, md: 40, lg: 52 }[size];
  const initials = monogramFor(institution);
  const accessibleName = label ?? institution?.name ?? "Instituição";
  const bg = institution?.logoBg ?? institution?.colors.primary;
  const style = {
    width: pixels,
    height: pixels,
    backgroundColor: bg,
    color: contrast(bg ?? "#52606d"),
  };
  const inlineLogo = institution?.logoSrc ? institutionSvg[institution.logoSrc] : undefined;
  const fileLogo = !inlineLogo ? institution?.logoSrc : undefined;

  return (
    <span
      role="img"
      aria-label={accessibleName}
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-xl font-bold ${className}`}
      style={style}
    >
      {inlineLogo ? (
        <span
          aria-hidden="true"
          className="flex h-[62%] w-[62%] items-center justify-center [&>svg]:h-full [&>svg]:w-full"
          dangerouslySetInnerHTML={{ __html: stripSvgTitle(inlineLogo) }}
        />
      ) : fileLogo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={fileLogo}
          alt=""
          aria-hidden="true"
          className={
            institution?.logoFit === "cover"
              ? "h-full w-full object-cover"
              : "h-[84%] w-[84%] object-contain"
          }
        />
      ) : institution ? (
        <span className="text-sm tracking-tight">{initials}</span>
      ) : (
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="h-5 w-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
        >
          <path d="M3 10h18M5 10v9m4-9v9m6-9v9m4-9v9M3 20h18M12 4l9 4H3l9-4Z" />
        </svg>
      )}
    </span>
  );
}

function monogramFor(institution?: Institution): string {
  if (!institution) return "";
  const short = institution.shortName.replace(/[^A-Za-z0-9]/g, "");
  if (short.length >= 2 && short.length <= 3) return short;
  const words = institution.shortName
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .match(/[A-Za-z0-9]+/g) ?? [];

  if (words.length > 1) return words.slice(0, 2).map((word) => word[0]).join("").toUpperCase();
  return (words[0] ?? short).slice(0, 2).toUpperCase();
}

function contrast(hex: string): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return "#fff";
  const value = parseInt(match[1], 16);
  const red = value >> 16;
  const green = (value >> 8) & 255;
  const blue = value & 255;
  return (red * 299 + green * 587 + blue * 114) / 1000 > 150 ? "#17202a" : "#fff";
}
