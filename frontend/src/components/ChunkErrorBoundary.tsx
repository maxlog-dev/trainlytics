import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** Called once when a child throws (e.g. a lazy chunk failed to load). */
  onError?: () => void
  /** Replaces the default reload prompt. */
  fallback?: ReactNode
}

/** Catches failed lazy-chunk loads so they don't unmount the whole app. */
export class ChunkErrorBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch() {
    this.props.onError?.()
  }

  render() {
    if (!this.state.failed) return this.props.children
    if (this.props.fallback !== undefined) return this.props.fallback
    return (
      <div className="p-6 text-sm text-text-muted-strong">
        <p>Couldn’t load this page. Check your connection and try again.</p>
        <button
          type="button"
          className="mt-3 underline"
          onClick={() => window.location.reload()}
        >
          Reload
        </button>
      </div>
    )
  }
}
