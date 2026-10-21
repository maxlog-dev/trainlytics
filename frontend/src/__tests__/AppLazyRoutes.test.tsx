import { render, screen, waitFor } from '@testing-library/react'
import { vi, describe, it, expect } from 'vitest'
import '@testing-library/jest-dom'

vi.mock('../contexts/AuthContext', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('../components/ProtectedRoute', () => ({
  ProtectedRoute: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('../components/Layout', () => ({
  Layout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock('../pages/StatsPage', () => ({
  default: () => <div>Stats page content</div>,
}))

const loaded = vi.hoisted(() => new Set<string>())

vi.mock('../pages/StrengthSessionDetailPage', () => {
  loaded.add('strength')
  return { default: () => <div>Strength detail</div> }
})

vi.mock('../pages/CardioSessionDetailPage', () => {
  loaded.add('cardio')
  return { default: () => <div>Cardio detail</div> }
})

// The session type query stays in flight
vi.mock('../lib/api', () => ({ api: { get: vi.fn(() => new Promise(() => {})) } }))

import App from '../App'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

describe('App lazy routes', () => {
  it('shows the fallback, then renders /stats once its chunk resolves', async () => {
    window.history.pushState({}, '', '/stats')
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <App />
      </QueryClientProvider>,
    )
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    expect(await screen.findByText('Stats page content')).toBeInTheDocument()
  })

  it('loads both session detail chunks while the session type is still being fetched', async () => {
    window.history.pushState({}, '', '/sessions/42')
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <App />
      </QueryClientProvider>,
    )
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    await waitFor(() => expect([...loaded].sort()).toEqual(['cardio', 'strength']))
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })
})
