import type { CardNetwork as PresetCardNetwork } from "@/lib/bank-presets";
import { getInstitution } from "./catalog";

export type CardNetwork = PresetCardNetwork | "unknown";

export interface CardProduct {
  id: string;
  institutionId: string;
  name: string;
  network: CardNetwork;
  material: "classic" | "metal" | "carbon" | "translucent" | "gradient";
  colors: { base: string; accent: string; text: string };
  artSource: "illustrative";
}

export const CARD_PRODUCTS: CardProduct[] = [
  {
    id: "nubank-roxinho",
    institutionId: "nubank",
    name: "Nubank",
    network: "mastercard",
    material: "gradient",
    colors: { base: "#542078", accent: "#B98BE0", text: "#fff" },
    artSource: "illustrative",
  },
  {
    id: "nubank-ultravioleta",
    institutionId: "nubank",
    name: "Ultravioleta",
    network: "mastercard",
    material: "metal",
    colors: { base: "#21152E", accent: "#D2B4F2", text: "#fff" },
    artSource: "illustrative",
  },
  {
    id: "itau-click",
    institutionId: "itau",
    name: "Itaú Click",
    network: "visa",
    material: "classic",
    colors: { base: "#EC7000", accent: "#FFC36A", text: "#fff" },
    artSource: "illustrative",
  },
  {
    id: "itau-personnalite",
    institutionId: "itau",
    name: "Personnalité",
    network: "visa",
    material: "metal",
    colors: { base: "#202020", accent: "#C6A664", text: "#fff" },
    artSource: "illustrative",
  },
  {
    id: "inter-gold",
    institutionId: "inter",
    name: "Inter Gold",
    network: "mastercard",
    material: "gradient",
    colors: { base: "#D95F00", accent: "#FFAA54", text: "#fff" },
    artSource: "illustrative",
  },
  {
    id: "c6-carbon",
    institutionId: "c6-bank",
    name: "C6 Carbon",
    network: "mastercard",
    material: "carbon",
    colors: { base: "#202124", accent: "#B7B7B7", text: "#fff" },
    artSource: "illustrative",
  },
  {
    id: "xp-visa",
    institutionId: "xp",
    name: "XP",
    network: "visa",
    material: "classic",
    colors: { base: "#151515", accent: "#FDB913", text: "#fff" },
    artSource: "illustrative",
  },
  {
    id: "picpay-card",
    institutionId: "picpay",
    name: "PicPay",
    network: "mastercard",
    material: "gradient",
    colors: { base: "#087D40", accent: "#5CE78D", text: "#fff" },
    artSource: "illustrative",
  },
  {
    id: "mercado-pago-card",
    institutionId: "mercado-pago",
    name: "Mercado Pago",
    network: "visa",
    material: "classic",
    colors: { base: "#007EB5", accent: "#75D0F4", text: "#fff" },
    artSource: "illustrative",
  },
  {
    id: "wise-card",
    institutionId: "wise",
    name: "Wise",
    network: "visa",
    material: "translucent",
    colors: { base: "#124B37", accent: "#9FE870", text: "#fff" },
    artSource: "illustrative",
  },
  {
    id: "santander-card",
    institutionId: "santander",
    name: "Santander",
    network: "mastercard",
    material: "classic",
    colors: { base: "#B80018", accent: "#FF6666", text: "#fff" },
    artSource: "illustrative",
  },
  {
    // Current product name/network: https://nubank.com.br/ultravioleta/cartao
    id: "nubank-ultravioleta-mastercard-black",
    institutionId: "nubank",
    name: "Nubank Ultravioleta",
    network: "mastercard",
    material: "metal",
    colors: { base: "#21152E", accent: "#D2B4F2", text: "#fff" },
    artSource: "illustrative",
  },
  {
    // Current product name/network: https://www.c6bank.com.br/cartao-c6-carbon-mastercard-black
    id: "c6-carbon-mastercard-black",
    institutionId: "c6-bank",
    name: "C6 Carbon Mastercard Black",
    network: "mastercard",
    material: "carbon",
    colors: { base: "#202124", accent: "#B7B7B7", text: "#fff" },
    artSource: "illustrative",
  },
  {
    // Current product name/network: https://www.itau.com.br/cartoes/escolha/
    id: "itau-azul-visa-infinite",
    institutionId: "itau",
    name: "Azul Itaú Visa Infinite",
    network: "visa",
    material: "classic",
    colors: { base: "#153B7A", accent: "#6AA7E8", text: "#fff" },
    artSource: "illustrative",
  },
  {
    // Current product name/network: https://www.itau.com.br/cartoes/escolha/
    id: "itau-latam-pass-mastercard-black",
    institutionId: "itau",
    name: "LATAM Pass Itaú Mastercard Black",
    network: "mastercard",
    material: "classic",
    colors: { base: "#202124", accent: "#B7B7B7", text: "#fff" },
    artSource: "illustrative",
  },
  {
    // Current product name/network: https://www.itau.com.br/cartoes/escolha/
    id: "itau-azul-visa-platinum",
    institutionId: "itau",
    name: "Azul Itaú Visa Platinum",
    network: "visa",
    material: "classic",
    colors: { base: "#373B45", accent: "#8992A5", text: "#fff" },
    artSource: "illustrative",
  },
];

export function getCardProduct(id: string): CardProduct | undefined {
  return CARD_PRODUCTS.find((product) => product.id === id);
}

export function cardProductsForInstitution(institutionId: string): CardProduct[] {
  return CARD_PRODUCTS.filter((product) => product.institutionId === institutionId);
}

export function resolveCardNetworkLabel(network: CardNetwork): string {
  return {
    visa: "Visa",
    mastercard: "Mastercard",
    elo: "Elo",
    amex: "American Express",
    hipercard: "Hipercard",
    unknown: "Bandeira",
  }[network];
}

export function isKnownCardProduct(id: string): boolean {
  const product = getCardProduct(id);
  return !!product && !!getInstitution(product.institutionId);
}

export function customCardProduct(input: {
  institutionId: string;
  name: string;
  network: CardNetwork;
}): CardProduct {
  return {
    id: "custom-product",
    institutionId: input.institutionId,
    name: input.name,
    network: input.network,
    material: "classic",
    colors: { base: "#373B45", accent: "#8992A5", text: "#fff" },
    artSource: "illustrative",
  };
}
