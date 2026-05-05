import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { smartScrape } from '@/lib/firecrawl/client'
import { logApiUsage } from '@/lib/api-logger'

export const maxDuration = 30

/**
 * POST /api/news/deep-fetch
 * Body: { news_item_id: string }
 *
 * Manual on-demand FireCrawl deep-dive for a single news article.
 * Stores the full markdown into news_items.scraped_md so the UI can
 * render the full content (vs. RSS excerpt).
 */
export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  const body = await request.json().catch(() => ({})) as { news_item_id?: string }
  if (!body.news_item_id) {
    return NextResponse.json({ error: 'news_item_id required' }, { status: 400 })
  }

  // Load the item + verify ownership
  const { data: item } = await db
    .from('news_items')
    .select('id, owner_user_id, url, title, scraped_md, scraped_at')
    .eq('id', body.news_item_id)
    .maybeSingle()

  if (!item)                                  return NextResponse.json({ error: 'Item not found' }, { status: 404 })
  if (item.owner_user_id !== ownerId)         return NextResponse.json({ error: 'Forbidden'    }, { status: 403 })

  // If we already scraped < 7 days ago, return cached content
  if (item.scraped_md && item.scraped_at) {
    const ageDays = (Date.now() - new Date(item.scraped_at).getTime()) / 86400000
    if (ageDays < 7) {
      return NextResponse.json({
        ok:        true,
        cached:    true,
        scraped_md: item.scraped_md,
        title:     item.title,
        url:       item.url,
      })
    }
  }

  const scraped = await smartScrape(item.url)
  if (!scraped) {
    return NextResponse.json({ error: 'FireCrawl scrape failed (no key configured or fetch error)' }, { status: 502 })
  }

  logApiUsage(supabase, ownerId, {
    api: 'firecrawl', endpoint: 'scrape', triggeredBy: 'url_analysis',
    metadata: { url: item.url, source: 'bifrost_deep_dive' },
  })

  const md = scraped.markdown ?? ''
  const wc = scraped.wordCount ?? md.split(/\s+/).filter(Boolean).length

  await db
    .from('news_items')
    .update({
      scraped_md:         md,
      scraped_at:         new Date().toISOString(),
      scraped_word_count: wc,
    })
    .eq('id', item.id)

  return NextResponse.json({
    ok:         true,
    cached:     false,
    scraped_md: md,
    word_count: wc,
    title:      scraped.title ?? item.title,
    url:        item.url,
  })
}
