export type CardNetwork = "visa" | "mastercard" | "elo" | "amex" | "hipercard";

export interface BankPreset {
  id: string;
  name: string;
  shortName: string;
  primaryColor: string;
  secondaryColor: string;
  gradient: string;
  cardGradient: string;
  textColor: string;
  network: CardNetwork;
  accentColor?: string;
  description: string;
}

export const BANK_PRESETS: BankPreset[] = [
  {
    id: "nubank",
    name: "Nubank",
    shortName: "Nu",
    primaryColor: "#820AD1",
    secondaryColor: "#4A148C",
    gradient: "linear-gradient(135deg, #820AD1 0%, #5E0BA3 45%, #3D0970 100%)",
    cardGradient: "linear-gradient(145deg, #820AD1 0%, #6A0EB5 30%, #4A148C 65%, #2D0861 100%)",
    textColor: "#FFFFFF",
    network: "mastercard",
    description: "Roxo icônico com degradê profundo",
  },
  {
    id: "inter",
    name: "Inter",
    shortName: "Inter",
    primaryColor: "#FF7A00",
    secondaryColor: "#E56700",
    gradient: "linear-gradient(135deg, #FF7A00 0%, #FF8C1A 40%, #E56700 100%)",
    cardGradient: "linear-gradient(145deg, #FF7A00 0%, #FF8A1A 25%, #EA6D00 60%, #C45A00 100%)",
    textColor: "#FFFFFF",
    network: "mastercard",
    accentColor: "#FFFFFF",
    description: "Laranja vibrante Inter",
  },
  {
    id: "itau",
    name: "Itaú",
    shortName: "Itaú",
    primaryColor: "#EC7000",
    secondaryColor: "#CC5F00",
    gradient: "linear-gradient(135deg, #EC7000 0%, #FF8A1A 45%, #C45A00 100%)",
    cardGradient: "linear-gradient(145deg, #EC7000 0%, #FF8610 30%, #D45F00 70%, #A34A00 100%)",
    textColor: "#FFFFFF",
    network: "visa",
    description: "Laranja Itaú clássico",
  },
  {
    id: "itau-personnalite",
    name: "Personnalité",
    shortName: "Perso",
    primaryColor: "#1A1A1A",
    secondaryColor: "#2D2D2D",
    gradient: "linear-gradient(135deg, #1A1A1A 0%, #2D2D2D 40%, #0F0F0F 100%)",
    cardGradient: "linear-gradient(145deg, #1A1A1A 0%, #252525 25%, #0F0F0F 60%, #000000 100%)",
    textColor: "#C6A664",
    network: "visa",
    accentColor: "#C6A664",
    description: "Preto premium Personnalité com dourado",
  },
  {
    id: "bradesco",
    name: "Bradesco",
    shortName: "Bradesco",
    primaryColor: "#CC092F",
    secondaryColor: "#A00724",
    gradient: "linear-gradient(135deg, #CC092F 0%, #E50A33 45%, #A00724 100%)",
    cardGradient: "linear-gradient(145deg, #CC092F 0%, #E30613 30%, #A00724 65%, #7A051C 100%)",
    textColor: "#FFFFFF",
    network: "visa",
    description: "Vermelho Bradesco",
  },
  {
    id: "bradesco-prime",
    name: "Prime",
    shortName: "Prime",
    primaryColor: "#0B0B0B",
    secondaryColor: "#1A1A1A",
    gradient: "linear-gradient(135deg, #0B0B0B 0%, #1A1A1A 40%, #000000 100%)",
    cardGradient: "linear-gradient(145deg, #0B0B0B 0%, #1F1F1F 25%, #000000 60%, #CC092F 95%)",
    textColor: "#D4AF37",
    network: "mastercard",
    accentColor: "#CC092F",
    description: "Preto Prime com detalhe vermelho",
  },
  {
    id: "santander",
    name: "Santander",
    shortName: "Santander",
    primaryColor: "#EC0000",
    secondaryColor: "#B50000",
    gradient: "linear-gradient(135deg, #EC0000 0%, #FF1A1A 45%, #B50000 100%)",
    cardGradient: "linear-gradient(145deg, #EC0000 0%, #FF2A2A 30%, #CC0000 65%, #900000 100%)",
    textColor: "#FFFFFF",
    network: "mastercard",
    description: "Vermelho Santander",
  },
  {
    id: "bb",
    name: "Banco do Brasil",
    shortName: "BB",
    primaryColor: "#003DA5",
    secondaryColor: "#002D7A",
    gradient: "linear-gradient(135deg, #003DA5 0%, #004FC4 40%, #00296B 100%)",
    cardGradient: "linear-gradient(145deg, #003DA5 0%, #0050D0 25%, #00296B 60%, #001A4D 85%, #FDEA00 95%)",
    textColor: "#FFFFFF",
    network: "visa",
    accentColor: "#FDEA00",
    description: "Azul BB com faixa amarela",
  },
  {
    id: "c6",
    name: "C6 Bank",
    shortName: "C6",
    primaryColor: "#1A1A1A",
    secondaryColor: "#000000",
    gradient: "linear-gradient(135deg, #1A1A1A 0%, #2A2A2A 40%, #000000 100%)",
    cardGradient: "linear-gradient(145deg, #1A1A1A 0%, #242424 30%, #000000 65%, #1A1A1A 100%)",
    textColor: "#FFFFFF",
    network: "mastercard",
    accentColor: "#F0F0F0",
    description: "Carbon C6 preto fosco",
  },
  {
    id: "caixa",
    name: "Caixa",
    shortName: "Caixa",
    primaryColor: "#005CA9",
    secondaryColor: "#003D73",
    gradient: "linear-gradient(135deg, #005CA9 0%, #0078D4 45%, #003D73 100%)",
    cardGradient: "linear-gradient(145deg, #005CA9 0%, #0070C0 30%, #003D73 65%, #00214D 100%)",
    textColor: "#FFFFFF",
    network: "visa",
    accentColor: "#FF8C00",
    description: "Azul Caixa com laranja",
  },
  {
    id: "picpay",
    name: "PicPay",
    shortName: "PicPay",
    primaryColor: "#21C25E",
    secondaryColor: "#148040",
    gradient: "linear-gradient(135deg, #21C25E 0%, #2ED46B 40%, #148040 100%)",
    cardGradient: "linear-gradient(145deg, #21C25E 0%, #25D46B 25%, #148040 60%, #0D5A2B 100%)",
    textColor: "#FFFFFF",
    network: "mastercard",
    description: "Verde PicPay",
  },
  {
    id: "xp",
    name: "XP",
    shortName: "XP",
    primaryColor: "#000000",
    secondaryColor: "#1A1A1A",
    gradient: "linear-gradient(135deg, #000000 0%, #1A1A1A 40%, #000000 100%)",
    cardGradient: "linear-gradient(145deg, #000000 0%, #0F0F0F 25%, #1A1A1A 50%, #000000 75%, #FDB913 95%)",
    textColor: "#FDB913",
    network: "visa",
    accentColor: "#FDB913",
    description: "Preto XP com dourado",
  },
];

const COLOR_TO_PRESET: Record<string, string> = {
  "#820ad1": "nubank",
  "#ff7a00": "inter",
  "#ec7000": "itau",
  "#cc092f": "bradesco",
  "#ec0000": "santander",
  "#003da5": "bb",
  "#005ca9": "caixa",
  "#21c25e": "picpay",
  "#000000": "xp",
  "#1a1a1a": "c6",
  "#003882": "bradesco",
};

const NAME_TO_PRESET: Record<string, string> = {
  "nubank": "nubank",
  "nu": "nubank",
  "inter": "inter",
  "banco inter": "inter",
  "itaú": "itau",
  "itau": "itau",
  "itaú unibanco": "itau",
  "itau unibanco": "itau",
  "personnalité": "itau-personnalite",
  "personnalite": "itau-personnalite",
  "bradesco": "bradesco",
  "prime": "bradesco-prime",
  "santander": "santander",
  "santander brasil": "santander",
  "banco do brasil": "bb",
  "bb": "bb",
  "c6": "c6",
  "c6 bank": "c6",
  "caixa": "caixa",
  "caixa econômica": "caixa",
  "caixa economica": "caixa",
  "caixa econômica federal": "caixa",
  "caixa economica federal": "caixa",
  "picpay": "picpay",
  "xp": "xp",
  "xp investimentos": "xp",
};

export function getBankPreset(id: string): BankPreset | undefined {
  const normalized = id.trim().toLowerCase();
  return BANK_PRESETS.find((p) => p.id === normalized || p.name.toLowerCase() === normalized || p.shortName.toLowerCase() === normalized);
}

export function getBankPresetByColor(color?: string): BankPreset | undefined {
  if (!color) return undefined;
  const hex = color.trim().toLowerCase();
  const presetId = COLOR_TO_PRESET[hex];
  if (presetId) return BANK_PRESETS.find((p) => p.id === presetId);
  // Fallback: find by primaryColor exact match
  return BANK_PRESETS.find((p) => p.primaryColor.toLowerCase() === hex);
}

export function getBankPresetByName(name?: string): BankPreset | undefined {
  if (!name) return undefined;
  const normalized = name.trim().toLowerCase();
  // Direct id match
  const direct = BANK_PRESETS.find((p) => p.id === normalized);
  if (direct) return direct;
  // Name map
  const mappedId = NAME_TO_PRESET[normalized];
  if (mappedId) return BANK_PRESETS.find((p) => p.id === mappedId);
  // Partial contains
  for (const [key, presetId] of Object.entries(NAME_TO_PRESET)) {
    if (normalized.includes(key)) {
      const found = BANK_PRESETS.find((p) => p.id === presetId);
      if (found) return found;
    }
  }
  // Fallback substring on preset names
  return BANK_PRESETS.find((p) => p.name.toLowerCase().includes(normalized) || normalized.includes(p.name.toLowerCase()) || p.shortName.toLowerCase() === normalized);
}

export function resolveBankPreset(input: { name?: string; color?: string; id?: string }): BankPreset {
  if (input.id) {
    const byId = getBankPreset(input.id);
    if (byId) return byId;
  }
  if (input.name) {
    const byName = getBankPresetByName(input.name);
    if (byName) return byName;
  }
  if (input.color) {
    const byColor = getBankPresetByColor(input.color);
    if (byColor) return byColor;
  }
  // Fallback to generic: try name first, then color, else default to nubank style generic
  return BANK_PRESETS.find((p) => p.id === "nubank")!;
}

export function formatMaskedNumber(lastDigits?: string): string {
  const suffix = lastDigits ? lastDigits.slice(-4).padStart(4, "0") : "••••";
  // If we have real last digits, show masked groups
  if (lastDigits && /^\d{4}$/.test(lastDigits)) {
    return `•••• •••• •••• ${lastDigits}`;
  }
  return `•••• •••• •••• ${suffix}`;
}
