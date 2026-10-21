/// <reference types="vite-plugin-pwa/react" />
import { useEffect, useRef, useState } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { UpdateBanner } from './pwaUpdateBanner'

const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000

/** Re-fetch sw.js. A changed worker installs and waits, which raises the banner. */
function checkForUpdate(registration: ServiceWorkerRegistration) {
  // A worker already installing finishes on its own; offline, update() only rejects
  if (registration.installing || !navigator.onLine) return
  registration.update().catch(() => {})
}

/**
 * Calls `onUpdate` whenever a new worker finishes installing over an existing one,
 * and returns a function that stops watching. workbox-window reports only the
 * first update in a page's lifetime (it drops its updatefound listener after one
 * it didn't trigger), and a Home Screen app can stay resumed for days across
 * several deploys.
 */
function watchForUpdates(registration: ServiceWorkerRegistration, onUpdate: () => void) {
  const onInstalled = (event: Event) => {
    if ((event.target as ServiceWorker).state === 'installed') onUpdate()
  }
  const tracked = new Set<ServiceWorker>()
  const track = (worker: ServiceWorker | null) => {
    // No active worker yet: this is the first install, not an update
    if (!worker || !registration.active) return
    tracked.add(worker)
    worker.addEventListener('statechange', onInstalled)
  }
  const onUpdateFound = () => track(registration.installing)

  if (registration.waiting && registration.active) onUpdate()
  track(registration.installing)
  registration.addEventListener('updatefound', onUpdateFound)
  return () => {
    registration.removeEventListener('updatefound', onUpdateFound)
    tracked.forEach((worker) => worker.removeEventListener('statechange', onInstalled))
  }
}

/**
 * Registers the service worker and, once a deploy's new worker has installed,
 * offers a reload. Nothing reloads a tab unless the user taps Reload in that tab:
 * a silent reload mid-workout would lose form state. A dismissed update takes
 * over once every tab of the app is closed.
 *
 * `reloadPage` is a prop so tests can observe it.
 */
export function PwaUpdatePrompt({ reloadPage = () => window.location.reload() }: { reloadPage?: () => void }) {
  const [open, setOpen] = useState(false)
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null)
  const reloadRequested = useRef(false)
  const reloading = useRef(false)
  const reloadPageRef = useRef(reloadPage)
  reloadPageRef.current = reloadPage

  // Reads only refs, so the copy the effect below captured on its first run stays correct
  const reloadOnce = () => {
    if (reloading.current) return
    reloading.current = true
    reloadPageRef.current()
  }

  const { updateServiceWorker } = useRegisterSW({
    // Register after the load event, so the precache downloads don't compete with the first screen
    immediate: false,
    // A worker that was already waiting when the page loaded
    onNeedRefresh: () => setOpen(true),
    // The plugin would reload this tab whenever the new worker takes over, even when
    // another tab's Reload activated it; the controllerchange listener below decides instead
    onNeedReload: () => {},
    onRegisteredSW: (_swUrl, reg) => {
      if (reg) setRegistration(reg)
    },
  })

  useEffect(() => {
    if (!registration) return
    const stopWatching = watchForUpdates(registration, () => setOpen(true))
    const onControllerChange = () => {
      if (reloadRequested.current) reloadOnce()
      // Activated from another tab: this one still runs the old version
      else setOpen(true)
    }
    const container = navigator.serviceWorker
    container.addEventListener('controllerchange', onControllerChange)
    const interval = setInterval(() => checkForUpdate(registration), UPDATE_CHECK_INTERVAL_MS)
    // A Home Screen app is usually resumed rather than relaunched
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') checkForUpdate(registration)
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      stopWatching()
      container.removeEventListener('controllerchange', onControllerChange)
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [registration])

  const reload = () => {
    reloadRequested.current = true
    const waiting = registration?.waiting
    if (waiting) {
      // A controlled tab reloads on controllerchange; an uncontrolled one never
      // gets that event, so it reloads once the worker is active
      waiting.addEventListener('statechange', () => {
        if (waiting.state === 'activated') reloadOnce()
      })
      void updateServiceWorker(true)
    } else {
      // The new worker is already active (another tab's Reload did it, or this
      // tab was never controlled), so a plain reload loads the new version
      reloadOnce()
    }
  }

  return <UpdateBanner open={open} onReload={reload} onDismiss={() => setOpen(false)} />
}
