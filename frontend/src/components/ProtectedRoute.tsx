import { type ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useIsRestoring } from '@tanstack/react-query'
import { useAuth } from '../contexts/AuthContext'
import { BootSplash } from './BootSplash'

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { token, username, isLoading } = useAuth()
  const isRestoring = useIsRestoring()
  if (!token && !username) return isLoading ? <BootSplash /> : <Navigate to="/login" replace />
  // Signed in, or a remembered session whose launch refresh hasn't settled (or
  // couldn't reach the server): render now, once the persisted queries are back
  // from IndexedDB, so the page paints with them instead of "Loading…"
  if (isRestoring) return <BootSplash />
  return <>{children}</>
}
