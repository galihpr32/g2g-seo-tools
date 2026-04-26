'use client'

import { useEffect, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { RealtimeChannel } from '@supabase/supabase-js'

/**
 * useRealtimeRefresh — subscribes to Supabase realtime postgres_changes on
 * the given table, calls `onChange` when any matching event fires.
 *
 * Soft fallback: if realtime isn't enabled on the table (publication config),
 * the subscription silently no-ops. Components using this hook should still
 * have their normal polling fallback in place.
 *
 * Caller responsibility: pass a stable `onChange` callback (e.g. via useCallback)
 * to avoid re-subscribe storms.
 *
 * Usage:
 *   useRealtimeRefresh({
 *     table:  'agent_actions',
 *     filter: `owner_user_id=eq.${userId}`,
 *     events: ['INSERT', 'UPDATE'],
 *     onChange: () => refetch(),
 *   })
 */
interface UseRealtimeRefreshArgs {
  table:    string
  filter?:  string
  events?:  Array<'INSERT' | 'UPDATE' | 'DELETE'>
  onChange: () => void
  enabled?: boolean
}

export function useRealtimeRefresh({
  table,
  filter,
  events  = ['INSERT', 'UPDATE'],
  onChange,
  enabled = true,
}: UseRealtimeRefreshArgs) {
  const onChangeRef = useRef(onChange)
  useEffect(() => { onChangeRef.current = onChange }, [onChange])

  useEffect(() => {
    if (!enabled) return
    const supabase = createClient()
    const channelName = `realtime:${table}:${filter ?? 'all'}`
    let channel: RealtimeChannel | null = null

    try {
      channel = supabase.channel(channelName)

      for (const event of events) {
        channel.on(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          'postgres_changes' as any,
          { event, schema: 'public', table, filter } as Record<string, unknown>,
          () => onChangeRef.current()
        )
      }

      channel.subscribe(status => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          // Realtime not enabled / network issue — quietly ignore.
          // Polling fallback in caller still works.
          // console.warn(`[realtime] ${channelName} status:`, status)
        }
      })
    } catch (e) {
      console.warn(`[realtime] subscribe failed for ${table}:`, e)
    }

    return () => {
      if (channel) {
        supabase.removeChannel(channel).catch(() => { /* ignore */ })
      }
    }
  }, [table, filter, events, enabled])
}
