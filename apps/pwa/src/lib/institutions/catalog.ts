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
  logoFit?: "cover" | "contain";
  logoBg?: string;
  popular?: boolean;
}

const NEW_INSTITUTION_MONOGRAM_COLORS = {
  "pagar-me": "#14532D",
  rede: "#B83A08",
  "99pay": "#42504C",
} as const;

export const INSTITUTIONS: Institution[] = [
  {
    id: "itau",
    name: "Itaú",
    shortName: "Itaú",
    aliases: ["itau", "itaú", "itau-unibanco", "itaú unibanco", "itau unibanco"],
    category: "bank",
    country: "BR",
    colors: { primary: "#EC7000" },
    logoSrc: "/brands/institutions/itau.svg",
    logoFit: "contain",
    logoBg: "#EC7000",
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
    logoSrc: "/brands/institutions/bradesco.svg",
    logoFit: "contain",
    logoBg: "#FFFFFF",
    popular: true,
  },
  {
    id: "santander",
    name: "Santander",
    shortName: "Santander",
    aliases: ["santander", "santander-brasil", "santander brasil"],
    category: "bank",
    country: "BR",
    colors: { primary: "#EC0000" },
    logoSrc: "/brands/institutions/santander.svg",
    logoFit: "cover",
    logoBg: "#FFFFFF",
    popular: true,
  },
  {
    id: "banco-do-brasil",
    name: "Banco do Brasil",
    shortName: "BB",
    aliases: ["banco-do-brasil", "banco do brasil", "bb"],
    category: "bank",
    country: "BR",
    colors: { primary: "#003DA5", secondary: "#FCFC30" },
    logoSrc: "/brands/institutions/banco-do-brasil.svg",
    logoFit: "cover",
    logoBg: "#FCFC30",
    popular: true,
  },
  {
    id: "caixa",
    name: "Caixa",
    shortName: "Caixa",
    aliases: ["caixa", "caixa-economica", "caixa econômica", "caixa economica federal", "caixa econômica federal", "cef"],
    category: "bank",
    country: "BR",
    colors: { primary: "#005CA9", secondary: "#F39200" },
    logoSrc: "/brands/institutions/caixa.svg",
    logoFit: "cover",
    logoBg: "#005CA9",
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
    logoSrc: "/brands/institutions/c6-bank.svg",
    logoFit: "contain",
    logoBg: "#FFFFFF",
    popular: true,
  },
  {
    id: "inter",
    name: "Inter",
    shortName: "Inter",
    aliases: ["inter", "banco-inter", "banco inter"],
    category: "bank",
    country: "BR",
    colors: { primary: "#FF7A00" },
    logoSrc: "/brands/institutions/inter.svg",
    logoFit: "cover",
    logoBg: "#EA7100",
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
    name: "XP",
    shortName: "XP",
    aliases: ["xp", "xp-investimentos", "xp investimentos"],
    category: "broker",
    country: "BR",
    colors: { primary: "#000000", secondary: "#FDB913" },
    logoSrc: "/brands/institutions/xp.svg",
    logoFit: "contain",
    logoBg: "#000000",
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
    logoSrc: "/brands/institutions/pagbank.svg",
    logoFit: "contain",
    logoBg: "#FFFFFF",
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
    logoSrc: "/brands/institutions/stone.svg",
    logoFit: "cover",
    logoBg: "#FFFFFF",
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
    colors: { primary: "#003641", secondary: "#00AE9D" },
    logoSrc: "/brands/institutions/sicoob.svg",
    logoFit: "contain",
    logoBg: "#FFFFFF",
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
    logoSrc: "/brands/institutions/sicredi.svg",
    logoFit: "cover",
    logoBg: "#FFFFFF",
    popular: true,
  },
  {
    id: "safra",
    name: "Safra",
    shortName: "Safra",
    aliases: ["safra", "banco-safra", "banco safra"],
    category: "bank",
    country: "BR",
    colors: { primary: "#1B2E4B" },
    logoSrc: "/brands/institutions/safra.svg",
    logoFit: "cover",
    logoBg: "#FFFFFF",
  },
  {
    id: "original",
    name: "Original",
    shortName: "Original",
    aliases: ["original", "banco-original", "banco original"],
    category: "bank",
    country: "BR",
    colors: { primary: "#00A859" },
    logoSrc: "/brands/institutions/original.svg",
    logoFit: "contain",
    logoBg: "#FFFFFF",
  },
  {
    id: "neon",
    name: "Neon",
    shortName: "Neon",
    aliases: ["neon", "banco neon"],
    category: "fintech",
    country: "BR",
    colors: { primary: "#00A5F0" },
    logoSrc: "/brands/institutions/neon.svg",
    logoFit: "cover",
    logoBg: "#00A5F0",
    popular: true,
  },
  {
    id: "next",
    name: "Next",
    shortName: "Next",
    aliases: ["next", "banco next"],
    category: "fintech",
    country: "BR",
    colors: { primary: "#00703C" },
    popular: true,
  },
  {
    id: "iti",
    name: "iti",
    shortName: "iti",
    aliases: ["iti", "iti itau", "iti itaú", "itau iti"],
    category: "wallet",
    country: "BR",
    colors: { primary: "#C2185B", secondary: "#FF6B00" },
  },
  {
    id: "agibank",
    name: "Agibank",
    shortName: "Agibank",
    aliases: ["agibank", "agi bank"],
    category: "bank",
    country: "BR",
    colors: { primary: "#0066CC" },
    logoSrc: "/brands/institutions/agibank.svg",
    logoFit: "contain",
    logoBg: "#FFFFFF",
  },
  {
    id: "will-bank",
    name: "Will Bank",
    shortName: "Will",
    aliases: ["will-bank", "will bank", "willbank", "will"],
    category: "fintech",
    country: "BR",
    colors: { primary: "#1F1F1F", secondary: "#FFD400" },
    popular: true,
  },
  {
    id: "porto-seguro",
    name: "Porto Bank",
    shortName: "Porto",
    aliases: ["porto-seguro", "porto seguro", "porto-bank", "porto bank", "porto"],
    category: "bank",
    country: "BR",
    colors: { primary: "#0046C0" },
    popular: true,
  },
  {
    id: "btg-pactual",
    name: "BTG Pactual",
    shortName: "BTG",
    aliases: ["btg-pactual", "btg pactual", "btg"],
    category: "bank",
    country: "BR",
    colors: { primary: "#195AB4" },
    logoSrc: "/brands/institutions/btg-pactual.svg",
    logoFit: "cover",
    logoBg: "#195AB4",
    popular: true,
  },
  {
    id: "banrisul",
    name: "Banrisul",
    shortName: "Banrisul",
    aliases: ["banrisul"],
    category: "bank",
    country: "BR",
    colors: { primary: "#0072BC" },
    logoSrc: "/brands/institutions/banrisul.svg",
    logoFit: "contain",
    logoBg: "#FFFFFF",
  },
  {
    id: "brb",
    name: "BRB",
    shortName: "BRB",
    aliases: ["brb"],
    category: "bank",
    country: "BR",
    colors: { primary: "#0055A4" },
    logoSrc: "/brands/institutions/brb.svg",
    logoFit: "contain",
    logoBg: "#FFFFFF",
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
    colors: { primary: "#00BCE7" },
    logoSrc: "/brands/institutions/banco-pan.svg",
    logoFit: "cover",
    logoBg: "#00BCE7",
    popular: true,
  },
  {
    id: "mercado-bitcoin",
    name: "Mercado Bitcoin",
    shortName: "MB",
    aliases: ["mercado-bitcoin", "mercado bitcoin"],
    category: "broker",
    country: "BR",
    colors: { primary: "#E85D04" },
    logoSrc: "/brands/institutions/mercado-bitcoin.svg",
    logoFit: "contain",
    logoBg: "#FFFFFF",
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
    colors: { primary: "#0030B9" },
    logoSrc: "/brands/institutions/asaas.svg",
    logoFit: "cover",
    logoBg: "#0030B9",
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
    aliases: ["efi", "efí", "efi bank", "efí bank", "gerencianet"],
    category: "gateway",
    country: "BR",
    colors: { primary: "#F37021" },
    logoSrc: "/brands/institutions/efi.svg",
    logoFit: "contain",
    logoBg: "#FFFFFF",
  },
  {
    id: "iugu",
    name: "Iugu",
    shortName: "Iugu",
    aliases: ["iugu"],
    category: "gateway",
    country: "BR",
    colors: { primary: "#1D4ED8" },
    logoSrc: "/brands/institutions/iugu.svg",
    logoFit: "contain",
    logoBg: "#FFFFFF",
  },
  {
    id: "cielo",
    name: "Cielo",
    shortName: "Cielo",
    aliases: ["cielo"],
    category: "acquirer",
    country: "BR",
    colors: { primary: "#0073E6" },
    logoSrc: "/brands/institutions/cielo.svg",
    logoFit: "contain",
    logoBg: "#FFFFFF",
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
    colors: { primary: "#CC092F" },
    logoSrc: "/brands/institutions/getnet.svg",
    logoFit: "cover",
    logoBg: "#FFFFFF",
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
    colors: { primary: "#1A1A1A" },
    logoSrc: "/brands/institutions/infinitepay.svg",
    logoFit: "contain",
    logoBg: "#FFFFFF",
  },
  {
    id: "recargapay",
    name: "RecargaPay",
    shortName: "RecargaPay",
    aliases: ["recarga pay", "recargapay"],
    category: "wallet",
    country: "BR",
    colors: { primary: "#005CB9" },
    logoSrc: "/brands/institutions/recargapay.svg",
    logoFit: "contain",
    logoBg: "#FFFFFF",
    popular: true,
  },
  {
    id: "99pay",
    name: "99Pay",
    shortName: "99Pay",
    aliases: ["99 pay", "99pay"],
    category: "wallet",
    country: "BR",
    colors: { primary: NEW_INSTITUTION_MONOGRAM_COLORS["99pay"] }, // cor de monograma própria (não oficial)
    popular: true,
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
