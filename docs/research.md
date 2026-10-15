# Waveform Research Notes

Last updated: Oct 14, 2026

## 2026-10-14 - Backend/frontend language-runtime comparison (empirical evidence)

Evidence dossier comparing backend (Rust/Axum, TS-Node, TS-Bun, Go, Python/FastAPI) and
frontend (SolidJS, React, Svelte, Vue, Angular) on performance + functionality. Full tables +
citations delivered to orchestrator. Key data points below.

### Backend (measured, unless flagged)
- TechEmpower Round 23 (2025, ProLiant DL360, Xeon Gold 6330 56C, 40GbE). Fortunes RPS:
  axum/postgresql 1,114,265 (2nd overall); fiber-prefork 848,213; fiber 411,213; gin 110,596;
  starlette 111,843; fastapi-hypercorn 11,543. (techempower.com/benchmarks data-r23)
- Fiber's own TFB page: JSON Fiber 2,363,294 vs Express 949,717; single-query Fiber 953,016 vs
  Express 441,543; multi-query Fiber 54,002 vs Express 85,011; updates Fiber 29,984 vs
  Express 54,887; plaintext Fiber 11,987,976 vs Express 1,204,969. (docs.gofiber.io/extra/benchmarks)
- FastAPI vs Axum with Postgres (Ryzen 7800X3D): Axum 15,363 rps / 11 MiB peak vs FastAPI-async
  2,267 rps / 69 MiB vs FastAPI-sync 612 rps / 78 MiB. (github.com/lukehsiao/axum-fastapi)
- Fastify self-bench (Node, 2026): Fastify 50,373 rps vs Express 27,474 vs Hono 45,102 rps.
- Bun Fastify 20,683 vs Node Fastify 9,340 rps (2.21x), 49.8MB vs 57.0MB. (sharkbench.dev)
- Binary size (Linux light app): Rust 458 KiB vs Go 2,635 KiB. (github.com/JustInTheCode/LangPerformanceEval)
- Minimal Docker JSON API: Rust ~5MB, Go ~9MB, Python ~60MB, Node/Bun/Deno 100-200MB. (HN 43035531)
- AWS Lambda cold init (siwix1, 2026): C 3.9ms, Rust 14.7ms, Python 82.7ms, Node 115.7ms.
  Conflicting older data (theam, 2019): Go 1.39ms, Node 3.85ms, Python 15.9ms, Rust 39.1ms. FLAG.
- JSON: serde_json 500-1000 MB/s de / 600-900 MB/s ser (serde docs); simd-json up to 1220 MB/s.
  Pydantic v2 (Rust core) 4-50x faster than v1. (pydantic.dev)
- Security: ~70% of Microsoft and Chrome CVEs are memory-safety bugs (CISA/MSRC/ZDNet);
  all Rust memory-safety CVEs require `unsafe` (ACM TOSEM 2021).
- Postgres: sqlx compile-time-checked queries (needs live DB at build); sqlc for Go; no
  compile-time schema checking in Node/Python (runtime/tests only).
- WebSocket benchmark (ntsd): tokio-tungstenite top (327k msg/s async), bun 293k, gorilla 201k.

### Frontend
- Krausest js-framework-benchmark: Solid ~1.1x, Svelte ~1.2x, React ~1.8x weighted vs vanilla
  (secondary source tech-insider - FLAG; directions corroborated). Transfer size in bench build:
  Solid 9.4KB vs React 143.4KB.
- Hello-world gzip: Solid 6-8KB, Svelte ~2-5KB (compiled), React+ReactDOM ~42-45KB, Vue ~34KB,
  Angular runtime ~195KB min. TodoMVC min: Solid 19KB, Svelte5 39KB, Vue3 66KB, React 189KB,
  Angular 202KB. (dev.to qingkuai 2026; theseus.fi thesis; tech-insider)
- PWA tooling: vite-plugin-pwa supports React/Vue/Svelte(KIT)/Solid/Preact virtual modules,
  Workbox-based; @vite-pwa/sveltekit zero-config; Angular has first-party @angular/pwa.
- Charts: uPlot 47.9KB, Chart.js 254KB, ECharts 1000KB; lightweight-charts ~150KB prod.
  Wrappers exist for all target frameworks; heatmaps: react-calendar-heatmap, @uiw/react-heat-map,
  svelte-heatmap (Svelte-3 era - stale).

### Contested / weak
- GoFrame R23 JSON figures (Gin 702k, Fiber 735k) come from a vendor page whose described hardware
  (Xeon Platinum 8375C 32C) conflicts with official R23 hardware - treat as unreliable.
- tech-insider.org / rustvsgo.com aggregate numbers (Actix 7.1M rps, "307k vs 180k") - low-quality
  SEO sources, not verified against primary TFB. FLAG.
- Hono benchmarks are self-published; Elysia "21x Express" marketing vs ~5x measured (Medium Hainan).

### Relevance to Waveform
Expected load <=10 users (<=10 rps peak). Every option is 1000x+ over-provisioned; raw throughput
differences are immaterial to load. Differentiators are type safety/regression-safety, cold start
if serverless, Postgres query tooling, and ecosystem fit - not RPS.
