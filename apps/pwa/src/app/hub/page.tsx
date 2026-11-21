import AppShell from "@/components/AppShell";
import PageHeader from "@/components/PageHeader";
import StatusBar from "@/components/StatusBar";
import Link from "next/link";
import type { ComponentType } from "react";
import {
  BarChart3,
  Bell,
  Calculator,
  CalendarClock,
  ChevronRight,
  ClipboardList,
  CreditCard,
  Flag,
  FolderOpen,
  Landmark,
  Layers,
  Settings,
  TrendingUp,
  User,
  type LucideProps,
} from "lucide-react";

interface HubModule {
  href: string;
  label: string;
  description: string;
  Icon: ComponentType<LucideProps>;
}

const MODULES: HubModule[] = [
  { href: "/compromissos", label: "Compromissos", description: "Contas a pagar e pendências", Icon: CalendarClock },
  { href: "/hub/patrimonio?aba=contas", label: "Contas", description: "Suas contas em um lugar", Icon: Landmark },
  { href: "/hub/patrimonio?aba=cartoes", label: "Cartões", description: "Seus cartões", Icon: CreditCard },
  { href: "/hub/planejamento", label: "Planejamento", description: "Orçamentos e assinaturas", Icon: Calculator },
  { href: "/hub/planejamento?aba=metas", label: "Metas", description: "Acompanhe seus objetivos", Icon: Flag },
  { href: "/hub/patrimonio?aba=patrimonio", label: "Patrimônio", description: "Visão do seu patrimônio", Icon: TrendingUp },
  { href: "/hub/relatorios", label: "Relatórios", description: "Fluxo, categorias e tendências", Icon: BarChart3 },
  { href: "/hub/alertas", label: "Avisos e Lembretes", description: "Alertas financeiros e de preço", Icon: Bell },
  { href: "/hub/categorias", label: "Categorias", description: "Organize seus lançamentos", Icon: FolderOpen },
  { href: "/hub/configuracoes", label: "Configurações", description: "Perfil, espaços e auditoria", Icon: Settings },
  { href: "/workspaces", label: "Meus Espaços", description: "Gerencie seus espaços", Icon: Layers },
  { href: "/perfil", label: "Perfil", description: "Seus dados e preferências", Icon: User },
  { href: "/audit", label: "Auditoria", description: "Histórico de atividades", Icon: ClipboardList },
];

/**
 * /hub — canonical module grid replacing the "Mais" drawer (item 13).
 */
export default function Hub() {
  return (
    <AppShell>
      <div className="flex min-h-dvh flex-col bg-bg pb-[calc(9rem+env(safe-area-inset-bottom))] lg:pb-8">
        <StatusBar />
        <PageHeader title="Explorar" subtitle="Tudo o que você precisa no Meu Ted em um só lugar." />
        <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col px-5 pb-4 pt-2 sm:px-8 lg:px-12">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            {MODULES.map((module) => (
              <Link
                key={module.href}
                href={module.href}
                className="flex flex-col gap-3 rounded-[20px] border border-border-subtle bg-surface-1 p-4 shadow-card transition-all hover:border-border-medium active:scale-[0.98]"
              >
                <span className="flex h-11 w-11 items-center justify-center rounded-[13px] bg-primary-tint text-primary">
                  <module.Icon size={21} strokeWidth={1.9} />
                </span>
                <span className="flex items-center justify-between gap-2">
                  <span className="min-w-0">
                    <span className="block truncate text-[14px] font-extrabold text-text-primary">
                      {module.label}
                    </span>
                    <span className="block truncate text-[11px] font-medium text-text-muted">
                      {module.description}
                    </span>
                  </span>
                  <ChevronRight size={16} className="flex-none text-text-muted" />
                </span>
              </Link>
            ))}
          </div>
        </main>
      </div>
    </AppShell>
  );
}
