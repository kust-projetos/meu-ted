import AppShell from "@/components/AppShell";
import PageHeader from "@/components/PageHeader";
import StatusBar from "@/components/StatusBar";
import Link from "next/link";
import type { ComponentType } from "react";
import {
  BarChart3,
  Bell,
  ChevronRight,
  FolderOpen,
  Settings,
  Target,
  Wallet,
  Layers,
  User,
  ClipboardList,
  CalendarClock,
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
  { href: "/hub/patrimonio?aba=contas", label: "Contas", description: "Suas contas em um lugar", Icon: Wallet },
  { href: "/hub/patrimonio?aba=cartoes", label: "Cartões", description: "Seus cartões", Icon: Wallet },
  { href: "/hub/planejamento", label: "Planejamento", description: "Orçamentos e assinaturas", Icon: Target },
  { href: "/hub/planejamento?aba=metas", label: "Metas", description: "Acompanhe seus objetivos", Icon: Target },
  { href: "/hub/patrimonio?aba=patrimonio", label: "Patrimônio", description: "Visão do seu patrimônio", Icon: Wallet },
  { href: "/hub/relatorios", label: "Relatórios", description: "Fluxo, categorias e tendências", Icon: BarChart3 },
  { href: "/hub/alertas", label: "Avisos e Lembretes", description: "Alertas financeiros e de preço", Icon: Bell },
  { href: "/hub/categorias", label: "Organizar Gastos", description: "Organize seus lançamentos", Icon: FolderOpen },
  { href: "/hub/configuracoes", label: "Configurações", description: "Perfil, espaços e auditoria", Icon: Settings },
  { href: "/workspaces", label: "Meus Espaços", description: "Gerencie seus espaços", Icon: Layers },
  { href: "/perfil", label: "Perfil", description: "Seus dados e preferências", Icon: User },
  { href: "/auditoria", label: "Auditoria", description: "Histórico de atividades", Icon: ClipboardList },
];

/**
 * /hub — canonical module grid replacing the "Mais" drawer (item 13).
 */
export default function Hub() {
  return (
    <AppShell>
      <div className="flex min-h-dvh flex-col bg-bg pb-[var(--tab-bar-height)]">
        <StatusBar />
        <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col px-5 py-4 sm:px-8 lg:px-12">
          <PageHeader title="Explorar" subtitle="Tudo o que você precisa no Meu Ted em um só lugar." />
          <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-3">
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
