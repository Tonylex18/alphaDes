/**
 * Generating a narrative for a call that arrived with nothing.
 *
 * The inversion from the Day 0 dumps: where the channel gave us the caller's
 * own prose, that IS the narrative and we never touch it. Generation exists
 * only for BARE_CA calls, which arrive as an address and no context at all.
 *
 * Two rules shape the whole design:
 *
 *  - Sourced from the project's own socials, never from our speculation. So the
 *    model gets `web_fetch` restricted by `allowed_domains` to the hostnames of
 *    THIS token's own links. It cannot read anything else, and it cannot search.
 *    If those pages say nothing useful it must say so.
 *  - Written once, never regenerated. The narrative records what was claimed at
 *    call time; regenerating would quietly rewrite history — the same failure
 *    as overwriting calledAtMarketCapUsd.
 */
import Anthropic from "@anthropic-ai/sdk";

/// Opus 5. Effort is low because this is a short summarisation of a page we
/// hand it — not a reasoning task.
export const MODEL = "claude-opus-5";
const MAX_TOKENS = 500;
/// Opus 5 list price, $ per million tokens.
const USD_PER_MTOK_INPUT = 5;
const USD_PER_MTOK_OUTPUT = 25;

/// The model says this, exactly, when the project's own pages do not support a
/// description. Parsing a sentinel is less fragile than hoping for a shape.
const INSUFFICIENT = "INSUFFICIENT:";

const SYSTEM = `You write two or three plain sentences describing a crypto token, for a trader who has just seen it called and knows nothing about it.

Your ONLY source is the project's own pages, which you must read with the web_fetch tool. You may not use anything you already know about the token, the ticker, or similar-sounding projects, and you may not guess from the name.

Write: what it is, and where the joke or reference comes from if there is one.

Never write: whether it is a good buy, whether it will go up or down, price or market cap commentary, risk warnings, or any recommendation. You are describing, not assessing.

If the pages you can read do not tell you what the project is — they are unreachable, empty, a parked domain, or just a logo and a buy button — reply with exactly "${INSUFFICIENT}" followed by a short reason, and nothing else. That is a perfectly good answer. Never fill the gap with a plausible-sounding description.`;

export type TokenForNarrative = {
  id: string;
  address: string;
  symbol: string | null;
  name: string | null;
  websiteUrl: string | null;
  twitterUrl: string | null;
  telegramUrl: string | null;
};

export type GenerationResult =
  | {
      ok: true;
      summary: string;
      sourceUrls: string[];
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
    }
  | { ok: false; reason: string; sourceUrls: string[]; inputTokens: number; outputTokens: number; costUsd: number };

/// The project's own links, and the hostnames web_fetch is allowed to touch.
export function sourcesFor(t: TokenForNarrative): { urls: string[]; domains: string[] } {
  const urls = [t.websiteUrl, t.twitterUrl, t.telegramUrl].filter((u): u is string => Boolean(u));
  const domains: string[] = [];
  for (const u of urls) {
    try {
      const host = new URL(u).hostname.replace(/^www\./, "");
      // allowed_domains rejects single-label names and IPs.
      if (host.includes(".") && !/^[\d.]+$/.test(host) && !domains.includes(host)) domains.push(host);
    } catch {
      // not a URL we can constrain — ignore it rather than widen the allowlist
    }
  }
  return { urls, domains };
}

export function costOf(inputTokens: number, outputTokens: number): number {
  return (inputTokens / 1e6) * USD_PER_MTOK_INPUT + (outputTokens / 1e6) * USD_PER_MTOK_OUTPUT;
}

export async function generateNarrative(
  client: Anthropic,
  token: TokenForNarrative,
): Promise<GenerationResult> {
  const { urls, domains } = sourcesFor(token);
  const empty = { sourceUrls: urls, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  if (domains.length === 0) {
    return { ok: false, reason: "no website, X or Telegram link on the token's DEX listing", ...empty };
  }

  const label = token.name ?? token.symbol ?? token.address;
  const prompt =
    `Token: ${label}${token.symbol ? ` ($${token.symbol})` : ""}\n` +
    `Its own pages:\n${urls.map((u) => `- ${u}`).join("\n")}\n\n` +
    `Read those pages and describe the project in two or three sentences.`;

  let response: Anthropic.Message;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      output_config: { effort: "low" },
      system: SYSTEM,
      tools: [
        {
          type: "web_fetch_20260209",
          name: "web_fetch",
          max_uses: 4,
          // The whole guarantee: it can read this project's pages and nothing
          // else. No search, no wandering, no other projects to confuse it.
          allowed_domains: domains,
        } as unknown as Anthropic.ToolUnion,
      ],
      messages: [{ role: "user", content: prompt }],
    });
  } catch (e) {
    const msg = e instanceof Anthropic.APIError ? `${e.status}: ${e.message}` : String((e as Error)?.message ?? e);
    return { ok: false, reason: `api error — ${msg.slice(0, 200)}`, ...empty };
  }

  const inputTokens = response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0);
  const outputTokens = response.usage.output_tokens;
  const costUsd = costOf(inputTokens, outputTokens);
  const spend = { inputTokens, outputTokens, costUsd, sourceUrls: urls };

  if (response.stop_reason === "refusal") {
    return { ok: false, reason: `model declined (${response.stop_details?.category ?? "unknown"})`, ...spend };
  }

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text.trim())
    .join("\n")
    .trim();

  if (!text) return { ok: false, reason: "model returned no text", ...spend };
  if (text.startsWith(INSUFFICIENT)) {
    return { ok: false, reason: `nothing usable on the project's own pages — ${text.slice(INSUFFICIENT.length).trim().slice(0, 200)}`, ...spend };
  }
  // A refusal to invent can arrive without the sentinel; do not store a
  // sentence that is about the absence of information.
  if (/^(i (cannot|can't|was unable)|unable to|the pages? (do|does) not)/i.test(text)) {
    return { ok: false, reason: `nothing usable on the project's own pages — ${text.slice(0, 200)}`, ...spend };
  }

  return { ok: true, summary: text, ...spend };
}
