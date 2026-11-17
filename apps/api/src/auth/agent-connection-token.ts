import { randomUUID } from 'node:crypto';

const encoder = new TextEncoder();
const toBase64Url = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const fromBase64Url = (v: string) => new Uint8Array(Buffer.from(v, 'base64url'));
const encodeJson = (v: unknown) => toBase64Url(encoder.encode(JSON.stringify(v)));

export type AgentConnectionClaims = {
  iss: 'pi-finance-api';
  aud: 'pi-finance-agent';
  sub: string;
  workspace: string;
  role: 'owner' | 'member';
  capabilities: string[];
  jti: string;
  /**
   * H-12: device this token was minted for (resolved server-side from the
   * presented device token at mint time — never a free client claim). The
   * Worker re-stamps it as x-agent-device and the DO + delegation boundary
   * verify the SAME value. Absent for session-only clients (read-only
   * downstream for sensitive mutations).
   */
  deviceId?: string;
  iat: number;
  exp: number;
};

const isValidDeviceId = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 128 && !/[\s\x00-\x1f\x7f]/.test(value);

export const createAgentConnectionToken = async (
  input: { sub: string; workspace: string; role: 'owner' | 'member'; capabilities?: string[]; jti?: string; deviceId?: string },
  secret: string,
  nowMs = Date.now(),
): Promise<string> => {
  if (!secret) throw new Error('secret required');
  if (!input.sub || !input.workspace) throw new Error('sub and workspace are required');
  if (input.role !== 'owner' && input.role !== 'member') throw new Error('role must be owner or member');
  if (input.deviceId !== undefined && !isValidDeviceId(input.deviceId)) throw new Error('deviceId is invalid');

  const iat = Math.floor(nowMs / 1000);
  const claims: AgentConnectionClaims = {
    iss: 'pi-finance-api',
    aud: 'pi-finance-agent',
    sub: input.sub,
    workspace: input.workspace,
    role: input.role,
    // Connection tokens are advisory/read-only by default. Mutation
    // capability is intentionally not granted by this boundary.
    capabilities: input.capabilities ?? ['financial.read'],
    jti: input.jti ?? randomUUID(),
    ...(input.deviceId !== undefined ? { deviceId: input.deviceId.trim() } : {}),
    iat,
    exp: iat + 120,
  };

  const header = encodeJson({ alg: 'HS256', typ: 'JWT' });
  const payload = encodeJson(claims);
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`${header}.${payload}`));
  return `${header}.${payload}.${toBase64Url(new Uint8Array(sig))}`;
};
