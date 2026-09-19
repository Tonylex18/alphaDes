/**
 * Chain-aware address extraction.
 *
 * Solana-only was an incorrect assumption. Both channels post EVM addresses,
 * and <private-channel> posts them bare — i.e. as calls. In the Day 0 dumps:
 *   <private-channel>      3 bare EVM calls (1186, 1196, 1279) + 1 inside a promo (1200)
 *   AlphaDesJurix   2 EVM calls (7520 BNB, 7550 HyperEVM)
 * All six were invisible to the original base58-only regex.
 */
import { isSolanaAddress } from "../lib/solana.js";

export type Chain = "SOLANA" | "EVM";

export type FoundAddress = {
  address: string;
  chain: Chain;
  /// Where in the (URL-stripped) text it started. Used to tell a call from
  /// commentary: in a BARE_CA channel the address leads the message.
  index: number;
};

const BASE58_RUN = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const EVM_ADDRESS = /\b0x[a-fA-F0-9]{40}\b/g;
const URL = /\bhttps?:\/\/\S+/gi;

/// Replace every URL with same-length spaces, so character offsets still line
/// up with the original text. An address inside a link is a reference to a
/// token, not a call for it — AlphaDesJurix 7667 links coinboom.net/solana/<CA>
/// as a follow-up to a call made an hour earlier. Counting that as a call would
/// have created a duplicate.
export function stripUrls(text: string): string {
  return text.replace(URL, (m) => " ".repeat(m.length));
}

/// Every distinct address in the text, in order of appearance, URLs ignored.
export function extractAddresses(text: string): FoundAddress[] {
  const scannable = stripUrls(text);
  const out: FoundAddress[] = [];
  const seen = new Set<string>();

  const push = (address: string, chain: Chain, index: number) => {
    if (seen.has(address)) return;
    seen.add(address);
    out.push({ address, chain, index });
  };

  for (const m of scannable.matchAll(EVM_ADDRESS)) {
    push(m[0], "EVM", m.index);
  }
  for (const m of scannable.matchAll(BASE58_RUN)) {
    // Decode, don't trust the shape. See lib/solana.ts.
    if (isSolanaAddress(m[0])) push(m[0], "SOLANA", m.index);
  }

  return out.sort((a, b) => a.index - b.index);
}

/// EVM addresses are case-insensitive (the mixed case is an EIP-55 checksum),
/// Solana's base58 is not. Normalise before comparing or storing.
export function normaliseAddress(address: string, chain: Chain): string {
  return chain === "EVM" ? address.toLowerCase() : address;
}
