/// <reference types="vite/client" />

/**
 * Env vars this app reads. VITE_API_BASE_URL points the sync engine at
 * the deployed API (set in .github/workflows/pages.yml) and can be
 * overridden at runtime from Account > Advanced; VITE_BASE_PATH is the
 * GitHub Pages base the router already consumes through BASE_URL.
 */
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_BASE_PATH?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
