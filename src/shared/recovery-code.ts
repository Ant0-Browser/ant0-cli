import { ParseError } from "./parse-error.js";

/** A recovery code encodes exactly this many raw bytes. */
export const RECOVERY_CODE_BYTES = 32;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Format 32 raw bytes as 13 dash-separated groups of four base32 characters. */
export function formatRecoveryCode(raw: Uint8Array): string {
  if (raw.length !== RECOVERY_CODE_BYTES) throw new ParseError("recovery code must be 32 bytes");
  let bits = 0;
  let value = 0;
  let encoded = "";
  for (const byte of raw) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      encoded += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) encoded += BASE32[(value << (5 - bits)) & 31];
  return encoded.match(/.{4}/g)!.join("-");
}

/** Parse a recovery code (dashes and case ignored) back to its 32 raw bytes. */
export function parseRecoveryCode(text: string): Buffer {
  if (typeof text !== "string" || text.length > 128 || /[^A-Za-z2-7-]/.test(text)) {
    throw new ParseError("recovery code contains an invalid character");
  }
  const encoded = text.replaceAll("-", "").toUpperCase();
  if (encoded.length !== 52)
    throw new ParseError("recovery code must contain 52 base32 characters");
  const out = Buffer.alloc(RECOVERY_CODE_BYTES);
  let bits = 0;
  let value = 0;
  let offset = 0;
  for (const char of encoded) {
    const digit = BASE32.indexOf(char);
    if (digit < 0) throw new ParseError("recovery code contains an invalid base32 character");
    value = (value << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      if (offset < out.length) out[offset++] = (value >>> bits) & 0xff;
    }
  }
  if (offset !== RECOVERY_CODE_BYTES || bits !== 4 || (value & 0x0f) !== 0) {
    throw new ParseError("recovery code has non-zero unused base32 bits");
  }
  return out;
}
