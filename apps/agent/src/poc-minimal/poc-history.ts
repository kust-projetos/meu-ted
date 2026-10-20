/**
 * POC Fase 2 — histórico conversacional mínimo (memória de turno em RAM).
 *
 * Isolado do hot path: não toca `agent_memory`, `persistMessages` nem SDK.
 * Cap fixo para não crescer sem limite; sem PII além do texto do turno.
 */
export type PocHistoryEntry = {
  readonly role: 'user' | 'assistant';
  readonly text: string;
};

const POC_HISTORY_CAP = 20;

export class PocHistory {
  private readonly entries: PocHistoryEntry[] = [];

  push(role: PocHistoryEntry['role'], text: string): void {
    this.entries.push({ role, text });
    while (this.entries.length > POC_HISTORY_CAP) this.entries.shift();
  }

  all(): readonly PocHistoryEntry[] {
    return [...this.entries];
  }

  size(): number {
    return this.entries.length;
  }
}
