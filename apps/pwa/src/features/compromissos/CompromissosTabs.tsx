"use client";

import PayablesPage from "@/features/payables/PayablesPage";
import PageHeader from "@/components/PageHeader";
import StatusBar from "@/components/StatusBar";

/** /compromissos — página canônica das contas a pagar. */
export default function CompromissosTabs() {
  return (
    <div className="flex min-h-dvh flex-col bg-bg pb-[calc(9rem+env(safe-area-inset-bottom))] lg:pb-8">
      <StatusBar />
      <PageHeader title="Contas a pagar" />
      <PayablesPage embedded />
    </div>
  );
}
