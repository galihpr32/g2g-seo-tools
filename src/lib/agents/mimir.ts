/**
 * @deprecated The "Mimir" agent was renamed to "Vor" to avoid colliding with
 * the user-facing "Mimir The All Knowing" interactive chatbot
 * (src/components/dashboard/AIAssistant.tsx + src/app/api/ai/chat/route.ts).
 *
 * Use `runVor` / `VorConfig` / `VOR_DEFAULTS` from `@/lib/agents/vor` instead.
 *
 * This file kept as a re-export stub so any stale third-party import
 * doesn't break compilation. Will be removed in a future cleanup.
 */
export { runVor as runMimir, VOR_DEFAULTS as MIMIR_DEFAULTS } from '@/lib/agents/vor'
export type { VorConfig as MimirConfig } from '@/lib/agents/vor'
