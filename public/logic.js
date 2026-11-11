/*
 * eBallot SACDECO - Representative election, mobile voting: the rules and the wording, with no screen in them.
 *
 * Everything the page DECIDES lives here as plain functions (so it is tested on its own, see test/logic.test.mjs): what a position allows,
 * whether the ballot may be reviewed, how a tap changes the selection, what receipt code is proposed, what to tell the voter for each
 * answer of the server. The server still has the last word on every rule: this file only keeps the voter from sending what it would refuse.
 */
(function (root) {
  'use strict';

  const L = {};

  /* ---------------------------------------------------------------- text */

  /** How the ballot compares positions (the server trims and ignores case too). */
  L.key = s => String(s == null ? '' : s).trim().toLowerCase();

  L.oneLine = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 1000);

  /** A name to look for: a number (ballot number) from one digit, a name from two letters. */
  L.searchText = s => L.oneLine(s, 100);
  L.searchable = q => (/^\d+$/.test(q) ? q.length >= 1 : q.length >= 2);

  /** The Account Code as typed: spaces, dots and dashes that a member copies from a card ("0030 0000 012773") are dropped when it is made of digits. */
  L.cleanAccountCode = s => {
    const t = L.oneLine(s, 64);
    return /^[\d\s.\-]+$/.test(t) ? t.replace(/[\s.\-]+/g, '') : t.replace(/\s+/g, '');
  };

  L.initials = name => {
    const words = String(name || '').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
    return ((words[0] || '').charAt(0) + (words.length > 1 ? words[1].charAt(0) : '')).toUpperCase() || '?';
  };

  /* ---------------------------------------------------------------- the rules of a position */

  /** Nobody can be asked for more choices than there are candidates (the server applies the same cap). */
  L.effectiveMin = p => Math.max(0, Math.min(Number(p.minVotes) || 0, Number(p.candidateCount) || 0));

  /** The positions of the ballot that have somebody to vote for, in the order of the rules. */
  L.groupsFromBallot = ballot =>
    (ballot && Array.isArray(ballot.positions) ? ballot.positions : [])
      .map(p => ({ key: L.key(p.position), name: p.position, min: L.effectiveMin(p), max: Math.max(1, Number(p.maxVotes) || 1), seats: Number(p.totalSeats) || 0, count: Number(p.candidateCount) || 0 }))
      .filter(g => g.count > 0);

  /** The line under the position name (same wording as the General Assembly page). */
  L.ruleText = g => (g.min === g.max ? `Pumili ng ${g.max}` : g.min < 1 ? `Hanggang ${g.max} ang pwedeng piliin` : `Pumili ng ${g.min} hanggang ${g.max}`);

  /** What to tell the voter who taps one candidate too many in a position. */
  L.fullText = g => `Hanggang ${g.max} lang ang pwede sa ${g.name}. Alisin muna ang isa para makapili ng iba.`;

  /** Selected candidates of one position. */
  L.countIn = (sel, group) => {
    let n = 0;
    for (const c of sel.values()) if (L.key(c.position) === group.key) n++;
    return n;
  };

  /** Where the ballot stands: how many positions still lack their minimum, and what the review button says. */
  L.standing = (groups, sel) => {
    let missing = 0;
    let first = null;
    const counts = groups.map(g => {
      const n = L.countIn(sel, g);
      if (n < g.min) { missing++; first = first || g; }
      return n;
    });
    const total = sel.size;
    const ready = missing === 0 && total >= 1;          // the server also wants at least one choice on the whole ballot
    const label = missing ? `Kulang pa ang napili sa ${first.name}${missing > 1 ? ` at ${missing - 1} pa` : ''}` : total === 0 ? 'Pumili ng kahit isa' : `Suriin ang boto (${total})`;
    return { missing, total, counts, ready, label };
  };

  /**
   * A tap on a candidate. Selected -> taken off. A position that allows one choice swaps it. Otherwise it is added until the position's
   * maximum is reached ("full": nothing changes and the page says so).
   */
  L.toggle = (sel, group, card) => {
    if (sel.has(card.id)) { sel.delete(card.id); return { action: 'removed' }; }
    if (group.max === 1) {
      for (const [id, c] of [...sel]) if (L.key(c.position) === group.key) sel.delete(id);
      sel.set(card.id, card);
      return { action: 'added' };
    }
    if (L.countIn(sel, group) >= group.max) return { action: 'full', max: group.max };
    sel.set(card.id, card);
    return { action: 'added' };
  };

  /** The selection of a position, in the order the voter chose them. */
  L.pickedOf = (sel, group) => [...sel.values()].filter(c => L.key(c.position) === group.key);

  /** Pages can overlap when the roster changes: one entry per candidate. */
  L.mergeItems = (items, incoming) => {
    const seen = new Set(items.map(c => c.id));
    for (const c of incoming) if (!seen.has(c.id)) { seen.add(c.id); items.push(c); }
    return items;
  };

  L.numberLabel = c => (c && c.ballotNumber != null ? `No. ${c.ballotNumber}` : '');

  /** What a voter may read about a candidate (the server never sends contact data). */
  L.detailsOf = c => [
    ['Dahilan sa pagtakbo', c.reason], ['Edukasyon', c.highestEducation], ['Dating posisyon', c.previousPositions], ['Kasanayan', c.specialSkills],
  ].map(([label, text]) => [label, L.oneLine(text, 2500)]).filter(([, text]) => text);

  /* ---------------------------------------------------------------- the receipt code */

  /** The format the API accepts for a receipt proposed by the client: EVT{event, at least 2 digits}-{8 hex}-{8 hex}, 30 characters at most. */
  L.RECEIPT_RE = /^EVT[0-9]{2,9}-[0-9A-F]{8}-[0-9A-F]{8}$/;

  const randomBytes = n => root.crypto.getRandomValues(new Uint8Array(n));

  /**
   * Proposed BEFORE the ballot is sent, so that sending it again after a lost answer is recognised by the server as the same ballot
   * (it answers with the same receipt instead of "already voted"). It is only a label: it holds nothing about the voter or the choices.
   */
  L.newReceiptCode = (eventId, rnd) => {
    const bytes = (rnd || randomBytes)(8);
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    return `EVT${String(eventId).padStart(2, '0')}-${hex.slice(0, 8)}-${hex.slice(8, 16)}`;
  };

  /** The same receipt code is kept for the same choices (a retry), and a new one is made when the choices changed. */
  L.attemptFor = (previous, eventId, ids, rnd) => {
    const key = [...ids].sort((a, b) => a - b).join(',');
    return previous && previous.key === key ? previous : { key, receipt: L.newReceiptCode(eventId, rnd) };
  };

  L.voteBody = (eventId, ids, receiptCode, rosterVersion) => {
    const body = { eventId, candidateIds: [...ids].sort((a, b) => a - b), receiptCode };
    if (rosterVersion) body.rosterVersion = rosterVersion;
    return body;
  };

  /* ---------------------------------------------------------------- waiting before trying again */

  /** 1.5 s, 3 s, 6 s (or what the server asked for, at most 8 s), plus up to half a second so that a crowd does not come back in step. */
  L.retryDelay = (attempt, retryAfterSeconds, rnd) => {
    const base = retryAfterSeconds > 0 ? Math.min(retryAfterSeconds, 8) * 1000 : [1500, 3000, 6000][Math.min(attempt, 2)];
    return base + Math.floor((rnd ? rnd() : Math.random()) * 500);
  };

  /* ---------------------------------------------------------------- what to tell the voter */

  const TRANSIENT = new Set(['RATE_LIMITED', 'TEMPORARY_FAILURE', 'UPSTREAM_UNAVAILABLE', 'UPSTREAM_ERROR']);
  L.isTransient = e => !!e && (!!e.net || TRANSIENT.has(e.code) || e.status === 429 || e.status === 502 || e.status === 503 || e.status === 504 || (e.status >= 500 && !e.code));

  const SCREENS = Object.assign(Object.create(null), {      // no prototype: a code like "constructor" from the server finds nothing here
    NO_OPEN_EVENT: ['Walang bukas na halalan', 'Wala pang bukas na halalan sa ngayon.'],
    WRONG_EVENT_TYPE: ['Hindi ito ang halalan ng mga Representative', 'Ang bukas na halalan ngayon ay hindi para sa mga Representative. Gamitin ang voting app para sa General Assembly.'],
    MEMBER_NOT_FOUND: ['Hindi nahanap ang account code', 'Walang aktibong member na may ganitong account code.'],
    ALREADY_VOTED: ['Nakaboto ka na', 'Naitala na ang boto ng account code na ito sa halalang ito.'],
    NOT_ELIGIBLE: ['Hindi ka maaaring bumoto', 'Hindi pwedeng bumoto ang account code na ito.'],
    BRANCH_NOT_PARTICIPATING: ['Hindi kasama ang branch mo', 'Hindi kalahok sa halalang ito ang branch ng account code na ito.'],
    RATE_LIMITED: ['Sandali lang', 'Masyadong maraming subok. Subukan ulit maya-maya.'],
    EVENT_NOT_OPEN: ['Sarado ang botohan', 'Hindi bukas ang botohan sa ngayon.'],
    TOKEN_MISMATCH: ['Nagbago ang halalan', 'Mag-verify ulit gamit ang account code mo.'],
    ROSTER_CHANGED: ['Nagbago ang listahan ng kandidato', 'Mag-verify ulit para makuha ang pinakabagong listahan.'],
  });
  const BY_STATUS = { 404: 'MEMBER_NOT_FOUND', 409: 'ALREADY_VOTED', 422: 'NOT_ELIGIBLE', 403: 'BRANCH_NOT_PARTICIPATING', 429: 'RATE_LIMITED' };
  const ROSTER_CODES = new Set(['UNKNOWN_CANDIDATE', 'CANDIDATE_WRONG_EVENT', 'CANDIDATE_NOT_ELIGIBLE', 'POSITION_NOT_CONFIGURED', 'NO_POSITION_RULES']);

  const screen = (code, e) => {
    const [title, msg] = SCREENS[code];
    return { kind: 'screen', code, title, msg: msg + (code === 'NOT_ELIGIBLE' && e && e.detail ? ` (${e.detail})` : '') };
  };

  /** The sign-in: a line under the code field ("inline") or a screen that returns to the start by itself ("screen"). */
  L.describeVerifyError = e => {
    if (e.net) return { kind: 'inline', msg: 'Walang koneksyon sa server. Subukan ulit.' };
    if (e.empty) return { kind: 'inline', msg: 'Wala pang kandidato sa halalang ito.' };
    if (e.code === 'KIOSK_REFUSED' || (e.status === 401 && !e.code)) return { kind: 'inline', msg: 'Hindi tinanggap ng server ang kiosk credentials.' };
    if (e.code === 'VALIDATION') return { kind: 'inline', msg: 'Suriin ang Account Code at subukan ulit.' };
    if (SCREENS[e.code]) return screen(e.code, e);
    if (e.status === 429) return screen('RATE_LIMITED', e);
    if (L.isTransient(e) || !e.status) return { kind: 'inline', msg: 'May problema sa server. Subukan ulit.' };
    if (BY_STATUS[e.status]) return screen(BY_STATUS[e.status], e);
    return { kind: 'screen', code: e.code || 'ERROR', title: 'Hindi ma-verify', msg: e.msg || 'Subukan ulit.' };
  };

  /**
   * Sending the ballot. action: "retry" (send the SAME ballot again, it is safe), "reverify" (the session ran out), "newreceipt",
   * "fix" (stay on the review and show msg) or "screen" (the voting is over for this voter: title and msg, then back to the start).
   */
  L.describeSubmitError = e => {
    if (e.net) return { action: 'retry', msg: 'Walang koneksyon. Pindutin ulit ang “Isumite ang boto” - ligtas ito at hindi mabibilang nang dalawang beses.' };
    if (e.code === 'TEMPORARY_FAILURE') return { action: 'retry', msg: 'Abala ang server at walang naitala. Pindutin ulit ang “Isumite ang boto”.' };
    if (L.isTransient(e)) return { action: 'retry', msg: 'Hindi pa tiyak kung naitala. Pindutin ulit ang “Isumite ang boto” - ligtas ito at hindi mabibilang nang dalawang beses.' };
    if (e.status === 401 || e.code === 'INVALID_TOKEN') return { action: 'reverify' };
    if (e.code === 'RECEIPT_IN_USE') return { action: 'newreceipt' };
    if (e.code === 'OUTSIDE_VOTING_WINDOW') {
      return /not started|not yet/i.test(e.msg || '')
        ? { action: 'screen', code: e.code, title: 'Hindi pa nagsisimula ang botohan', msg: 'Subukan ulit kapag nagsimula na ang botohan.' }
        : { action: 'screen', code: e.code, title: 'Tapos na ang botohan', msg: 'Hindi na tumatanggap ng boto ang halalang ito.' };
    }
    if (e.code === 'ALREADY_VOTED') return { action: 'screen', code: e.code, title: SCREENS.ALREADY_VOTED[0], msg: 'Kung wala kang resibo, lumapit sa admin.' };
    if (ROSTER_CODES.has(e.code)) return { action: 'screen', code: 'ROSTER_CHANGED', title: SCREENS.ROSTER_CHANGED[0], msg: SCREENS.ROSTER_CHANGED[1] };
    if (['EVENT_NOT_OPEN', 'TOKEN_MISMATCH', 'NOT_ELIGIBLE', 'BRANCH_NOT_PARTICIPATING', 'MEMBER_NOT_FOUND', 'WRONG_EVENT_TYPE'].includes(e.code)) {
      return { action: 'screen', code: e.code, title: SCREENS[e.code][0], msg: SCREENS[e.code][1] };
    }
    if (['BELOW_MINIMUM', 'ABOVE_MAXIMUM', 'NO_SELECTION', 'TOO_MANY_SELECTIONS', 'DUPLICATE_SELECTION'].includes(e.code)) {
      return { action: 'fix', msg: 'Hindi tinanggap ang balota: ' + (e.msg || 'suriin ang mga napili mo.') };
    }
    return { action: 'fix', msg: e.msg || 'Hindi naisumite. Subukan ulit.' };
  };

  /** Reading the roster (ballot, pages, photos): what to say when it fails. */
  L.describeLoadError = e => {
    if (e.status === 401 || e.code === 'INVALID_TOKEN') return { action: 'reverify' };
    // The election closed, the voter can no longer vote (the silent sign-in that renews the session says so), or it is another election now.
    if (e.code && e.code !== 'RATE_LIMITED' && SCREENS[e.code]) {
      return { action: 'screen', code: e.code, title: SCREENS[e.code][0], msg: SCREENS[e.code][1] };
    }
    return { action: 'retry', msg: e.net ? 'Walang koneksyon. Subukan ulit.' : 'May problema sa server. Subukan ulit.' };
  };

  /** "2026-11-11T08:00:00" -> "Nov 11, 2026 8:00 AM". The schedule is the election's own wall-clock time, so it is shown as it is, with no time zone change. */
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  L.clockText = iso => {
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(iso || ''));
    if (!m) return '';
    const h = Number(m[4]);
    return `${MONTHS[Number(m[2]) - 1] || m[2]} ${Number(m[3])}, ${m[1]} ${h % 12 || 12}:${m[5]} ${h < 12 ? 'AM' : 'PM'}`;
  };

  /** The ballot says voting is not open right now (not Opened, or outside the schedule): a screen that says so and when it is. */
  L.closedScreen = ballot => {
    if (!ballot || ballot.isVotingOpen) return null;
    const from = L.clockText(ballot.scheduleFrom);
    const to = L.clockText(ballot.scheduleTo);
    return {
      title: 'Hindi bukas ang botohan ngayon',
      msg: from && to ? `Ang botohan ay mula ${from} hanggang ${to}.` : 'Subukan ulit kapag bukas na ang botohan.',
    };
  };

  /* ---------------------------------------------------------------- the receipt picture */

  /** Phones refuse very large canvases (about 16 million pixels); a long ballot gets a smaller picture instead of none. */
  L.receiptScale = (width, height, wanted) => {
    const limit = 16e6;
    let k = wanted || 2;
    while (k > 0.5 && width * k * height * k > limit) k -= 0.25;
    return k;
  };

  root.RepLogic = L;
})(typeof window !== 'undefined' ? window : globalThis);
