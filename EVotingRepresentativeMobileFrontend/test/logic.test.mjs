import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

/* public/logic.js is a plain browser script that puts RepLogic on `window`; it is run here as the page runs it (same realm, so deepStrictEqual works). */
const source = readFileSync(new URL('../public/logic.js', import.meta.url), 'utf8');
const fakeWindow = { crypto: webcrypto };
new Function('window', source)(fakeWindow);
const L = fakeWindow.RepLogic;

const card = (id, position = 'Delegate', extra = {}) => ({ id, candidateName: 'N' + id, position, ...extra });
const group = (name, min, max, count = 50) => ({ key: L.key(name), name, min, max, seats: max, count });

/* ---------------------------------------------------------------- text */

test('key compares positions the way the server does: trimmed, no case', () => {
  assert.equal(L.key('  Delegate '), 'delegate');
  assert.equal(L.key(null), '');
  assert.equal(L.key(undefined), '');
});

test('oneLine collapses white space, drops control characters and cuts', () => {
  assert.equal(L.oneLine('  Juan \n\t Dela   Cruz  '), 'Juan Dela Cruz');
  assert.equal(L.oneLine('a\u0000b\u007fc'), 'a b c');
  assert.equal(L.oneLine('x'.repeat(500), 100).length, 100);
  assert.equal(L.oneLine(null), '');
});

test('a search starts from one digit (a ballot number) or two letters', () => {
  assert.equal(L.searchable('7'), true);
  assert.equal(L.searchable('0012'), true);
  assert.equal(L.searchable('a'), false);
  assert.equal(L.searchable('ab'), true);
  assert.equal(L.searchable(''), false);
  assert.equal(L.searchable('a1'), true);
});

test('initials for a photo that cannot be shown', () => {
  assert.equal(L.initials('DELA CRUZ, JUAN'), 'DC');
  assert.equal(L.initials('Juan'), 'J');
  assert.equal(L.initials('ñoño peña'), 'ÑP');
  assert.equal(L.initials(''), '?');
  assert.equal(L.initials('   '), '?');
});

/* ---------------------------------------------------------------- rules of a position */

test('nobody is asked for more choices than there are candidates', () => {
  assert.equal(L.effectiveMin({ minVotes: 3, candidateCount: 2 }), 2);
  assert.equal(L.effectiveMin({ minVotes: 1, candidateCount: 526 }), 1);
  assert.equal(L.effectiveMin({ minVotes: 0, candidateCount: 10 }), 0);
  assert.equal(L.effectiveMin({ minVotes: -2, candidateCount: 10 }), 0);
  assert.equal(L.effectiveMin({ minVotes: 2, candidateCount: 0 }), 0);
  assert.equal(L.effectiveMin({}), 0);
});

test('the groups of the ballot: rule order, only positions that have candidates', () => {
  const g = L.groupsFromBallot({ positions: [
    { position: 'Delegate', minVotes: 1, maxVotes: 5, totalSeats: 5, candidateCount: 526 },
    { position: 'Alternate', minVotes: 2, maxVotes: 3, totalSeats: 2, candidateCount: 0 },
    { position: ' Observer ', minVotes: 3, maxVotes: 4, totalSeats: 1, candidateCount: 2 },
  ] });
  assert.deepEqual(g.map(x => [x.name, x.key, x.min, x.max, x.count]), [['Delegate', 'delegate', 1, 5, 526], [' Observer ', 'observer', 2, 4, 2]]);
  assert.deepEqual(L.groupsFromBallot(null), []);
  assert.deepEqual(L.groupsFromBallot({}), []);
  assert.equal(L.groupsFromBallot({ positions: [{ position: 'X', minVotes: 0, maxVotes: 0, candidateCount: 3 }] })[0].max, 1, 'a position always allows at least one choice');
});

test('the line under the position name', () => {
  assert.equal(L.ruleText(group('D', 1, 1)), 'Pumili ng 1');
  assert.equal(L.ruleText(group('D', 5, 5)), 'Pumili ng 5');
  assert.equal(L.ruleText(group('D', 0, 5)), 'Hanggang 5 ang pwedeng piliin');
  assert.equal(L.ruleText(group('D', 1, 5)), 'Pumili ng 1 hanggang 5');
  assert.equal(L.ruleText(group('D', 2, 3)), 'Pumili ng 2 hanggang 3');
});

/* ---------------------------------------------------------------- standing of the ballot */

test('standing: nothing chosen, a missing minimum, ready', () => {
  const groups = [group('Delegate', 1, 5), group('Alternate', 0, 2)];
  const sel = new Map();
  let s = L.standing(groups, sel);
  assert.deepEqual([s.missing, s.total, s.ready, s.label], [1, 0, false, 'Kulang pa ang napili sa Delegate']);
  sel.set(1, card(1, 'Delegate'));
  s = L.standing(groups, sel);
  assert.deepEqual([s.missing, s.total, s.ready, s.label, s.counts], [0, 1, true, 'Suriin ang boto (1)', [1, 0]]);
  sel.clear();
  sel.set(9, card(9, 'Alternate'));
  s = L.standing(groups, sel);
  assert.deepEqual([s.missing, s.ready, s.label], [1, false, 'Kulang pa ang napili sa Delegate']);
});

test('standing: when no position has a minimum, one choice on the whole ballot is still needed', () => {
  const groups = [group('Delegate', 0, 5)];
  const sel = new Map();
  let s = L.standing(groups, sel);
  assert.deepEqual([s.missing, s.ready, s.label], [0, false, 'Pumili ng kahit isa']);
  sel.set(1, card(1));
  s = L.standing(groups, sel);
  assert.deepEqual([s.ready, s.label], [true, 'Suriin ang boto (1)']);
});

test('standing: counts every position and says how many lack their minimum', () => {
  const groups = [group('A', 2, 3), group('B', 1, 1), group('C', 0, 2)];
  const sel = new Map([[1, card(1, 'A')], [2, card(2, 'B')], [3, card(3, 'c')]]);
  const s = L.standing(groups, sel);
  assert.deepEqual(s.counts, [1, 1, 1]);
  assert.equal(s.missing, 1);
  assert.equal(s.label, 'Kulang pa ang napili sa A');
  // two positions lack their minimum: the first is named, the rest are counted
  const two = L.standing([group('Delegate', 1, 3), group('Alternate', 1, 1), group('Auditor', 1, 1)], new Map([[1, card(1, 'Auditor')]]));
  assert.deepEqual([two.missing, two.ready, two.label], [2, false, 'Kulang pa ang napili sa Delegate at 1 pa']);
});

test('account code: spaces, dots and dashes copied from a card are dropped; letters are left alone', () => {
  assert.equal(L.cleanAccountCode('11112222333344'), '11112222333344');
  assert.equal(L.cleanAccountCode(' 1111 2222 333344 '), '11112222333344');
  assert.equal(L.cleanAccountCode('1111-2222-333344'), '11112222333344');
  assert.equal(L.cleanAccountCode('1111.2222.333344'), '11112222333344');
  assert.equal(L.cleanAccountCode('1111\u00A02222\t333344'), '11112222333344');
  assert.equal(L.cleanAccountCode('ZZ-NO-SUCH CODE'), 'ZZ-NO-SUCHCODE', 'a code with letters keeps its dashes, only blanks go');
  assert.equal(L.cleanAccountCode('   '), '');
  assert.equal(L.cleanAccountCode('- - -'), '', 'nothing but separators is an empty code');
  assert.equal(L.cleanAccountCode(null), '');
  assert.equal(L.cleanAccountCode('1'.repeat(200)).length, 64, 'at most 64 characters');
});

test('a tap too many: the message says the limit and what to do', () => {
  const t = L.fullText({ name: 'Delegate', max: 3 });
  assert.match(t, /^Hanggang 3 lang ang pwede sa Delegate\./);
  assert.match(t, /Alisin muna ang isa/);
});

/* ---------------------------------------------------------------- a tap */

test('a tap adds and takes off, up to the maximum', () => {
  const g = group('Delegate', 1, 3);
  const sel = new Map();
  assert.equal(L.toggle(sel, g, card(1)).action, 'added');
  assert.equal(L.toggle(sel, g, card(2)).action, 'added');
  assert.equal(L.toggle(sel, g, card(3)).action, 'added');
  assert.deepEqual(L.toggle(sel, g, card(4)), { action: 'full', max: 3 });
  assert.deepEqual([...sel.keys()], [1, 2, 3], 'nothing changed');
  assert.equal(L.toggle(sel, g, card(2)).action, 'removed');
  assert.equal(L.toggle(sel, g, card(4)).action, 'added');
  assert.deepEqual([...sel.keys()], [1, 3, 4]);
});

test('a position with one choice swaps it, and only in its own position', () => {
  const one = group('President', 1, 1);
  const many = group('Delegate', 1, 5);
  const sel = new Map();
  L.toggle(sel, many, card(10, 'Delegate'));
  L.toggle(sel, one, card(1, 'President'));
  L.toggle(sel, one, card(2, 'president '));
  assert.deepEqual([...sel.keys()], [10, 2]);
  assert.equal(L.toggle(sel, one, card(2, 'President')).action, 'removed');
  assert.deepEqual([...sel.keys()], [10]);
});

test('positions are told apart by their key (case and spaces do not matter)', () => {
  const g = group('Delegate', 1, 2);
  const sel = new Map([[1, card(1, ' DELEGATE')], [2, card(2, 'delegate ')]]);
  assert.equal(L.countIn(sel, g), 2);
  assert.equal(L.toggle(sel, g, card(3, 'Delegate')).action, 'full');
});

test('the choices of a position come back in the order they were made', () => {
  const g = group('Delegate', 1, 5);
  const sel = new Map();
  for (const id of [5, 2, 9]) L.toggle(sel, g, card(id));
  L.toggle(sel, group('Other', 0, 1), card(77, 'Other'));
  assert.deepEqual(L.pickedOf(sel, g).map(c => c.id), [5, 2, 9]);
});

test('a page that overlaps the one before adds each candidate once', () => {
  const items = [card(1), card(2)];
  L.mergeItems(items, [card(2), card(3), card(3), card(4)]);
  assert.deepEqual(items.map(c => c.id), [1, 2, 3, 4]);
});

test('details a voter may read, in order, without the empty ones', () => {
  const d = L.detailsOf({ reason: '  Para sa   lahat ', highestEducation: 'BS Accountancy', previousPositions: '', specialSkills: null });
  assert.deepEqual(d, [['Dahilan sa pagtakbo', 'Para sa lahat'], ['Edukasyon', 'BS Accountancy']]);
  assert.deepEqual(L.detailsOf({}), []);
  assert.equal(L.numberLabel({ ballotNumber: 12 }), 'No. 12');
  assert.equal(L.numberLabel({ ballotNumber: null }), '');
  assert.equal(L.numberLabel({}), '');
});

/* ---------------------------------------------------------------- receipt code */

test('the receipt code has the shape the API accepts', () => {
  for (const id of [1, 7, 12, 123, 100000, 999999999]) {
    const code = L.newReceiptCode(id);
    assert.match(code, L.RECEIPT_RE, code);
    assert.ok(code.length <= 30, code);
    assert.equal(Number(/^EVT(\d+)-/.exec(code)[1]), id);
  }
  assert.match(L.newReceiptCode(7), /^EVT07-[0-9A-F]{8}-[0-9A-F]{8}$/);
});

test('the receipt code is random and uses the bytes it is given (upper case, two digits each)', () => {
  assert.equal(L.newReceiptCode(7, () => Uint8Array.from([0, 1, 2, 171, 172, 205, 239, 255])), 'EVT07-000102AB-ACCDEFFF');
  const codes = new Set(Array.from({ length: 200 }, () => L.newReceiptCode(7)));
  assert.equal(codes.size, 200);
});

test('the same choices keep the same receipt code; other choices get a new one', () => {
  const a = L.attemptFor(null, 7, [3, 1, 2]);
  assert.equal(a.key, '1,2,3');
  assert.match(a.receipt, L.RECEIPT_RE);
  assert.equal(L.attemptFor(a, 7, [2, 3, 1]), a, 'a retry of the same ballot');
  const b = L.attemptFor(a, 7, [1, 2, 4]);
  assert.notEqual(b.receipt, a.receipt);
  assert.equal(b.key, '1,2,4');
  assert.equal(L.attemptFor(b, 7, [1, 2, 3]).key, '1,2,3', 'changing back is a new attempt: the first one was a different ballot');
});

test('the ballot body: sorted ids, the receipt, the roster version when there is one', () => {
  assert.deepEqual(L.voteBody(7, [5, 3], 'EVT07-0123ABCD-4567CDEF', 'abc'), { eventId: 7, candidateIds: [3, 5], receiptCode: 'EVT07-0123ABCD-4567CDEF', rosterVersion: 'abc' });
  assert.deepEqual(Object.keys(L.voteBody(7, [1], 'EVT07-0123ABCD-4567CDEF', '')), ['eventId', 'candidateIds', 'receiptCode']);
  const ids = [9, 1];
  L.voteBody(7, ids, 'x');
  assert.deepEqual(ids, [9, 1], 'the caller list is not changed');
});

/* ---------------------------------------------------------------- waiting */

test('waiting before trying again', () => {
  assert.equal(L.retryDelay(0, 0, () => 0), 1500);
  assert.equal(L.retryDelay(1, 0, () => 0), 3000);
  assert.equal(L.retryDelay(2, 0, () => 0), 6000);
  assert.equal(L.retryDelay(9, 0, () => 0), 6000);
  assert.equal(L.retryDelay(0, 2, () => 0), 2000);
  assert.equal(L.retryDelay(0, 60, () => 0), 8000);
  assert.equal(L.retryDelay(0, 0, () => 0.999), 1999);
  const d = L.retryDelay(0);
  assert.ok(d >= 1500 && d < 2000);
});

/* ---------------------------------------------------------------- the words */

test('signing in: every reason a voter is turned away', () => {
  const d = L.describeVerifyError;
  assert.deepEqual(d({ net: true }), { kind: 'inline', msg: 'Walang koneksyon sa server. Subukan ulit.' });
  assert.equal(d({ empty: true }).msg, 'Wala pang kandidato sa halalang ito.');
  assert.equal(d({ status: 401, code: 'KIOSK_REFUSED' }).msg, 'Hindi tinanggap ng server ang kiosk credentials.');
  assert.equal(d({ status: 401 }).msg, 'Hindi tinanggap ng server ang kiosk credentials.');
  assert.equal(d({ status: 400, code: 'VALIDATION' }).kind, 'inline');
  const cases = {
    NO_OPEN_EVENT: 'Walang bukas na halalan', MEMBER_NOT_FOUND: 'Hindi nahanap ang account code', ALREADY_VOTED: 'Nakaboto ka na',
    NOT_ELIGIBLE: 'Hindi ka maaaring bumoto', BRANCH_NOT_PARTICIPATING: 'Hindi kasama ang branch mo', WRONG_EVENT_TYPE: 'Hindi ito ang halalan ng mga Representative',
    RATE_LIMITED: 'Sandali lang',
  };
  for (const [code, title] of Object.entries(cases)) {
    const r = d({ status: 400, code });
    assert.equal(r.kind, 'screen', code);
    assert.equal(r.title, title, code);
  }
});

test('signing in: the status tells the same when there is no code (an older server)', () => {
  const d = L.describeVerifyError;
  assert.equal(d({ status: 404 }).title, 'Hindi nahanap ang account code');
  assert.equal(d({ status: 409 }).title, 'Nakaboto ka na');
  assert.equal(d({ status: 422 }).title, 'Hindi ka maaaring bumoto');
  assert.equal(d({ status: 403 }).title, 'Hindi kasama ang branch mo');
  assert.equal(d({ status: 429 }).title, 'Sandali lang');
  assert.deepEqual(d({ status: 500 }), { kind: 'inline', msg: 'May problema sa server. Subukan ulit.' });
  assert.deepEqual(d({ status: 503, code: 'UPSTREAM_UNAVAILABLE' }), { kind: 'inline', msg: 'May problema sa server. Subukan ulit.' });
  assert.deepEqual(d({}), { kind: 'inline', msg: 'May problema sa server. Subukan ulit.' });
  assert.equal(d({ status: 418, msg: 'Teapot' }).msg, 'Teapot');
});

test('signing in: the reason of the cooperative is shown to a member who is not eligible', () => {
  const r = L.describeVerifyError({ status: 422, code: 'NOT_ELIGIBLE', detail: 'Share capital is below the minimum.' });
  assert.equal(r.msg, 'Hindi pwedeng bumoto ang account code na ito. (Share capital is below the minimum.)');
  assert.equal(L.describeVerifyError({ status: 422, code: 'NOT_ELIGIBLE' }).msg, 'Hindi pwedeng bumoto ang account code na ito.');
  assert.ok(!/\(/.test(L.describeVerifyError({ status: 409, code: 'ALREADY_VOTED', detail: 'x' }).msg), 'a detail is only added for eligibility');
});

test('sending the ballot: what is safe to send again', () => {
  const d = L.describeSubmitError;
  for (const e of [{ net: true }, { status: 503, code: 'UPSTREAM_UNAVAILABLE' }, { status: 502, code: 'UPSTREAM_ERROR' }, { status: 429, code: 'RATE_LIMITED' }, { status: 503 }, { status: 504 }, { status: 500 }]) {
    assert.equal(d(e).action, 'retry', JSON.stringify(e));
    assert.match(d(e).msg, /Isumite/);
  }
  assert.match(d({ status: 503, code: 'TEMPORARY_FAILURE' }).msg, /walang naitala/i);
  assert.match(d({ net: true }).msg, /^Walang koneksyon\..*ligtas/, 'no connection says so');
  assert.match(d({ status: 503, code: 'UPSTREAM_UNAVAILABLE' }).msg, /^Hindi pa tiyak kung naitala\..*ligtas/, 'an unsure answer says it is not sure it was recorded');
});

test('sending the ballot: a session that ran out, a receipt that clashed', () => {
  assert.equal(L.describeSubmitError({ status: 401, code: 'INVALID_TOKEN' }).action, 'reverify');
  assert.equal(L.describeSubmitError({ status: 401 }).action, 'reverify');
  assert.equal(L.describeSubmitError({ status: 409, code: 'RECEIPT_IN_USE' }).action, 'newreceipt');
});

test('sending the ballot: when the voting is over for this voter', () => {
  const d = L.describeSubmitError;
  assert.deepEqual([d({ status: 409, code: 'ALREADY_VOTED' }).action, d({ status: 409, code: 'ALREADY_VOTED' }).title], ['screen', 'Nakaboto ka na']);
  assert.equal(d({ status: 409, code: 'OUTSIDE_VOTING_WINDOW', msg: 'Voting has not started yet for this election.' }).title, 'Hindi pa nagsisimula ang botohan');
  assert.equal(d({ status: 409, code: 'OUTSIDE_VOTING_WINDOW', msg: 'Voting has already ended for this election.' }).title, 'Tapos na ang botohan');
  assert.equal(d({ status: 409, code: 'EVENT_NOT_OPEN' }).title, 'Sarado ang botohan');
  for (const code of ['UNKNOWN_CANDIDATE', 'CANDIDATE_WRONG_EVENT', 'CANDIDATE_NOT_ELIGIBLE', 'POSITION_NOT_CONFIGURED', 'NO_POSITION_RULES']) {
    assert.equal(d({ status: 422, code }).title, 'Nagbago ang listahan ng kandidato', code);
  }
  for (const code of ['TOKEN_MISMATCH', 'NOT_ELIGIBLE', 'BRANCH_NOT_PARTICIPATING', 'MEMBER_NOT_FOUND', 'WRONG_EVENT_TYPE']) {
    assert.equal(d({ status: 403, code }).action, 'screen', code);
  }
});

test('sending the ballot: a ballot the server refuses stays on screen with the reason', () => {
  for (const code of ['BELOW_MINIMUM', 'ABOVE_MAXIMUM', 'NO_SELECTION', 'TOO_MANY_SELECTIONS', 'DUPLICATE_SELECTION']) {
    const r = L.describeSubmitError({ status: 422, code, msg: "'Delegate' allows at most 5 selection(s); 6 were submitted." });
    assert.equal(r.action, 'fix', code);
    assert.match(r.msg, /Delegate/);
  }
  assert.equal(L.describeSubmitError({ status: 400, msg: 'Something odd.' }).msg, 'Something odd.');
  assert.equal(L.describeSubmitError({ status: 400 }).msg, 'Hindi naisumite. Subukan ulit.');
});

test('reading the roster: a session that ran out, a closed election, a problem', () => {
  assert.equal(L.describeLoadError({ status: 401 }).action, 'reverify');
  assert.equal(L.describeLoadError({ status: 401, code: 'INVALID_TOKEN' }).action, 'reverify');
  assert.equal(L.describeLoadError({ status: 409, code: 'EVENT_NOT_OPEN' }).action, 'screen');
  assert.equal(L.describeLoadError({ status: 403, code: 'TOKEN_MISMATCH' }).action, 'screen');
  assert.equal(L.describeLoadError({ status: 409, code: 'WRONG_EVENT_TYPE' }).action, 'screen');
  // the silent sign-in that renews the session can find out the voter has voted meanwhile, is no longer eligible, or the election is gone
  for (const code of ['ALREADY_VOTED', 'NOT_ELIGIBLE', 'MEMBER_NOT_FOUND', 'BRANCH_NOT_PARTICIPATING', 'NO_OPEN_EVENT']) {
    const d = L.describeLoadError({ status: 409, code });
    assert.equal(d.action, 'screen', code);
    assert.ok(d.title && d.msg, code);
  }
  assert.equal(L.describeLoadError({ status: 429, code: 'RATE_LIMITED' }).action, 'retry');       // busy server: not a reason to leave the ballot
  assert.equal(L.describeLoadError({ status: 400, code: 'toString' }).action, 'retry');            // a code that is not ours is never looked up on the object itself
  assert.equal(L.describeVerifyError({ status: 409, code: 'constructor' }).code, 'ALREADY_VOTED'); // ...here either: the status decides
  assert.deepEqual(L.describeLoadError({ net: true }), { action: 'retry', msg: 'Walang koneksyon. Subukan ulit.' });
  assert.deepEqual(L.describeLoadError({ status: 500 }), { action: 'retry', msg: 'May problema sa server. Subukan ulit.' });
});

test('transient: what is worth trying again', () => {
  for (const e of [{ net: true }, { status: 429 }, { status: 502 }, { status: 503 }, { status: 504 }, { status: 500 }, { code: 'RATE_LIMITED' }, { code: 'TEMPORARY_FAILURE' }]) assert.equal(L.isTransient(e), true, JSON.stringify(e));
  for (const e of [{ status: 400 }, { status: 401 }, { status: 403 }, { status: 404 }, { status: 409 }, { status: 422 }, { status: 500, code: 'SOMETHING' }, null, undefined]) assert.equal(L.isTransient(e), false, JSON.stringify(e));
});

/* ---------------------------------------------------------------- the schedule */

test('the schedule is shown as the election wrote it', () => {
  assert.equal(L.clockText('2026-11-11T08:00:00'), 'Nov 11, 2026 8:00 AM');
  assert.equal(L.clockText('2026-12-01T17:05:00'), 'Dec 1, 2026 5:05 PM');
  assert.equal(L.clockText('2026-11-11T00:30:00'), 'Nov 11, 2026 12:30 AM');
  assert.equal(L.clockText('2026-11-11T12:00:00'), 'Nov 11, 2026 12:00 PM');
  assert.equal(L.clockText('garbage'), '');
  assert.equal(L.clockText(null), '');
});

test('a ballot that says voting is not open', () => {
  assert.equal(L.closedScreen({ isVotingOpen: true }), null);
  assert.equal(L.closedScreen(null), null);
  const s = L.closedScreen({ isVotingOpen: false, scheduleFrom: '2026-11-11T08:00:00', scheduleTo: '2026-11-11T17:00:00' });
  assert.equal(s.title, 'Hindi bukas ang botohan ngayon');
  assert.equal(s.msg, 'Ang botohan ay mula Nov 11, 2026 8:00 AM hanggang Nov 11, 2026 5:00 PM.');
  assert.equal(L.closedScreen({ isVotingOpen: false }).msg, 'Subukan ulit kapag bukas na ang botohan.');
});

/* ---------------------------------------------------------------- the picture of the receipt */

test('a receipt picture is made smaller before a phone would refuse it', () => {
  assert.equal(L.receiptScale(360, 900, 2), 2);
  const k = L.receiptScale(360, 12000, 2);
  assert.ok(k < 2 && k >= 0.5);
  assert.ok(360 * k * 12000 * k <= 16e6);
  assert.equal(L.receiptScale(360, 100000, 2), 0.5, 'never below half size');
});
