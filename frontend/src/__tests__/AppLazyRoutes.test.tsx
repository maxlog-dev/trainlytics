import { render, screen } from '@testing-library/react'
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
})
