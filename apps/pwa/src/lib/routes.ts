/**
 * Canonical IA routes (item 13) — single source of truth for in-app
 * navigation and next.config.ts redirects.
 *
 * BottomNav: Início (/) · Extrato (/registros) · [+] FAB · Compromissos
 * (/compromissos) · Hub (/hub). Absorbed pages live as tabs under
 * /compromissos and /hub/* and keep working through temporary redirects,
 * so no deep link 404s.
 *
 * Pure string helpers (no React) so next.config.ts can import this module.
 */

export const COMPROMISSOS_ABAS = ["a-pagar"] as const;
export type CompromissosAba = (typeof COMPROMISSOS_ABAS)[number];

export const PATRIMONIO_ABAS = ["contas", "cartoes", "patrimonio"] as const;
export type PatrimonioAba = (typeof PATRIMONIO_ABAS)[number];

export const PLANEJAMENTO_ABAS = ["orcamentos", "metas", "assinaturas"] as const;
export type PlanejamentoAba = (typeof PLANEJAMENTO_ABAS)[number];

export const ALERTAS_ABAS = ["financeiras", "preco"] as const;
export type AlertasAba = (typeof ALERTAS_ABAS)[number];

export function routeCompromissos(aba: CompromissosAba = "a-pagar"): string {
  return `/compromissos?aba=${aba}`;
}

export function routePatrimonio(
  aba: PatrimonioAba = "contas",
  params?: { accountId?: string; cardId?: string },
): string {
  const qs = new URLSearchParams({ aba });
  if (params?.accountId) qs.set("accountId", params.accountId);
  if (params?.cardId) qs.set("cardId", params.cardId);
  return `/hub/patrimonio?${qs.toString()}`;
}

export function routePlanejamento(aba: PlanejamentoAba = "orcamentos"): string {
  return `/hub/planejamento?aba=${aba}`;
}

export function routeAlertas(aba: AlertasAba = "financeiras"): string {
  return `/hub/alertas?aba=${aba}`;
}

export interface CanonicalRedirect {
  source: string;
  destination: string;
}

/**
 * Legacy page routes → canonical routes (temporary redirects, query
 * preserved and merged by Next.js). API routes (/pendentes, /pwa-control)
 * and kept real pages (/perfil, /workspaces, /audit, /convite) are
 * intentionally absent.
 */
export const CANONICAL_REDIRECTS: CanonicalRedirect[] = [
  { source: "/a-pagar", destination: "/compromissos?aba=a-pagar" },
  { source: "/pending", destination: "/compromissos?aba=a-pagar" },
  { source: "/contas", destination: "/hub/patrimonio?aba=contas" },
  { source: "/cartoes", destination: "/hub/patrimonio?aba=cartoes" },
  { source: "/patrimonio", destination: "/hub/patrimonio?aba=patrimonio" },
  { source: "/orcamentos", destination: "/hub/planejamento?aba=orcamentos" },
  { source: "/metas", destination: "/hub/planejamento?aba=metas" },
  { source: "/assinaturas", destination: "/hub/planejamento?aba=assinaturas" },
  { source: "/relatorios", destination: "/hub/relatorios" },
  { source: "/alerts", destination: "/hub/alertas?aba=financeiras" },
  { source: "/alerts/price", destination: "/hub/alertas?aba=preco" },
  { source: "/categorias", destination: "/hub/categorias" },
];
