import { Suspense } from "react";
import AppShell from "@/components/AppShell";
import TedChatPage from "@/features/ted/TedChatPage";

export default function Ted() {
  return (
    <AppShell>
      <Suspense fallback={null}>
        <TedChatPage />
      </Suspense>
    </AppShell>
  );
}
