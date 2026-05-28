// ─── Mimir Memory auto-seeder ───────────────────────────────────────────────
// Scan workspace data (tier products, KB rules, brief outcomes, etc.) and
// proactively turn high-signal items into Mimir memories. Lets the assistant
// "know" the SEO state without waiting for the user to chat about it first.
//
// Sources scanned (in order of priority):
//   1. Tier 1 products  → product-scoped memory ("critical product: X | 7d clicks: N | avg pos: P")
//   2. Tier 2 products  → lower-priority product memory
//   3. brand KB rules   → global pinned rules (DOs / DON'Ts / forbidden_claims)
//   4. Brief outcomes   → lessons from past briefs (success/failure attribution)
//   5. Active campaigns → site-scoped temporal facts ("Q4 push: focus on Genshin")
//
// Idempotent: skips a memory whose content already exists for this owner.
// Safe to re-run after a tier/KB/outcome change to keep memories fresh.

import type { SupabaseClient } from '@supabase/supabase-js'

export interface SeedResult {
  scanned:     { tier: number; kb: number; outcomes: number; campaigns: number }
  inserted:    { tier: number; kb: number; outcomes: number; campaigns: number }
  skipped:     number  // already existed
  errors:      string[]
}

export async function seedMimirMemories(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any, any, any>,
  ownerId:  string,
  siteSlug: string,
): Promise<SeedResult> {
  const result: SeedResult = {
    scanned:  { tier: 0, kb: 0, outcomes: 0, campaigns: 0 },
    inserted: { tier: 0, kb: 0, outcomes: 0, campaigns: 0 },
    skipped:  0,
    errors:   [],
  }

  // Existing memories — fetch all content strings once for dedup check
  const { data: existing } = await db
    .from('mimir_memories')
    .select('content')
    .eq('owner_user_id', ownerId)
  const existingSet = new Set((existing ?? []).map(r => String(r.content).toLowerCase()))

  const toInsert: Array<Record<string, unknown>> = []

  // ── 1. Tier 1 + Tier 2 products ──────────────────────────────────────────
  try {
    const { data: tiers } = await db
      .from('product_tiers')
      .select('tier, product_name, category, url, notes, relation_id')
      .eq('owner_user_id', ownerId)
      .eq('site_slug', siteSlug)
    result.scanned.tier = tiers?.length ?? 0

    for (const t of tiers ?? []) {
      const tierLabel = t.tier === 1 ? 'Tier 1 (top 10)' : 'Tier 2 (next 25)'
      const importance = t.tier === 1 ? 85 : 65
      const content = `${tierLabel} product on ${siteSlug}: "${t.product_name}"${t.category ? ` (${t.category})` : ''}${t.notes ? ` — ${t.notes}` : ''}. Treat ranking drops and content issues here as high-priority.`

      if (existingSet.has(content.toLowerCase())) { result.skipped++; continue }
      existingSet.add(content.toLowerCase())

      toInsert.push({
        owner_user_id: ownerId,
        scope:         'site',
        site_slug:     siteSlug,
        topic_slug:    null,
        relation_id:   t.relation_id,
        category:      'fact',
        content,
        tags:          ['tier', t.tier === 1 ? 'tier1' : 'tier2', String(t.category ?? '').toLowerCase().replace(/\s+/g, '_'), 'priority_product'].filter(Boolean),
        importance,
        pinned:        t.tier === 1,   // T1 always pinned → always in context
        source_kind:   'imported',
      })
      result.inserted.tier++
    }
  } catch (e) {
    result.errors.push(`tier scan: ${e instanceof Error ? e.message : String(e)}`)
  }

  // ── 2. Brand KB DOs / DON'Ts / forbidden_claims ─────────────────────────
  try {
    const { data: kbItems } = await db
      .from('knowledge_base_items')
      .select('category, name, data')
      .eq('owner_user_id', ownerId)
      .eq('site_slug', siteSlug)
      .in('category', ['brand', 'category'])
    result.scanned.kb = kbItems?.length ?? 0

    for (const item of kbItems ?? []) {
      const data = (item.data ?? {}) as Record<string, unknown>

      // Brand DOs → preferences (pinned, importance 80)
      const dos = Array.isArray(data.dos) ? data.dos.filter(Boolean) : []
      for (const rule of dos) {
        const content = `Brand rule (DO): ${rule}`
        if (existingSet.has(content.toLowerCase())) { result.skipped++; continue }
        existingSet.add(content.toLowerCase())
        toInsert.push({
          owner_user_id: ownerId,
          scope:         'site',
          site_slug:     siteSlug,
          category:      'preference',
          content,
          tags:          ['brand', 'do', 'rule'],
          importance:    80,
          pinned:        true,
          source_kind:   'imported',
        })
        result.inserted.kb++
      }

      // Brand DON'Ts → rules (pinned, importance 90)
      const donts = Array.isArray(data.donts) ? data.donts.filter(Boolean) : []
      for (const rule of donts) {
        const content = `Brand rule (DON'T): ${rule}`
        if (existingSet.has(content.toLowerCase())) { result.skipped++; continue }
        existingSet.add(content.toLowerCase())
        toInsert.push({
          owner_user_id: ownerId,
          scope:         'site',
          site_slug:     siteSlug,
          category:      'rule',
          content,
          tags:          ['brand', 'dont', 'rule'],
          importance:    90,
          pinned:        true,
          source_kind:   'imported',
        })
        result.inserted.kb++
      }

      // Forbidden claims → rules (pinned, max importance)
      const forbidden = Array.isArray(data.forbidden_claims) ? data.forbidden_claims.filter(Boolean) : []
      for (const claim of forbidden) {
        const content = `FORBIDDEN claim: ${claim}`
        if (existingSet.has(content.toLowerCase())) { result.skipped++; continue }
        existingSet.add(content.toLowerCase())
        toInsert.push({
          owner_user_id: ownerId,
          scope:         'global',
          site_slug:     null,
          category:      'rule',
          content,
          tags:          ['brand', 'forbidden', 'compliance'],
          importance:    95,
          pinned:        true,
          source_kind:   'imported',
        })
        result.inserted.kb++
      }

      // Category buyer intent / angle / notes → category-scoped facts
      if (item.category === 'category' && item.name) {
        const cat = String(item.name)
        const buyerIntent = String(data.buyer_intent ?? '').trim()
        const angle       = String(data.angle ?? '').trim()
        if (buyerIntent) {
          const content = `Category "${cat}" buyer intent: ${buyerIntent}`
          if (!existingSet.has(content.toLowerCase())) {
            existingSet.add(content.toLowerCase())
            toInsert.push({
              owner_user_id: ownerId,
              scope:         'site',
              site_slug:     siteSlug,
              category:      'fact',
              content,
              tags:          ['category', cat.toLowerCase().replace(/\s+/g, '_'), 'buyer_intent'],
              importance:    70,
              pinned:        false,
              source_kind:   'imported',
            })
            result.inserted.kb++
          } else result.skipped++
        }
        if (angle) {
          const content = `Category "${cat}" angle/positioning: ${angle}`
          if (!existingSet.has(content.toLowerCase())) {
            existingSet.add(content.toLowerCase())
            toInsert.push({
              owner_user_id: ownerId,
              scope:         'site',
              site_slug:     siteSlug,
              category:      'preference',
              content,
              tags:          ['category', cat.toLowerCase().replace(/\s+/g, '_'), 'angle'],
              importance:    70,
              pinned:        false,
              source_kind:   'imported',
            })
            result.inserted.kb++
          } else result.skipped++
        }
      }
    }
  } catch (e) {
    result.errors.push(`KB scan: ${e instanceof Error ? e.message : String(e)}`)
  }

  // ── 3. Brief outcomes ────────────────────────────────────────────────────
  // Only seed clearly-positive or clearly-negative outcomes (skip mid-tier
  // "ok" results — they aren't strong enough lessons).
  try {
    const { data: outcomes } = await db
      .from('brief_outcomes')
      .select('brief_id, outcome_category, narrative, captured_at')
      .order('captured_at', { ascending: false })
      .limit(50)
    result.scanned.outcomes = outcomes?.length ?? 0

    for (const o of outcomes ?? []) {
      const cat = String(o.outcome_category ?? '').toLowerCase()
      if (!['success', 'big_win', 'failure', 'regression'].some(k => cat.includes(k))) continue

      const isWin = cat.includes('success') || cat.includes('win')
      const narrative = String(o.narrative ?? '').trim().slice(0, 200)
      if (!narrative) continue

      const content = `${isWin ? '✓ WIN' : '✗ LESSON'}: ${narrative}`
      if (existingSet.has(content.toLowerCase())) { result.skipped++; continue }
      existingSet.add(content.toLowerCase())

      toInsert.push({
        owner_user_id: ownerId,
        scope:         'site',
        site_slug:     siteSlug,
        category:      'lesson',
        content,
        tags:          ['brief_outcome', isWin ? 'win' : 'failure'],
        importance:    isWin ? 65 : 80,
        pinned:        false,
        source_kind:   'imported',
      })
      result.inserted.outcomes++
    }
  } catch (e) {
    result.errors.push(`outcomes scan: ${e instanceof Error ? e.message : String(e)}`)
  }

  // ── 4. Active campaigns ──────────────────────────────────────────────────
  try {
    const { data: campaigns } = await db
      .from('campaigns')
      .select('name, focus, expires_at')
      .eq('owner_user_id', ownerId)
      .eq('site_slug', siteSlug)
      .eq('status', 'active')
      .limit(10)
    result.scanned.campaigns = campaigns?.length ?? 0

    for (const c of campaigns ?? []) {
      const content = `Active campaign on ${siteSlug}: ${c.name}${c.focus ? ` — focus: ${c.focus}` : ''}.`
      if (existingSet.has(content.toLowerCase())) { result.skipped++; continue }
      existingSet.add(content.toLowerCase())
      toInsert.push({
        owner_user_id: ownerId,
        scope:         'site',
        site_slug:     siteSlug,
        category:      'fact',
        content,
        tags:          ['campaign', 'active'],
        importance:    75,
        pinned:        true,
        expires_at:    c.expires_at ?? null,
        source_kind:   'imported',
      })
      result.inserted.campaigns++
    }
  } catch (e) {
    // campaigns table may not exist in all envs — silent skip
    if (!(e instanceof Error && /does not exist/i.test(e.message))) {
      result.errors.push(`campaigns scan: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // ── Bulk insert ──────────────────────────────────────────────────────────
  if (toInsert.length > 0) {
    // Chunk insert (100 each) to avoid request size limits
    for (let i = 0; i < toInsert.length; i += 100) {
      const chunk = toInsert.slice(i, i + 100)
      const { error } = await db.from('mimir_memories').insert(chunk)
      if (error) result.errors.push(`chunk ${i}: ${error.message}`)
    }
  }

  return result
}
