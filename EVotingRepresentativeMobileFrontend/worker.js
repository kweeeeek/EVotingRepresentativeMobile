/*
 * eBallot SACDECO - Representative election, mobile voting.
 *
 * One Cloudflare Worker = the static page (ASSETS binding -> ./public) + a thin, allow-listed proxy to the eVoting API.
 * The kiosk secret lives only here (env KIOSK_SECRET); the browser never sees it and cannot ask for anything that is not listed below.
 *
 *   POST /api/v1/auth/voter-verify                                    kiosk token (held here)   -> the open election must be a REPRESENTATIVE one
 *   GET  /api/v1/events/{id}/representative-ballot                    voter token from the browser   position rules, schedule, roster version
 *   GET  /api/v1/events/{id}/representative-candidates                voter token   ?search &position &page &pageSize   (same list for every voter)
 *   GET  /api/v1/events/{id}/representative-candidates/{cid}/photo    voter token   ?v=<photo version>   thumbnail only
 *   POST /api/v1/representative-votes                                 voter token   { eventId, candidateIds[], receiptCode, rosterVersion }
 *   GET  /healthz                                                     answers { ok: true } without touching the API
 *   everything else under /api/ -> 404
 *
 * Environment (Worker settings):
 *   KIOSK_SECRET   required, store it as a secret. Same value as the API's EVOTING_KIOSK_SECRET.
 *   KIOSK_ID       default MOBILE-REP-KIOSK-01   (only a label in the API's log)
 *   API_BASE       default https://api.eballotsacdeco.site
 *   CACHE_SECONDS  default 60. Roster pages and photos are the same for every voter, so they are cached here; 0 switches the cache off.
 */

const DEFAULT_API = 'https://api.eballotsacdeco.site';
const DEFAULT_KIOSK_ID = 'MOBILE-REP-KIOSK-01';

const MAX_BODY_BYTES = 16 * 1024;
const MAX_SELECTIONS = 500;                 // RepresentativeLimits.MaxSelectionsPerRequest in the API
const READ_TIMEOUT_MS = 12_000;
const VOTE_TIMEOUT_MS = 25_000;
const STALE_MS = 10 * 60 * 1000;            // a slightly old roster page is better than no page while the API is down
const PHOTO_TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 600;
const MAX_BYTES = 24 * 1024 * 1024;
const MAX_PHOTO_BYTES = 256 * 1024;

const SEC = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

const RE_BALLOT = /^\/api\/v1\/events\/(\d{1,9})\/representative-ballot$/;
const RE_CANDIDATES = /^\/api\/v1\/events\/(\d{1,9})\/representative-candidates$/;
const RE_PHOTO = /^\/api\/v1\/events\/(\d{1,9})\/representative-candidates\/(\d{1,9})\/photo$/;
const RE_JWT = /^Bearer ([A-Za-z0-9_-]{8,4096})\.([A-Za-z0-9_-]{8,4096})\.([A-Za-z0-9_-]{8,4096})$/;

/* ------------------------------------------------------------------ small helpers */

const sleep = ms => new Promise(r => setTimeout(r, ms));

function json(status, body, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SEC, ...headers },
  });
}

function problem(status, error, code, headers, extra) {
  return json(status, { error, code, ...extra }, headers);
}

const notAllowed = allow => problem(405, 'Method not allowed.', 'METHOD_NOT_ALLOWED', { Allow: allow });

function apiBase(env) {
  return String(env.API_BASE || DEFAULT_API).replace(/\/+$/, '') + '/api/v1';
}

/** One call to the API. A timeout or a network failure is a rejected promise (callers turn it into 503). */
function up(env, path, init, timeoutMs) {
  return fetch(apiBase(env) + path, { ...init, signal: AbortSignal.timeout(timeoutMs || READ_TIMEOUT_MS) });
}

function retryAfter(headers) {
  const v = headers && headers.get && headers.get('Retry-After');
  return v && /^\d{1,4}$/.test(v) ? { 'Retry-After': v } : undefined;
}

async function readJsonBody(response) {
  let text = '';
  try { text = await response.text(); } catch { /* an unreadable body is treated as no body */ }
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/** The API's own answer for a refusal (its message and stable code) or, for anything unusable, a neutral one. Server errors never leak details. */
function relayFailure(status, data, headers) {
  if (status < 400 || (status >= 500 && status !== 503)) {
    return problem(502, 'The server had a problem. Nothing was changed; please try again.', 'UPSTREAM_ERROR');
  }
  const message = data && typeof data === 'object' ? (data.error ?? data.title) : null;
  if (typeof message === 'string') {
    return json(status, { error: message, code: data.code, detail: data.detail, fields: data.fields }, retryAfter(headers));
  }
  if (status === 429) return problem(429, 'Too many requests. Please try again in a moment.', 'RATE_LIMITED', retryAfter(headers) || { 'Retry-After': '3' });
  if (status === 503) return problem(503, 'The server is busy. Please try again in a moment.', 'UPSTREAM_UNAVAILABLE', retryAfter(headers) || { 'Retry-After': '2' });
  return problem(status, 'The request was not accepted.', 'REJECTED');
}

const unreachable = () => problem(503, 'The server could not be reached. Please try again.', 'UPSTREAM_UNAVAILABLE', { 'Retry-After': '2' });

class BodyError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

async function readJsonRequest(request) {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new BodyError(413, 'TOO_LARGE', 'The request is too large.');
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_BODY_BYTES) throw new BodyError(413, 'TOO_LARGE', 'The request is too large.');
  let value;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { value = null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BodyError(400, 'VALIDATION', 'The request body must be a JSON object.');
  return value;
}

const bodyProblem = e => (e instanceof BodyError ? problem(e.status, e.message, e.code) : null);

/* ------------------------------------------------------------------ kiosk sign-in (held here, never sent to the browser) */

let kioskTokenValue = null;
let kioskTokenExpires = 0;
let kioskLoginInFlight = null;

class CredentialsRefused extends Error {}

async function kioskLogin(env) {
  for (let attempt = 0; ; attempt++) {
    const r = await up(env, '/auth/kiosk-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kioskId: env.KIOSK_ID || DEFAULT_KIOSK_ID, deviceSecret: env.KIOSK_SECRET || '' }),
    }, 10_000);
    if (r.status === 429 && attempt < 3) {      // the API limits kiosk sign-ins per minute; wait a little and ask again
      const wait = Number((retryAfter(r.headers) || {})['Retry-After']);
      await sleep(Math.min(wait > 0 ? wait * 1000 : 400 * 2 ** attempt, 5000) + Math.random() * 250);
      continue;
    }
    if (r.status === 401) throw new CredentialsRefused('kiosk credentials refused');
    if (!r.ok) throw new Error('kiosk-login ' + r.status);
    const j = await readJsonBody(r);
    if (!j || typeof j.accessToken !== 'string') throw new Error('kiosk-login without a token');
    kioskTokenValue = j.accessToken;
    kioskTokenExpires = Date.now() + Math.max(30, (Number(j.expiresIn) || 0) - 120) * 1000;
    return kioskTokenValue;
  }
}

/** The kiosk token, signed in once per Worker instance at a time (a burst of voters must not become a burst of sign-ins). */
async function kioskToken(env, force) {
  if (!force && kioskTokenValue && Date.now() < kioskTokenExpires) return kioskTokenValue;
  if (kioskLoginInFlight) return kioskLoginInFlight;
  const p = kioskLogin(env);
  kioskLoginInFlight = p;
  try { return await p; } finally { if (kioskLoginInFlight === p) kioskLoginInFlight = null; }
}

/* ------------------------------------------------------------------ voter token (shape + expiry only; the API checks the signature) */

function voterBearer(request) {
  const m = RE_JWT.exec(request.headers.get('Authorization') || '');
  if (!m) return null;
  try {
    const b64 = m[2].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)));
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now() - 60_000) return null;   // same 1 minute of clock skew as the API
  } catch { return null; }
  return `${m[1]}.${m[2]}.${m[3]}`;
}

const invalidToken = () => problem(401, 'Your voter session is invalid or has expired.', 'INVALID_TOKEN');

/* ------------------------------------------------------------------ cache for what is the same for every voter */

const cache = new Map();          // key -> { at, status, type, body, bytes }   (insertion order = least recently used first)
const inflight = new Map();       // key -> Promise of the call that is already on its way
let cacheBytes = 0;

function cacheTouch(key) {
  const e = cache.get(key);
  if (e) { cache.delete(key); cache.set(key, e); }
  return e;
}

function cachePut(key, entry) {
  const old = cache.get(key);
  if (old) { cacheBytes -= old.bytes; cache.delete(key); }
  cache.set(key, entry);
  cacheBytes += entry.bytes;
  while ((cache.size > MAX_ENTRIES || cacheBytes > MAX_BYTES) && cache.size > 1) {
    const oldest = cache.keys().next().value;
    cacheBytes -= cache.get(oldest).bytes;
    cache.delete(oldest);
  }
}

function ttlOf(env) {
  const n = Number(env.CACHE_SECONDS);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 300) * 1000 : 60_000;
}

function fromEntry(entry, tag, photoVersioned) {
  if (entry.photo) {
    const cc = photoVersioned ? 'private, max-age=86400' : 'private, max-age=300';
    if (entry.status === 204) return new Response(null, { status: 204, headers: { 'Cache-Control': cc, 'X-Cache': tag, ...SEC } });
    return new Response(entry.body, { status: 200, headers: { 'Content-Type': entry.type, 'Cache-Control': cc, 'X-Cache': tag, ...SEC } });
  }
  return new Response(entry.body, {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Cache': tag, ...SEC },
  });
}

/** One read from the API. Never throws: { ok, entry } for a usable answer, { ok: false, net | status, data, headers } otherwise. */
async function load(env, path, token, photo) {
  let r;
  try {
    r = await up(env, path, { headers: { Authorization: 'Bearer ' + token, Accept: photo ? 'image/*' : 'application/json' } }, READ_TIMEOUT_MS);
  } catch { return { ok: false, net: true }; }

  if (r.status === 200 || (photo && r.status === 204)) {
    try {
      if (photo) {
        if (r.status === 204) return { ok: true, entry: { at: Date.now(), photo: true, status: 204, type: '', body: null, bytes: 0 } };
        const type = (r.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
        if (!/^image\/(png|jpeg|gif|bmp|webp)$/.test(type)) return { ok: false, status: 502, data: null };
        const body = new Uint8Array(await r.arrayBuffer());
        return { ok: true, entry: { at: Date.now(), photo: true, status: 200, type, body, bytes: body.byteLength }, oversize: body.byteLength > MAX_PHOTO_BYTES };
      }
      const text = await r.text();
      JSON.parse(text);                                    // never cache or relay something that is not JSON
      return { ok: true, entry: { at: Date.now(), photo: false, status: 200, type: 'application/json', body: text, bytes: text.length * 2 } };
    } catch { return { ok: false, net: true }; }
  }
  return { ok: false, status: r.status, data: await readJsonBody(r), headers: r.headers };
}

/**
 * A GET whose answer is the same for every voter. Served from the cache while it is fresh; identical requests that arrive together share
 * ONE call to the API (only an answer is shared, a refusal is not: every voter is then asked with his own token); when the API is down a
 * recent copy is served instead of an error.
 */
async function cached(env, key, path, token, o) {
  const ttl = o.ttlMs;
  const now = Date.now();
  if (ttl > 0) {
    const hit = cacheTouch(key);
    if (hit && now - hit.at < ttl) return fromEntry(hit, 'HIT', o.versioned);
  }

  let res;
  const pending = ttl > 0 ? inflight.get(key) : undefined;
  if (pending) {
    res = await pending;
    if (!res.ok) res = await load(env, path, token, o.photo);
  } else {
    const p = load(env, path, token, o.photo);
    if (ttl > 0) inflight.set(key, p);
    try { res = await p; } finally { if (inflight.get(key) === p) inflight.delete(key); }
  }

  if (res.ok) {
    if (ttl > 0 && !res.oversize) cachePut(key, res.entry);
    return fromEntry(res.entry, 'MISS', o.versioned);
  }
  const stale = cache.get(key);
  if ((res.net || res.status >= 500) && stale && now - stale.at < o.staleMs) return fromEntry(stale, 'STALE', o.versioned);
  if (res.net) return unreachable();
  return relayFailure(res.status, res.data, res.headers);
}

/* ------------------------------------------------------------------ routes */

const intOr = (v, min, max, fallback) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

function oneLine(v, max) {
  if (v == null) return '';
  return String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** voter-verify answers with a status and a message but no stable code; give the page one so it never has to read the wording. */
function verifyFailure(status, data, headers) {
  const message = data && typeof data === 'object' ? data.error : null;
  let code = data && typeof data.code === 'string' ? data.code : undefined;
  if (!code) {
    if (status === 404) code = /event/i.test(message || '') ? 'NO_OPEN_EVENT' : 'MEMBER_NOT_FOUND';
    else if (status === 409) code = 'ALREADY_VOTED';
    else if (status === 422) code = 'NOT_ELIGIBLE';
    else if (status === 403) code = 'BRANCH_NOT_PARTICIPATING';
  }
  if (!code) return relayFailure(status, data, headers);
  const d = typeof message === 'string' ? { ...data, code } : { error: 'The request was not accepted.', code };
  return relayFailure(status, d, headers);
}

async function verify(request, env) {
  let body;
  try { body = await readJsonRequest(request); } catch (e) { return bodyProblem(e) || problem(400, 'Bad request.', 'VALIDATION'); }
  const accountCode = typeof body.accountCode === 'string' ? oneLine(body.accountCode, 64) : '';
  if (!accountCode) return problem(400, 'The account code is required.', 'VALIDATION');

  for (let pass = 0; pass < 2; pass++) {
    let token;
    try { token = await kioskToken(env, pass === 1); } catch (e) {
      if (e instanceof CredentialsRefused) return problem(401, 'The server did not accept the kiosk credentials of this page.', 'KIOSK_REFUSED');
      return unreachable();
    }
    let r;
    try {
      r = await up(env, '/auth/voter-verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ accountCode }),
      });
    } catch { return unreachable(); }

    if (r.status === 401) {
      if (pass === 0) continue;                            // the kiosk token expired or was revoked: sign in again, once
      return problem(401, 'The server did not accept the kiosk credentials of this page.', 'KIOSK_REFUSED');
    }

    const data = await readJsonBody(r);
    if (!r.ok) return verifyFailure(r.status, data, r.headers);

    // This page votes in Representative elections only. The API has ONE open election at a time; when it is another type, no voter token is handed out.
    const type = data && data.event && data.event.eventType;
    if (type !== 'REPRESENTATIVE') {
      return problem(409, 'The election that is open now is not a Representative election.', 'WRONG_EVENT_TYPE', undefined, { eventType: typeof type === 'string' ? type : null });
    }
    return json(200, data);
  }
  return unreachable();
}

async function ballot(request, env, eventId) {
  const token = voterBearer(request);
  if (!token) return invalidToken();
  const ttl = Math.min(ttlOf(env), 20_000);                // it carries isVotingOpen and the server clock: keep it fresh
  return cached(env, `ballot:${eventId}`, `/events/${eventId}/representative-ballot`, token, { ttlMs: ttl, staleMs: 2 * 60 * 1000 });
}

async function candidates(request, env, url, eventId) {
  const token = voterBearer(request);
  if (!token) return invalidToken();
  const sp = url.searchParams;
  const q = new URLSearchParams({ page: String(intOr(sp.get('page'), 1, 100000, 1)), pageSize: String(intOr(sp.get('pageSize'), 1, 200, 50)) });
  const position = oneLine(sp.get('position'), 150);
  const search = oneLine(sp.get('search'), 100);
  if (position) q.set('position', position);
  if (search) q.set('search', search);
  const qs = q.toString();
  const ttl = search ? Math.min(ttlOf(env), 30_000) : ttlOf(env);
  return cached(env, `cand:${eventId}:${qs}`, `/events/${eventId}/representative-candidates?${qs}`, token, { ttlMs: ttl, staleMs: STALE_MS });
}

async function photo(request, env, url, eventId, candidateId) {
  const token = voterBearer(request);
  if (!token) return invalidToken();
  const v = /^\d{1,20}$/.test(url.searchParams.get('v') || '') ? url.searchParams.get('v') : '';
  const ttl = ttlOf(env) > 0 ? PHOTO_TTL_MS : 0;
  return cached(env, `photo:${eventId}:${candidateId}:${v}`, `/events/${eventId}/representative-candidates/${candidateId}/photo?size=thumb`, token,
    { ttlMs: ttl, staleMs: 60 * 60 * 1000, photo: true, versioned: v !== '' });
}

const RE_RECEIPT = /^[A-Za-z0-9-]{1,30}$/;
const RE_VERSION = /^[A-Za-z0-9]{1,64}$/;

async function vote(request, env) {
  const token = voterBearer(request);
  if (!token) return invalidToken();
  let b;
  try { b = await readJsonRequest(request); } catch (e) { return bodyProblem(e) || problem(400, 'Bad request.', 'VALIDATION'); }

  const ids = b.candidateIds;
  const valid = Number.isInteger(b.eventId) && b.eventId >= 1 && b.eventId <= 2_147_483_647
    && Array.isArray(ids) && ids.length >= 1 && ids.length <= MAX_SELECTIONS
    && ids.every(n => Number.isInteger(n) && n >= 1 && n <= 2_147_483_647)
    && (b.receiptCode === undefined || b.receiptCode === null || (typeof b.receiptCode === 'string' && RE_RECEIPT.test(b.receiptCode)))
    && (b.rosterVersion === undefined || b.rosterVersion === null || (typeof b.rosterVersion === 'string' && RE_VERSION.test(b.rosterVersion)));
  if (!valid) return problem(400, 'The ballot is not in the expected form.', 'VALIDATION');

  // Only the known fields are passed on, rebuilt from the checked values.
  const out = { eventId: b.eventId, candidateIds: ids };
  if (b.receiptCode) out.receiptCode = b.receiptCode;
  if (b.rosterVersion) out.rosterVersion = b.rosterVersion;

  let r;
  try {
    r = await up(env, '/representative-votes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(out),
    }, VOTE_TIMEOUT_MS);
  } catch { return unreachable(); }          // the ballot may or may not have been recorded: the page retries with the SAME receipt code, which is safe

  const data = await readJsonBody(r);
  if (!r.ok) return relayFailure(r.status, data, r.headers);
  if (!data || typeof data.receiptCode !== 'string') return problem(502, 'The server answer was not understood. Please try again.', 'UPSTREAM_ERROR');
  return json(200, data);
}

async function api(request, env, url) {
  const p = url.pathname;
  const m = request.method;
  let x;
  if (p === '/api/v1/auth/voter-verify') return m === 'POST' ? verify(request, env) : notAllowed('POST');
  if ((x = RE_BALLOT.exec(p))) return m === 'GET' ? ballot(request, env, +x[1]) : notAllowed('GET');
  if ((x = RE_PHOTO.exec(p))) return m === 'GET' ? photo(request, env, url, +x[1], +x[2]) : notAllowed('GET');
  if ((x = RE_CANDIDATES.exec(p))) return m === 'GET' ? candidates(request, env, url, +x[1]) : notAllowed('GET');
  if (p === '/api/v1/representative-votes') return m === 'POST' ? vote(request, env) : notAllowed('POST');
  return problem(404, 'Not found.', 'NOT_FOUND');
}

/* ------------------------------------------------------------------ the page (headers for static files come from public/_headers) */

async function site(request, env, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return notAllowed('GET, HEAD');
  const req = url.pathname === '/favicon.ico' ? new Request(new URL('/favicon.png', url), request) : request;
  const res = await env.ASSETS.fetch(req);
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(SEC)) h.set(k, v);
  if (!res.ok) h.set('Cache-Control', 'no-store');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) return await api(request, env, url);
      if (url.pathname === '/healthz') return json(200, { ok: true });
      return await site(request, env, url);
    } catch (e) {
      console.error('worker error:', e && e.message);          // the message only: never a header, a token or a body
      return problem(500, 'Unexpected error.', 'INTERNAL');
    }
  },
};
