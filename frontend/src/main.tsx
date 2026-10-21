import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient } from '@tanstack/react-query'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import './index.css'
import App from './App.tsx'
import { PwaUpdatePrompt } from './pwaUpdatePrompt.tsx'
import { finishRestore, PERSIST_MAX_AGE_MS, persistOptions } from './lib/queryPersist.ts'

const queryClient = new QueryClient({
  defaultOptions: {
    // At least the persister's maxAge: a shorter gcTime drops restored queries
    // that aren't used soon from memory, and so from the next save.
    // staleTime stays 0: restored data shows at once and refetches.
    queries: { gcTime: PERSIST_MAX_AGE_MS },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Restores the signed-in account's last-known queries from IndexedDB (lib/queryPersist) */}
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={persistOptions}
      onSuccess={() => finishRestore(queryClient)}
    >
      <App />
    </PersistQueryClientProvider>
    {/* The service worker exists only in production builds */}
    {import.meta.env.PROD && <PwaUpdatePrompt />}
  </StrictMode>,
)
