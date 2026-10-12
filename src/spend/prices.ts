/**
 * API list prices, USD per million tokens, as published on 2026-09-28:
 *   platform.claude.com/docs/en/about-claude/pricing
 *   developers.openai.com/api/docs/pricing
 *
 * These give the API-equivalent cost of a session. A Claude or ChatGPT subscription is not
 * billed per token, so for those users this is what the same work would cost on the API.
 * A model missing here is reported with its tokens and no cost; users can add or correct
 * prices in ~/.config/snout/prices.json with the same shape.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface Price {
  input: number;
  /** 5-minute cache write. OpenAI has one cache-write rate; it goes here and in cacheWrite1h. */
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
  /** Fast mode input and output; cache multipliers apply on top. */
  fast?: { input: number; output: number };
}

const claude = (input: number, cacheRead: number, output: number, fast?: Price["fast"]): Price => ({
  input,
  cacheWrite5m: input * 1.25,
  cacheWrite1h: input * 2,
  cacheRead,
  output,
  ...(fast ? { fast } : {}),
});
const openai = (input: number, cacheRead: number, output: number, cacheWrite = 0): Price => ({ input, cacheWrite5m: cacheWrite, cacheWrite1h: cacheWrite, cacheRead, output });

export const PRICES_AS_OF = "2026-09-28";

export const PRICES: Record<string, Price> = {
  "claude-fable-5-1": claude(10, 0.25, 50),
  "claude-mythos-5-1": claude(10, 0.25, 50),
  "claude-fable-5": claude(10, 1, 50),
  "claude-mythos-5": claude(10, 1, 50),
  "claude-opus-5-5": claude(4, 0.2, 20, { input: 8, output: 40 }),
  "claude-opus-5": claude(5, 0.5, 25, { input: 10, output: 50 }),
  "claude-opus-4-8": claude(5, 0.5, 25, { input: 10, output: 50 }),
  "claude-opus-4-7": claude(5, 0.5, 25),
  "claude-opus-4-6": claude(5, 0.5, 25),
  "claude-opus-4-5": claude(5, 0.5, 25),
  "claude-opus-4-1": claude(15, 1.5, 75),
  "claude-opus-4": claude(15, 1.5, 75),
  "claude-sonnet-5-5": claude(2, 0.2, 10),
  "claude-sonnet-5": claude(2, 0.2, 10),
  "claude-sonnet-4-6": claude(3, 0.3, 15),
  "claude-sonnet-4-5": claude(3, 0.3, 15),
  "claude-sonnet-4": claude(3, 0.3, 15),
  // Released 2026-10-07 (anthropic.com/claude-haiku-5-5). Prompts over 100k tokens bill at 5× these
  // rates; like the other models here, the long-context tier is not modelled.
  "claude-haiku-5-5": claude(0.1, 0.01, 0.5),
  "claude-haiku-4-5": claude(1, 0.1, 5),
  "claude-3-5-haiku": claude(0.8, 0.08, 4),
  "gpt-6-astra": openai(10, 1, 50, 12.5),
  "gpt-6-sol": openai(2, 0.2, 10, 2.5),
  "gpt-6-luna": openai(0.1, 0.01, 0.5, 0.125),
  "gpt-5.6-sol": openai(4, 0.4, 20, 5),
  "gpt-5.6-terra": openai(2, 0.2, 12, 2.5),
  "gpt-5.6-luna": openai(0.2, 0.02, 1.2, 0.25),
  "gpt-5.5": openai(5, 0.5, 30),
  "gpt-5.4": openai(2.5, 0.25, 15),
  "gpt-5.3-codex": openai(1.75, 0.175, 14),
  "gpt-5.2": openai(1.75, 0.175, 14),
  "gpt-5.1": openai(1.25, 0.125, 10),
};

/** `claude-haiku-4-5-20251001` → `claude-haiku-4-5`: dated snapshots share their family's price. */
export function modelKey(model: string): string {
  return model.toLowerCase().replace(/-\d{8}$/, "").replace(/\[.*\]$/, "");
}

let overrides: Record<string, Price> | null = null;

function userPrices(configDir: string): Record<string, Price> {
  if (overrides) return overrides;
  try {
    overrides = JSON.parse(readFileSync(join(configDir, "prices.json"), "utf8")) as Record<string, Price>;
  } catch {
    overrides = {};
  }
  return overrides;
}

export function priceOf(model: string, configDir?: string): Price | null {
  const key = modelKey(model);
  const user = configDir ? userPrices(configDir) : {};
  return user[key] ?? PRICES[key] ?? null;
}

export interface Usage {
  /** Input not served from or written to the cache. */
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
  fast?: boolean;
}

/** USD for one request's usage, or null when the model has no known price. */
export function costOf(model: string, u: Usage, configDir?: string): number | null {
  const p = priceOf(model, configDir);
  if (!p) return null;
  // Fast mode raises the base rates; cache writes and reads keep their multiples of input.
  const scale = u.fast && p.fast ? p.fast.input / p.input : 1;
  const output = u.fast && p.fast ? p.fast.output : p.output;
  return (
    (u.input * p.input * scale + u.cacheWrite5m * p.cacheWrite5m * scale + u.cacheWrite1h * p.cacheWrite1h * scale + u.cacheRead * p.cacheRead * scale + u.output * output) /
    1_000_000
  );
}
