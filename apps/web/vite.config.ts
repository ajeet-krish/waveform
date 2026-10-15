import { copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import solid from "vite-plugin-solid";
import { VitePWA } from "vite-plugin-pwa";

const configDir = dirname(fileURLToPath(import.meta.url));

/**
 * GitHub Pages serves a static tree: a deep link like /waveform/history
 * would 404 without a file there. Copying index.html to 404.html makes
 * Pages answer every deep link with the SPA shell, which the router then
 * routes. Runs after every other plugin has finished with index.html.
 */
function spaDeepLinkFallback(): Plugin {
  return {
    name: "waveform-spa-deep-link-fallback",
    closeBundle() {
      copyFileSync(resolve(configDir, "dist/index.html"), resolve(configDir, "dist/404.html"));
    },
  };
}

// Base path is env-driven so local dev and tests keep "/" while the GitHub
// Pages build (see .github/workflows/pages.yml) serves under /waveform/.
export default defineConfig(() => ({
  base: process.env.VITE_BASE_PATH ?? "/",
  plugins: [
    solid(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "Waveform Training Console",
        short_name: "Waveform",
        description:
          "Training log for lifting, cycling, and climbing with group boards and a daily effort grid.",
        // Relative values resolve against the manifest URL, so they follow the
        // Vite base instead of pinning the app to the domain root.
        id: ".",
        start_url: ".",
        scope: ".",
        display: "standalone",
        background_color: "#0f1519",
        theme_color: "#0f1519",
        categories: ["health", "fitness"],
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,ico,svg,png,woff2}"],
        navigateFallback: "index.html",
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: "StaleWhileRevalidate",
            options: { cacheName: "google-fonts-stylesheets" },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "google-fonts-webfonts",
              cacheableResponse: { statuses: [0, 200] },
              expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
        ],
      },
    }),
    spaDeepLinkFallback(),
  ],
  build: {
    target: "es2022",
  },
}));
