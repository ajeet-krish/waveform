# Waveform Web (apps/web)

SolidJS + Vite PWA, the training console for the Waveform platform. Phase 0 is the
application shell: routes, design tokens, PWA wiring, and placeholder states. No
auth, data fetching, or sync yet.

## Commands

- `pnpm dev` runs the Vite dev server.
- `pnpm build` production build into `dist/` (service worker and manifest included).
- `pnpm lint` typechecks with `tsc --noEmit` (strict, mirrors the api-types package).
- `pnpm test` runs the Vitest unit tests for `src/lib`.
- `pnpm icons` regenerates the placeholder PWA icons in `public/`.

## Layout

- `src/routes/` one file per screen (dashboard, workout, history, activities, body, social, profile, login).
- `src/components/` shell chrome (command bar, week strip, tab bar) and shared panels.
- `src/lib/` pure helpers (week math, heat levels, nav model).
- `src/types/api.ts` re-exports the ts-rs generated types from `@waveform/api-types`. Rust is the source of truth: edit the Rust structs, run `cargo test export_ts`, never edit `generated.ts` by hand.
- `src/styles/` `tokens.css` (single source of truth for color, type, space), `base.css` (reset, focus, reduced motion), `shell.css` (chrome), `app.css` (page content).

## Design notes

The palette is instrument convention, not a stock dark theme: slate console
surfaces, and three signals with one job each. Magenta (`--live`) means active
and current, amber (`--load`) means effort and records, green (`--steady`)
means completed. The heat ramp (`--heat-0` to `--heat-4`) follows the Effort
Point levels published in `crates/scoring`. Class naming is plain global CSS
with short prefixes (`cmd`, `wk`, `tab`, `panel`, `empty`, `heat`, `form`).
