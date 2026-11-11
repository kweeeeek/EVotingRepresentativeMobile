import test from 'node:test';
import assert from 'node:assert/strict';

/* The REAL worker.js against a scripted API. Every test gets its own copy of the module, so the kiosk token and the cache start empty. */

const SECRET = 'sekret-kiosk-value-for-tests';
const KIOSK_TOKEN = 'KIOSK-TOKEN-1';
const realFetch = globalThis.fetch;
let copies = 0;

const freshWorker = async () => (await import(`../worker.js?copy=${++copies}`)).default;

const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (exp = Math.floor(Date.now() / 1000) + 900, extra = {}) =>
  `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ exp, eventId: '7', memberId: '5', ...extra })}.${Buffer.from('signature-bytes-0123456789').toString('base64url')}`;

const J = (status, body, headers) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const VERIFY_OK = {
  accessToken: jwt(), expiresIn: 900,
  member: { memberId: 5, name: 'DELA CRUZ, JUAN', branch: 'Agoo Branch', branchId: 1, accountCode: '0001234' },
  event: { eventId: 7, title: 'Representative Election 2026', venue: 'Hall', scheduleFrom: '2026-11-11T08:00:00', scheduleTo: '2026-11-11T17:00:00', status: 'Opened', eventType: 'REPRESENTATIVE' },
};
const BALLOT = {
  eventId: 7, eventType: 'REPRESENTATIVE', title: 'Representative Election 2026', status: 'Opened', isVotingOpen: true, rosterVersion: 'abc123', totalCandidates: 526,
  positions: [{ position: 'Delegate', minVotes: 1, maxVotes: 5, totalSeats: 5, candidateCount: 526 }],
};
const PAGE = { eventId: 7, rosterVersion: 'abc123', total: 526, page: 1, pageSize: 50, totalPages: 11, items: [{ id: 1, candidateCode: 'REP-001', candidateName: 'ABAD, ANA', position: 'Delegate', ballotNumber: 1, hasPhoto: false, photoVersion: 0 }] };
const RECEIPT = { message: 'Your ballot has been recorded successfully.', eventId: 7, receiptCode: 'EVT07-0123ABCD-4567CDEF', votedAt: '2026-11-11T02:00:00Z', selectionCount: 2, alreadyProcessed: false, rosterChanged: false };
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);

const route = c => `${c.method} ${c.path}`;

/** The API as the tests need it. `handler(call)` may answer first (return a Response) or return undefined to get the normal answer. */
function fakeApi(t, handler = () => undefined) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(typeof input === 'string' ? input : input.url);
    const call = {
      method: init.method || 'GET', path: u.pathname.replace(/^\/api\/v1/, ''), query: u.search,
      headers: new Headers(init.headers), body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const custom = await handler(call, calls);
    if (custom !== undefined) return custom;
    const r = route(call);
    if (r === 'POST /auth/kiosk-login') return J(200, { accessToken: KIOSK_TOKEN, expiresIn: 28800, role: 'Kiosk' });
    if (r === 'POST /auth/voter-verify') return J(200, VERIFY_OK);
    if (/^GET \/events\/\d+\/representative-ballot$/.test(r)) return J(200, BALLOT);
    if (/^GET \/events\/\d+\/representative-candidates$/.test(r)) return J(200, PAGE);
    if (/^GET \/events\/\d+\/representative-candidates\/\d+\/photo$/.test(r)) return new Response(PNG, { status: 200, headers: { 'Content-Type': 'image/png' } });
    if (r === 'POST /representative-votes') return J(200, RECEIPT);
    return J(404, { error: 'unexpected call ' + r });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  return calls;
}

function makeEnv(extra = {}) {
  const assets = [];
  return {
    API_BASE: 'https://api.test', KIOSK_SECRET: SECRET, assets,
    ASSETS: { fetch: async req => { assets.push(new URL(req.url).pathname); return new Response('<!doctype html><title>x</title>', { headers: { 'Content-Type': 'text/html' } }); } },
    ...extra,
  };
}

/** One request to the worker. Every answer is also checked for the two things that must never leave it: the kiosk secret and the kiosk token. */
async function ask(w, env, method, path, { token, body, headers } = {}) {
  const init = { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers } };
  if (body !== undefined) { init.body = typeof body === 'string' ? body : JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
  const res = await w.fetch(new Request('https://vote.test' + path, init), env);
  const text = res.status === 204 || /^image\//.test(res.headers.get('Content-Type') || '') ? '' : await res.clone().text();
  assert.ok(!text.includes(SECRET) && !text.includes(KIOSK_TOKEN), 'the kiosk secret / token must never be in an answer: ' + path);
  for (const [, v] of res.headers) assert.ok(!v.includes(SECRET) && !v.includes(KIOSK_TOKEN), 'nor in a header');
  res.text_ = text;
  res.json_ = () => JSON.parse(text);
  return res;
}

const tick = () => new Promise(r => setImmediate(r));
function gate() { let open; const promise = new Promise(r => { open = r; }); return { promise, open }; }

/* ------------------------------------------------------------------ the allow-list */

test('/healthz answers without touching the API', async t => {
  const calls = fakeApi(t);
  const w = await freshWorker();
  const r = await ask(w, makeEnv(), 'GET', '/healthz');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json_(), { ok: true });
  assert.equal(calls.length, 0);
});

test('every route that is not on the list is 404 and never reaches the API', async t => {
  const calls = fakeApi(t);
  const w = await freshWorker();
  const env = makeEnv();
  const token = jwt();
  const paths = [
    ['GET', '/api/v1/events/7/candidates'],                      // the General Assembly list
    ['GET', '/api/v1/events/7/position-rules'],
    ['POST', '/api/v1/votes'],
    ['POST', '/api/v1/votes/offline-sync'],
    ['POST', '/api/v1/representative-votes/offline-sync'],       // kiosk only
    ['POST', '/api/v1/representative-votes/offline-sync-bulk'],
    ['GET', '/api/v1/events/7/representative-roster'],           // kiosk only
    ['GET', '/api/v1/events/7/representative-results'],
    ['GET', '/api/v1/admin/events'],
    ['POST', '/api/v1/auth/kiosk-login'],
    ['POST', '/api/v1/auth/admin-login'],
    ['GET', '/api/v1/events/current'],
    ['GET', '/api/v1/events/abc/representative-ballot'],
    ['GET', '/api/v1/events/1234567890/representative-ballot'],  // more than 9 digits
    ['GET', '/api/v1/events/7/representative-ballot/'],
    ['GET', '/api/v1/events/7/representative-candidates/'],
    ['GET', '/api/v1/events/7/representative-candidates/3/photo/x'],
    ['GET', '/api/v1/events/7/representative-candidates/x/photo'],
    ['GET', '/api/v1/events/7/representative-candidates/../../admin/events'],
    ['GET', '/api/v1/events/%2e%2e/representative-ballot'],
    ['GET', '/api/v1'],
    ['GET', '/api/'],
  ];
  for (const [m, p] of paths) {
    const r = await ask(w, env, m, p, { token, body: m === 'POST' ? {} : undefined });
    assert.equal(r.status, 404, `${m} ${p}`);
    assert.equal(r.json_().code, 'NOT_FOUND');
  }
  assert.equal(calls.length, 0, 'nothing was forwarded');
});

test('a listed route with the wrong method is 405 and never reaches the API', async t => {
  const calls = fakeApi(t);
  const w = await freshWorker();
  const env = makeEnv();
  const token = jwt();
  const cases = [
    ['GET', '/api/v1/auth/voter-verify', 'POST'], ['PUT', '/api/v1/auth/voter-verify', 'POST'],
    ['POST', '/api/v1/events/7/representative-ballot', 'GET'], ['DELETE', '/api/v1/events/7/representative-ballot', 'GET'],
    ['POST', '/api/v1/events/7/representative-candidates', 'GET'],
    ['POST', '/api/v1/events/7/representative-candidates/3/photo', 'GET'],
    ['GET', '/api/v1/representative-votes', 'POST'], ['PUT', '/api/v1/representative-votes', 'POST'],
  ];
  for (const [m, p, allow] of cases) {
    const r = await ask(w, env, m, p, { token, body: m === 'GET' ? undefined : {} });
    assert.equal(r.status, 405, `${m} ${p}`);
    assert.equal(r.headers.get('Allow'), allow);
  }
  assert.equal(calls.length, 0);
});

test('static files: the page is fetched from the assets, with the security headers; /favicon.ico is the png', async t => {
  const calls = fakeApi(t);
  const w = await freshWorker();
  const env = makeEnv();
  const home = await ask(w, env, 'GET', '/');
  assert.equal(home.status, 200);
  assert.equal(home.headers.get('X-Frame-Options'), 'DENY');
  assert.equal(home.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(home.headers.get('Referrer-Policy'), 'no-referrer');
  await ask(w, env, 'GET', '/favicon.ico');
  assert.deepEqual(env.assets, ['/', '/favicon.png']);
  assert.equal((await ask(w, env, 'POST', '/')).status, 405);
  assert.equal(calls.length, 0);
});

test('a missing static file is a 404 that is not cached', async t => {
  fakeApi(t);
  const w = await freshWorker();
  const env = makeEnv({ ASSETS: { fetch: async () => new Response('nope', { status: 404, headers: { 'Cache-Control': 'public, max-age=3600' } }) } });
  const r = await ask(w, env, 'GET', '/missing.js');
  assert.equal(r.status, 404);
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
});

/* ------------------------------------------------------------------ voter-verify */

test('verify: signs the kiosk in with the secret and id, asks the API, and hands the voter token to the page', async t => {
  const calls = fakeApi(t);
  const w = await freshWorker();
  const r = await ask(w, makeEnv(), 'POST', '/api/v1/auth/voter-verify', { body: { accountCode: '0001234' } });
  assert.equal(r.status, 200);
  const j = r.json_();
  assert.equal(j.event.eventType, 'REPRESENTATIVE');
  assert.equal(j.member.accountCode, '0001234');
  assert.ok(j.accessToken);
  assert.deepEqual(calls.map(route), ['POST /auth/kiosk-login', 'POST /auth/voter-verify']);
  assert.deepEqual(calls[0].body, { kioskId: 'MOBILE-REP-KIOSK-01', deviceSecret: SECRET });
  assert.equal(calls[1].headers.get('Authorization'), 'Bearer ' + KIOSK_TOKEN);
  assert.deepEqual(calls[1].body, { accountCode: '0001234' });
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
});

test('verify: KIOSK_ID and API_BASE come from the settings', async t => {
  const calls = fakeApi(t);
  const w = await freshWorker();
  await ask(w, makeEnv({ KIOSK_ID: 'REP-PHONES', API_BASE: 'https://example.org/base///' }), 'POST', '/api/v1/auth/voter-verify', { body: { accountCode: 'A1' } });
  assert.equal(calls[0].body.kioskId, 'REP-PHONES');
});

test('verify: the account code is trimmed, collapsed and cut to 64 characters', async t => {
  const calls = fakeApi(t);
  const w = await freshWorker();
  const env = makeEnv();
  await ask(w, env, 'POST', '/api/v1/auth/voter-verify', { body: { accountCode: '  0001234 \n' } });
  assert.equal(calls.at(-1).body.accountCode, '0001234');
  await ask(w, env, 'POST', '/api/v1/auth/voter-verify', { body: { accountCode: 'X'.repeat(200) } });
  assert.equal(calls.at(-1).body.accountCode.length, 64);
});

test('verify: only the account code is passed on', async t => {
  const calls = fakeApi(t);
  const w = await freshWorker();
  await ask(w, makeEnv(), 'POST', '/api/v1/auth/voter-verify', { body: { accountCode: 'A1', eventId: 99, role: 'Admin', isEligible: true } });
  assert.deepEqual(calls.at(-1).body, { accountCode: 'A1' });
});

test('verify: a bad body is refused before the API is asked', async t => {
  const calls = fakeApi(t);
  const w = await freshWorker();
  const env = makeEnv();
  for (const body of ['', 'not json', '[]', '{"accountCode":""}', '{"accountCode":"   "}', '{"accountCode":123}', '{"other":1}', 'null']) {
    const r = await ask(w, env, 'POST', '/api/v1/auth/voter-verify', { body });
    assert.equal(r.status, 400, body);
    assert.equal(r.json_().code, 'VALIDATION');
  }
  const big = await ask(w, env, 'POST', '/api/v1/auth/voter-verify', { body: JSON.stringify({ accountCode: 'A', pad: 'x'.repeat(20000) }) });
  assert.equal(big.status, 413);
  assert.equal(calls.length, 0);
});

test('verify: the kiosk token is kept; twenty voters arriving at once cause one sign-in', async t => {
  const g = gate();
  const calls = fakeApi(t, call => (route(call) === 'POST /auth/kiosk-login' ? g.promise.then(() => undefined) : undefined));
  const w = await freshWorker();
  const env = makeEnv();
  const all = Array.from({ length: 20 }, (_, i) => ask(w, env, 'POST', '/api/v1/auth/voter-verify', { body: { accountCode: 'C' + i } }));
  await tick();
  g.open();
  const answers = await Promise.all(all);
  assert.ok(answers.every(r => r.status === 200));
  assert.equal(calls.filter(c => route(c) === 'POST /auth/kiosk-login').length, 1);
  await ask(w, env, 'POST', '/api/v1/auth/voter-verify', { body: { accountCode: 'later' } });
  assert.equal(calls.filter(c => route(c) === 'POST /auth/kiosk-login').length, 1, 'still the same token');
});

test('verify: a kiosk token that is about to expire is renewed', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const calls = fakeApi(t, call => (route(call) === 'POST /auth/kiosk-login' ? J(200, { accessToken: KIOSK_TOKEN, expiresIn: 600 }) : undefined));
  const w = await freshWorker();
  const env = makeEnv();
  const verify = () => ask(w, env, 'POST', '/api/v1/auth/voter-verify', { body: { accountCode: 'A1' } });
  await verify();
  t.mock.timers.tick(470 * 1000);          // 600 s minus the 120 s margin is 480 s
  await verify();
  assert.equal(calls.filter(c => route(c) === 'POST /auth/kiosk-login').length, 1);
  t.mock.timers.tick(20 * 1000);
  await verify();
  assert.equal(calls.filter(c => route(c) === 'POST /auth/kiosk-login').length, 2);
});

test('verify: a kiosk token the API no longer accepts is replaced once, then the voter goes through', async t => {
  let first = true;
  const calls = fakeApi(t, call => {
    if (route(call) === 'POST /auth/voter-verify' && first) { first = false; return J(401, { error: 'expired' }); }
    return undefined;
  });
  const w = await freshWorker();
  const r = await ask(w, makeEnv(), 'POST', '/api/v1/auth/voter-verify', { body: { accountCode: 'A1' } });
  assert.equal(r.status, 200);
  assert.deepEqual(calls.map(route), ['POST /auth/kiosk-login', 'POST /auth/voter-verify', 'POST /auth/kiosk-login', 'POST /auth/voter-verify']);
});

test('verify: when the API keeps refusing the kiosk, the page is told KIOSK_REFUSED (and nothing loops)', async t => {
  const calls = fakeApi(t, call => (route(call) === 'POST /auth/voter-verify' ? J(401, {}) : undefined));
  const w = await freshWorker();
  const r = await ask(w, makeEnv(), 'POST', '/api/v1/auth/voter-verify', { body: { accountCode: 'A1' } });
  assert.equal(r.status, 401);
  assert.equal(r.json_().code, 'KIOSK_REFUSED');
  assert.equal(calls.length, 4);
});

test('verify: a refused kiosk sign-in (wrong KIOSK_SECRET) is KIOSK_REFUSED and the secret is not echoed', async t => {
  fakeApi(t, call => (route(call) === 'POST /auth/kiosk-login' ? J(401, { error: 'Invalid kiosk credentials.' }) : undefined));
  const w = await freshWorker();
  const r = await ask(w, makeEnv(), 'POST', '/api/v1/auth/voter-verify', { body: { accountCode: 'A1' } });
  assert.equal(r.status, 401);
  assert.equal(r.json_().code, 'KIOSK_REFUSED');
});

test('verify: a kiosk sign-in the API throttles (429) is retried', async t => {
  let n = 0;
  const calls = fakeApi(t, call => (route(call) === 'POST /auth/kiosk-login' && n++ === 0 ? J(429, {}, { 'Retry-After': '0' }) : undefined));
  const w = await freshWorker();
  const r = await ask(w, makeEnv(), 'POST', '/api/v1/auth/voter-verify', { body: { accountCode: 'A1' } });
  assert.equal(r.status, 200);
  assert.equal(calls.filter(c => route(c) === 'POST /auth/kiosk-login').length, 2);
});

test('verify: an API that cannot be reached is 503 UPSTREAM_UNAVAILABLE with Retry-After', async t => {
  fakeApi(t, () => { throw new TypeError('fetch failed'); });
  const w = await freshWorker();
  const r = await ask(w, makeEnv(), 'POST', '/api/v1/auth/voter-verify', { body: { accountCode: 'A1' } });
  assert.equal(r.status, 503);
  assert.equal(r.json_().code, 'UPSTREAM_UNAVAILABLE');
  assert.ok(r.headers.get('Retry-After'));
});

test('verify: a General Assembly election is not voted here - no voter token is handed out', async t => {
  fakeApi(t, call => (route(call) === 'POST /auth/voter-verify' ? J(200, { ...VERIFY_OK, event: { ...VERIFY_OK.event, eventType: 'GENERAL_ASSEMBLY' } }) : undefined));
  const w = await freshWorker();
  const r = await ask(w, makeEnv(), 'POST', '/api/v1/auth/voter-verify', { body: { accountCode: 'A1' } });
  assert.equal(r.status, 409);
  const j = r.json_();
  assert.equal(j.code, 'WRONG_EVENT_TYPE');
  assert.equal(j.eventType, 'GENERAL_ASSEMBLY');
  assert.ok(!('accessToken' in j) && !r.text_.includes(VERIFY_OK.accessToken));
});

test('verify: an answer without an event type (an old API) is not accepted as a Representative election', async t => {
  fakeApi(t, call => (route(call) === 'POST /auth/voter-verify' ? J(200, { ...VERIFY_OK, event: { eventId: 7, title: 'x' } }) : undefined));
  const w = await freshWorker();
  const r = await ask(w, makeEnv(), 'POST', '/api/v1/auth/voter-verify', { body: { accountCode: 'A1' } });
  assert.equal(r.status, 409);
  assert.equal(r.json_().code, 'WRONG_EVENT_TYPE');
});

test('verify: the reasons a voter is turned away keep their status and get a stable code', async t => {
  const cases = [
    [404, { error: 'Member not found.' }, 'MEMBER_NOT_FOUND'],
    [404, { error: 'No election event is currently open.' }, 'NO_OPEN_EVENT'],
    [409, { error: 'Member has already voted in this election.' }, 'ALREADY_VOTED'],
    [422, { error: 'Member is not eligible to vote.', detail: 'Share capital below the minimum.' }, 'NOT_ELIGIBLE'],
    [403, { error: 'Branch not assigned to this election.', detail: "Branch 'Agoo Branch' is not participating in this event." }, 'BRANCH_NOT_PARTICIPATING'],
  ];
  for (const [status, body, code] of cases) {
    fakeApi(t, call => (route(call) === 'POST /auth/voter-verify' ? J(status, body) : undefined));
    const w = await freshWorker();
    const r = await ask(w, makeEnv(), 'POST', '/api/v1/auth/voter-verify', { body: { accountCode: 'A1' } });
    assert.equal(r.status, status);
    const j = r.json_();
    assert.equal(j.code, code);
    assert.equal(j.error, body.error);
    assert.equal(j.detail, body.detail);
  }
});

test('verify: a throttled answer (429, empty body) keeps its Retry-After', async t => {
  fakeApi(t, call => (route(call) === 'POST /auth/voter-verify' ? new Response(null, { status: 429, headers: { 'Retry-After': '7' } }) : undefined));
  const w = await freshWorker();
  const r = await ask(w, makeEnv(), 'POST', '/api/v1/auth/voter-verify', { body: { accountCode: 'A1' } });
  assert.equal(r.status, 429);
  assert.equal(r.json_().code, 'RATE_LIMITED');
  assert.equal(r.headers.get('Retry-After'), '7');
});

test('verify: a server error never shows its details', async t => {
  fakeApi(t, call => (route(call) === 'POST /auth/voter-verify' ? J(500, { error: 'System.NullReferenceException at EVoting.Api.Controllers.AuthController.VoterVerify line 12', stack: 'secret' }) : undefined));
  const w = await freshWorker();
  const r = await ask(w, makeEnv(), 'POST', '/api/v1/auth/voter-verify', { body: { accountCode: 'A1' } });
  assert.equal(r.status, 502);
  assert.equal(r.json_().code, 'UPSTREAM_ERROR');
  assert.ok(!/NullReference|secret|AuthController/.test(r.text_));
});

/* ------------------------------------------------------------------ the voter token */

test('every voter route wants a voter token that looks right and has not expired; nothing is asked of the API without one', async t => {
  const calls = fakeApi(t);
  const w = await freshWorker();
  const env = makeEnv();
  const expired = jwt(Math.floor(Date.now() / 1000) - 3600);
  const bad = [undefined, 'garbage', 'a.b.c', 'x'.repeat(40), expired, KIOSK_TOKEN, `${b64({ alg: 'none' })}.${b64({ no: 'exp' })}.${Buffer.from('signature-bytes-0123456789').toString('base64url')}`];
  const routes = [
    ['GET', '/api/v1/events/7/representative-ballot'], ['GET', '/api/v1/events/7/representative-candidates'],
    ['GET', '/api/v1/events/7/representative-candidates/3/photo'], ['POST', '/api/v1/representative-votes'],
  ];
  for (const token of bad) for (const [m, p] of routes) {
    const r = await ask(w, env, m, p, { token, body: m === 'POST' ? { eventId: 7, candidateIds: [1] } : undefined });
    assert.equal(r.status, 401, `${m} ${p} ${String(token).slice(0, 12)}`);
    assert.equal(r.json_().code, 'INVALID_TOKEN');
  }
  assert.equal(calls.length, 0);
});

test('a token that expired less than the 1 minute of skew ago is still passed to the API (which decides)', async t => {
  const calls = fakeApi(t);
  const w = await freshWorker();
  const r = await ask(w, makeEnv(), 'GET', '/api/v1/events/7/representative-ballot', { token: jwt(Math.floor(Date.now() / 1000) - 30) });
  assert.equal(r.status, 200);
  assert.equal(calls.length, 1);
});

/* ------------------------------------------------------------------ ballot */

test('ballot: asked with the VOTER token (never the kiosk token) and answered as the API says', async t => {
  const calls = fakeApi(t);
  const w = await freshWorker();
  const token = jwt();
  const r = await ask(w, makeEnv(), 'GET', '/api/v1/events/7/representative-ballot', { token });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json_(), BALLOT);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/events/7/representative-ballot');
  assert.equal(calls[0].headers.get('Authorization'), 'Bearer ' + token);
  assert.equal(r.headers.get('X-Cache'), 'MISS');
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
});

test('ballot: kept for 20 seconds at most, whatever CACHE_SECONDS says (it carries isVotingOpen and the server clock)', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const calls = fakeApi(t);
  const w = await freshWorker();
  const env = makeEnv({ CACHE_SECONDS: '300' });
  const get = () => ask(w, env, 'GET', '/api/v1/events/7/representative-ballot', { token: jwt() });
  assert.equal((await get()).headers.get('X-Cache'), 'MISS');
  t.mock.timers.tick(19_000);
  assert.equal((await get()).headers.get('X-Cache'), 'HIT');
  t.mock.timers.tick(2_000);
  assert.equal((await get()).headers.get('X-Cache'), 'MISS');
  assert.equal(calls.length, 2);
});

test('CACHE_SECONDS=0 switches the cache off', async t => {
  const calls = fakeApi(t);
  const w = await freshWorker();
  const env = makeEnv({ CACHE_SECONDS: '0' });
  for (let i = 0; i < 3; i++) await ask(w, env, 'GET', '/api/v1/events/7/representative-ballot', { token: jwt() });
  for (let i = 0; i < 3; i++) await ask(w, env, 'GET', '/api/v1/events/7/representative-candidates?page=1', { token: jwt() });
  assert.equal(calls.length, 6);
});

test('ballot: a refusal is passed on as it is and is not kept', async t => {
  let refuse = true;
  const calls = fakeApi(t, call => {
    if (/representative-ballot/.test(call.path) && refuse) return J(403, { error: 'Your voter session belongs to a different election.', code: 'TOKEN_MISMATCH' });
    return undefined;
  });
  const w = await freshWorker();
  const env = makeEnv();
  const r = await ask(w, env, 'GET', '/api/v1/events/7/representative-ballot', { token: jwt() });
  assert.equal(r.status, 403);
  assert.equal(r.json_().code, 'TOKEN_MISMATCH');
  refuse = false;
  assert.equal((await ask(w, env, 'GET', '/api/v1/events/7/representative-ballot', { token: jwt() })).status, 200);
  assert.equal(calls.length, 2);
});

test('ballot: a General Assembly election answers 409 WRONG_EVENT_TYPE through to the page', async t => {
  fakeApi(t, call => (/representative-ballot/.test(call.path) ? J(409, { error: 'This is a General Assembly election; it has no Representative ballot.', code: 'WRONG_EVENT_TYPE' }) : undefined));
  const w = await freshWorker();
  const r = await ask(w, makeEnv(), 'GET', '/api/v1/events/7/representative-ballot', { token: jwt() });
  assert.equal(r.status, 409);
  assert.equal(r.json_().code, 'WRONG_EVENT_TYPE');
});

test('ballot: while the API is down a copy of less than 2 minutes is shown, an older one is not', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  let down = false;
  fakeApi(t, () => { if (down) throw new TypeError('fetch failed'); return undefined; });
  const w = await freshWorker();
  const env = makeEnv();
  const get = () => ask(w, env, 'GET', '/api/v1/events/7/representative-ballot', { token: jwt() });
  await get();
  down = true;
  t.mock.timers.tick(60_000);
  const stale = await get();
  assert.equal(stale.status, 200);
  assert.equal(stale.headers.get('X-Cache'), 'STALE');
  t.mock.timers.tick(61_000);
  const gone = await get();
  assert.equal(gone.status, 503);
  assert.equal(gone.json_().code, 'UPSTREAM_UNAVAILABLE');
});

/* ------------------------------------------------------------------ candidates */

const candidateCalls = calls => calls.filter(c => /representative-candidates$/.test(c.path));

test('candidates: only the known parameters reach the API, in a fixed order, with sane values', async t => {
  const calls = fakeApi(t);
  const w = await freshWorker();
  const env = makeEnv({ CACHE_SECONDS: '0' });        // no cache, so that every question really reaches the API
  const get = (q, token = jwt()) => ask(w, env, 'GET', '/api/v1/events/7/representative-candidates' + q, { token });
  await get('');
  assert.equal(calls.at(-1).query, '?page=1&pageSize=50');
  await get('?foo=1&size=full&pageSize=100&page=3&token=abc');
  assert.equal(calls.at(-1).query, '?page=3&pageSize=100');
  await get('?page=0&pageSize=0');
  assert.equal(calls.at(-1).query, '?page=1&pageSize=50');
  await get('?page=abc&pageSize=9999');
  assert.equal(calls.at(-1).query, '?page=1&pageSize=50');
  await get('?page=2.5&pageSize=-4');
  assert.equal(calls.at(-1).query, '?page=1&pageSize=50');
  await get('?pageSize=200&page=100000');
  assert.equal(calls.at(-1).query, '?page=100000&pageSize=200');
  await get('?search=%20%20juan%20%20%0Adela%09cruz%20&position=%20Delegate%20');
  assert.equal(calls.at(-1).query, '?page=1&pageSize=50&position=Delegate&search=juan+dela+cruz');
  await get('?search=' + 'x'.repeat(300));
  assert.equal(new URLSearchParams(calls.at(-1).query).get('search').length, 100);
  await get('?search=%C3%91%C3%A1+%26+%3D+%3F');
  assert.equal(new URLSearchParams(calls.at(-1).query).get('search'), 'Ñá & = ?');
  await get('?search=&position=');
  assert.equal(calls.at(-1).query, '?page=1&pageSize=50');
});

test('candidates: the same question in another order is one cache entry; another question is another entry', async t => {
  const calls = fakeApi(t);
  const w = await freshWorker();
  const env = makeEnv();
  const get = q => ask(w, env, 'GET', '/api/v1/events/7/representative-candidates' + q, { token: jwt() });
  assert.equal((await get('?search=ana&page=1')).headers.get('X-Cache'), 'MISS');
  assert.equal((await get('?page=1&search=ana&junk=1')).headers.get('X-Cache'), 'HIT');
  assert.equal((await get('?page=2&search=ana')).headers.get('X-Cache'), 'MISS');
  assert.equal((await get('?page=1&search=ANA')).headers.get('X-Cache'), 'MISS');
  assert.equal((await get('?page=1&search=ana&position=Delegate')).headers.get('X-Cache'), 'MISS');
  assert.equal((await ask(w, env, 'GET', '/api/v1/events/8/representative-candidates?search=ana&page=1', { token: jwt() })).headers.get('X-Cache'), 'MISS');
  assert.equal(candidateCalls(calls).length, 5);
});

test('candidates: one answer serves every voter - the list is the same for all of them', async t => {
  const calls = fakeApi(t);
  const w = await freshWorker();
  const env = makeEnv();
  const a = await ask(w, env, 'GET', '/api/v1/events/7/representative-candidates?page=1', { token: jwt(undefined, { memberId: '1' }) });
  const b = await ask(w, env, 'GET', '/api/v1/events/7/representative-candidates?page=1', { token: jwt(undefined, { memberId: '2' }) });
  assert.equal(a.headers.get('X-Cache'), 'MISS');
  assert.equal(b.headers.get('X-Cache'), 'HIT');
  assert.deepEqual(b.json_(), PAGE);
  assert.equal(candidateCalls(calls).length, 1);
});

test('candidates: a page is kept for CACHE_SECONDS, a search result for 30 s at most', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const calls = fakeApi(t);
  const w = await freshWorker();
  const env = makeEnv();
  const get = q => ask(w, env, 'GET', '/api/v1/events/7/representative-candidates' + q, { token: jwt() });
  await get('?page=1');
  await get('?page=1&search=ana');
  t.mock.timers.tick(31_000);
  assert.equal((await get('?page=1')).headers.get('X-Cache'), 'HIT');
  assert.equal((await get('?page=1&search=ana')).headers.get('X-Cache'), 'MISS');
  t.mock.timers.tick(30_000);
  assert.equal((await get('?page=1')).headers.get('X-Cache'), 'MISS');
  assert.equal(candidateCalls(calls).length, 4);
});

test('candidates: ten voters asking for the same page at the same moment cost the API one call', async t => {
  const g = gate();
  const calls = fakeApi(t, call => (/representative-candidates$/.test(call.path) ? g.promise.then(() => undefined) : undefined));
  const w = await freshWorker();
  const env = makeEnv();
  const all = Array.from({ length: 10 }, (_, i) => ask(w, env, 'GET', '/api/v1/events/7/representative-candidates?page=1', { token: jwt(undefined, { memberId: String(i) }) }));
  await tick();
  g.open();
  const answers = await Promise.all(all);
  assert.ok(answers.every(r => r.status === 200 && r.json_().total === 526));
  assert.equal(candidateCalls(calls).length, 1);
});

test('candidates: a refusal of the first voter is not given to the voters who asked at the same time', async t => {
  const g = gate();
  const tokenA = jwt(undefined, { memberId: 'A' });
  const tokenB = jwt(undefined, { memberId: 'B' });
  const calls = fakeApi(t, async call => {
    if (!/representative-candidates$/.test(call.path)) return undefined;
    await g.promise;
    return call.headers.get('Authorization') === 'Bearer ' + tokenA ? J(401, { error: 'Unauthorized' }) : undefined;
  });
  const w = await freshWorker();
  const env = makeEnv();
  const a = ask(w, env, 'GET', '/api/v1/events/7/representative-candidates?page=1', { token: tokenA });
  await tick();
  const b = ask(w, env, 'GET', '/api/v1/events/7/representative-candidates?page=1', { token: tokenB });
  await tick();
  g.open();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.status, 401);
  assert.equal(rb.status, 200);
  assert.equal(candidateCalls(calls).length, 2);
});

test('candidates: while the API is down a copy of less than 10 minutes is shown', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  let down = false;
  fakeApi(t, () => { if (down) throw new TypeError('fetch failed'); return undefined; });
  const w = await freshWorker();
  const env = makeEnv();
  const get = () => ask(w, env, 'GET', '/api/v1/events/7/representative-candidates?page=1', { token: jwt() });
  await get();
  down = true;
  t.mock.timers.tick(9 * 60_000);
  const stale = await get();
  assert.equal(stale.status, 200);
  assert.equal(stale.headers.get('X-Cache'), 'STALE');
  t.mock.timers.tick(2 * 60_000);
  assert.equal((await get()).status, 503);
});

test('candidates: a server error shows the stale copy; an error of the voter (4xx) never does', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  let mode = 'ok';
  fakeApi(t, call => {
    if (!/representative-candidates$/.test(call.path)) return undefined;
    if (mode === '500') return J(500, { error: 'boom' });
    if (mode === '403') return J(403, { error: 'Your voter session belongs to a different election.', code: 'TOKEN_MISMATCH' });
    return undefined;
  });
  const w = await freshWorker();
  const env = makeEnv();
  const get = () => ask(w, env, 'GET', '/api/v1/events/7/representative-candidates?page=1', { token: jwt() });
  await get();
  t.mock.timers.tick(61_000);
  mode = '500';
  assert.equal((await get()).headers.get('X-Cache'), 'STALE');
  mode = '403';
  const denied = await get();
  assert.equal(denied.status, 403);
  assert.equal(denied.json_().code, 'TOKEN_MISMATCH');
});

test('candidates: something that is not JSON is neither kept nor passed on', async t => {
  const calls = fakeApi(t, call => (/representative-candidates$/.test(call.path) ? new Response('<html>gateway</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }) : undefined));
  const w = await freshWorker();
  const env = makeEnv();
  const r = await ask(w, env, 'GET', '/api/v1/events/7/representative-candidates?page=1', { token: jwt() });
  assert.equal(r.status, 503);
  await ask(w, env, 'GET', '/api/v1/events/7/representative-candidates?page=1', { token: jwt() });
  assert.equal(candidateCalls(calls).length, 2);
});

test('the cache stays bounded: the oldest entries go first', async t => {
  const calls = fakeApi(t);
  const w = await freshWorker();
  const env = makeEnv();
  const get = page => ask(w, env, 'GET', `/api/v1/events/7/representative-candidates?page=${page}`, { token: jwt() });
  for (let p = 1; p <= 650; p++) await get(p);
  assert.equal((await get(650)).headers.get('X-Cache'), 'HIT');
  assert.equal((await get(1)).headers.get('X-Cache'), 'MISS');
  assert.equal(candidateCalls(calls).length, 651);
});

/* ------------------------------------------------------------------ photos */

test('photo: the thumbnail is asked for (whatever the page says), delivered as an image, and kept', async t => {
  const calls = fakeApi(t);
  const w = await freshWorker();
  const env = makeEnv();
  const get = () => ask(w, env, 'GET', '/api/v1/events/7/representative-candidates/3/photo?size=full&v=638000000', { token: jwt() });
  const first = await get();
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('Content-Type'), 'image/png');
  assert.equal(first.headers.get('Cache-Control'), 'private, max-age=86400');
  assert.equal(first.headers.get('X-Cache'), 'MISS');
  assert.deepEqual(new Uint8Array(await first.arrayBuffer()), PNG);
  assert.equal(calls.at(-1).path, '/events/7/representative-candidates/3/photo');
  assert.equal(calls.at(-1).query, '?size=thumb');
  const second = await get();
  assert.equal(second.headers.get('X-Cache'), 'HIT');
  assert.deepEqual(new Uint8Array(await second.arrayBuffer()), PNG);
  assert.equal(calls.length, 1);
});

test('photo: another version stamp is another picture; without a stamp the browser may keep it for 5 minutes only', async t => {
  const calls = fakeApi(t);
  const w = await freshWorker();
  const env = makeEnv();
  await ask(w, env, 'GET', '/api/v1/events/7/representative-candidates/3/photo?v=1', { token: jwt() });
  await ask(w, env, 'GET', '/api/v1/events/7/representative-candidates/3/photo?v=2', { token: jwt() });
  const bare = await ask(w, env, 'GET', '/api/v1/events/7/representative-candidates/3/photo?v=abc', { token: jwt() });
  assert.equal(bare.headers.get('Cache-Control'), 'private, max-age=300');
  assert.equal(calls.length, 3);
});

test('photo: a candidate without a picture is a plain 204', async t => {
  fakeApi(t, call => (/photo$/.test(call.path) ? new Response(null, { status: 204 }) : undefined));
  const w = await freshWorker();
  const r = await ask(w, makeEnv(), 'GET', '/api/v1/events/7/representative-candidates/3/photo?v=0', { token: jwt() });
  assert.equal(r.status, 204);
  assert.equal(await r.text(), '');
});

test('photo: only pictures are delivered; a big one is delivered but not kept', async t => {
  let kind = 'html';
  const calls = fakeApi(t, call => {
    if (!/photo$/.test(call.path)) return undefined;
    if (kind === 'html') return new Response('<script>alert(1)</script>', { status: 200, headers: { 'Content-Type': 'text/html' } });
    return new Response(new Uint8Array(300 * 1024), { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
  });
  const w = await freshWorker();
  const env = makeEnv();
  const get = () => ask(w, env, 'GET', '/api/v1/events/7/representative-candidates/3/photo?v=1', { token: jwt() });
  assert.equal((await get()).status, 502);
  kind = 'big';
  const big = await get();
  assert.equal(big.status, 200);
  assert.equal((await big.arrayBuffer()).byteLength, 300 * 1024);
  assert.equal((await get()).headers.get('X-Cache'), 'MISS');
  assert.equal(calls.length, 3);
});

test('photo: an unknown candidate is a 404 from the API, passed on', async t => {
  fakeApi(t, call => (/photo$/.test(call.path) ? J(404, { error: 'Candidate not found.', code: 'NOT_FOUND' }) : undefined));
  const w = await freshWorker();
  const r = await ask(w, makeEnv(), 'GET', '/api/v1/events/7/representative-candidates/3/photo?v=1', { token: jwt() });
  assert.equal(r.status, 404);
});

/* ------------------------------------------------------------------ casting the ballot */

const BALLOT_BODY = { eventId: 7, candidateIds: [3, 5], receiptCode: 'EVT07-0123ABCD-4567CDEF', rosterVersion: 'abc123' };

test('vote: asked with the voter token; only the known fields go on; the answer is the API receipt', async t => {
  const calls = fakeApi(t);
  const w = await freshWorker();
  const token = jwt();
  const r = await ask(w, makeEnv(), 'POST', '/api/v1/representative-votes', { token, body: { ...BALLOT_BODY, position: 'Delegate', memberId: 99, isEligible: true, selections: [{ candidacyId: 3 }] } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json_(), RECEIPT);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.get('Authorization'), 'Bearer ' + token);
  assert.deepEqual(calls[0].body, BALLOT_BODY);
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
});

test('vote: the receipt code and the roster version are optional', async t => {
  const calls = fakeApi(t);
  const w = await freshWorker();
  const r = await ask(w, makeEnv(), 'POST', '/api/v1/representative-votes', { token: jwt(), body: { eventId: 7, candidateIds: [3] } });
  assert.equal(r.status, 200);
  assert.deepEqual(calls[0].body, { eventId: 7, candidateIds: [3] });
});

test('vote: a ballot that is not in the expected form is refused before the API is asked', async t => {
  const calls = fakeApi(t);
  const w = await freshWorker();
  const env = makeEnv();
  const token = jwt();
  const ids = n => Array.from({ length: n }, (_, i) => i + 1);
  const bad = [
    {}, { eventId: 7 }, { candidateIds: [1] }, { eventId: '7', candidateIds: [1] }, { eventId: 0, candidateIds: [1] }, { eventId: 1.5, candidateIds: [1] },
    { eventId: 7, candidateIds: [] }, { eventId: 7, candidateIds: 'all' }, { eventId: 7, candidateIds: [1, '2'] }, { eventId: 7, candidateIds: [1.5] },
    { eventId: 7, candidateIds: [0] }, { eventId: 7, candidateIds: [-3] }, { eventId: 7, candidateIds: [1, null] }, { eventId: 7, candidateIds: [2147483648] },
    { eventId: 7, candidateIds: ids(501) },
    { ...BALLOT_BODY, receiptCode: 'EVT07 0123' }, { ...BALLOT_BODY, receiptCode: 'x'.repeat(31) }, { ...BALLOT_BODY, receiptCode: 5 },
    { ...BALLOT_BODY, rosterVersion: 'ab c' }, { ...BALLOT_BODY, rosterVersion: 'z'.repeat(65) },
    [], 'text', null,
  ];
  for (const body of bad) {
    const r = await ask(w, env, 'POST', '/api/v1/representative-votes', { token, body: typeof body === 'string' ? body : JSON.stringify(body) });
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
    assert.equal(r.json_().code, 'VALIDATION');
  }
  const ok = await ask(w, env, 'POST', '/api/v1/representative-votes', { token, body: { eventId: 7, candidateIds: ids(500) } });
  assert.equal(ok.status, 200, '500 selections are allowed');
  assert.equal(calls.length, 1);
  const huge = await ask(w, env, 'POST', '/api/v1/representative-votes', { token, body: JSON.stringify({ eventId: 7, candidateIds: Array.from({ length: 4000 }, (_, i) => 1000000 + i) }) });
  assert.equal(huge.status, 413);
  assert.equal(calls.length, 1);
});

test('vote: what the API refuses is told to the page with its status and code', async t => {
  const cases = [
    [409, { error: 'This member has already voted in this election.', code: 'ALREADY_VOTED' }],
    [422, { error: "'Delegate' requires at least 1 selection(s); 0 were submitted.", code: 'BELOW_MINIMUM' }],
    [422, { error: "'Delegate' allows at most 5 selection(s); 6 were submitted.", code: 'ABOVE_MAXIMUM' }],
    [403, { error: 'Your voter session belongs to a different election.', code: 'TOKEN_MISMATCH' }],
    [409, { error: 'Voting has already ended for this election.', code: 'OUTSIDE_VOTING_WINDOW' }],
    [503, { error: 'The server is busy and did not record this ballot. Nothing was saved - please submit it again in a moment.', code: 'TEMPORARY_FAILURE' }],
    [409, { error: 'That receipt code is already in use by another ballot.', code: 'RECEIPT_IN_USE' }],
  ];
  for (const [status, body] of cases) {
    fakeApi(t, call => (route(call) === 'POST /representative-votes' ? J(status, body) : undefined));
    const w = await freshWorker();
    const r = await ask(w, makeEnv(), 'POST', '/api/v1/representative-votes', { token: jwt(), body: BALLOT_BODY });
    assert.equal(r.status, status);
    assert.equal(r.json_().code, body.code);
    assert.equal(r.json_().error, body.error);
  }
});

test('vote: a throttled ballot (429) can be sent again later', async t => {
  fakeApi(t, call => (route(call) === 'POST /representative-votes' ? new Response(null, { status: 429, headers: { 'Retry-After': '5' } }) : undefined));
  const w = await freshWorker();
  const r = await ask(w, makeEnv(), 'POST', '/api/v1/representative-votes', { token: jwt(), body: BALLOT_BODY });
  assert.equal(r.status, 429);
  assert.equal(r.json_().code, 'RATE_LIMITED');
  assert.equal(r.headers.get('Retry-After'), '5');
});

test('vote: a server error does not show its details', async t => {
  fakeApi(t, call => (route(call) === 'POST /representative-votes' ? J(500, { error: 'MySqlConnector.MySqlException: Deadlock found', detail: 'secret' }) : undefined));
  const w = await freshWorker();
  const r = await ask(w, makeEnv(), 'POST', '/api/v1/representative-votes', { token: jwt(), body: BALLOT_BODY });
  assert.equal(r.status, 502);
  assert.equal(r.json_().code, 'UPSTREAM_ERROR');
  assert.ok(!/MySql|Deadlock|secret/.test(r.text_));
});

test('vote: an API that cannot be reached is one attempt, then 503 - the page retries with the same receipt, the worker never repeats a ballot', async t => {
  const calls = fakeApi(t, call => { if (route(call) === 'POST /representative-votes') throw new TypeError('fetch failed'); return undefined; });
  const w = await freshWorker();
  const r = await ask(w, makeEnv(), 'POST', '/api/v1/representative-votes', { token: jwt(), body: BALLOT_BODY });
  assert.equal(r.status, 503);
  assert.equal(r.json_().code, 'UPSTREAM_UNAVAILABLE');
  assert.equal(calls.filter(c => route(c) === 'POST /representative-votes').length, 1);
});

test('vote: an answer without a receipt code is not passed on as a success', async t => {
  fakeApi(t, call => (route(call) === 'POST /representative-votes' ? J(200, { message: 'ok' }) : undefined));
  const w = await freshWorker();
  const r = await ask(w, makeEnv(), 'POST', '/api/v1/representative-votes', { token: jwt(), body: BALLOT_BODY });
  assert.equal(r.status, 502);
});

test('vote: a replayed ballot (same receipt) is a normal success with alreadyProcessed', async t => {
  fakeApi(t, call => (route(call) === 'POST /representative-votes' ? J(200, { ...RECEIPT, alreadyProcessed: true, message: 'This ballot was already recorded - no action needed.' }) : undefined));
  const w = await freshWorker();
  const r = await ask(w, makeEnv(), 'POST', '/api/v1/representative-votes', { token: jwt(), body: BALLOT_BODY });
  assert.equal(r.status, 200);
  assert.equal(r.json_().alreadyProcessed, true);
});

test('vote: ballots are never cached or shared', async t => {
  const calls = fakeApi(t);
  const w = await freshWorker();
  const env = makeEnv();
  await ask(w, env, 'POST', '/api/v1/representative-votes', { token: jwt(), body: BALLOT_BODY });
  await ask(w, env, 'POST', '/api/v1/representative-votes', { token: jwt(), body: BALLOT_BODY });
  assert.equal(calls.length, 2);
});

/* ------------------------------------------------------------------ the worker itself never falls over */

test('an unexpected failure inside the worker is a plain 500 without details', async t => {
  fakeApi(t);
  const w = await freshWorker();
  const env = makeEnv({ ASSETS: { fetch: async () => { throw new Error('internal detail ' + SECRET); } } });
  const orig = console.error;
  console.error = () => {};
  try {
    const res = await w.fetch(new Request('https://vote.test/'), env);
    assert.equal(res.status, 500);
    assert.ok(!(await res.text()).includes('internal detail'));
  } finally { console.error = orig; }
});
