type NetworkEvent = {
  method: string;
  route: string;
  status: number;
  stage: "mint" | "propose" | "active";
  durationMs?: number;
  code?: string;
};
type ResponseLike = {
  request(): {
    method(): string;
    timing?(): { responseEnd: number };
  };
  url(): string;
  status(): number;
  json(): Promise<unknown>;
};

const ROUTES = [
  "/pending-operations/propose",
  "/pending-operations/active",
  "/auth/agent/pending-token",
  "/rpc/pending-operations/propose",
  "/rpc/pending-operations/active",
];

function stageFor(route: string): NetworkEvent["stage"] {
  return route.includes("pending-token") ? "mint" : route.endsWith("/active") ? "active" : "propose";
}

export function createNetworkReport(page: {
  on(event: "response", listener: (response: ResponseLike) => void): void;
  off(event: "response", listener: (response: ResponseLike) => void): void;
}) {
  const events: NetworkEvent[] = [];
  const pending: Promise<void>[] = [];
  const listener = (response: ResponseLike) => {
    const request = response.request();
    const url = new URL(response.url());
    if (!ROUTES.some((route) => url.pathname.includes(route))) return;
    const event: NetworkEvent = {
      method: request.method(),
      route: url.pathname,
      status: response.status(),
      stage: stageFor(url.pathname),
    };
    try {
      const timing = request.timing?.();
      if (timing && Number.isFinite(timing.responseEnd) && timing.responseEnd >= 0) {
        event.durationMs = timing.responseEnd;
      }
    } catch { /* duration is optional */ }
    events.push(event);
    pending.push((async () => {
      try {
        const body = await response.json();
        if (typeof body === "object" && body !== null && "code" in body && typeof body.code === "string") {
          event.code = body.code;
        }
      } catch { /* response may not contain JSON */ }
    })());
  };
  page.on("response", listener);
  return {
    async report() {
      await Promise.all(pending);
      const counts = Object.fromEntries(
        [...new Set(events.map((event) => event.route))].map((route) => [
          route,
          events.filter((event) => event.route === route).length,
        ]),
      );
      return { events: [...events], counts };
    },
    stop() {
      page.off("response", listener);
    },
  };
}
