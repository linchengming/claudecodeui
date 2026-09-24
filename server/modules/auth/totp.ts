import { createHmac, timingSafeEqual } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;
// Accept the previous and next 30s step to tolerate small clock drift.
const TOTP_WINDOW_STEPS = 1;

function decodeBase32(input: string): Buffer {
  const cleaned = input.replace(/[\s=-]/g, '').toUpperCase();
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error('TOTP_SECRET must be a Base32 string (A-Z, 2-7)');
    }
    value = ((value << 5) | index) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  if (bytes.length === 0) {
    throw new Error('TOTP_SECRET is empty');
  }
  return Buffer.from(bytes);
}

function generateCode(key: Buffer, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', key).update(message).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/**
 * Creates an RFC 6238 (HMAC-SHA1, 30s, 6 digits) verifier for a Base32 secret.
 * A code is accepted at most once, so an observed code cannot be replayed.
 */
export function createTotpVerifier(secret: string, now: () => number = Date.now) {
  const key = decodeBase32(secret);
  let lastUsedCounter = -1;

  return (code: string): boolean => {
    if (!/^\d{6}$/.test(code)) {
      return false;
    }
    const currentCounter = Math.floor(now() / 1000 / TOTP_STEP_SECONDS);
    for (let drift = -TOTP_WINDOW_STEPS; drift <= TOTP_WINDOW_STEPS; drift += 1) {
      const counter = currentCounter + drift;
      if (counter <= lastUsedCounter) {
        continue;
      }
      if (timingSafeEqual(Buffer.from(generateCode(key, counter)), Buffer.from(code))) {
        lastUsedCounter = counter;
        return true;
      }
    }
    return false;
  };
}
