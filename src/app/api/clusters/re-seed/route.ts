import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'
import { resolveBrandNamesBulk, brandSlug } from '@/lib/clusters/resolve-brand-name'

export const maxDuration = 60

/**
 * Sprint CLUSTER.RENAME.2 — re-seed cluster names from canonical sources.
 *
 * Background: add_saga_cluster_hierarchy.sql used `split_part(name, ' ', 1)` to
 * seed level-0 brand clusters, giving us "Counter" for CSGO, "World" for WoW,
 * etc. This endpoint rewrites those names in-place using resolveBrandName.
 *
 * Strategy:
 *   • UPDATE in-place (preserve cluster_id → FK to keyword_map_clusters stays intact)
 *   • Backup the old topic to keyword_maps.topic_original (only on first run; subsequent
 *     re-seeds don't overwrite the backup, so revert always points to the original)
 *   • For level-1 sub-products: strip the (old) brand prefix when the sub topic
 *     starts with it, since "World of Warcraft Gold" under brand "World of Warcraft"
 *     becomes redundant — strip to "Gold"
 *
 * Body:
 *   { dry_run?: boolean }   // default false — when true, return preview without writing
 *
 * Response:
 *   { ok, preview: [{ cluster_id, level, old, new, source }], applied: N }
 *
 * Scope: only touches clusters with source='tracked_product' AND auto_generated=true.
 * Manual clusters (source='manual') are untouched.
 */
interface RenameRow {
  cluster_id: string
  level:      number
  old:        string
  new:        string
  source:     'override' | 'catalog' | 'name' | 'strip-prefix'
  parent_id:  string | null
}

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db       = createServiceClient()

  const body = await req.json().catch(() => ({})) as { dry_run?: boolean }
  const dryRun = !!body.dry_run

  // 1. Resolve canonical brand name per tier
  const resolved = await resolveBrandNamesBulk(db, ownerId, siteSlug)
  if (resolved.size === 0) {
    return NextResponse.json({ ok: true, preview: [], applied: 0, message: 'No tier products to resolve.' })
  }

  // 2. Load all auto-seeded clusters for this site
  const { data: clusters } = await db
    .from('keyword_maps')
    .select('id, topic, topic_slug, level, parent_map_id, source, auto_generated, topic_original')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .eq('source', 'tracked_product')
    .eq('auto_generated', true)
  const allClusters = (clusters ?? []) as Array<{
    id: string; topic: string; topic_slug: string; level: number
    parent_map_id: string | null; source: string; auto_generated: boolean
    topic_original: string | null
  }>

  // Group by level
  const level0 = allClusters.filter(c => c.level === 0)
  const level1 = allClusters.filter(c => c.level === 1)

  // 3. Map each level-0 brand cluster to a tier (via slug match on the OLD broken topic_slug)
  // The auto-seed produced topic_slug = slug(first_word(tier.product_name)).
  // We match that back to a tier by computing slug(first_word(...)) for each tier
  // and picking the one whose first-word-slug matches the cluster's topic_slug.
  const { data: tiers } = await db
    .from('product_tiers')
    .select('id, product_name')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
  const tierRows = (tiers ?? []) as Array<{ id: string; product_name: string }>

  function firstWordSlug(name: string): string {
    const first = (name ?? '').trim().split(/\s+/)[0] ?? ''
    return brandSlug(first)
  }
  const slugToTierIds = new Map<string, string[]>()
  for (const t of tierRows) {
    const k = firstWordSlug(t.product_name)
    if (!k) continue
    const arr = slugToTierIds.get(k) ?? []
    arr.push(t.id)
    slugToTierIds.set(k, arr)
  }

  // 4. Compute the new topic for each level-0 cluster
  const renames: RenameRow[] = []
  const brandSlugByClusterId = new Map<string, string>()   // cluster_id → new brand slug, for level-1 stripping
  const brandNameByClusterId = new Map<string, string>()
  for (const c of level0) {
    const tierIds = slugToTierIds.get(c.topic_slug) ?? []
    if (tierIds.length === 0) continue   // no tier matched (orphan auto cluster) — skip
    // When multiple tiers map to same cluster (common, e.g. "World of Warcraft Gold"
    // + "World of Warcraft Items" both first-word "world"), pick the one whose
    // resolved name appears most often (or just the first; they should agree
    // after resolution anyway since they share the brand).
    let winner: { id: string; resolved: string; source: 'override' | 'catalog' | 'name' } | null = null
    for (const tid of tierIds) {
      const r = resolved.get(tid)
      if (!r) continue
      if (!winner) winner = { id: tid, ...r }
    }
    if (!winner) continue
    const newTopic = winner.resolved
    if (newTopic === c.topic) continue   // already correct (e.g. single-word brand like "Adobe")
    renames.push({
      cluster_id: c.id,
      level:      0,
      old:        c.topic,
      new:        newTopic,
      source:     winner.source,
      parent_id:  null,
    })
    brandSlugByClusterId.set(c.id, brandSlug(newTopic))
    brandNameByClusterId.set(c.id, newTopic)
  }

  // 5. For level-1 sub-products: strip the (current!) topic prefix if it starts
  //    with the new brand name. E.g. "World of Warcraft Gold" under new brand
  //    "World of Warcraft" → strip to "Gold".
  for (const c of level1) {
    if (!c.parent_map_id) continue
    const brandName = brandNameByClusterId.get(c.parent_map_id)
    if (!brandName) continue   // parent level-0 didn't get renamed — leave sub alone
    const oldTopic = c.topic
    const lowerTopic = oldTopic.toLowerCase()
    const lowerBrand = brandName.toLowerCase()
    if (!lowerTopic.startsWith(lowerBrand)) continue   // no prefix to strip
    const stripped = oldTopic.slice(brandName.length).replace(/^[\s\-:]+/, '').trim()
    if (!stripped || stripped === oldTopic) continue
    renames.push({
      cluster_id: c.id,
      level:      1,
      old:        oldTopic,
      new:        stripped,
      source:     'strip-prefix',
      parent_id:  c.parent_map_id,
    })
  }

  if (dryRun) {
    return NextResponse.json({ ok: true, preview: renames, applied: 0, dry_run: true })
  }

  // 6. Apply: UPDATE in-place. Preserve cluster_id. Backup old topic on first rename.
  let applied = 0
  for (const r of renames) {
    const cluster = allClusters.find(c => c.id === r.cluster_id)
    if (!cluster) continue
    const newSlug = brandSlug(r.new)
     
    const { error } = await db
      .from('keyword_maps')
      .update({
        topic:          r.new,
        topic_slug:     newSlug,
        topic_original: cluster.topic_original ?? cluster.topic,   // only backup if not already backed up
        updated_at:     new Date().toISOString(),
      })
      .eq('id', r.cluster_id)
    if (!error) applied++
  }

  return NextResponse.json({ ok: true, preview: renames, applied })
}
