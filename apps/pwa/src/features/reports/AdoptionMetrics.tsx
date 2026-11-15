"use client";

import { useEffect, useState } from "react";
import { fetchAdoptionFunnel, type AdoptionFunnel } from "@/lib/api/adoption";

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const duration = (value: number | null) =>
  value === null ? "—" : `${(value / 1000).toFixed(1)}s`;

export default function AdoptionMetrics() {
  const [funnel, setFunnel] = useState<AdoptionFunnel | null>(null);

  useEffect(() => {
    let active = true;
    void fetchAdoptionFunnel()
      .then((result) => {
        if (active) setFunnel(result);
      })
      .catch(() => {
        if (active) setFunnel(null);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <section
      aria-labelledby="adoption-metrics-title"
      className="mx-5 mb-5 rounded-[16px] border border-border bg-surface p-4"
    >
      <div className="mb-3">
        <h2
          id="adoption-metrics-title"
          className="text-[14px] font-bold text-text-primary"
        >
          Adoção do produto
        </h2>
        <p className="text-[11px] text-text-muted">
          Funil operacional do período recente
        </p>
      </div>
      {funnel ? (
        <>
          <div className="grid grid-cols-2 gap-2 text-[12px]">
            <Metric label="Entregues" value={funnel.delivered} />
            <Metric
              label="Abertas"
              value={`${funnel.opened} · ${percent(funnel.openRate)}`}
            />
            <Metric
              label="Chat usado"
              value={`${funnel.chatUsed} · ${percent(funnel.chatRate)}`}
            />
            <Metric
              label="Captura concluída"
              value={`${funnel.capturesCompleted} · ${percent(funnel.captureCompletionRate)}`}
            />
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-border pt-3 text-[11px]">
            <div>
              <dt className="text-text-muted">Captura mediana</dt>
              <dd className="font-bold text-text-primary">
                {duration(funnel.captureDurationMedianMs)}
              </dd>
            </div>
            <div>
              <dt className="text-text-muted">Captura p95</dt>
              <dd className="font-bold text-text-primary">
                {duration(funnel.captureDurationP95Ms)}
              </dd>
            </div>
          </dl>
        </>
      ) : (
        <p className="text-[12px] text-text-muted">
          Métricas indisponíveis no momento.
        </p>
      )}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-[10px] bg-fill-light px-3 py-2">
      <div className="text-text-muted">{label}</div>
      <div className="mt-0.5 font-bold text-text-primary">{value}</div>
    </div>
  );
}
