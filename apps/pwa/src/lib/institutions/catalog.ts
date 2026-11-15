import {
  BANK_PRESETS,
  getBankPresetByColor,
  getBankPresetByName,
  type BankPreset,
  resolveBankPreset,
} from "@/lib/bank-presets";

export type InstitutionCategory =
  | "bank"
  | "fintech"
  | "cooperative"
  | "wallet"
  | "gateway"
  | "acquirer"
  | "broker"
  | "global-account";

export interface Institution {
  id: string;
  name: string;
  shortName: string;
  aliases: string[];
  category: InstitutionCategory;
  country: "BR" | "US" | "EU" | "GB" | "other";
  colors: { primary: string; secondary?: string };
  logoSrc?: string;
  popular?: boolean;
}

const NEW_INSTITUTION_MONOGRAM_COLORS = {
  asaas: "#1F4E79",
  "pagar-me": "#7A2E5D",
  efi: "#2F5D3A",
  iugu: "#6B3FA0",
  cielo: "#8A4B1F",
  rede: "#245A63",
  getnet: "#7A1F2B",
  infinitepay: "#3D4A6B",
  recargapay: "#533D2D",
  "99pay": "#42504C",
} as const;

export const INSTITUTIONS: Institution[] = [
  {
    id: "itau",
    name: "Itaú Unibanco",
    shortName: "Itaú",
    aliases: ["itau", "itaú", "itau-unibanco"],
    category: "bank",
    country: "BR",
    colors: { primary: "#EC7000" },
    popular: true,
  },
  {
    id: "bradesco",
    name: "Bradesco",
    shortName: "Bradesco",
    aliases: ["bradesco"],
    category: "bank",
    country: "BR",
    colors: { primary: "#CC092F" },
    popular: true,
  },
  {
    id: "santander",
    name: "Santander Brasil",
    shortName: "Santander",
    aliases: ["santander"],
    category: "bank",
    country: "BR",
    colors: { primary: "#EC0000" },
    popular: true,
  },
  {
    id: "banco-do-brasil",
    name: "Banco do Brasil",
    shortName: "Banco do Brasil",
    aliases: ["banco-do-brasil", "banco do brasil", "bb"],
    category: "bank",
    country: "BR",
    colors: { primary: "#003DA5" },
    popular: true,
  },
  {
    id: "caixa",
    name: "Caixa Econômica Federal",
    shortName: "Caixa",
    aliases: ["caixa", "caixa-economica", "caixa econômica"],
    category: "bank",
    country: "BR",
    colors: { primary: "#005CA9" },
    popular: true,
  },
  {
    id: "c6-bank",
    name: "C6 Bank",
    shortName: "C6",
    aliases: ["c6", "c6-bank", "c6 bank"],
    category: "bank",
    country: "BR",
    colors: { primary: "#1A1A1A" },
    popular: true,
  },
  {
    id: "inter",
    name: "Banco Inter",
    shortName: "Inter",
    aliases: ["inter", "banco-inter", "banco inter"],
    category: "bank",
    country: "BR",
    colors: { primary: "#FF7A00" },
    popular: true,
  },
  {
    id: "nubank",
    name: "Nubank",
    shortName: "Nu",
    aliases: ["nubank", "nu"],
    category: "fintech",
    country: "BR",
    colors: { primary: "#820AD1" },
    logoSrc: "/brands/institutions/nubank.svg",
    popular: true,
  },
  {
    id: "picpay",
    name: "PicPay",
    shortName: "PicPay",
    aliases: ["picpay", "pic pay"],
    category: "wallet",
    country: "BR",
    colors: { primary: "#21C25E" },
    logoSrc: "/brands/institutions/picpay.svg",
    popular: true,
  },
  {
    id: "xp",
    name: "XP Investimentos",
    shortName: "XP",
    aliases: ["xp", "xp-investimentos", "xp investimentos"],
    category: "broker",
    country: "BR",
    colors: { primary: "#000000" },
    popular: true,
  },
  {
    id: "mercado-pago",
    name: "Mercado Pago",
    shortName: "Mercado Pago",
    aliases: ["mercado-pago", "mercado pago", "mercadopago"],
    category: "wallet",
    country: "BR",
    colors: { primary: "#009EE3" },
    logoSrc: "/brands/institutions/mercado-pago.svg",
    popular: true,
  },
  {
    id: "pagbank",
    name: "PagBank",
    shortName: "PagBank",
    aliases: ["pagbank", "pag bank"],
    category: "gateway",
    country: "BR",
    colors: { primary: "#00A859" },
    popular: true,
  },
  {
    id: "pagseguro",
    name: "PagSeguro",
    shortName: "PagSeguro",
    aliases: ["pagseguro", "pag seguro"],
    category: "acquirer",
    country: "BR",
    colors: { primary: "#00A859" },
    logoSrc: "/brands/institutions/pagseguro.svg",
  },
  {
    id: "stone",
    name: "Stone",
    shortName: "Stone",
    aliases: ["stone"],
    category: "acquirer",
    country: "BR",
    colors: { primary: "#00A868" },
    popular: true,
  },
  {
    id: "wise",
    name: "Wise",
    shortName: "Wise",
    aliases: ["wise"],
    category: "global-account",
    country: "GB",
    colors: { primary: "#9FE870" },
    logoSrc: "/brands/institutions/wise.svg",
    popular: true,
  },
  {
    id: "revolut",
    name: "Revolut",
    shortName: "Revolut",
    aliases: ["revolut"],
    category: "global-account",
    country: "GB",
    colors: { primary: "#0075EB" },
    logoSrc: "/brands/institutions/revolut.svg",
    popular: true,
  },
  {
    id: "n26",
    name: "N26",
    shortName: "N26",
    aliases: ["n26"],
    category: "global-account",
    country: "EU",
    colors: { primary: "#36A18B" },
    logoSrc: "/brands/institutions/n26.svg",
    popular: true,
  },
  {
    id: "nomad",
    name: "Nomad",
    shortName: "Nomad",
    aliases: ["nomad"],
    category: "global-account",
    country: "US",
    colors: { primary: "#232323" },
    logoSrc: "/brands/institutions/nomad.svg",
    popular: true,
  },
  {
    id: "sicoob",
    name: "Sicoob",
    shortName: "Sicoob",
    aliases: ["sicoob"],
    category: "cooperative",
    country: "BR",
    colors: { primary: "#006B42" },
    popular: true,
  },
  {
    id: "sicredi",
    name: "Sicredi",
    shortName: "Sicredi",
    aliases: ["sicredi"],
    category: "cooperative",
    country: "BR",
    colors: { primary: "#3F7E44" },
    popular: true,
  },
  {
    id: "safra",
    name: "Banco Safra",
    shortName: "Safra",
    aliases: ["safra", "banco-safra"],
    category: "bank",
    country: "BR",
    colors: { primary: "#7A1538" },
  },
  {
    id: "original",
    name: "Banco Original",
    shortName: "Original",
    aliases: ["original", "banco-original"],
    category: "bank",
    country: "BR",
    colors: { primary: "#00A88F" },
  },
  {
    id: "neon",
    name: "Neon",
    shortName: "Neon",
    aliases: ["neon"],
    category: "fintech",
    country: "BR",
    colors: { primary: "#00C8B3" },
  },
  {
    id: "next",
    name: "Next",
    shortName: "Next",
    aliases: ["next"],
    category: "fintech",
    country: "BR",
    colors: { primary: "#00A4E4" },
  },
  {
    id: "iti",
    name: "iti Itaú",
    shortName: "iti",
    aliases: ["iti"],
    category: "wallet",
    country: "BR",
    colors: { primary: "#FF6B00" },
  },
  {
    id: "agibank",
    name: "Agibank",
    shortName: "Agibank",
    aliases: ["agibank", "agi bank"],
    category: "bank",
    country: "BR",
    colors: { primary: "#00A8A8" },
  },
  {
    id: "will-bank",
    name: "will bank",
    shortName: "will",
    aliases: ["will-bank", "will bank", "willbank"],
    category: "fintech",
    country: "BR",
    colors: { primary: "#FF5A5F" },
  },
  {
    id: "porto-seguro",
    name: "Porto Bank",
    shortName: "Porto",
    aliases: ["porto-seguro", "porto seguro", "porto-bank"],
    category: "bank",
    country: "BR",
    colors: { primary: "#00A3E0" },
  },
  {
    id: "btg-pactual",
    name: "BTG Pactual",
    shortName: "BTG",
    aliases: ["btg-pactual", "btg pactual", "btg"],
    category: "bank",
    country: "BR",
    colors: { primary: "#F58220" },
  },
  {
    id: "banrisul",
    name: "Banrisul",
    shortName: "Banrisul",
    aliases: ["banrisul"],
    category: "bank",
    country: "BR",
    colors: { primary: "#0072BC" },
  },
  {
    id: "brb",
    name: "BRB",
    shortName: "BRB",
    aliases: ["brb"],
    category: "bank",
    country: "BR",
    colors: { primary: "#009B77" },
  },
  {
    id: "avenue",
    name: "Avenue",
    shortName: "Avenue",
    aliases: ["avenue"],
    category: "broker",
    country: "US",
    colors: { primary: "#162A4A" },
  },
  {
    id: "banco-pan",
    name: "Banco PAN",
    shortName: "PAN",
    aliases: ["banco-pan", "banco pan", "pan"],
    category: "bank",
    country: "BR",
    colors: { primary: "#F39200" },
  },
  {
    id: "mercado-bitcoin",
    name: "Mercado Bitcoin",
    shortName: "MB",
    aliases: ["mercado-bitcoin", "mercado bitcoin"],
    category: "broker",
    country: "BR",
    colors: { primary: "#F5A623" },
  },
  {
    id: "cooperforte",
    name: "Cooperforte",
    shortName: "Cooperforte",
    aliases: ["cooperforte"],
    category: "cooperative",
    country: "BR",
    colors: { primary: "#087E54" },
  },
  {
    id: "paypal",
    name: "PayPal",
    shortName: "PayPal",
    aliases: ["paypal"],
    category: "wallet",
    country: "US",
    colors: { primary: "#1F2A27" }, // neutro: logo CC0 disponível
    logoSrc: "/brands/institutions/paypal.svg",
  },
  {
    id: "stripe",
    name: "Stripe",
    shortName: "Stripe",
    aliases: ["stripe"],
    category: "gateway",
    country: "US",
    colors: { primary: "#1F2A27" }, // neutro: logo CC0 disponível
    logoSrc: "/brands/institutions/stripe.svg",
  },
  {
    id: "asaas",
    name: "Asaas",
    shortName: "Asaas",
    aliases: ["asaas"],
    category: "gateway",
    country: "BR",
    colors: { primary: NEW_INSTITUTION_MONOGRAM_COLORS["asaas"] }, // cor de monograma própria (não oficial)
  },
  {
    id: "pagar-me",
    name: "Pagar.me",
    shortName: "Pagar.me",
    aliases: ["pagar me", "pagarme", "pagar.me"],
    category: "gateway",
    country: "BR",
    colors: { primary: NEW_INSTITUTION_MONOGRAM_COLORS["pagar-me"] }, // cor de monograma própria (não oficial)
  },
  {
    id: "efi",
    name: "Efí",
    shortName: "Efí",
    aliases: ["efi", "gerencianet"],
    category: "gateway",
    country: "BR",
    colors: { primary: NEW_INSTITUTION_MONOGRAM_COLORS["efi"] }, // cor de monograma própria (não oficial)
  },
  {
    id: "iugu",
    name: "Iugu",
    shortName: "Iugu",
    aliases: ["iugu"],
    category: "gateway",
    country: "BR",
    colors: { primary: NEW_INSTITUTION_MONOGRAM_COLORS["iugu"] }, // cor de monograma própria (não oficial)
  },
  {
    id: "cielo",
    name: "Cielo",
    shortName: "Cielo",
    aliases: ["cielo"],
    category: "acquirer",
    country: "BR",
    colors: { primary: NEW_INSTITUTION_MONOGRAM_COLORS["cielo"] }, // cor de monograma própria (não oficial)
  },
  {
    id: "rede",
    name: "Rede",
    shortName: "Rede",
    aliases: ["rede", "userede"],
    category: "acquirer",
    country: "BR",
    colors: { primary: NEW_INSTITUTION_MONOGRAM_COLORS["rede"] }, // cor de monograma própria (não oficial)
  },
  {
    id: "getnet",
    name: "Getnet",
    shortName: "Getnet",
    aliases: ["getnet", "get net"],
    category: "acquirer",
    country: "BR",
    colors: { primary: NEW_INSTITUTION_MONOGRAM_COLORS["getnet"] }, // cor de monograma própria (não oficial)
  },
  {
    id: "sumup",
    name: "SumUp",
    shortName: "SumUp",
    aliases: ["sumup", "sum up"],
    category: "acquirer",
    country: "BR",
    colors: { primary: "#1F2A27" }, // neutro: logo CC0 disponível
    logoSrc: "/brands/institutions/sumup.svg",
  },
  {
    id: "infinitepay",
    name: "InfinitePay",
    shortName: "InfinitePay",
    aliases: ["infinite", "infinitepay", "cloudwalk"],
    category: "acquirer",
    country: "BR",
    colors: { primary: NEW_INSTITUTION_MONOGRAM_COLORS["infinitepay"] }, // cor de monograma própria (não oficial)
  },
  {
    id: "recargapay",
    name: "RecargaPay",
    shortName: "RecargaPay",
    aliases: ["recarga pay", "recargapay"],
    category: "wallet",
    country: "BR",
    colors: { primary: NEW_INSTITUTION_MONOGRAM_COLORS["recargapay"] }, // cor de monograma própria (não oficial)
  },
  {
    id: "99pay",
    name: "99Pay",
    shortName: "99Pay",
    aliases: ["99 pay", "99pay"],
    category: "wallet",
    country: "BR",
    colors: { primary: NEW_INSTITUTION_MONOGRAM_COLORS["99pay"] }, // cor de monograma própria (não oficial)
  },
];

const byId = new Map(INSTITUTIONS.map((institution) => [institution.id, institution]));

export function normalize(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR").trim();
}

export function getInstitution(id: string): Institution | undefined {
  return byId.get(normalize(id));
}

export function searchInstitutions(query: string, limit = 20): Institution[] {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) {
    return [...INSTITUTIONS]
      .sort((a, b) => Number(!!b.popular) - Number(!!a.popular) || a.name.localeCompare(b.name, "pt-BR"))
      .slice(0, limit);
  }

  return INSTITUTIONS.map((institution, index) => {
    const fields = [institution.name, institution.shortName, ...institution.aliases].map(normalize);
    return { institution, index, fields };
  })
    .filter(({ fields }) => fields.some((field) => field.includes(normalizedQuery)))
    .sort((a, b) => {
      const score = (entry: typeof a) =>
        Number(!!entry.institution.popular) * 100 +
        Number(entry.fields.some((field) => field === normalizedQuery)) * 30 +
        Number(entry.fields.some((field) => field.startsWith(normalizedQuery))) * 10;
      return score(b) - score(a) || a.index - b.index;
    })
    .slice(0, limit)
    .map(({ institution }) => institution);
}

export function institutionFromPresetId(presetId: string): Institution | undefined {
  const legacyIds: Record<string, string> = {
    bb: "banco-do-brasil",
    c6: "c6-bank",
    "itau-personnalite": "itau",
    "bradesco-prime": "bradesco",
  };
  return getInstitution(legacyIds[presetId] ?? presetId);
}

export function presetFromInstitution(id: string): BankPreset | undefined {
  const legacyIds: Record<string, string> = {
    "banco-do-brasil": "bb",
    "c6-bank": "c6",
    pagbank: "pagseguro",
    pagseguro: "pagseguro",
  };
  const target = legacyIds[id] ?? id;
  return BANK_PRESETS.find((preset) => preset.id === target);
}

export function resolveInstitution(input: { id?: string; name?: string; color?: string }): Institution | undefined {
  if (input.id) {
    const direct = getInstitution(input.id);
    if (direct) return direct;
  }
  if (input.name) {
    const name = normalize(input.name);
    const exact = INSTITUTIONS.find((institution) =>
      [institution.name, institution.shortName, ...institution.aliases].some((field) => normalize(field) === name),
    );
    if (exact) return exact;
  }
  const presetByName = input.name ? getBankPresetByName(input.name) : undefined;
  const presetByColor = input.color ? getBankPresetByColor(input.color) : undefined;
  if (!presetByName && !presetByColor) return undefined;
  const preset = resolveBankPreset({ name: input.name, color: input.color });
  return institutionFromPresetId(preset.id);
}
