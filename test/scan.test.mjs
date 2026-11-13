import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/* public/scan.js is a plain browser script that puts QrScan on `window`; it is run here as the page runs it.
 * Only the text rules are tested here (no camera in Node); the camera, the picture fallback and the window are tested in a real browser. */
const source = readFileSync(new URL('../public/scan.js', import.meta.url), 'utf8');
const fakeWindow = {};
new Function('window', source)(fakeWindow);
const Q = fakeWindow.QrScan;

test('loads without a page (nothing touches the document until the scanner is opened)', () => {
  assert.equal(typeof Q.open, 'function');
  assert.equal(typeof Q.close, 'function');
  assert.equal(Q.isOpen(), false);
});

test('an Account Code as the Registration QR holds it comes through unchanged', () => {
  assert.equal(Q.accountCode('00900000000001'), '00900000000001');
  assert.equal(Q.accountCode('123456789012'), '123456789012');
  assert.equal(Q.accountCode('  00900000000001  '), '00900000000001');
  assert.equal(Q.accountCode('00900000000001\n'), '00900000000001');
});

test('digits written in groups lose their separators, like a typed code does', () => {
  assert.equal(Q.accountCode('0090 0000 000003'), '00900000000003');
  assert.equal(Q.accountCode('0090-0000-000003'), '00900000000003');
  assert.equal(Q.accountCode('0090.0000.000003'), '00900000000003');
  assert.equal(Q.accountCode('0090\n0000\n000003'), '00900000000003');
  assert.equal(Q.accountCode('0090  -  0000'), '00900000');
  assert.equal(Q.accountCode('-1234567'), '1234567');          // a stray dash is dropped, as it is when typed
});

test('one word of letters and digits is accepted as it is (the server decides whether such a code exists)', () => {
  assert.equal(Q.accountCode('AB-1234'), 'AB-1234');
  assert.equal(Q.accountCode('ab1234/5'), 'ab1234/5');
  assert.equal(Q.accountCode('ZZ-NO-SUCH-CODE'), 'ZZ-NO-SUCH-CODE');
});

test('anything that is not an Account Code is refused: web addresses, sentences, Wi-Fi and contact codes, empty and huge text', () => {
  for (const t of [
    'https://example.com/eballot', 'HTTPS://EXAMPLE.INVALID/EBALLOT', 'http://x.y', 'WIFI:S:home;T:WPA;P:secret;;',
    'BEGIN:VCARD', 'tel:+639171234567', 'mailto:a@b.c', 'Hello World', 'AB 1234', 'AB  CD',
    '', '   ', null, undefined, '123', '12', '1',
    '1'.repeat(33), 'A'.repeat(65), '9'.repeat(200),
    '٠٠٩٠٠٠٠٠', '.1234567x', '12 34 5x',
  ]) {
    assert.equal(Q.accountCode(t), '', JSON.stringify(t));
  }
});

test('control characters never get through, and the length limits are 4 to 32 characters', () => {
  assert.equal(Q.accountCode('0090\u0000 0000'), '00900000');
  assert.equal(Q.accountCode('1234'), '1234');
  assert.equal(Q.accountCode('1'.repeat(32)), '1'.repeat(32));
  assert.equal(Q.accountCode('A234'), 'A234');
  assert.equal(Q.accountCode('A'.repeat(32)), 'A'.repeat(32));
  assert.equal(Q.accountCode('A'.repeat(33)), '');
});

test('a scanned code and a typed code end up the same after the page cleans them (typed: RepLogic.cleanAccountCode)', () => {
  const logicSrc = readFileSync(new URL('../public/logic.js', import.meta.url), 'utf8');
  const w = {};
  new Function('window', logicSrc)(w);
  for (const t of ['00900000000001', '0090 0000 000003', '0090-0000-000003', ' 00900000000002 ', 'AB-1234']) {
    assert.equal(w.RepLogic.cleanAccountCode(Q.accountCode(t)), w.RepLogic.cleanAccountCode(t), t);
  }
});
