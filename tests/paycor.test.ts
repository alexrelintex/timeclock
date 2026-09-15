/**
 * Paycor token provider: it must call Paycor's AuthenticationSupport endpoint as
 * JSON with the subscription-key header, cache the access token, and PERSIST the
 * rotated (single-use) refresh token — the bug that would break the connector on
 * the second exchange if the rotation weren't written back.
 */
import { finish } from './assert';
import { PaycorTokenProvider } from '../apps/api/src/hris/tokenProvider';

type AnyFetch = typeof fetch;
function res(status: number, json: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
    text: async () => JSON.stringify(json),
  } as unknown as Response;
}

async function main(): Promise<void> {
  // 1. snake_case response: correct request shape + rotation persisted.
  {
    let captured: { url: string; init: RequestInit } | null = null;
    let rotated: string | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return res(200, { access_token: 'at1', refresh_token: 'rt2', expires_in: 3600 });
    }) as unknown as AnyFetch;
    const p = new PaycorTokenProvider(
      { tokenUrl: 'https://apis.paycor.com/v1/authenticationsupport/retrieveAccessTokenWithRefreshToken', clientId: 'cid', clientSecret: 'sec', refreshToken: 'rt1', subscriptionKey: 'subkey' },
      (r) => { rotated = r; },
      fetchImpl,
    );
    const at = await p.getAccessToken();
    const h = (captured!.init.headers ?? {}) as Record<string, string>;
    const body = JSON.parse(captured!.init.body as string);
    console.assert(at === 'at1', 'returns the access token');
    console.assert(captured!.url.endsWith('/retrieveAccessTokenWithRefreshToken'), 'POSTs to the AuthenticationSupport endpoint');
    console.assert(captured!.init.method === 'POST', 'uses POST');
    console.assert(h['Ocp-Apim-Subscription-Key'] === 'subkey', 'sends the Ocp-Apim-Subscription-Key header');
    console.assert(h['Content-Type'] === 'application/json', 'sends JSON');
    console.assert(body.clientId === 'cid' && body.clientSecret === 'sec' && body.refreshToken === 'rt1', 'JSON body carries clientId/clientSecret/refreshToken');
    console.assert(rotated === 'rt2', 'persists the rotated refresh token via onRotate');
    console.assert(p.currentRefreshToken() === 'rt2', 'in-memory refresh token advanced to the rotated value');
  }

  // 2. the access token is cached (a second call within TTL makes no network call).
  {
    let calls = 0;
    const fetchImpl = (async () => { calls += 1; return res(200, { access_token: 'atC', refresh_token: 'rtC', expires_in: 3600 }); }) as unknown as AnyFetch;
    const p = new PaycorTokenProvider({ tokenUrl: 'u', clientId: 'c', clientSecret: 's', refreshToken: 'r', subscriptionKey: 'k' }, () => {}, fetchImpl);
    await p.getAccessToken();
    await p.getAccessToken();
    console.assert(calls === 1, 'caches the access token (one exchange for two reads)');
  }

  // 3. camelCase response is parsed too (schema-tolerant).
  {
    let rotated: string | null = null;
    const fetchImpl = (async () => res(200, { accessToken: 'atX', refreshToken: 'rtX', expiresIn: 1200 })) as unknown as AnyFetch;
    const p = new PaycorTokenProvider({ tokenUrl: 'u', clientId: 'c', clientSecret: 's', refreshToken: 'r0', subscriptionKey: 'k' }, (r) => { rotated = r; }, fetchImpl);
    const at = await p.getAccessToken();
    console.assert(at === 'atX', 'parses camelCase accessToken');
    console.assert(rotated === 'rtX', 'parses + persists camelCase refreshToken');
  }

  // 4. an HTTP error surfaces (does not cache a bad state).
  {
    const fetchImpl = (async () => res(401, { message: 'unauthorized' })) as unknown as AnyFetch;
    const p = new PaycorTokenProvider({ tokenUrl: 'u', clientId: 'c', clientSecret: 's', refreshToken: 'r', subscriptionKey: 'k' }, () => {}, fetchImpl);
    let threw = false;
    try { await p.getAccessToken(); } catch { threw = true; }
    console.assert(threw, 'throws on a non-2xx token response');
  }

  console.log('paycor: all assertions passed');
  finish('paycor');
}

main().catch((e) => { console.error(e); process.exit(1); });
