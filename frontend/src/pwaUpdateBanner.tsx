import { useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * Height of the bar pinned to the bottom of the screen under `x` (phone tab bar,
 * workout bar, Log form Save bar), or 0. Measured rather than known per route:
 * the banner is mounted outside the router, and each bar has its own height.
 */
function pinnedBarHeight(x: number, banner: Element): number {
  if (typeof document.elementsFromPoint !== 'function') return 0
  const vh = window.innerHeight
  for (const el of document.elementsFromPoint(x, vh - 1)) {
    if (banner.contains(el)) continue
    const { position } = getComputedStyle(el)
    if (position !== 'fixed' && position !== 'sticky') continue
    const { top } = el.getBoundingClientRect()
    // A layer that starts at the top edge (modal backdrop, desktop sidebar) is not a bar
    if (top > 0 && top < vh) return vh - top
  }
  return 0
}

function measure(card: HTMLElement | null): number {
  if (!card) return 0
  const { left, width } = card.getBoundingClientRect()
  return pinnedBarHeight(left + width / 2, card)
}

/**
 * "A new version is available" toast, kept just above whatever bar is pinned to
 * the bottom. z-20 sits under the pages' own toasts (workout Undo, Plan) so it
 * never hides their actions.
 */
export function UpdateBanner({
  open,
  onReload,
  onDismiss,
}: {
  open: boolean
  onReload: () => void
  onDismiss: () => void
}) {
  const cardRef = useRef<HTMLDivElement>(null)
  const [barHeight, setBarHeight] = useState(0)

  // Before paint, so the banner never shows over the bar for a frame
  useLayoutEffect(() => {
    if (open) setBarHeight(measure(cardRef.current))
  }, [open])

  useEffect(() => {
    if (!open) return
    let frame = 0
    const remeasure = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setBarHeight(measure(cardRef.current)))
    }
    // Navigation mounts and unmounts the bars; text and class changes can resize one
    const observer = new MutationObserver(remeasure)
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true })
    window.addEventListener('resize', remeasure)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', remeasure)
    }
  }, [open])

  return (
    // The live region stays mounted, so screen readers announce the message when it appears
    <div
      role="status"
      data-testid="update-banner"
      className="pointer-events-none fixed inset-x-0 z-20 flex justify-center px-4 lg:justify-end lg:px-6"
      style={{ bottom: barHeight ? `${barHeight + 8}px` : 'calc(1rem + env(safe-area-inset-bottom))' }}
    >
      {open && (
        <div
          ref={cardRef}
          className="pointer-events-auto flex items-center gap-1 rounded-xl border border-border bg-surface py-1 pl-4 pr-1 text-sm text-text shadow-md"
        >
          <span className="mr-1">A new version is available</span>
          <button
            type="button"
            onClick={onReload}
            className="min-h-11 rounded-lg bg-primary-dark px-4 font-semibold text-white hover:brightness-95"
          >
            Reload
          </button>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
            className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-text-muted-strong hover:bg-primary-tint"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  )
}
