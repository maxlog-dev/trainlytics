import { execSync } from 'node:child_process'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// Identifies this build: the persisted query cache of an older build is
// discarded (src/lib/queryPersist.ts), since a deploy may change response
// shapes. Always unique (build time), with the commit when git is there (the
// Docker build context has no .git).
function buildId(): string {
  const time = Date.now().toString(36)
  try {
    const sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
    return sha ? `${sha}-${time}` : time
  } catch {
    return time
  }
}

export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(buildId()),
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // A new worker waits until the user taps Reload in the update banner
      // (src/pwaUpdatePrompt.tsx): a silent reload mid-workout would lose form state.
      registerType: 'prompt',
      // Registered from React (virtual:pwa-register/react), production builds only
      injectRegister: false,
      // public/manifest.webmanifest is the manifest; index.html links it
      manifest: false,
      devOptions: { enabled: false },
      // (A file over the 2 MiB precache limit fails the build, which is the plugin's
      // default: don't set showMaximumFileSizeToCacheInBytesWarning, it turns that
      // into a warning and drops the file.)
      workbox: {
        // Everything in dist is the offline app shell (sw.js and the Workbox runtime
        // are excluded automatically), except: public/splash/ (iOS reads its launch
        // image when the app is added to the Home Screen, not through the page), the
        // 512px icons (only the OS fetches them, at install), and the font subsets
        // and formats a modern browser rarely or never loads (latin-ext,
        // cyrillic-ext, vietnamese, .woff), which stay on the network.
        globPatterns: ['**/*'],
        globIgnores: [
          'splash/**',
          'icons/*-512.png',
          'assets/montserrat-{latin-ext,cyrillic-ext,vietnamese}-*',
          '**/*.woff',
          '**/*.map',
        ],
        navigateFallback: 'index.html',
        // The API is never served from the worker: no navigate fallback, no runtime caching
        navigateFallbackDenylist: [/^\/api\//],
      },
    }),
  ],
  server: {
    proxy: {
      '/api': 'http://backend:8000',
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
  },
})
