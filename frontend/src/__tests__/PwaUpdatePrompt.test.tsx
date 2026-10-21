import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RegisterSWOptions } from 'vite-plugin-pwa/types'
import { PwaUpdatePrompt } from '../pwaUpdatePrompt'

// The real virtual module registers a service worker; only its options are needed here
const sw = vi.hoisted(() => ({
  options: undefined as RegisterSWOptions | undefined,
  updateServiceWorker: vi.fn(async () => {}),
}))
vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: (options: RegisterSWOptions) => {
    sw.options = options
    return {
      needRefresh: [false, () => {}],
      offlineReady: [false, () => {}],
      updateServiceWorker: sw.updateServiceWorker,
    }
  },
}))

type FakeWorker = EventTarget & { state: string }
type FakeRegistration = EventTarget & {
  active: FakeWorker | null
  waiting: FakeWorker | null
  installing: FakeWorker | null
  update: ReturnType<typeof vi.fn>
}

function worker(state = 'installing'): FakeWorker {
  return Object.assign(new EventTarget(), { state })
}

function registration(active: FakeWorker | null = worker('activated')): FakeRegistration {
  return Object.assign(new EventTarget(), {
    active,
    waiting: null,
    installing: null,
    update: vi.fn(async () => {}),
  })
}

let container: EventTarget

beforeEach(() => {
  container = new EventTarget()
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: container })
  sw.updateServiceWorker.mockClear()
})

afterEach(() => {
  delete (navigator as { serviceWorker?: unknown }).serviceWorker
  vi.useRealTimers()
})

function setup(reg = registration()) {
  const reloadPage = vi.fn()
  const view = render(<PwaUpdatePrompt reloadPage={reloadPage} />)
  act(() => sw.options!.onRegisteredSW!('/sw.js', reg as unknown as ServiceWorkerRegistration))
  return { reg, reloadPage, unmount: view.unmount }
}

/** A deploy's worker installs over the active one. */
function install(reg: FakeRegistration) {
  const next = worker()
  reg.installing = next
  act(() => {
    reg.dispatchEvent(new Event('updatefound'))
    next.state = 'installed'
    reg.installing = null
    reg.waiting = next
    next.dispatchEvent(new Event('statechange'))
  })
}

const banner = () => screen.queryByText('A new version is available')

describe('PwaUpdatePrompt', () => {
  it('registers after the load event and keeps the plugin from reloading on its own', () => {
    setup()
    expect(sw.options!.immediate).toBe(false)
    expect(sw.options!.onNeedReload).toBeTypeOf('function')
  })

  it('shows the banner when a new worker installs; Reload activates it and reloads once it takes over', async () => {
    const { reg, reloadPage } = setup()
    expect(banner()).toBeNull()

    install(reg)
    expect(banner()).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(sw.updateServiceWorker).toHaveBeenCalledWith(true)
    expect(reloadPage).not.toHaveBeenCalled()

    act(() => container.dispatchEvent(new Event('controllerchange')))
    expect(reloadPage).toHaveBeenCalledOnce()

    // The worker then finishes activating: still a single reload
    const activated = reg.waiting!
    activated.state = 'activated'
    act(() => activated.dispatchEvent(new Event('statechange')))
    expect(reloadPage).toHaveBeenCalledOnce()
  })

  it('a tab the worker never controlled reloads once the new worker is active', async () => {
    const { reg, reloadPage } = setup()
    install(reg)
    await userEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(sw.updateServiceWorker).toHaveBeenCalledWith(true)

    // No controllerchange comes for an uncontrolled tab
    const next = reg.waiting!
    next.state = 'activating'
    act(() => next.dispatchEvent(new Event('statechange')))
    expect(reloadPage).not.toHaveBeenCalled()
    next.state = 'activated'
    act(() => next.dispatchEvent(new Event('statechange')))
    expect(reloadPage).toHaveBeenCalledOnce()
  })

  it('stops listening when unmounted', () => {
    vi.useFakeTimers()
    const { reg, reloadPage, unmount } = setup()
    unmount()

    act(() => container.dispatchEvent(new Event('controllerchange')))
    vi.advanceTimersByTime(60 * 60 * 1000)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(reg.update).not.toHaveBeenCalled()
    expect(reloadPage).not.toHaveBeenCalled()
  })

  it('a takeover started by another tab offers the reload instead of reloading', async () => {
    const { reg, reloadPage } = setup()

    act(() => container.dispatchEvent(new Event('controllerchange')))
    expect(reloadPage).not.toHaveBeenCalled()
    expect(banner()).toBeInTheDocument()

    // Nothing is waiting any more, so Reload reloads straight away
    expect(reg.waiting).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(reloadPage).toHaveBeenCalledOnce()
    expect(sw.updateServiceWorker).not.toHaveBeenCalled()
  })

  it('raises the banner again for a later deploy after a dismiss', async () => {
    const { reg } = setup()
    install(reg)
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(banner()).toBeNull()

    install(reg)
    expect(banner()).toBeInTheDocument()
  })

  it('does not show the banner for the first install', () => {
    const first = setup(registration(null))
    install(first.reg)
    expect(banner()).toBeNull()
  })

  it('shows the banner for a worker that was already waiting', () => {
    const reg = registration()
    reg.waiting = worker('installed')
    setup(reg)
    expect(banner()).toBeInTheDocument()
  })

  it('checks for an update hourly and when the app comes back to the foreground', () => {
    vi.useFakeTimers()
    const { reg } = setup()
    expect(reg.update).not.toHaveBeenCalled()

    vi.advanceTimersByTime(60 * 60 * 1000)
    expect(reg.update).toHaveBeenCalledTimes(1)

    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(document.visibilityState).toBe('visible')
    expect(reg.update).toHaveBeenCalledTimes(2)

    // An install already in flight finishes on its own
    reg.installing = worker()
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(reg.update).toHaveBeenCalledTimes(2)
  })
})
