"use client";

import { resolveBankPreset, type BankPreset } from "@/lib/bank-presets";
import { getInstitution, institutionFromPresetId } from "@/lib/institutions/catalog";
import { CardArtwork } from "./brand/CardArtwork";
import type { CardNetwork, CardProduct } from "@/lib/institutions/card-products";

export interface BankCardProps {
  bankId?: string;
  preset?: BankPreset;
  product?: CardProduct;
  cardName: string;
  maskedNumber?: string;
  holderName?: string;
  expiry?: string;
  network?: Exclude<CardNetwork, "unknown">;
  variant?: string;
  className?: string;
  onClick?: () => void;
  "aria-label"?: string;
  compact?: boolean;
}

export default function BankCard({
  bankId,
  preset,
  product,
  cardName,
  maskedNumber,
  holderName,
  expiry,
  network,
  className = "",
  onClick,
  "aria-label": ariaLabel,
  compact = false,
}: BankCardProps) {
  const resolvedPreset = preset ?? resolveBankPreset({
    id: bankId ?? "nubank",
    name: cardName,
  });
  const institution = getInstitution(bankId ?? "")
    ?? getInstitution(product?.institutionId ?? "")
    ?? institutionFromPresetId(resolvedPreset.id);
  const fallbackStyle = institution || product ? undefined : {
    background: resolvedPreset.cardGradient,
    color: resolvedPreset.textColor,
  };

  return (
    <CardArtwork
      institution={institution}
      product={product}
      productName={cardName}
      network={network ?? product?.network ?? resolvedPreset.network}
      maskedNumber={maskedNumber}
      holderName={holderName}
      expiry={expiry}
      compact={compact}
      className={className}
      onClick={onClick}
      aria-label={ariaLabel}
      style={{
        ...fallbackStyle,
        minHeight: compact ? 130 : 168,
      }}
    />
  );
}
