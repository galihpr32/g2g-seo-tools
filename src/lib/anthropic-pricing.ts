/**
 * Anthropic model pricing — USD per 1M tokens, current as of Apr 2026.
 * Used by api-costs page to compute spend from token logs.
 *
 * Update these values when Anthropic publishes new pricing.
 */

export interface ModelPricing {
  inputPerMTok:  number   // USD per 1M input tokens
  outputPerMTok: number   // USD per 1M output tokens
}

const PRICING: Record<string, ModelPricing> = {
  // Claude 4.x family (Apr 2026)
  'claude-opus-4-6':              { inputPerMTok: 15, outputPerMTok: 75 },
  'claude-opus-4-7':              { inputPerMTok: 15, outputPerMTok: 75 },
  'claude-sonnet-4-6':            { inputPerMTok: 3,  outputPerMTok: 15 },
  'claude-haiku-4-5-20251001':    { inputPerMTok: 1,  outputPerMTok: 5  },
  'claude-haiku-4-5':             { inputPerMTok: 1,  outputPerMTok: 5  },

  // Legacy 3.x — kept in case old logs exist
  'claude-3-5-sonnet':            { inputPerMTok: 3,  outputPerMTok: 15 },
  'claude-3-5-haiku':             { inputPerMTok: 0.8, outputPerMTok: 4 },
}

export const DEFAULT_PRICING: ModelPricing = { inputPerMTok: 5, outputPerMTok: 25 }

export function pricingFor(model: string): ModelPricing {
  // Match exact, then prefix-match (e.g. "claude-haiku-4-5-20251001" → "claude-haiku-4-5")
  if (PRICING[model]) return PRICING[model]
  for (const k of Object.keys(PRICING)) {
    if (model.startsWith(k)) return PRICING[k]
  }
  return DEFAULT_PRICING
}

export function costForCall(model: string, inputTokens: number, outputTokens: number): number {
  const p = pricingFor(model)
  return (inputTokens / 1_000_000) * p.inputPerMTok + (outputTokens / 1_000_000) * p.outputPerMTok
}
