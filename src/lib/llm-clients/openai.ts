// ─── OpenAI Chat Completions Client (lightweight) ─────────────────────────────
//
// Used by Frey to query GPT models for AI visibility tracking. Kept narrow:
// only chat completions, no streaming, no tools — just send prompt → get text.
//
// Env: OPENAI_API_KEY

const BASE = 'https://api.openai.com/v1'

export interface OpenAIChatRequest {
  model:        string
  prompt:       string
  systemPrompt?: string
  maxTokens?:   number
  temperature?: number
}

export interface OpenAIChatResponse {
  text:           string
  model:          string
  inputTokens:    number
  outputTokens:   number
  totalTokens:    number
}

/**
 * Single-shot chat completion. Returns the model's text response + token usage.
 * Returns null on failure (auth, network, rate limit) — caller handles fallback.
 */
export async function chatCompletion(req: OpenAIChatRequest): Promise<OpenAIChatResponse | null> {
  if (!process.env.OPENAI_API_KEY) {
    console.warn('[openai] OPENAI_API_KEY not set')
    return null
  }

  const messages: Array<{ role: string; content: string }> = []
  if (req.systemPrompt) messages.push({ role: 'system', content: req.systemPrompt })
  messages.push({ role: 'user', content: req.prompt })

  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model:       req.model,
        messages,
        max_tokens:  req.maxTokens ?? 1024,
        temperature: req.temperature ?? 0.3,
      }),
      signal: AbortSignal.timeout(30_000),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.error(`[openai] chat HTTP ${res.status}:`, text.slice(0, 300))
      return null
    }

    const data = await res.json() as {
      choices: Array<{ message: { content: string } }>
      usage:   { prompt_tokens: number; completion_tokens: number; total_tokens: number }
      model:   string
    }

    const text = data.choices?.[0]?.message?.content ?? ''
    if (!text) {
      console.error('[openai] empty response')
      return null
    }

    return {
      text,
      model:        data.model,
      inputTokens:  data.usage?.prompt_tokens     ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
      totalTokens:  data.usage?.total_tokens      ?? 0,
    }
  } catch (err) {
    console.error('[openai] chat error:', err instanceof Error ? err.message : String(err))
    return null
  }
}
