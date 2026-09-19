/// Solana contract addresses are base58 and decode to exactly 32 bytes.
/// Transaction signatures decode to 64, so they cannot collide.
/// Base58 excludes 0, O, I and l by design.
///
/// The character-count range 32-44 is necessary but NOT sufficient: plenty of
/// 32-44 character base58-looking runs are not 32-byte keys. We decode and
/// check the byte length, because a wrong call poisons the record and a missed
/// one costs nothing.
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_RUN = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;

const INDEX = new Map<string, bigint>();
for (let i = 0; i < BASE58_ALPHABET.length; i++) {
  INDEX.set(BASE58_ALPHABET[i]!, BigInt(i));
}

/// Decode base58 to bytes, or null if the string contains a non-base58 char.
export function base58Decode(s: string): Uint8Array | null {
  if (s.length === 0) return null;
  let n = 0n;
  for (const ch of s) {
    const v = INDEX.get(ch);
    if (v === undefined) return null;
    n = n * 58n + v;
  }
  const digits: number[] = [];
  while (n > 0n) {
    digits.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  // Each leading '1' is one leading zero byte.
  let leadingZeros = 0;
  while (leadingZeros < s.length && s[leadingZeros] === "1") leadingZeros++;
  return new Uint8Array([...new Array<number>(leadingZeros).fill(0), ...digits]);
}

/// True only for a base58 string that decodes to exactly 32 bytes.
export function isSolanaAddress(s: string): boolean {
  const bytes = base58Decode(s);
  return bytes !== null && bytes.length === 32;
}

/// Every distinct 32-byte base58 address in the text, in order of appearance.
export function extractSolanaAddresses(text: string): string[] {
  const out: string[] = [];
  for (const m of text.match(BASE58_RUN) ?? []) {
    if (isSolanaAddress(m) && !out.includes(m)) out.push(m);
  }
  return out;
}

/// Kept for the Day 0 dump scripts, which predate chain awareness.
/// New code should use `extractAddresses` from ../ingest/address.js.
export const extractAddresses = extractSolanaAddresses;
