// ---------------------------------------------------------------------------
// util.js — byte helpers, base58, little-endian encoders, hex dumps
// ---------------------------------------------------------------------------
'use strict';

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function b58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58_ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b === 0) out = '1' + out;
    else break;
  }
  return out === '' ? '1'.repeat(bytes.length ? 1 : 0) : out;
}

function b58decode(str) {
  let n = 0n;
  for (const c of str) {
    const i = B58_ALPHABET.indexOf(c);
    if (i < 0) throw new Error(`invalid base58 character: ${c}`);
    n = n * 58n + BigInt(i);
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const c of str) {
    if (c === '1') bytes.unshift(0);
    else break;
  }
  return new Uint8Array(bytes);
}

function concatBytes(...arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

function u16le(n) {
  if (n < 0 || n > 0xffff) throw new Error(`u16 out of range: ${n}`);
  return Uint8Array.of(n & 0xff, (n >> 8) & 0xff);
}

function u32le(n) {
  if (n < 0 || n > 0xffffffff) throw new Error(`u32 out of range: ${n}`);
  return Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
}

function u64le(n) {
  n = BigInt(n);
  if (n < 0n || n > 0xffffffffffffffffn) throw new Error(`u64 out of range: ${n}`);
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function readU16le(bytes, off) {
  return bytes[off] | (bytes[off + 1] << 8);
}

function readU32le(bytes, off) {
  return (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0;
}

function readU64le(bytes, off) {
  let n = 0n;
  for (let i = 7; i >= 0; i--) n = (n << 8n) | BigInt(bytes[off + i]);
  return n;
}

// Legacy-format "compact-u16" (shortvec) length encoding.
function shortvec(n) {
  const out = [];
  let rem = n;
  for (;;) {
    let b = rem & 0x7f;
    rem >>= 7;
    if (rem === 0) {
      out.push(b);
      break;
    }
    out.push(b | 0x80);
  }
  return Uint8Array.from(out);
}

function toHex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function utf8(str) {
  return new TextEncoder().encode(str);
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
