'use client'

import { useSiteSlug } from './useSiteSlug'

// Sprint THEME.BRAND — central source for per-brand visual identity.
// Used by Sidebar, SiteSwitcher, primary CTAs, and any component that
// needs to brand-adapt. Keeps tailwind classes consistent across the app.

export interface BrandTheme {
  slug:           'g2g' | 'offgamers'
  name:           string         // "G2G" | "OffGamers"
  emoji:          string         // 🎯 | 🕹️
  /** Hex color for Slack attachments / inline styles */
  hex:            string         // '#DC2626' | '#2563EB'
  /** Tailwind utility classes for common surfaces. Keep this list short —
   *  prefer combining `bgPrimary + textOnPrimary` over inventing new ones. */
  bgPrimary:      string         // 'bg-red-700' | 'bg-blue-700'
  bgPrimaryHover: string         // 'hover:bg-red-600' | ...
  bgSoft:         string         // 'bg-red-500/15' soft chip / pill
  border:         string         // 'border-red-700/40'
  text:           string         // 'text-red-300'
  textStrong:     string         // 'text-red-400'
  ring:           string         // 'ring-red-500'
  badgeBg:        string         // notification badge solid bg
}

const G2G: BrandTheme = {
  slug:           'g2g',
  name:           'G2G',
  emoji:          '🎯',
  hex:            '#DC2626',
  bgPrimary:      'bg-red-700',
  bgPrimaryHover: 'hover:bg-red-600',
  bgSoft:         'bg-red-500/15',
  border:         'border-red-700/40',
  text:           'text-red-300',
  textStrong:     'text-red-400',
  ring:           'ring-red-500',
  badgeBg:        'bg-red-600',
}

const OFFGAMERS: BrandTheme = {
  slug:           'offgamers',
  name:           'OffGamers',
  emoji:          '🕹️',
  hex:            '#2563EB',
  bgPrimary:      'bg-blue-700',
  bgPrimaryHover: 'hover:bg-blue-600',
  bgSoft:         'bg-blue-500/15',
  border:         'border-blue-700/40',
  text:           'text-blue-300',
  textStrong:     'text-blue-400',
  ring:           'ring-blue-500',
  badgeBg:        'bg-blue-600',
}

const REGISTRY: Record<string, BrandTheme> = {
  g2g:       G2G,
  offgamers: OFFGAMERS,
}

/**
 * Returns the active brand theme. Reactive — re-renders when the user
 * switches site via SiteSwitcher (uses useSiteSlug internally).
 */
export function useBrandTheme(): BrandTheme {
  const slug = useSiteSlug()
  return REGISTRY[slug] ?? G2G
}

/** Synchronous lookup for non-hook contexts (e.g. utility functions). */
export function getBrandThemeFor(slug: string | null | undefined): BrandTheme {
  return REGISTRY[slug ?? 'g2g'] ?? G2G
}
