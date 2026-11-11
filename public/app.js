/*
 * eBallot SACDECO - Representative election, mobile voting: the page.
 *
 * Flow: Account Code -> POST /auth/voter-verify -> ballot (rules) -> candidates, one page at a time, per position, with search ->
 * review -> POST /representative-votes (the same receipt code is sent again after a lost answer, so the ballot can never count twice) -> receipt picture.
 * What is allowed and what to tell the voter is decided in logic.js (tested on its own); this file draws the screens and talks to the Worker.
 * Everything that comes from the server is put on the page as text, never as markup.
 */
(function () {
  'use strict';

  const L = window.RepLogic;
  const API = '/api/v1';
  const PAGE_SIZE = 100;
  const $ = s => document.querySelector(s);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /** A tiny element builder: strings become text nodes, so nothing from the server is ever parsed as HTML. */
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') e.className = v;
        else e.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const kid of kids) if (kid != null && kid !== false) e.append(kid);
    return e;
  }

  let S = null;              // the voter's session: from a successful sign-in until home()
  let cur = 'home';          // the screen: home | result | ballot | receipt
  let busy = false;          // a sign-in or a submit is on its way
  let countdown = null;
  let toastTimer = null;
  let searchTimer = null;

  /* ---------------------------------------------------------------- talking to the Worker */

  /** Resolves with the JSON answer. Rejects with { net }, { aborted } or { status, code, msg, detail, retryAfter }. */
  async function http(path, { method = 'GET', token, body, signal, timeout = 35000 } = {}) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    const onAbort = () => ctl.abort();
    if (signal) { if (signal.aborted) ctl.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    try {
      let r;
      try {
        r = await fetch(API + path, {
          method, signal: ctl.signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
          headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch { throw signal && signal.aborted ? { aborted: true } : { net: true }; }
      let j = null;
      try { j = await r.json(); } catch { /* not JSON */ }
      if (!r.ok) {
        throw { status: r.status, code: j && j.code, msg: (j && (j.error || j.title)) || '', detail: (j && j.detail) || '', retryAfter: Number(r.headers.get('Retry-After')) || 0 };
      }
      if (j == null) throw signal && signal.aborted ? { aborted: true } : { net: true };      // an answer that cannot be read counts as a lost answer
      return j;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  /** Tries again (after a short, slightly random wait) when the problem is the network or a busy server. */
  async function retrying(fn, { signal, onWait, tries = 3 } = {}) {
    for (let i = 0; ; i++) {
      try { return await fn(); } catch (e) {
        if (!L.isTransient(e) || i >= tries - 1 || (signal && signal.aborted)) throw e;
        if (onWait) onWait(i);
        await sleep(L.retryDelay(i, e.retryAfter));
        if (signal && signal.aborted) throw { aborted: true };
      }
    }
  }

  const verifyCall = code => http('/auth/voter-verify', { method: 'POST', body: { accountCode: code } });

  /** The voter token lasts a few minutes: when it ran out, the same account code (kept in memory only) signs in again, without bothering the voter. */
  function reverify(s) {
    if (!s.reverifying) {
      s.reverifying = (async () => {
        try {
          const v = await retrying(() => verifyCall(s.code));
          if (!v || !v.accessToken || !v.event || v.event.eventId !== s.event.eventId || v.event.eventType !== 'REPRESENTATIVE') throw { status: 409, code: 'TOKEN_MISMATCH' };
          s.token = v.accessToken;
        } finally { s.reverifying = null; }
      })();
    }
    return s.reverifying;
  }

  async function authed(s, fn) {
    try { return await fn(s.token); } catch (e) {
      if (!(e && (e.status === 401 || e.code === 'INVALID_TOKEN')) || !s.code) throw e;
      await reverify(s);
      return await fn(s.token);
    }
  }

  /* ---------------------------------------------------------------- screens */

  function show(id) {
    clearInterval(countdown);
    cur = id;
    for (const s of ['home', 'result', 'ballot', 'receipt']) $('#' + s).hidden = s !== id;
    scrollTo(0, 0);
  }

  function toast(t) {
    const e = $('#toast');
    e.textContent = t;
    e.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { e.hidden = true; }, 5000);
  }

  /** The session ends: nothing may come back to it, and the secrets are dropped. */
  function endSession(s) {
    if (!s) return;
    s.gen++;
    s.token = '';
    s.code = '';
    for (const g of s.groups) if (g.st.ctl) g.st.ctl.abort();
  }

  function home() {
    clearInterval(countdown);
    clearTimeout(searchTimer);
    const s = S;
    endSession(s);
    S = null;
    busy = false;
    if (s) {
      for (const u of s.photos.values()) URL.revokeObjectURL(u);
      if (s.url) URL.revokeObjectURL(s.url);
    }
    if (photoObs) { photoObs.disconnect(); photoObs = null; }
    photoQueue.length = 0;
    if ($('#dlg').open) $('#dlg').close();
    $('#groups').replaceChildren();
    $('#rv').replaceChildren();
    $('#rimg').removeAttribute('src');
    popGuard();
    show('home');
    $('#code').value = '';
    $('#herr').textContent = '';
    $('#vb').disabled = false;
    $('#vb').textContent = 'I-verify';
  }

  const RESULT_SECS = 15;     // most voters are senior citizens who read slowly: the message stays this long ("Bumalik sa home" is always there)

  function result(title, msg) {
    endSession(S);
    if ($('#dlg').open) $('#dlg').close();
    show('result');
    $('#rt').textContent = title;
    $('#rm').textContent = msg;
    $('#trk').style.setProperty('--secs', RESULT_SECS + 's');
    $('#trk').replaceChildren(h('i'));
    let n = RESULT_SECS;
    const tick = () => { $('#rc').textContent = `Babalik sa home sa ${n} segundo…`; };
    tick();
    countdown = setInterval(() => { n--; if (n <= 0) home(); else tick(); }, 1000);
  }

  /* ---------------------------------------------------------------- leaving the page by accident (Back, reload) */

  const losesWork = () => !!S && ((cur === 'ballot' && S.sel.size > 0) || (cur === 'receipt' && !S.saved));
  let pushed = false;
  let skipPop = 0;

  function pushGuard() {
    if (pushed) return;
    try { history.pushState({ eballot: 1 }, ''); pushed = true; } catch { /* the guard is a convenience */ }
  }

  function popGuard() {
    if (!pushed) return;
    pushed = false;
    skipPop++;
    setTimeout(() => { skipPop = 0; }, 1000);
    try { history.back(); } catch { skipPop = 0; }
  }

  addEventListener('popstate', () => {
    if (skipPop) { skipPop--; return; }
    pushed = false;                                   // this Back used up the entry we added
    if (cur === 'home' || cur === 'result') return;
    if (losesWork() && !confirm(cur === 'receipt' ? 'Hindi mo pa nase-save ang resibo. Aalis pa rin?' : 'Aalis ka ba? Mawawala ang mga napili mo.')) { pushGuard(); return; }
    home();
  });

  addEventListener('beforeunload', ev => {
    if (!losesWork()) return;
    ev.preventDefault();
    ev.returnValue = '';
  });

  /* ---------------------------------------------------------------- sign in */

  $('#code').addEventListener('input', () => { $('#herr').textContent = ''; });

  $('#vf').addEventListener('submit', async ev => {
    ev.preventDefault();
    if (busy) return;
    const code = L.cleanAccountCode($('#code').value);
    if (!code) return;
    busy = true;
    const b = $('#vb');
    b.disabled = true;
    b.textContent = 'Bine-verify…';
    $('#herr').textContent = '';
    try {
      const v = await retrying(() => verifyCall(code), { onWait: () => { b.textContent = 'Sinusubukan ulit…'; } });
      b.textContent = 'Kinukuha ang balota…';
      await openBallot(v, code);
    } catch (e) {
      b.disabled = false;
      b.textContent = 'I-verify';
      verifyFailed(e || {});
    } finally {
      busy = false;
    }
  });

  function verifyFailed(e) {
    if (e.screen) return result(e.screen.title, e.screen.msg);
    if (e.closed) return result(e.closed.title, e.closed.msg);
    if (e.inline) { $('#herr').textContent = e.inline; return; }
    const d = L.describeVerifyError(e);
    if (d.kind === 'screen') return result(d.title, d.msg);
    $('#herr').textContent = d.msg;
  }

  async function openBallot(v, code) {
    if (!v || !v.accessToken || !v.event || !v.member) throw { net: true };                          // an answer the page cannot use
    if (v.event.eventType !== 'REPRESENTATIVE') throw { status: 409, code: 'WRONG_EVENT_TYPE' };
    let ballot;
    try {
      ballot = await retrying(() => http(`/events/${v.event.eventId}/representative-ballot`, { token: v.accessToken }));
    } catch (e) {
      const d = L.describeLoadError(e || {});
      throw d.action === 'screen' ? { screen: d } : { inline: d.msg || 'May problema sa server. Subukan ulit.' };
    }
    const closed = L.closedScreen(ballot);
    if (closed) throw { closed };
    const groups = L.groupsFromBallot(ballot);
    if (!groups.length) throw { empty: true };

    S = {
      token: v.accessToken, code, member: v.member, event: v.event, rosterVersion: ballot.rosterVersion || '',
      groups, sel: new Map(), cards: new Map(), mode: 'all', query: '', gen: 0,
      attempt: null, saved: false, url: '', file: null, photos: new Map(), reverifying: null,
    };
    $('#bn').textContent = v.member.name;
    $('#be').textContent = v.event.title;
    $('#q').value = '';
    $('#q').disabled = false;
    $('#qc').hidden = true;
    pickButton(false);
    buildGroups();
    show('ballot');
    pushGuard();
    paint();
    syncHead();
    schedulePump();
  }

  /* ---------------------------------------------------------------- the ballot */

  const ordered = cards => [...cards].sort((a, b) =>
    ((a.ballotNumber == null) - (b.ballotNumber == null)) || (a.ballotNumber - b.ballotNumber) || String(a.candidateName).localeCompare(String(b.candidateName)) || (a.id - b.id));

  const freshState = () => ({ items: [], total: 0, page: 0, pages: 1, loading: false, error: '', done: false, loaded: false, ctl: null });

  function buildGroups() {
    const box = $('#groups');
    box.replaceChildren();
    S.groups.forEach((g, i) => {
      g.i = i;
      g.st = freshState();
      g.cnt = h('span', { class: 'cnt' });
      g.info = h('p', { class: 'gi' });
      g.list = h('div', { class: 'items' });
      g.foot = h('div', { class: 'foot' });
      g.el = h('div', { class: 'grp' },
        h('div', { class: 'gh' }, h('div', null, h('b', null, g.name), h('small', null, L.ruleText(g))), g.cnt),
        g.info, g.list, g.foot);
      box.append(g.el);
      renderGroup(g);
    });
    box.append(h('div', { class: 'sp' }));
  }

  function skeleton() { return h('div', { class: 'skel', 'aria-hidden': 'true' }, h('i'), h('i')); }

  function rowEl(c, g) {
    const on = S.sel.has(c.id);
    const no = L.numberLabel(c);
    const details = L.detailsOf(c);
    const pick = h('button', { type: 'button', class: 'pick', role: 'checkbox', 'aria-checked': String(on), 'data-act': 'pick' },
      h('span', { class: 'bub' }),
      c.hasPhoto ? avatarEl(c) : null,
      h('span', { class: 'who' }, c.candidateName, no ? h('span', { class: 'no' }, no) : null));
    const more = details.length
      ? h('button', { type: 'button', class: 'more', 'aria-expanded': 'false', 'aria-label': 'Tingnan ang detalye ni ' + c.candidateName, 'data-act': 'info' }, 'Tingnan ang detalye')
      : null;
    const row = h('div', { class: on ? 'cand on' : 'cand', 'data-id': c.id, 'data-g': g.i }, h('div', { class: 'r1' }, pick), more);
    if (details.length) {
      const dl = h('dl', { class: 'det', hidden: true });
      for (const [label, text] of details) dl.append(h('dt', null, label), h('dd', null, text));
      row.append(dl);
    }
    return row;
  }

  function appendRows(g, cards) {
    const frag = document.createDocumentFragment();
    for (const c of cards) frag.append(rowEl(c, g));
    g.list.append(frag);
  }

  function renderInfo(g) {
    const st = g.st;
    let t;
    if (S.mode === 'picked') {
      const n = L.countIn(S.sel, g);
      t = n ? `${n} ang napili` : 'Wala pang napili sa posisyong ito.';
    } else if (S.query) {
      t = !st.loaded ? 'Hinahanap…' : st.total ? `${st.total} ang tugma sa “${S.query}”` : `Walang tugma sa “${S.query}”.`;
    } else {
      t = `${st.loaded ? st.total : g.count} kandidato`;
    }
    g.info.textContent = t;
  }

  function renderFoot(g) {
    const st = g.st;
    const f = g.foot;
    f.replaceChildren();
    f.hidden = true;
    if (S.mode !== 'all') return;
    if (st.error) {
      f.hidden = false;
      f.append(h('div', { class: 'e' }, st.error), h('button', { type: 'button', class: 'alt', 'data-act': 'again', 'data-g': g.i }, 'Subukan ulit'));
    } else if (st.loading && st.loaded) {
      f.hidden = false;
      f.textContent = 'Kinukuha ang susunod…';
    } else if (st.loaded && !st.done) {
      f.hidden = false;
      f.append(h('div', null, `Ipinapakita ang ${st.items.length} sa ${st.total}`), h('button', { type: 'button', class: 'alt', 'data-act': 'next', 'data-g': g.i }, 'Magpakita pa'));
    }
  }

  /** Draws a position from scratch: the selected ones (mode "picked") or what was loaded so far (mode "all"). */
  function renderGroup(g) {
    const st = g.st;
    g.list.replaceChildren();
    if (S.mode === 'picked') {
      appendRows(g, ordered(L.pickedOf(S.sel, g)));
    } else if (st.loaded) {
      appendRows(g, st.items);
    } else {
      for (let k = 0; k < 4; k++) g.list.append(skeleton());
    }
    renderInfo(g);
    renderFoot(g);
  }

  /** The counters, the ticks and the review button follow the selection. */
  function paint() {
    const standing = L.standing(S.groups, S.sel);
    S.groups.forEach((g, i) => {
      const n = standing.counts[i];
      g.cnt.textContent = `${n}/${g.max}`;
      g.cnt.classList.toggle('ok', n >= g.min);
      if (S.mode === 'picked') renderInfo(g);
    });
    for (const el of $('#groups').querySelectorAll('.cand')) {
      const on = S.sel.has(Number(el.dataset.id));
      if (el.classList.contains('on') !== on) {
        el.classList.toggle('on', on);
        el.querySelector('.pick').setAttribute('aria-checked', String(on));
      }
    }
    $('#pn').textContent = String(standing.total);
    const b = $('#rvb');
    b.disabled = !standing.ready;
    b.textContent = standing.label;
  }

  $('#groups').addEventListener('click', ev => {
    const b = ev.target.closest('button[data-act]');
    if (!b || !S) return;
    const act = b.dataset.act;
    if (act === 'next' || act === 'again') {
      const g = S.groups[Number(b.dataset.g)];
      if (g) { g.st.error = ''; loadMore(g); }
      return;
    }
    const row = b.closest('.cand');
    if (!row) return;
    if (act === 'info') {
      const dl = row.querySelector('.det');
      const open = dl.hidden;
      dl.hidden = !open;
      const card = S.cards.get(Number(row.dataset.id));
      const t = open ? 'Itago ang detalye' : 'Tingnan ang detalye';
      b.textContent = t;
      b.setAttribute('aria-label', `${t} ni ${card ? card.candidateName : ''}`.trim());
      b.setAttribute('aria-expanded', String(open));
      return;
    }
    const g = S.groups[Number(row.dataset.g)];
    const card = S.cards.get(Number(row.dataset.id));
    if (!g || !card) return;
    const r = L.toggle(S.sel, g, card);
    if (r.action === 'full') toast(L.fullText(g));
    paint();
  });

  /* ---------------------------------------------------------------- loading the candidates, a page at a time */

  async function loadMore(g) {
    const s = S;
    const st = g.st;
    if (!s || st.loading || st.done) return;
    const gen = s.gen;
    const stale = () => S !== s || s.gen !== gen;
    const page = st.page + 1;
    const q = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), position: g.name });
    if (s.query) q.set('search', s.query);
    const ctl = new AbortController();
    st.ctl = ctl;
    st.loading = true;
    st.error = '';
    if (s.mode === 'all') renderFoot(g);
    try {
      const res = await retrying(
        () => authed(s, t => http(`/events/${s.event.eventId}/representative-candidates?${q}`, { token: t, signal: ctl.signal })),
        { signal: ctl.signal });
      if (stale()) return;
      st.loading = false;
      const items = Array.isArray(res.items) ? res.items : [];
      const before = st.items.length;
      L.mergeItems(st.items, items);
      const added = st.items.slice(before);
      for (const c of added) if (!s.cards.has(c.id)) s.cards.set(c.id, c);
      st.total = Number(res.total) || 0;
      st.page = Number(res.page) || page;
      st.pages = Number(res.totalPages) || 1;
      st.loaded = true;
      st.done = st.page >= st.pages || items.length === 0;
      if (s.mode === 'all') {
        if (page === 1) renderGroup(g);
        else { appendRows(g, added); renderInfo(g); renderFoot(g); }
      }
      schedulePump();
    } catch (e) {
      if (stale()) return;
      st.loading = false;
      if (e && e.aborted) return;
      const d = L.describeLoadError(e || {});
      if (d.action === 'screen') { result(d.title, d.msg); return; }
      st.error = d.msg || 'May problema sa server. Subukan ulit.';
      if (s.mode === 'all') renderFoot(g);
    }
  }

  /** Loads what the voter is about to scroll to: a position whose end is near the screen asks for its next page. */
  let pumpQueued = false;
  function schedulePump() {
    if (pumpQueued) return;
    pumpQueued = true;
    requestAnimationFrame(() => { pumpQueued = false; pump(); });
  }

  function pump() {
    if (!S || cur !== 'ballot' || S.mode !== 'all') return;
    for (const g of S.groups) {
      const st = g.st;
      if (st.loading || st.error || st.done) continue;
      const r = g.el.getBoundingClientRect();
      const near = st.loaded ? r.bottom > -100 && r.bottom < innerHeight + 700 : r.top < innerHeight + 300;
      if (near) loadMore(g);
    }
  }

  addEventListener('scroll', schedulePump, { passive: true });
  addEventListener('resize', () => { syncHead(); schedulePump(); });

  /** The position names stick under the search bar: tell the style sheet how tall that bar is. */
  function syncHead() {
    const hd = $('.head');
    if (hd && !$('#ballot').hidden) document.documentElement.style.setProperty('--headH', hd.offsetHeight + 'px');
  }
  if ('ResizeObserver' in window) new ResizeObserver(syncHead).observe($('.head'));

  /* ---------------------------------------------------------------- search and "only my choices" */

  function applySearch() {
    if (!S) return;
    const t = L.searchText($('#q').value);
    const next = L.searchable(t) ? t : '';
    if (next === S.query) return;
    S.query = next;
    S.gen++;
    for (const g of S.groups) {
      if (g.st.ctl) g.st.ctl.abort();
      g.st = freshState();
    }
    if (S.mode === 'all') {
      S.groups.forEach(renderGroup);
      scrollTo(0, 0);
      schedulePump();
    }
  }

  $('#q').addEventListener('input', () => {
    $('#qc').hidden = $('#q').value === '';
    clearTimeout(searchTimer);
    searchTimer = setTimeout(applySearch, 350);
  });

  $('#q').addEventListener('keydown', ev => {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    clearTimeout(searchTimer);
    applySearch();
    $('#q').blur();
  });

  $('#qc').addEventListener('click', () => {
    $('#q').value = '';
    $('#qc').hidden = true;
    clearTimeout(searchTimer);
    applySearch();
    $('#q').focus();
  });

  function pickButton(on) {
    const b = $('#vpick');
    b.setAttribute('aria-pressed', String(on));
    b.setAttribute('aria-label', on ? 'Ipakita ang lahat ng kandidato' : 'Ipakita lang ang mga napili');
  }

  function setMode(mode) {
    if (!S || S.mode === mode) return;
    S.mode = mode;
    pickButton(mode === 'picked');
    $('#q').disabled = mode === 'picked';
    S.groups.forEach(renderGroup);
    scrollTo(0, 0);
    schedulePump();
  }

  $('#vpick').addEventListener('click', () => { if (S) setMode(S.mode === 'all' ? 'picked' : 'all'); });

  /* ---------------------------------------------------------------- photos (only for candidates that have one; thumbnails, loaded as they come into view) */

  const photoQueue = [];
  let photoActive = 0;
  let photoObs = null;

  function avatarEl(c) {
    const el = h('span', { class: 'av', 'aria-hidden': 'true', 'data-ph': c.id }, L.initials(c.candidateName));
    const url = S.photos.get(c.id);
    if (url) setPhoto(el, url);
    else watchPhoto(el);
    return el;
  }

  function setPhoto(el, url) { el.replaceChildren(h('img', { src: url, alt: '' })); }

  function watchPhoto(el) {
    if (!('IntersectionObserver' in window)) { photoQueue.push(el); drainPhotos(); return; }
    if (!photoObs) {
      photoObs = new IntersectionObserver(entries => {
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          photoObs.unobserve(en.target);
          photoQueue.push(en.target);
        }
        drainPhotos();
      }, { rootMargin: '300px 0px' });
    }
    photoObs.observe(el);
  }

  function drainPhotos() {
    while (photoActive < 4 && photoQueue.length) {
      const el = photoQueue.shift();
      const s = S;
      if (!s || !el.isConnected) continue;
      const id = Number(el.dataset.ph);
      if (s.photos.has(id)) { setPhoto(el, s.photos.get(id)); continue; }
      const c = s.cards.get(id);
      if (!c) continue;
      photoActive++;
      fetchPhoto(s, c)
        .then(url => { if (url && S === s && el.isConnected) setPhoto(el, url); })
        .finally(() => { photoActive--; drainPhotos(); });
    }
  }

  /** A missing or failed photo is not an error: the initials stay. */
  async function fetchPhoto(s, c) {
    const v = /^\d{1,20}$/.test(String(c.photoVersion == null ? '' : c.photoVersion)) ? `?v=${c.photoVersion}` : '';
    try {
      const r = await fetch(`${API}/events/${s.event.eventId}/representative-candidates/${c.id}/photo${v}`, {
        headers: { Authorization: 'Bearer ' + s.token }, credentials: 'omit', referrerPolicy: 'no-referrer',
      });
      if (r.status !== 200) return null;
      const blob = await r.blob();
      if (S !== s || !/^image\//.test(blob.type) || blob.size > 400000) return null;
      const url = URL.createObjectURL(blob);
      s.photos.set(c.id, url);
      return url;
    } catch { return null; }
  }

  /* ---------------------------------------------------------------- review and submit */

  $('#rvb').addEventListener('click', () => {
    if (!S) return;
    const standing = L.standing(S.groups, S.sel);
    if (!standing.ready) return;
    const rv = $('#rv');
    rv.replaceChildren();
    for (const g of S.groups) {
      rv.append(h('b', null, g.name));
      const picked = ordered(L.pickedOf(S.sel, g));
      if (!picked.length) rv.append(h('div', null, '—'));
      for (const c of picked) rv.append(h('div', null, c.candidateName, L.numberLabel(c) ? h('small', null, L.numberLabel(c)) : null));
    }
    rv.append(h('div', { class: 'tot' }, `Kabuuan: ${standing.total} ang napili`));
    $('#derr').textContent = '';
    setBusy(false);
    armSubmit();
    $('#dlg').showModal();
  });

  let armTimer = null;
  function armSubmit() {
    const yes = $('#dyes');
    yes.disabled = true;
    clearTimeout(armTimer);
    armTimer = setTimeout(() => { if (!busy) yes.disabled = false; }, 800);
  }

  function setBusy(on, label) {
    busy = on;
    $('#dyes').disabled = on;
    $('#dno').disabled = on;
    $('#dyes').textContent = on ? label : 'Isumite ang boto';
  }

  $('#dno').addEventListener('click', () => { if (!busy) $('#dlg').close(); });
  $('#dlg').addEventListener('cancel', ev => { if (busy) ev.preventDefault(); });
  $('#dyes').addEventListener('click', submit);

  async function submit() {
    const s = S;
    if (!s || busy) return;
    const ids = [...s.sel.keys()];
    if (!ids.length) return;
    s.attempt = L.attemptFor(s.attempt, s.event.eventId, ids);
    setBusy(true, 'Isinusumite…');
    $('#derr').textContent = '';
    const fail = msg => { setBusy(false); $('#derr').textContent = msg; };
    let again = 0;
    let renewed = false;
    let reverified = false;
    try {
      for (;;) {
        let r;
        try {
          r = await http('/representative-votes', {
            method: 'POST', token: s.token, timeout: 40000,
            body: L.voteBody(s.event.eventId, ids, s.attempt.receipt, s.rosterVersion),
          });
        } catch (e0) {
          if (S !== s) return;
          const e = e0 || {};
          const d = L.describeSubmitError(e);
          if (d.action === 'retry' && again < 2) {                 // the same ballot with the same receipt code: safe to send again
            $('#dyes').textContent = 'Sinusubukan ulit…';
            await sleep(L.retryDelay(again++, e.retryAfter));
            if (S !== s) return;
            continue;
          }
          if (d.action === 'reverify' && !reverified && s.code) {
            reverified = true;
            try { await reverify(s); } catch (e2) {
              if (S !== s) return;
              const v = L.describeVerifyError(e2 || {});
              if (v.kind === 'screen') { $('#dlg').close(); result(v.title, v.msg); return; }
              fail(v.msg);
              return;
            }
            continue;
          }
          if (d.action === 'newreceipt' && !renewed) {
            renewed = true;
            s.attempt = { key: s.attempt.key, receipt: L.newReceiptCode(s.event.eventId) };
            continue;
          }
          if (d.action === 'screen') { $('#dlg').close(); result(d.title, d.msg); return; }
          if (d.action === 'reverify') { $('#dlg').close(); result('Nag-expire ang session', 'Mag-verify ulit gamit ang account code mo.'); return; }
          fail(d.msg || 'Hindi naisumite. Subukan ulit.');
          return;
        }
        if (S !== s) return;
        if (!r || typeof r.receiptCode !== 'string') { fail('Hindi malinaw ang sagot ng server. Pindutin ulit ang “Isumite ang boto” - ligtas ito.'); return; }
        s.token = '';                                              // the ballot is in: the session is not needed any more
        s.code = '';
        setBusy(false);
        $('#dlg').close();
        await makeReceipt(s, r);
        return;
      }
    } catch {
      if (S === s) fail('Hindi naisumite. Pindutin ulit ang “Isumite ang boto” - ligtas ito.');
    }
  }

  /* ---------------------------------------------------------------- receipt picture */

  /** The API sends its time in UTC; a time without a zone (a ballot that was recorded earlier) is UTC as well. */
  const asUtc = t => {
    const x = String(t || '');
    return /(Z|[+-]\d{2}:?\d{2})$/i.test(x) ? x : x.replace(' ', 'T') + 'Z';
  };

  function whenText(iso) {
    let d = new Date(asUtc(iso));
    if (isNaN(d)) d = new Date();
    try { return d.toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Manila' }); } catch { return d.toLocaleString(); }
  }

  const loadImage = src => new Promise(ok => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => ok(null); i.src = src; });

  async function makeReceipt(s, r) {
    s.saved = false;
    $('#rcodev').textContent = r.receiptCode;
    $('#sv').disabled = true;
    $('#rimg').removeAttribute('src');
    show('receipt');
    try {
      const sample = [s.event.title, s.member.name, ...s.sel.values()].map(c => (typeof c === 'string' ? c : c.candidateName + c.position)).join(' ');
      if (document.fonts && document.fonts.load) {
        await Promise.all([document.fonts.load('700 18px "Atkinson Hyperlegible"', sample), document.fonts.load('400 17px "Atkinson Hyperlegible"', sample)]).catch(() => {});
      }
      const logo = await loadImage('logo.webp');
      const cv = drawReceipt(s, r, logo);
      const blob = await new Promise(res => cv.toBlob(res, 'image/png'));
      if (!blob) throw new Error('no picture');
      if (S !== s) return;
      s.url = URL.createObjectURL(blob);
      s.file = new File([blob], `resibo-${r.receiptCode}.png`, { type: 'image/png' });
      $('#rimg').src = s.url;
      $('#sv').disabled = false;
    } catch { toast('Hindi nagawa ang larawan. I-screenshot ang receipt code.'); }
  }

  /** Two passes: the first only measures (so the picture is exactly as tall as the ballot is long), the second draws. */
  function drawReceipt(s, r, logo) {
    const W = 360;
    const P = 24;
    const INK = '#16251B';
    const MUTE = '#5D6B61';
    const GREEN = '#1F7A33';
    const F = '"Atkinson Hyperlegible",system-ui,sans-serif';
    const lw = 190;
    const lh = logo ? Math.round(lw * logo.height / logo.width) : 0;

    const run = (x, draw) => {
      let y = 0;
      const font = (w, sz, col) => { x.font = `${w} ${sz}px ${F}`; x.fillStyle = col; };
      const wrap = (t, w) => {
        const out = [];
        let line = '';
        for (const word of String(t).split(/[ \t\r\n]+/).filter(Boolean)) {          // (a no-break space, as in "No. 42", is not a place to break)
          const next = line ? line + ' ' + word : word;
          if (x.measureText(next).width <= w) { line = next; continue; }
          if (line) { out.push(line); line = ''; }
          let part = '';
          for (const ch of word) {                                  // a single word wider than the line is cut
            if (part && x.measureText(part + ch).width > w) { out.push(part); part = ch; } else part += ch;
          }
          line = part;
        }
        out.push(line);
        return out;
      };
      const T = (t, wt, sz, col, ind = 0, al = 'left') => {
        font(wt, sz, col);
        x.textAlign = al;
        for (const ln of wrap(t, W - 2 * P - ind)) {
          if (draw) x.fillText(ln, al === 'center' ? W / 2 : P + ind, y);
          y += Math.round(sz * 1.35);
        }
      };
      const dash = () => {
        y += 8;
        if (draw) {
          x.strokeStyle = '#BFD3C4'; x.lineWidth = 1.2; x.setLineDash([5, 4]);
          x.beginPath(); x.moveTo(P, y); x.lineTo(W - P, y); x.stroke(); x.setLineDash([]);
        }
        y += 14;
      };

      if (logo && draw) x.drawImage(logo, (W - lw) / 2, 14, lw, lh);
      const by = lh + 22;
      if (draw) {
        x.fillStyle = GREEN; x.fillRect(0, by, W, 44);
        font(700, 20, '#fff'); x.textAlign = 'center'; x.fillText('Resibo ng Boto', W / 2, by + 12);
      }
      y = by + 66;
      T(s.event.title, 700, 19, INK, 0, 'center');
      T(whenText(r.votedAt), 400, 16, MUTE, 0, 'center');
      dash();
      T('Member', 400, 15, MUTE);
      T(s.member.name, 700, 19, INK);
      T('Account Code: ' + s.member.accountCode, 400, 16, MUTE);
      dash();
      for (const g of s.groups) {
        const picked = ordered(L.pickedOf(s.sel, g));
        if (!picked.length) continue;
        T(g.name, 700, 17, GREEN);
        for (const c of picked) {
          if (draw) { x.fillStyle = INK; x.beginPath(); x.ellipse(P + 10, y + 12, 9, 6, 0, 0, 7); x.fill(); }
          T(c.ballotNumber != null ? `${c.candidateName} (No. ${c.ballotNumber})` : c.candidateName, 400, 19, INK, 28);
        }
        y += 8;
      }
      T(`Kabuuang napili: ${s.sel.size}`, 400, 16, MUTE, 0, 'center');
      dash();
      T('Receipt code', 400, 15, MUTE, 0, 'center');
      let size = 26;                                                // the code is one unbroken word: shrink it until it fits the line
      font(700, size, INK);
      while (size > 14 && x.measureText(r.receiptCode).width > W - 2 * P) { size--; font(700, size, INK); }
      T(r.receiptCode, 700, size, INK, 0, 'center');
      y += 4;
      T('Itago ang resibong ito bilang patunay na naitala ang boto mo.', 400, 14, MUTE, 0, 'center');
      y += P;
      return Math.ceil(y);
    };

    const H = run(document.createElement('canvas').getContext('2d'), false);
    const K = L.receiptScale(W, H, 2);
    const cv = document.createElement('canvas');
    cv.width = Math.round(W * K);
    cv.height = Math.round(H * K);
    const x = cv.getContext('2d');
    x.scale(K, K);
    x.fillStyle = '#fff';
    x.fillRect(0, 0, W, H);
    x.textBaseline = 'top';
    run(x, true);
    return cv;
  }

  $('#sv').addEventListener('click', async () => {
    const s = S;
    if (!s || !s.file) return;
    try {
      if (navigator.canShare && navigator.canShare({ files: [s.file] })) await navigator.share({ files: [s.file], title: 'Resibo ng Boto' });
      else {
        const a = h('a', { href: s.url, download: s.file.name });
        document.body.append(a);
        a.click();
        a.remove();
      }
      s.saved = true;
    } catch (e) { if (!e || e.name !== 'AbortError') toast('Hindi na-save. Pindutin nang matagal ang larawan.'); }
  });

  $('#done').addEventListener('click', () => {
    if (S && !S.saved && !confirm('Hindi mo pa nase-save ang resibo. Aalis pa rin?')) return;
    home();
  });

  $('#rback').addEventListener('click', home);
})();
