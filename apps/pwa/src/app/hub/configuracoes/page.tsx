import AppShell from "@/components/AppShell";
import PageHeader from "@/components/PageHeader";
import StatusBar from "@/components/StatusBar";
import Link from "next/link";
import type { ComponentType } from "react";
import {
  ChevronRight,
  Layers,
  Shield,
  User,
  type LucideProps,
} from "lucide-react";

interface ConfigEntry {
  href: string;
  label: string;
  description: string;
  Icon: ComponentType<LucideProps>;
}

const ENTRIES: ConfigEntry[] = [
  { href: "/perfil", label: "Perfil", description: "Seus dados e notificações", Icon: User },
  { href: "/workspaces", label: "Meus Espaços", description: "Seus espaços, membros e convites", Icon: Layers },
  { href: "/audit", label: "Auditoria", description: "Histórico de operações", Icon: Shield },
];

/**
 * /hub/configuracoes — canonical section absorbing /perfil, /workspaces and
 * /audit (item 13). The subpages stay real and keep their routes; this page
 * groups them. /convite remains a standalone token flow (no hub entry).
 */
export default function HubConfiguracoes() {
  return (
    <AppShell>
      <div className="flex min-h-dvh flex-col bg-bg pb-[calc(9rem+env(safe-area-inset-bottom))] lg:pb-8">
        <StatusBar />
        <PageHeader title="Configurações" subtitle="Conta, ambientes e auditoria." />
        <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col px-5 pb-4 pt-2 sm:px-8 lg:px-12">
          <div className="flex flex-col gap-2.5">
            {ENTRIES.map((entry) => (
              <Link
                key={entry.href}
                href={entry.href}
                className="flex items-center gap-3.5 rounded-[18px] border border-border-subtle bg-surface-1 px-4 py-3.5 shadow-card transition-all hover:border-border-medium active:scale-[0.99]"
              >
                <span className="flex h-10 w-10 flex-none items-center justify-center rounded-[12px] bg-primary-tint text-primary">
                  <entry.Icon size={19} strokeWidth={1.9} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-extrabold text-text-primary">
                    {entry.label}
                  </span>
                  <span className="block truncate text-[11px] font-medium text-text-muted">
                    {entry.description}
                  </span>
                </span>
                <ChevronRight size={16} className="flex-none text-text-muted" />
              </Link>
            ))}
          </div>
        </main>
      </div>
    </AppShell>
  );
}
