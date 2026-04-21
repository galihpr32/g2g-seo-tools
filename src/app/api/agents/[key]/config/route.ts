import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

// GET /api/agents/[key]/config — fetch current config for an agent
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ key: string }> }
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { key } = await params
  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const { data } = await db
    .from('agents')
    .select('config')
    .eq('owner_user_id', ownerId)
    .eq('agent_key', key)
    .maybeSingle()

  return NextResponse.json({ config: data?.config ?? {} })
}

// PATCH /api/agents/[key]/config — save config for an agent
// Body: { config: Record<string, unknown> }
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ key: string }> }
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { key } = await params
  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const body = await request.json() as { config: Record<string, unknown> }
  if (!body.config || typeof body.config !== 'object') {
    return NextResponse.json({ error: 'config object required' }, { status: 400 })
  }

  // Upsert agent row with new config
  const { error } = await db
    .from('agents')
    .upsert({
      owner_user_id: ownerId,
      agent_key: key,
      config: body.config,
    }, { onConflict: 'owner_user_id,agent_key' })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
