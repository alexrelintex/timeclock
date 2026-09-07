/**
 * Host identity assertion.
 *
 * The embed NEVER trusts a raw user id (or email) from the page. The host CRM
 * backend mints a short-lived signed JWT ( {iss:tenant, sub:hostUserId, exp,
 * email?, role?} ) and hands it to the widget via
 * window.TimeClock.setIdentityToken(jwt). The widget forwards it to us; we verify
 * signature + expiry here and resolve it to an Agent via the identity map.
 *
 * The optional `email` claim is the CRM<->Time-Clock connection key. A CRM knows
 * its user by email; Time-Clock knows an agent by hostUserId. On a hostUserId the
 * store hasn't seen yet, the email lets us match an existing agent and bind the
 * hostUserId to it once (see resolveAgent). Because it rides INSIDE the signed
 * token it is host-attested — the page can't forge it. It is normalized (trim +
 * lowercase) so casing never causes a match miss.
 *
 * The optional `role` claim is the host's authorization assertion. Only the three
 * known tiers are accepted — an unknown value is dropped. The claim can only
 * RESTRICT: the effective role is clamped to min(claimRole, storedRole) at the
 * call site, so a host token demotes for a session but never escalates above the
 * role an admin granted in-app.
 *
 * Demo uses HS256 with a per-tenant shared secret (TIMECLOCK_IDENTITY_SECRET).
 * Production swap: verify RS256/ES256 against the host's JWKS — the call sites
 * only depend on verifyIdentityToken()'s return shape.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Role } from './types.js';

const ROLES: ReadonlySet<string> = new Set<Role>(['admin', 'manager', 'supervisor', 'user']);

// A deliberately loose shape check — we are not validating deliverability, only
// that the value looks like an address so it can serve as a stable match key.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Normalize an email for use as a match key: trim + lowercase. Returns undefined
 * for anything that doesn't look like an address (so a junk claim is simply
 * dropped rather than trusted). The CRM and the stored agent are compared through
 * this same function, so casing/whitespace never causes a miss.
 */
export function normalizeEmail(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim().toLowerCase();
  return EMAIL_RE.test(v) ? v : undefined;
}

export interface IdentityClaims {
  tenantId: string; // iss
  hostUserId: string; // sub
  displayName?: string; // optional convenience claim
  email?: string; // optional CRM-connection key (normalized lowercase)
  role?: Role; // optional host authorization assertion
  expiresAt: number; // exp (epoch seconds)
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}
function b64urlJson(obj: unknown): string {
  return b64url(JSON.stringify(obj));
}

/** Mint a token (host-side helper; used by the demo seeder and tests). */
export function mintIdentityToken(
  claims: {
    tenantId: string;
    hostUserId: string;
    displayName?: string;
    email?: string;
    role?: Role;
    ttlSeconds?: number;
  },
  secret: string,
): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const email = normalizeEmail(claims.email);
  const payload = {
    iss: claims.tenantId,
    sub: claims.hostUserId,
    name: claims.displayName,
    ...(email ? { email } : {}),
    ...(claims.role ? { role: claims.role } : {}),
    iat: now,
    exp: now + (claims.ttlSeconds ?? 300), // <= 5 min per the loader contract
  };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const sig = b64url(createHmac('sha256', secret).update(signingInput).digest());
  return `${signingInput}.${sig}`;
}

export class IdentityError extends Error {}

export function verifyIdentityToken(token: string, secret: string): IdentityClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new IdentityError('malformed token');
  const [h, p, s] = parts;
  const expected = b64url(createHmac('sha256', secret).update(`${h}.${p}`).digest());
  const a = Buffer.from(s);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new IdentityError('bad signature');
  }
  let payload: { iss?: string; sub?: string; name?: string; email?: string; role?: string; exp?: number };
  try {
    payload = JSON.parse(Buffer.from(p, 'base64').toString('utf8'));
  } catch {
    throw new IdentityError('bad payload');
  }
  if (!payload.iss || !payload.sub) throw new IdentityError('missing iss/sub');
  if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) {
    throw new IdentityError('expired');
  }
  const email = normalizeEmail(payload.email);
  return {
    tenantId: payload.iss,
    hostUserId: payload.sub,
    displayName: payload.name,
    // A malformed email claim is dropped rather than trusted (never a hard error).
    ...(email ? { email } : {}),
    // Accept only a known tier; an unrecognized claim is ignored (never trusted).
    ...(payload.role && ROLES.has(payload.role) ? { role: payload.role as Role } : {}),
    expiresAt: payload.exp,
  };
}

/** Verify an HMAC webhook signature (hex or base64) in constant time. */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string,
  secret: string,
): boolean {
  const mac = createHmac('sha256', secret).update(rawBody).digest();
  const provided = signatureHeader.trim().replace(/^sha256=/i, '');
  const asHex = Buffer.from(provided, 'hex');
  const asB64 = Buffer.from(provided, 'base64');
  for (const cand of [asHex, asB64]) {
    if (cand.length === mac.length && timingSafeEqual(cand, mac)) return true;
  }
  return false;
}
