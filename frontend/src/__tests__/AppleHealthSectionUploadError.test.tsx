import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom'

vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  api: { get: vi.fn(), patch: vi.fn().mockResolvedValue({}) },
}))

const auth = vi.hoisted(() => ({ token: 'test-token' as string | null }))

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => auth,
}))

import { AppleHealthSection } from '../components/AppleHealthSection'
import { setToken } from '../lib/api'

// Minimal XHR stand-in: send() immediately "completes" with the queued response.
let nextResponse: { status: number; body: string }
let sentHeaders: Record<string, string> = {}
let sends = 0

class FakeXHR {
  status = 0
  responseText = ''
  upload = { onprogress: null as unknown }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  open() {}
  setRequestHeader(name: string, value: string) {
    sentHeaders[name] = value
  }
  send() {
    sends++
    this.status = nextResponse.status
    this.responseText = nextResponse.body
    this.onload?.()
  }
}

function renderSection() {
  const qc = new QueryClient()
  const { container } = render(
    <QueryClientProvider client={qc}>
      <AppleHealthSection
        health_metric_resting_hr
        health_metric_hrv
        health_metric_weight
        health_metric_sleep
        health_metric_vo2_max
        health_metric_active_energy
        onNavigateToImports={() => {}}
      />
    </QueryClientProvider>,
  )
  return container.querySelector('input[type="file"]') as HTMLInputElement
}

function uploadZip(input: HTMLInputElement) {
  const file = new File(['zip'], 'export.zip', { type: 'application/zip' })
  fireEvent.change(input, { target: { files: [file] } })
}

describe('AppleHealthSection — upload error detail', () => {
  beforeEach(() => {
    vi.stubGlobal('XMLHttpRequest', FakeXHR)
    auth.token = 'test-token'
    sentHeaders = {}
    sends = 0
    setToken(null) // the api module's own token, set by a refresh in an earlier test
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders a FastAPI 422 list detail as joined messages', () => {
    nextResponse = {
      status: 422,
      body: JSON.stringify({
        detail: [
          { type: 'missing', loc: ['body', 'file'], msg: 'Field required', input: null },
          { type: 'bool_parsing', loc: ['query', 'workouts'], msg: 'Input should be a valid boolean' },
        ],
      }),
    }
    uploadZip(renderSection())
    expect(
      screen.getByText('file: Field required; query › workouts: Input should be a valid boolean'),
    ).toBeInTheDocument()
  })

  it('renders a string detail unchanged', () => {
    nextResponse = { status: 400, body: JSON.stringify({ detail: 'Not a valid Apple Health export.' }) }
    uploadZip(renderSection())
    expect(screen.getByText('Not a valid Apple Health export.')).toBeInTheDocument()
  })

  it.each([
    ['missing detail', JSON.stringify({})],
    ['empty string detail', JSON.stringify({ detail: '' })],
    ['non-JSON body', '<html>502 Bad Gateway</html>'],
  ])('falls back to a generic message for %s', (_, body) => {
    nextResponse = { status: 502, body }
    uploadZip(renderSection())
    expect(screen.getByText('Upload failed.')).toBeInTheDocument()
  })

  it('waits for the session to be renewed when there is no token yet (just after launch)', async () => {
    auth.token = null
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ access_token: 'fresh-token' }), { status: 200 })))
    nextResponse = { status: 400, body: JSON.stringify({ detail: 'Not a valid Apple Health export.' }) }

    uploadZip(renderSection())

    expect(await screen.findByText('Not a valid Apple Health export.')).toBeInTheDocument()
    expect(sentHeaders['Authorization']).toBe('Bearer fresh-token')
  })

  it("doesn't send the archive when the session can't be renewed", async () => {
    auth.token = null
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })))

    uploadZip(renderSection())

    expect(await screen.findByText(/Could not renew the session/)).toBeInTheDocument()
    expect(sends).toBe(0)
  })
})
