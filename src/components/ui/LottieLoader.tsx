'use client'

// ── LottieLoader ──────────────────────────────────────────────────────────────
// Drop-in replacement for all loading spinners across the app.
//
// Usage:
//   <LottieLoader />                         — inline dots, 80px wide
//   <LottieLoader size={120} text="…" />     — bigger + caption
//   <PageLoader text="Analyzing page…" />    — centered full-card loader
//
// Swap animation: replace /src/components/ui/loadingAnimation.json with any
// Lottie JSON downloaded from https://lottiefiles.com (free tier → download JSON).

import Lottie from 'lottie-react'
import defaultAnimation from './loadingAnimation.json'

interface LottieLoaderProps {
  /** Pass your own Lottie JSON to override the default animation */
  animationData?: object
  /** Width (and height) in px — default 80 */
  size?: number
  /** Optional caption shown below the animation */
  text?: string
  className?: string
}

export function LottieLoader({
  animationData,
  size = 80,
  text,
  className = '',
}: LottieLoaderProps) {
  return (
    <div className={`flex flex-col items-center justify-center gap-2 ${className}`}>
      <Lottie
        animationData={animationData ?? defaultAnimation}
        loop
        style={{ width: size, height: size }}
      />
      {text && (
        <p className="text-gray-400 text-sm">{text}</p>
      )}
    </div>
  )
}

// ── PageLoader ────────────────────────────────────────────────────────────────
// Full-card loading state: centered, with optional title + step list.
interface PageLoaderProps {
  animationData?: object
  title?: string
  steps?: string[]
  size?: number
}

export function PageLoader({
  animationData,
  title = 'Loading…',
  steps,
  size = 110,
}: PageLoaderProps) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-10 text-center">
      <div className="flex justify-center mb-4">
        <Lottie
          animationData={animationData ?? defaultAnimation}
          loop
          style={{ width: size, height: size }}
        />
      </div>
      <p className="text-white font-semibold mb-2">{title}</p>
      {steps && steps.length > 0 && (
        <div className="text-gray-500 text-sm space-y-1">
          {steps.map((s, i) => (
            <p key={i}>{s}</p>
          ))}
        </div>
      )}
    </div>
  )
}
