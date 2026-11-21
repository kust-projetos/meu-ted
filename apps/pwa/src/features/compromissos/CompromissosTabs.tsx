"use client";

import PayablesPage from "@/features/payables/PayablesPage";
import PendingOperationsPage from "@/features/pending-operations/PendingOperationsPage";
import PageHeader from "@/components/PageHeader";
import StatusBar from "@/components/StatusBar";
import { QueryTabs, useQueryTab } from "@/components/QueryTabs";
import { COMPROMISSOS_ABAS } from "@/lib/routes";

/**
 * /compromissos — canonical section absorbing /a-pagar and /pending
 * (item 13). Tab lives in ?aba= so redirects and deep links land right.
 */
export default function CompromissosTabs() {
  const aba = useQueryTab("aba", COMPROMISSOS_ABAS, "a-pagar");
  return (
    <div className="flex min-h-dvh flex-col bg-bg pb-[calc(9rem+env(safe-area-inset-bottom))] lg:pb-8">
      <StatusBar />
      <PageHeader title={aba === "pendencias" ? "Aprovações" : "Contas a pagar"} />
      <div className="px-5 pt-2 sm:px-8 lg:px-12">
        <QueryTabs
          ariaLabel="Compromissos"
          defaultKey="a-pagar"
          tabs={[
            { key: "a-pagar", label: "A Pagar" },
            { key: "pendencias", label: "Pendências" },
          ]}
        />
      </div>
      {aba === "pendencias" ? <PendingOperationsPage embedded /> : <PayablesPage embedded />}
    </div>
  );
}
