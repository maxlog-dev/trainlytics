import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import './index.css'
import App from './App.tsx'
import { PwaUpdatePrompt } from './pwaUpdatePrompt.tsx'

const queryClient = new QueryClient()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
    {/* The service worker exists only in production builds */}
    {import.meta.env.PROD && <PwaUpdatePrompt />}
  </StrictMode>,
)
