import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@/lib/test-utils";
import { FilterPillBar } from "../FilterPillBar";
import {
  AnalyticsFiltersProvider,
  useAnalyticsFilters,
  ANALYTICS_FILTERS_KEY,
  ANALYTICS_FILTERS_KEY_PREFIX,
  ANALYTICS_FILTERS_VERSION,
  DEFAULT_ANALYTICS_FILTERS,
  clearStoredAnalyticsFilters,
  scopedAnalyticsFiltersKey,
} from "../analytics-filters";

const accounts = [
  { id: "acc-1", name: "Nubank" },
  { id: "acc-2", name: "Itaú" },
];

describe("FilterPillBar", () => {
  const base = { period: "last30days" as const };

  it("shows current period and account labels", () => {
    render(<FilterPillBar filters={base} accounts={accounts} onPeriodChange={vi.fn()} onAccountChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Período: Últimos 30 dias/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Conta: Todas/ })).toBeInTheDocument();
  });

  it("opens the period drawer and selects Mês Passado", () => {
    const onPeriodChange = vi.fn();
    render(<FilterPillBar filters={base} accounts={accounts} onPeriodChange={onPeriodChange} onAccountChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Período:/ }));
    fireEvent.click(screen.getByRole("button", { name: "Mês Passado" }));
    expect(onPeriodChange).toHaveBeenCalledWith("lastMonth");
  });

  it("requires both custom dates before confirming", () => {
    const onPeriodChange = vi.fn();
    render(<FilterPillBar filters={base} accounts={accounts} onPeriodChange={onPeriodChange} onAccountChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Período:/ }));
    const ok = screen.getByRole("button", { name: "OK" });
    expect(ok).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Data inicial personalizada"), { target: { value: "2026-01-01" } });
    fireEvent.change(screen.getByLabelText("Data final personalizada"), { target: { value: "2026-01-31" } });
    expect(screen.getByRole("button", { name: "OK" })).not.toBeDisabled();
    expect(screen.getByTestId("period-custom-dates").className).toContain("flex-col");
    expect(screen.getByTestId("period-custom-dates").className).toContain("sm:flex-row");
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(onPeriodChange).toHaveBeenCalledWith("custom", { from: "2026-01-01", to: "2026-01-31" });
  });

  it("selects and clears an account", () => {
    const onAccountChange = vi.fn();
    render(
      <FilterPillBar
        filters={{ ...base, accountId: "acc-1" }}
        accounts={accounts}
        onPeriodChange={vi.fn()}
        onAccountChange={onAccountChange}
      />,
    );
    expect(screen.getByRole("button", { name: /Conta: Nubank/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Conta: Nubank/ }));
    fireEvent.click(screen.getByRole("button", { name: "Itaú" }));
    expect(onAccountChange).toHaveBeenCalledWith("acc-2");
  });
});

describe("analytics-filters store", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  function Probe() {
    const { filters, setPeriod, setAccountId, reset } = useAnalyticsFilters();
    return (
      <div>
        <span data-testid="state">{JSON.stringify(filters)}</span>
        <button type="button" onClick={() => setPeriod("lastMonth")}>
          month
        </button>
        <button type="button" onClick={() => setAccountId("acc-9")}>
          account
        </button>
        <button type="button" onClick={reset}>
          reset
        </button>
      </div>
    );
  }

  const KEY_A = scopedAnalyticsFiltersKey({ workspaceId: "ws-a", actorId: "user-1" })!;
  const KEY_B = scopedAnalyticsFiltersKey({ workspaceId: "ws-b", actorId: "user-1" })!;

  const renderScoped = (workspaceId: string | null, actorId: string | null = "user-1") =>
    render(
      <AnalyticsFiltersProvider workspaceId={workspaceId} actorId={actorId}>
        <Probe />
      </AnalyticsFiltersProvider>,
    );

  const setFilters = () => {
    act(() => {
      fireEvent.click(screen.getByText("month"));
      fireEvent.click(screen.getByText("account"));
    });
  };

  it("persists under the workspace+actor key and restores on mount", () => {
    const { unmount } = renderScoped("ws-a");
    setFilters();
    expect(window.localStorage.getItem(KEY_A)).toContain("lastMonth");
    unmount();
    renderScoped("ws-a");
    expect(screen.getByTestId("state").textContent).toContain("acc-9");
  });

  it("não sobrescreve filtros persistidos com defaults durante o mount", () => {
    window.localStorage.setItem(KEY_A, JSON.stringify({ version: ANALYTICS_FILTERS_VERSION, filters: { period: "lastMonth" } }));
    const setItem = vi.spyOn(window.localStorage, "setItem");

    renderScoped("ws-a");

    expect(setItem).toHaveBeenCalled();
    expect(setItem.mock.calls[0]?.[1]).toContain('"period":"lastMonth"');
  });

  it("isolates workspaces: B never sees A's filters, A→B→A restores each", () => {
    const first = renderScoped("ws-a");
    setFilters();
    first.unmount();

    renderScoped("ws-b");
    expect(screen.getByTestId("state").textContent).toContain(JSON.stringify(DEFAULT_ANALYTICS_FILTERS.period));
    expect(screen.getByTestId("state").textContent).not.toContain("acc-9");
  });

  it("rerender across scopes keeps each scope's filters", () => {
    const view = renderScoped("ws-a");
    setFilters();
    view.rerender(
      <AnalyticsFiltersProvider workspaceId="ws-b" actorId="user-1">
        <Probe />
      </AnalyticsFiltersProvider>,
    );
    expect(screen.getByTestId("state").textContent).not.toContain("acc-9");
    view.rerender(
      <AnalyticsFiltersProvider workspaceId="ws-a" actorId="user-1">
        <Probe />
      </AnalyticsFiltersProvider>,
    );
    expect(screen.getByTestId("state").textContent).toContain("acc-9");
  });

  it("logout (null scope) resets to defaults and wipes stored keys", () => {
    const view = renderScoped("ws-a");
    setFilters();
    expect(window.localStorage.getItem(KEY_A)).toContain("acc-9");
    view.rerender(
      <AnalyticsFiltersProvider workspaceId={null}>
        <Probe />
      </AnalyticsFiltersProvider>,
    );
    expect(screen.getByTestId("state").textContent).toContain(JSON.stringify(DEFAULT_ANALYTICS_FILTERS.period));
    expect(screen.getByTestId("state").textContent).not.toContain("acc-9");
    expect(window.localStorage.getItem(KEY_A)).toBeNull();
  });

  it("logout→login as another user does not leak the previous filters", () => {
    const view = renderScoped("ws-a", "user-1");
    setFilters();
    view.rerender(
      <AnalyticsFiltersProvider workspaceId={null}>
        <Probe />
      </AnalyticsFiltersProvider>,
    );
    view.rerender(
      <AnalyticsFiltersProvider workspaceId="ws-a" actorId="user-2">
        <Probe />
      </AnalyticsFiltersProvider>,
    );
    expect(screen.getByTestId("state").textContent).not.toContain("acc-9");
  });

  it("ignores and removes the legacy global key", () => {
    window.localStorage.setItem(ANALYTICS_FILTERS_KEY, JSON.stringify({ period: "thisYear", accountId: "acc-1" }));
    renderScoped("ws-a");
    expect(screen.getByTestId("state").textContent).not.toContain("acc-1");
    expect(window.localStorage.getItem(ANALYTICS_FILTERS_KEY)).toBeNull();
  });

  it("falls back to defaults on corrupt storage", () => {
    window.localStorage.setItem(KEY_A, "not-json{{{");
    renderScoped("ws-a");
    expect(screen.getByTestId("state").textContent).toContain(JSON.stringify(DEFAULT_ANALYTICS_FILTERS.period));
  });

  it("falls back to defaults on an obsolete envelope version", () => {
    window.localStorage.setItem(KEY_A, JSON.stringify({ version: 1, filters: { period: "thisYear" } }));
    renderScoped("ws-a");
    expect(screen.getByTestId("state").textContent).toContain(JSON.stringify(DEFAULT_ANALYTICS_FILTERS.period));
    expect(screen.getByTestId("state").textContent).not.toContain("thisYear");
  });

  it("uses the explicit no-actor segment without an actor id", () => {
    render(
      <AnalyticsFiltersProvider workspaceId="ws-a">
        <Probe />
      </AnalyticsFiltersProvider>,
    );
    setFilters();
    expect(
      window.localStorage.getItem(`${ANALYTICS_FILTERS_KEY_PREFIX}:v${ANALYTICS_FILTERS_VERSION}:ws-a:no-actor`),
    ).toContain("acc-9");
  });

  it("clearStoredAnalyticsFilters wipes legacy and scoped keys", () => {
    window.localStorage.setItem(ANALYTICS_FILTERS_KEY, "{}");
    window.localStorage.setItem(KEY_A, "{}");
    window.localStorage.setItem(KEY_B, "{}");
    window.localStorage.setItem("unrelated", "keep");
    clearStoredAnalyticsFilters();
    expect(window.localStorage.getItem(ANALYTICS_FILTERS_KEY)).toBeNull();
    expect(window.localStorage.getItem(KEY_A)).toBeNull();
    expect(window.localStorage.getItem(KEY_B)).toBeNull();
    expect(window.localStorage.getItem("unrelated")).toBe("keep");
  });
});
