import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UpdateBanner } from '../pwaUpdateBanner'

/** A layer pinned to the viewport whose top edge is `height` px above the bottom. */
function addFixed(height: number) {
  const el = document.createElement('nav')
  el.style.position = 'fixed'
  el.getBoundingClientRect = () => ({ top: window.innerHeight - height }) as DOMRect
  document.body.appendChild(el)
  return el
}

const noop = () => {}

describe('UpdateBanner', () => {
  afterEach(() => {
    // jsdom has no elementsFromPoint; tests that need one install it
    delete (document as Partial<Document>).elementsFromPoint
    document.body.innerHTML = ''
  })

  it('keeps an empty live region mounted while closed', () => {
    render(<UpdateBanner open={false} onReload={noop} onDismiss={noop} />)
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('offers a reload and can be dismissed', async () => {
    const onReload = vi.fn()
    const onDismiss = vi.fn()
    render(<UpdateBanner open onReload={onReload} onDismiss={onDismiss} />)

    expect(screen.getByRole('status')).toHaveTextContent('A new version is available')
    await userEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(onReload).toHaveBeenCalledOnce()
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('sits just above a bar pinned to the bottom, and drops down when it goes away', async () => {
    let bar: HTMLElement | null = addFixed(64)
    document.elementsFromPoint = () => (bar ? [bar, document.body] : [document.body])

    render(<UpdateBanner open onReload={noop} onDismiss={noop} />)
    const banner = screen.getByTestId('update-banner')
    // Measured before the first paint
    expect(banner.style.bottom).toBe('72px')

    // Leaving a page with a tab bar unmounts it
    act(() => {
      bar?.remove()
      bar = null
    })
    await waitFor(() => expect(banner.style.bottom).toBe('calc(1rem + env(safe-area-inset-bottom))'))
  })

  it('follows a bar that grows when its text changes', async () => {
    let height = 64
    const bar = document.createElement('nav')
    bar.style.position = 'fixed'
    bar.textContent = 'Resting'
    bar.getBoundingClientRect = () => ({ top: window.innerHeight - height }) as DOMRect
    document.body.appendChild(bar)
    document.elementsFromPoint = () => [bar, document.body]

    render(<UpdateBanner open onReload={noop} onDismiss={noop} />)
    const banner = screen.getByTestId('update-banner')
    expect(banner.style.bottom).toBe('72px')

    // Same text node, new text that wraps onto a second line
    act(() => {
      height = 96
      bar.firstChild!.nodeValue = 'Rest done, start the next set'
    })
    await waitFor(() => expect(banner.style.bottom).toBe('104px'))
  })

  it('ignores layers that start at the top edge, such as modal backdrops', () => {
    const backdrop = addFixed(window.innerHeight)
    const tabBar = addFixed(64)
    document.elementsFromPoint = () => [backdrop, tabBar, document.body]

    render(<UpdateBanner open onReload={noop} onDismiss={noop} />)
    expect(screen.getByTestId('update-banner').style.bottom).toBe('72px')
  })

  it('still clears a bar taller than half of a short viewport', () => {
    const bar = addFixed(window.innerHeight * 0.6)
    document.elementsFromPoint = () => [bar, document.body]

    render(<UpdateBanner open onReload={noop} onDismiss={noop} />)
    expect(screen.getByTestId('update-banner').style.bottom).toBe(`${window.innerHeight * 0.6 + 8}px`)
  })
})
