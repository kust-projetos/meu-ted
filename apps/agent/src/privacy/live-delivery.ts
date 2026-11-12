/**
 * ADR-032 live delivery is default-deny: bind each connection to its verified
 * upgrade identity and deliver only frames/messages classified for that actor.
 */
import { canAccessMessage } from './conversation-visibility.js';

export type ConnectionBinding = {
  actorId: string;
  workspaceId: string;
  role: string;
  deviceId?: string;
  validatedAt: number;
};

export function bindingFromUpgradeHeaders(headers: Headers, now = Date.now()): ConnectionBinding | null {
  try {
    const actorId = headers.get('x-agent-actor')?.trim();
    const workspaceId = headers.get('x-agent-workspace')?.trim();
    const role = headers.get('x-agent-role')?.trim();
    if (!actorId || !workspaceId || !role) return null;
    const deviceId = headers.get('x-agent-device')?.trim();
    return { actorId, workspaceId, role, ...(deviceId ? { deviceId } : {}), validatedAt: now };
  } catch {
    return null;
  }
}

export type FrameAudience = { workspaceId: string; visibility: 'workspace' | 'private'; ownerActorId?: string };

export function frameMessages(frame: unknown): Array<Record<string, unknown>> | null {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return null;
  const messages = (frame as Record<string, unknown>).messages;
  if (!Array.isArray(messages) || messages.length === 0 || messages.some((m) => !m || typeof m !== 'object' || Array.isArray(m))) return null;
  return messages as Array<Record<string, unknown>>;
}

export function filterFrameForBinding(frame: Record<string, unknown>, binding: ConnectionBinding): Record<string, unknown> | null {
  const messages = frameMessages(frame);
  if (!messages) return null;
  const accessible = messages.filter((item) => canAccessMessage({
    actorId: binding.actorId,
    workspaceId: binding.workspaceId,
    meta: item.metadata as import('./conversation-visibility.js').MessageAudienceMeta | undefined,
  }));
  return accessible.length ? { ...frame, messages: accessible } : null;
}

export type DeliveryConnection = { id: string; state: ConnectionBinding | null; send: (data: string) => void };

export function deliverFrameJson(connections: Iterable<DeliveryConnection>, raw: string, without: string[] = []): { delivered: number; dropped: number } {
  let frame: unknown;
  try { frame = JSON.parse(raw); } catch { frame = null; }
  let delivered = 0;
  let dropped = 0;
  for (const connection of connections) {
    if (without.includes(connection.id)) continue;
    const filtered = frame && typeof frame === 'object' && !Array.isArray(frame) && connection.state
      ? filterFrameForBinding(frame as Record<string, unknown>, connection.state)
      : null;
    if (!filtered) { dropped++; continue; }
    connection.send(JSON.stringify(filtered));
    delivered++;
  }
  return { delivered, dropped };
}
