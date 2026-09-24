import assert from 'node:assert/strict';
import test from 'node:test';

import { createTotpVerifier } from '../totp.js';

// RFC 6238 appendix B SHA1 secret "12345678901234567890" in Base32.
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

test('totp matches the RFC 6238 SHA1 test vectors (last 6 digits)', () => {
  const vectors: Array<[number, string]> = [
    [59, '287082'],
    [1111111109, '081804'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ];
  for (const [seconds, code] of vectors) {
    const verify = createTotpVerifier(RFC_SECRET, () => seconds * 1000);
    assert.equal(verify(code), true, `code at T=${seconds}`);
  }
});

test('totp tolerates one step of clock drift but not two', () => {
  const at = (seconds: number) => createTotpVerifier(RFC_SECRET, () => seconds * 1000);
  // '081804' is the code for the step containing T=1111111109.
  assert.equal(at(1111111109 + 30)('081804'), true);
  assert.equal(at(1111111109 - 30)('081804'), true);
  assert.equal(at(1111111109 + 60)('081804'), false);
});

test('totp rejects replayed, malformed and wrong codes', () => {
  const verify = createTotpVerifier(RFC_SECRET, () => 59_000);
  assert.equal(verify('000000'), false);
  assert.equal(verify('28708'), false);
  assert.equal(verify('28708a'), false);
  assert.equal(verify(''), false);
  assert.equal(verify('287082'), true);
  assert.equal(verify('287082'), false);
});

test('totp rejects a secret that is not Base32', () => {
  assert.throws(() => createTotpVerifier('not base32!'));
});
