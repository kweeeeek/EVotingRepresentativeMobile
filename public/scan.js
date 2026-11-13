/*
 * eBallot SACDECO - QR code scanner for the Account Code.
 *
 * Used by BOTH mobile voting pages (General Assembly and Representative): the two copies of this file must stay identical.
 * The QR code printed by the Registration desk holds only the member's Account Code (trimmed, upper case), so scanning only has to
 * read that text; the page then fills in the Account Code and verifies it, exactly as if the member had typed it.
 *
 * How it reads: the phone's camera (getUserMedia, back camera) -> the phone's own QR reader (BarcodeDetector, Chrome/Android) when it has one,
 * otherwise jsQR (jsqr.js, Apache-2.0, loaded only when needed). Nothing is uploaded: every picture stays on the phone and is dropped when the window closes.
 * If the camera cannot be used (not allowed, no camera, an in-app browser), "Kunan ng litrato ang QR" opens the phone's camera app and reads the picture instead.
 *
 * The page provides this markup (ids are used below):
 *   <dialog id="scn"> <div id="scs"><video id="scv" playsinline muted></video></div> <p id="scm"></p> <div id="sce" role="alert"></div>
 *     <input type="file" id="scf" accept="image/*" capture="environment" hidden> <button id="scp"></button> <button id="scx"></button> </dialog>
 * and calls  QrScan.open({ onCode(code) })  from a button.  onCode gets the cleaned Account Code, after the window has been closed.
 */
(function (root) {
  'use strict';

  const MSG = {
    wait: 'Pindutin ang “Allow” o “Payagan” kapag tinanong ng phone mo ang tungkol sa camera.',
    aim: 'Itapat ang QR code sa loob ng kahon. Kusa itong mababasa.',
    slow: 'Hindi pa nababasa? Lapitan o ilayo nang kaunti ang QR at siguraduhing may ilaw. Pwede ring pindutin ang “Kunan ng litrato ang QR”.',
    denied: 'Hindi pinayagan ang camera. Pindutin ang “Kunan ng litrato ang QR”, o payagan ang camera sa settings ng browser.',
    none: 'Walang nakitang camera sa phone na ito. Pindutin ang “Kunan ng litrato ang QR”.',
    used: 'Ginagamit ng ibang app ang camera. Isara muna ang app na iyon, o pindutin ang “Kunan ng litrato ang QR”.',
    broken: 'Hindi masimulan ang camera sa browser na ito. Pindutin ang “Kunan ng litrato ang QR”.',
    notCode: 'Hindi ito QR code ng Account Code. Subukan ulit.',
    noQrInPhoto: 'Walang nabasang QR code sa litrato. Lapitan ang QR at kunan ulit.',
    badPhoto: 'Hindi mabuksan ang litrato. Subukan ulit.',
  };

  /* ---------------------------------------------------------------- the text of a QR code -> an Account Code (no camera needed; tested on its own) */

  /**
   * Returns the Account Code held by the scanned text, or '' when the text is not one.
   * Same cleaning as typing it: digits written in groups ("1111 2222 333344", "1111-2222-333344") lose the spaces, dashes and dots.
   * Anything else must be one word of letters/digits (. _ - / allowed) - a web address, a sentence or a Wi-Fi code is NOT an Account Code.
   */
  function accountCode(raw) {
    const t = String(raw == null ? '' : raw).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
    if (!t || t.length > 64) return '';
    const code = /^[\d\s.\-]+$/.test(t) ? t.replace(/[\s.\-]+/g, '') : t;
    return /^[A-Za-z0-9][A-Za-z0-9._\-/]{3,31}$/.test(code) ? code : '';
  }

  /* ---------------------------------------------------------------- reading pictures */

  let reader = null;            // a promise of the phone's own QR reader, or of null when it has none (asked once)

  function nativeReader() {
    if (!reader) {
      reader = (async () => {
        try {
          if ('BarcodeDetector' in root) {
            const formats = await root.BarcodeDetector.getSupportedFormats();
            if (!formats || formats.indexOf('qr_code') >= 0) return new root.BarcodeDetector({ formats: ['qr_code'] });
          }
        } catch { /* no reader of its own: jsQR is used */ }
        return null;
      })();
    }
    return reader;
  }

  let jsqrLoading = null;

  function loadJsQr() {
    if (root.jsQR) return Promise.resolve(root.jsQR);
    if (!jsqrLoading) {
      jsqrLoading = new Promise((ok, no) => {
        const s = root.document.createElement('script');
        s.src = 'jsqr.js';
        s.onload = () => (root.jsQR ? ok(root.jsQR) : no(new Error('jsQR')));
        s.onerror = () => { jsqrLoading = null; no(new Error('jsQR')); };
        root.document.head.append(s);
      });
    }
    return jsqrLoading;
  }

  let work = null;              // a canvas that is reused for every frame

  /** jsQR on a picture (a video frame or a bitmap), reduced so that its longest side is at most `max` pixels. */
  async function readWithJsQr(source, w, h, max, both) {
    const jsQR = await loadJsQr();
    const k = Math.min(1, max / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * k));
    const ch = Math.max(1, Math.round(h * k));
    if (!work) work = root.document.createElement('canvas');
    work.width = cw;
    work.height = ch;
    const g = work.getContext('2d', { willReadFrequently: true });
    g.drawImage(source, 0, 0, cw, ch);
    const px = g.getImageData(0, 0, cw, ch);
    const r = jsQR(px.data, cw, ch, { inversionAttempts: both ? 'attemptBoth' : 'dontInvert' });
    return r && r.data ? [r.data] : [];
  }

  /** The texts of the QR codes found in a picture (video element or bitmap). */
  async function readPicture(source, w, h, still) {
    const nat = await nativeReader();
    if (nat) {
      try {
        const found = await nat.detect(source);
        const texts = found.map(f => f.rawValue).filter(Boolean);
        if (texts.length || !still) return texts;
      } catch { reader = Promise.resolve(null); }        // the phone's reader does not work after all: jsQR takes over
    }
    let texts = await readWithJsQr(source, w, h, still ? 1600 : 960, still);
    if (!texts.length && still && Math.max(w, h) > 1600) texts = await readWithJsQr(source, w, h, 2600, true);
    return texts;
  }

  /* ---------------------------------------------------------------- the window */

  const $ = s => root.document.querySelector(s);
  let st = null;                // the open scan: { opts, stream, timer, hintTimer, reading, lastBad, lastBadAt }

  function say(el, text) { el.textContent = text || ''; }

  function stopCamera() {
    if (!st) return;
    clearTimeout(st.timer);
    clearTimeout(st.hintTimer);
    st.live = false;
    const v = $('#scv');
    if (st.stream) for (const t of st.stream.getTracks()) { try { t.stop(); } catch { /* already stopped */ } }
    st.stream = null;
    if (v) { try { v.pause(); } catch { /* nothing playing */ } v.srcObject = null; }
  }

  function close() {
    const d = $('#scn');
    stopCamera();
    st = null;
    if (d && d.open) d.close();
  }

  /** A text was read: use it when it is an Account Code, otherwise say so and keep looking. */
  function deliver(texts) {
    if (!st) return false;
    for (const raw of texts) {
      const code = accountCode(raw);
      if (!code) continue;
      const opts = st.opts;
      try { if (root.navigator.vibrate) root.navigator.vibrate(60); } catch { /* not every phone vibrates */ }
      close();
      if (opts.onCode) opts.onCode(code);
      return true;
    }
    if (texts.length) {
      const now = Date.now();
      if (st.lastBad !== texts[0] || now - st.lastBadAt > 2500) say($('#sce'), MSG.notCode);
      st.lastBad = texts[0];
      st.lastBadAt = now;
    }
    return false;
  }

  function loop() {
    if (!st || !st.live) return;
    const v = $('#scv');
    const next = () => { if (st && st.live) st.timer = setTimeout(loop, 110); };
    if (st.reading || v.readyState < 2 || !v.videoWidth) { next(); return; }
    st.reading = true;
    const mine = st;
    readPicture(v, v.videoWidth, v.videoHeight, false)
      .then(texts => { if (st === mine) deliver(texts); })
      .catch(e => { if (!mine.warned) { mine.warned = true; try { console.warn('QR scan: a picture could not be read -', e && e.message); } catch { /* no console */ } } })    // the next frame is tried anyway
      .then(() => { mine.reading = false; next(); });
  }

  function explain(e) {
    const n = e && e.name;
    if (n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError') return MSG.denied;
    if (n === 'NotFoundError' || n === 'DevicesNotFoundError') return MSG.none;
    if (n === 'NotReadableError' || n === 'TrackStartError' || n === 'AbortError') return MSG.used;
    return MSG.broken;
  }

  async function startCamera() {
    const md = root.navigator.mediaDevices;
    if (!md || !md.getUserMedia) throw { name: 'Unsupported' };
    const tries = [
      { audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } },
      { audio: false, video: true },
    ];
    let last;
    for (const c of tries) {
      try { return await md.getUserMedia(c); } catch (e) {
        last = e;
        if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError' || e.name === 'NotFoundError')) break;     // another try would not help
      }
    }
    throw last;
  }

  /** The window with the live camera. Without a working camera it stays open for "Kunan ng litrato ang QR". */
  async function open(opts) {
    const d = $('#scn');
    if (!d || st) return;
    const mine = st = { opts: opts || {}, stream: null, live: false, reading: false, timer: 0, hintTimer: 0, lastBad: '', lastBadAt: 0 };
    const v = $('#scv');
    say($('#sce'), '');
    say($('#scm'), MSG.wait);
    $('#scs').dataset.on = 'true';
    $('#scp').classList.add('alt');
    if (!d.open) d.showModal();
    d.scrollTop = 0;                                                                         // on a zoomed screen the window is taller than the screen: start at its title, not at the focused button
    try {
      const stream = await startCamera();
      if (st !== mine) { for (const t of stream.getTracks()) t.stop(); return; }            // closed while the phone was asking for permission
      mine.stream = stream;
      v.srcObject = stream;
      try { await v.play(); } catch { /* the first frame still arrives */ }
      if (st !== mine) return;
      say($('#scm'), MSG.aim);
      mine.live = true;
      mine.hintTimer = setTimeout(() => { if (st === mine) say($('#scm'), MSG.slow); }, 15000);
      nativeReader();                                                                        // find out now, so the first frame is not slow
      loop();
    } catch (e) {
      if (st !== mine) return;
      say($('#sce'), explain(e));
      say($('#scm'), '');
      $('#scs').dataset.on = 'false';
      $('#scp').classList.remove('alt');                                                     // the picture button is now the main way
    }
  }

  async function fromPhoto(file) {
    if (!st || !file) return;
    const mine = st;
    say($('#sce'), '');
    let bmp = null;
    try { bmp = await root.createImageBitmap(file, { imageOrientation: 'from-image' }); } catch {
      try { bmp = await root.createImageBitmap(file); } catch { bmp = null; }
    }
    if (st !== mine) return;
    if (!bmp) { say($('#sce'), MSG.badPhoto); return; }
    let texts = [];
    try { texts = await readPicture(bmp, bmp.width, bmp.height, true); } catch { texts = []; }
    if (bmp.close) bmp.close();
    if (st !== mine) return;
    if (!texts.length) { say($('#sce'), MSG.noQrInPhoto); return; }
    deliver(texts);
  }

  /** Wires the window's buttons once the page has loaded. */
  function wire() {
    const d = $('#scn');
    if (!d) return;
    $('#scx').addEventListener('click', close);
    $('#scp').addEventListener('click', () => $('#scf').click());
    $('#scf').addEventListener('change', ev => { const f = ev.target.files && ev.target.files[0]; ev.target.value = ''; fromPhoto(f); });
    d.addEventListener('close', () => { stopCamera(); st = null; });          // Esc, Back or a script closed it: the camera must go off
    d.addEventListener('cancel', () => { stopCamera(); });
    root.addEventListener('pagehide', close);
    root.document.addEventListener('visibilitychange', () => { if (root.document.hidden) close(); });
  }

  if (root.document) {
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', wire);
    else wire();
  }

  root.QrScan = { accountCode, open, close, isOpen: () => !!st };
})(typeof window !== 'undefined' ? window : globalThis);
