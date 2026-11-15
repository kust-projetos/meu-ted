import { render, screen, waitFor } from "@/lib/test-utils";
import { describe, expect, it, vi } from "vitest";
import AdoptionMetrics from "../AdoptionMetrics";

const adoption = vi.hoisted(() => ({ fetchAdoptionFunnel: vi.fn() }));

vi.mock("@/lib/api/adoption", () => adoption);

describe("AdoptionMetrics", () => {
  it("renders the operational funnel and capture timings", async () => {
    adoption.fetchAdoptionFunnel.mockResolvedValue({
      from: "2026-08-01",
      to: "2026-08-14",
      delivered: 10,
      opened: 8,
      chatUsed: 4,
      capturesStarted: 3,
      capturesCompleted: 2,
      openRate: 0.8,
      chatRate: 0.5,
      captureStartRate: 0.75,
      captureCompletionRate: 0.6667,
      captureDurationMedianMs: 1200,
      captureDurationP95Ms: 2500,
    });

    render(<AdoptionMetrics />);

    await waitFor(() => {
      expect(screen.getByText("Adoção do produto")).toBeInTheDocument();
      expect(screen.getByText("8 · 80.0%")).toBeInTheDocument();
      expect(screen.getByText("1.2s")).toBeInTheDocument();
      expect(screen.getByText("2.5s")).toBeInTheDocument();
    });
  });
});
