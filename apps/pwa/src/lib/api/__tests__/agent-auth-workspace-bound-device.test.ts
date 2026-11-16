/**
 * #392: o device token é emitido para UM household e o gateway do OpenCode exige
 * `household do dispositivo === workspace ativo`. O mint agora confere o vínculo e, ao trocar de
 * workspace, registra o dispositivo de novo NO workspace pedido (X-Workspace-Id).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { clearAgentConnectionTokenCache, clearAgentSession, fetchAgentConnectionToken } from "../agent-auth";
import { clearToken, getToken, getTokenHousehold, setToken } from "../../auth/token-store";

const ORIGIN = "http://localhost:3000";
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Call = { url: string; method: string; headers: Record<string, string> };
const calls = (): Call[] =>
  fetchMock.mock.calls.map(([input, init]) => ({
    url: String(input),
    method: ((init as RequestInit | undefined)?.method ?? "GET").toUpperCase(),
    headers: ((init as RequestInit | undefined)?.headers ?? {}) as Record<string, string>,
  }));
const registers = (): Call[] => calls().filter((c) => c.url.includes("/auth/devices/register"));
const probes = (): Call[] => calls().filter((c) => c.url.includes("/auth/devices/me"));
const mints = (): Call[] => calls().filter((c) => c.url.includes("/auth/agent-token"));

/** API simulada: register vincula ao workspace do header; devices/me devolve o household do token. */
const routeApi = (bindings: Record<string, string>, registerFails = false): { issued: string[] } => {
  const issued: string[] = [];
  fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (url.includes("/auth/devices/register")) {
      if (registerFails) return json({ code: "auth.workspace_forbidden" }, 403);
      const ws = headers["X-Workspace-Id"] ?? "ws-default";
      const token = `device-for-${ws}-${issued.length + 1}`;
      issued.push(token);
      bindings[token] = ws;
      return json({ token, deviceId: "dev-1", householdId: ws }, 201);
    }
    if (url.includes("/auth/devices/me")) {
      const presented = headers["x-device-token"] ?? "";
      const household = bindings[presented];
      return household ? json({ deviceId: "dev-1", householdId: household }) : json({ code: "auth.invalid" }, 401);
    }
    return json({ token: "conn-jwt", expiresIn: 120 });
  });
  return { issued };
};

describe("device token vinculado ao workspace do mint (#392)", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubEnv("NEXT_PUBLIC_PI_FINANCE_API_BASE_URL", ORIGIN);
    clearAgentConnectionTokenCache();
    clearAgentSession();
    clearToken();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("vínculo igual ao workspace: reaproveita o token, sem register nem probe", async () => {
    routeApi({});
    setToken("device-A", "ws-A");
    await fetchAgentConnectionToken("ws-A");
    expect(registers()).toHaveLength(0);
    expect(probes()).toHaveLength(0);
    expect(mints()[0]!.headers["x-device-token"]).toBe("device-A");
  });

  it("trocou de workspace: registra de novo com X-Workspace-Id e o mint usa o token novo", async () => {
    const api = routeApi({ "device-A": "ws-A" });
    setToken("device-A", "ws-A");
    await fetchAgentConnectionToken("ws-B");
    expect(registers()).toHaveLength(1);
    expect(registers()[0]!.headers["X-Workspace-Id"]).toBe("ws-B");
    expect(api.issued).toHaveLength(1);
    expect(mints()[0]!.headers["x-device-token"]).toBe(api.issued[0]);
    expect(getToken()).toBe(api.issued[0]);
    expect(getTokenHousehold()).toBe("ws-B");
  });

  it("depois de religado, mints seguintes no mesmo workspace não registram de novo", async () => {
    routeApi({ "device-A": "ws-A" });
    setToken("device-A", "ws-A");
    await fetchAgentConnectionToken("ws-B");
    clearAgentConnectionTokenCache();
    await fetchAgentConnectionToken("ws-B");
    expect(registers()).toHaveLength(1);
    expect(probes()).toHaveLength(0);
  });

  it("token legado sem vínculo: descobre o household uma vez (GET /auth/devices/me) e re-registra se divergir", async () => {
    routeApi({ "device-legacy": "ws-A" });
    setToken("device-legacy");
    expect(getTokenHousehold()).toBeNull();
    await fetchAgentConnectionToken("ws-B");
    expect(probes()).toHaveLength(1);
    expect(registers()).toHaveLength(1);
    expect(registers()[0]!.headers["X-Workspace-Id"]).toBe("ws-B");
  });

  it("token legado sem vínculo e workspace igual: grava o vínculo e não registra", async () => {
    routeApi({ "device-legacy": "ws-A" });
    setToken("device-legacy");
    await fetchAgentConnectionToken("ws-A");
    expect(probes()).toHaveLength(1);
    expect(registers()).toHaveLength(0);
    expect(getTokenHousehold()).toBe("ws-A");
    clearAgentConnectionTokenCache();
    await fetchAgentConnectionToken("ws-A");
    expect(probes()).toHaveLength(1); // vínculo gravado: sem nova sondagem
  });

  it("re-registro negado: mantém o token atual (nunca deviceless) e não entra em tempestade de registros", async () => {
    routeApi({ "device-A": "ws-A" }, true);
    setToken("device-A", "ws-A");
    await fetchAgentConnectionToken("ws-B");
    clearAgentConnectionTokenCache();
    await fetchAgentConnectionToken("ws-B");
    clearAgentConnectionTokenCache();
    await fetchAgentConnectionToken("ws-B");
    expect(registers()).toHaveLength(1);
    expect(mints().every((m) => m.headers["x-device-token"] === "device-A")).toBe(true);
  });

  it("sem token: registra já no workspace do mint", async () => {
    const api = routeApi({});
    await fetchAgentConnectionToken("ws-B");
    expect(registers()).toHaveLength(1);
    expect(registers()[0]!.headers["X-Workspace-Id"]).toBe("ws-B");
    expect(mints()[0]!.headers["x-device-token"]).toBe(api.issued[0]);
  });

  it("setToken sem household descarta o vínculo do token anterior", () => {
    setToken("device-A", "ws-A");
    setToken("device-B");
    expect(getTokenHousehold()).toBeNull();
  });
});
