import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

export const maxDuration = 10

// ─── Slack routing config CRUD ──────────────────────────────────────────────
// One row per (owner × site_slug? × notification_type). Caller can either
// scope a row to a specific brand (site_slug = 'g2g' / 'offgamers') or leave
// site_slug = null for a brand-agnostic mapping.
//
// GET    — list all rows for the calling owner
// POST   — upsert a row (id optional; UNIQUE(owner, site_slug, type))
// DELETE — remove a row by id

const VALID_TYPES = [
  'agent_performance',
  'tier_summary',
  'weekly_report',
  'daily_alerts',
  'cms_alerts',
  'bug_reports',
  'general',
] as const
type ValidType = typeof VALID_TYPES[number]

function isValidType(s: unknown): s is ValidType {
  return typeof s === 'string' && (VALID_TYPES as readonly string[]).includes(s)
}

// ── GET ────────────────────────────────────────────────────────────────────
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const { data, error } = await db
    .from('slack_routing_config')
    .select('id, owner_user_id, site_slug, notification_type, webhook_url, channel_label, enabled, updated_at')
    .eq('owner_user_id', ownerId)
    .order('notification_type', { ascending: true })
    .order('site_slug',        { ascending: true, nullsFirst: true })

  // Surface whether env fallback is set so the UI can show "✓ Global default
  // configured via env" vs "⚠ No webhook anywhere".
  const env_fallback_set = !!process.env.SLACK_WEBHOOK_URL && process.env.SLACK_WEBHOOK_URL !== 'placeholder'

  // If the table is missing (migration not applied yet) we still want the UI
  // to render the 7 form templates — surface a soft warning instead of 500
  // so Galih can paste webhook URLs and the schema is ready post-migration.
  if (error) {
    const msg = error.message ?? ''
    const isMissingTable = msg.toLowerCase().includes("could not find the table") || msg.toLowerCase().includes('does not exist')
    return NextResponse.json({
      configs: [],
      env_fallback_set,
      notification_types: VALID_TYPES,
      migration_missing: isMissingTable,
      error: isMissingTable
        ? 'slack_routing_config table not found — apply supabase/migrations/add_slack_routing_config.sql in the Supabase SQL editor, then reload this page.'
        : msg,
    })
  }

  return NextResponse.json({
    configs: data ?? [],
    env_fallback_set,
    notification_types: VALID_TYPES,
    migration_missing: false,
  })
}

// ── POST (upsert) ──────────────────────────────────────────────────────────
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const body = await req.json().catch(() => ({})) as {
    id?:                 string
    site_slug?:          string | null
    notification_type?:  string
    webhook_url?:        string
    channel_label?:      string | null
    enabled?:            boolean
  }

  if (!isValidType(body.notification_type)) {
    return NextResponse.json({ error: 'notification_type invalid' }, { status: 400 })
  }
  const url = String(body.webhook_url ?? '').trim()
  if (!url.startsWith('https://hooks.slack.com/')) {
    return NextResponse.json({ error: 'webhook_url must be a hooks.slack.com URL' }, { status: 400 })
  }

  const payload = {
    owner_user_id:     ownerId,
    site_slug:         body.site_slug || null,   // '' / undefined → null (site-agnostic)
    notification_type: body.notification_type,
    webhook_url:       url,
    channel_label:     body.channel_label?.toString().slice(0, 80) ?? null,
    enabled:           body.enabled !== false,    // default to true
    updated_at:        new Date().toISOString(),
  }

  // We rely on the UNIQUE(owner_user_id, site_slug, notification_type)
  // constraint. Postgres treats two NULL site_slugs as distinct in a UNIQUE
  // index — which actually plays to our advantage: if a row already exists
  // with the same triple, upsert will succeed via the constraint targeting.
  const { data, error } = await db
    .from('slack_routing_config')
    .upsert(payload, { onConflict: 'owner_user_id,site_slug,notification_type' })
    .select('*')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ config: data })
}

// ── DELETE ─────────────────────────────────────────────────────────────────
export async function DELETE(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const id = new URL(req.url).searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const { error } = await db
    .from('slack_routing_config')
    .delete()
    .eq('id', id)
    .eq('owner_user_id', ownerId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
