# Waveform: Offline-first training tracker for lifting, climbing, and cycling

[![Live on GitHub Pages](https://img.shields.io/badge/Live-GitHub%20Pages-2ea44f.svg)](https://ajeet-krish.github.io/waveform/)
[![SolidJS](https://img.shields.io/badge/SolidJS-1.9-2c4f7c.svg?logo=solid&logoColor=white)](https://www.solidjs.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Rust](https://img.shields.io/badge/Rust-2021-000000.svg?logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

Waveform is a training log for lifting, climbing, and cycling that runs entirely in your browser. Every workout, climb, ride, and body reading is stored on your own device in IndexedDB, so the app opens quickly, keeps working without a network, and leaves your numbers under your control. You can install it on your phone as a PWA and it behaves like a native app, with no account and no sign-in.

---

## Demo

Waveform is live at https://ajeet-krish.github.io/waveform/.

![Waveform dashboard showing the week at a glance](docs/screenshots/dashboard.png)

*The dashboard gives you the week at a glance: sessions completed, volume lifted, and active days.*

---

## Key Capabilities

- **Offline-first storage**: every record lives in IndexedDB on your device, so the app loads without a network and keeps working when the connection drops.
- **Installable PWA**: add Waveform to your home screen, launch it from an icon, and use it offline after the first load.
- **Workout logging**: add exercises, log each set by weight and reps, and read a live Brzycki e1RM estimate as you type.
- **Draft sessions that autosave**: a session in progress saves itself, so a reload or a closed tab does not cost you the work.
- **Monday-start history**: sessions group into weeks that begin on Monday, with a detail view for each session.
- **Exercise catalog**: over a hundred movements out of the box, and custom exercises you create become part of your catalog.
- **Climbing with V-points**: record how many problems you sent at each V grade and let Waveform score the session in V-points.
- **Cycling rides**: capture distance, elevation, and duration in the same history as your lifting and climbing.
- **Body stats with a weight trend**: track weight, body fat, and tape circumferences, with a trend line so the direction matters more than any single day.
- **Week-at-a-glance dashboard**: see sessions, volume, and active days for the current week in one place.
- **Editable units**: switch between kg and lb for weight and cm and in for lengths whenever you like.
- **JSON backup export and import**: export everything as JSON and import it to restore or move your data.

---

## Application Walkthrough

Screenshots below are placeholders, to be captured from the live app.

### Dashboard

The dashboard opens on the current week, with session count, total volume lifted, and active days so you can see how the week is going before you dig into any single session.

![Dashboard screen with the week at a glance](docs/screenshots/dashboard.png)

*The dashboard sums up the week: sessions, volume lifted, and active days.*

### Workout

Start a session, add exercises from the catalog or create your own, and log every set by weight and reps. As you type, Waveform shows a live e1RM estimate labeled as Brzycki, so you can see the strength behind the numbers. A session in progress saves itself as a draft, and when you are done you finish it or discard it.

![Workout screen with exercises and sets](docs/screenshots/workout.png)

*Logging a workout, with the exercise list, the sets entered so far, and the live e1RM reading.*

### History

History is grouped into Monday-start weeks, with a day heading for each session. Open any session for the full detail, or delete it behind a confirmation.

![History screen grouped by weeks](docs/screenshots/history.png)

*History is grouped into Monday-start weeks, with a detail view for each session.*

### Exercises

Browse the catalog of over a hundred movements, covering the usual lifts plus plenty of variations. Search by name, open an exercise to see its history, and add a custom movement when something is missing.

![Exercises screen showing the catalog](docs/screenshots/exercises.png)

*The exercise catalog, plus any custom movements you have added.*

### Climbing

Log a climbing session by picking a date and recording how many problems you sent at each V grade. Waveform turns those sends into V-points, a simple score that rewards harder grades, so a good session adds up to something you can compare over time.

![Climbing screen with V grade counts](docs/screenshots/climbing.png)

*Climbing sessions count sends per V grade and total the V-points.*

### Cycling

Record a ride with distance, elevation, and duration. It is a plain, honest ride log that sits alongside your lifting and climbing in the same history.

![Cycling screen with a ride entry](docs/screenshots/cycling.png)

*A cycling ride, captured with distance, elevation, and duration.*

### Body

Track weight, body fat, and tape circumferences such as arms, chest, and waist. You keep one reading per day, and Waveform draws a weight trend so the direction matters more than any single day.

![Body screen showing stats and weight trend](docs/screenshots/body.png)

*Body stats with one reading per day and a weight trend over time.*

### Profile and backup

Set your display name and choose kg or lb for weight and cm or in for lengths. Your data never leaves the device on its own, so Waveform also gives you a JSON backup you can export and later import to bring everything back.

![Profile and settings screen](docs/screenshots/profile.png)

*Settings for your name, units, and the JSON backup tools.*

---

## Step by step

### First run

1. Open https://ajeet-krish.github.io/waveform/ in a browser.
2. Go to settings and set your display name.
3. Choose your units: kg or lb for weight, cm or in for lengths.

### Log a workout

1. Start a new session.
2. Add exercises from the catalog, or create a custom one.
3. Enter each set as weight and reps.
4. Read the live e1RM, labeled as Brzycki, as you go.
5. Finish the session, or discard it if it was a mistake.

### Log a climb

1. Pick the date of the session.
2. Set how many problems you sent at each V grade.
3. Watch the V-points total update.
4. Save the session.

### Log a ride

1. Enter the distance.
2. Add the elevation.
3. Record the duration.
4. Save the ride.

### Log a body reading

1. Enter your weight.
2. Add body fat if you have it.
3. Fill in any tape circumferences you measured.
4. Save it. You keep one reading per day, and the weight trend updates.

### Review your history

1. Open history, grouped into Monday-start weeks.
2. Use the day headings to find a session.
3. Open a session for the full detail.
4. Delete it if you need to, with a confirmation first.

### Protect your data

1. Export a JSON backup from settings.
2. Keep that file somewhere safe.
3. Import it on another device to restore everything.
4. Choose merge to add data, or replace behind a typed confirmation.

### Install on your phone

1. Open the site in your phone browser.
2. Use Add to Home Screen.
3. Launch it from the icon. It works offline after the first load.

---

## Architecture

```
waveform/
  apps/
    api/                  # Rust Axum API (planned): routers, extractors, handlers, config
    web/                  # SolidJS + Vite PWA, the shipped app
      public/             # PWA icons and favicon
      src/
        components/       # shell, panels, forms, charts, activity and body widgets
        db/               # IndexedDB core: Dexie schema, repos, outbox, seed
          repos/          # workouts, exercises, activities, body, drafts, profile
          seed/           # exercise catalog seed and UUIDv5 helpers
        lib/              # view models and helpers: week stats, history, backup, import
        routes/           # Dashboard, Workout, History, Exercises, Climbing, Cycling, Body, Profile
        styles/           # design tokens and app CSS
  crates/
    analytics/            # aggregation metrics
    db/                   # SQLx pool, migration runner, row models (ts-rs)
    scoring/              # Brzycki e1RM, Effort Points, V-points
    sync/                 # outbox apply, last-write-wins, tombstone contract
  packages/
    api-types/            # TypeScript types generated from Rust
    scoring/              # TypeScript scoring plus the shared golden vectors
  migrations/             # SQLx SQL: init, catalog seed, hardening, catalog cleanup and dedup
  infra/                  # docker-compose (Postgres + Mailpit), railway.toml
  docs/                   # architecture, decisions, research, reviews, tests
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | SolidJS + Vite PWA |
| **Language** | TypeScript 5.9 |
| **Data** | IndexedDB via Dexie |
| **Backend (planned)** | Rust with Axum, SQLx, Postgres |
| **Build** | pnpm + Turborepo (JS), Cargo (Rust) |
| **Testing** | Vitest (web and scoring), cargo test (Rust) |
| **Hosting** | GitHub Pages |

---

## Quick Start

```bash
# JavaScript workspace (apps/web, packages/*)
npx pnpm@10 install
npx pnpm@10 dev      # dev server
npx pnpm@10 build    # Turbo build pipeline
npx pnpm@10 lint     # Turbo lint pipeline
npx pnpm@10 test     # Turbo test pipeline

# Rust workspace (apps/api, crates/*)
cargo build --workspace
cargo test --workspace
```

See [AGENTS.md](AGENTS.md) for the full command list and project conventions, and the `docs/` folder for depth: [architecture](docs/architecture.md), [decisions](docs/decisions.md), [research](docs/research.md), [reviews](docs/reviews.md), and [tests](docs/tests.md).

---

## Testing

| Suite | Files | Tests | Notes |
|-------|-------|-------|-------|
| Web (`apps/web`) | 35 | 330 | Vitest over the IndexedDB core and the lib view models |
| Scoring (`packages/scoring`) | 4 | 42 | Brzycki, climbing, effort, and the golden fence |
| Rust workspace | 4 crates | 84 | Unit and integration tests across the crates |

The scoring golden fence spans both languages. `packages/scoring/golden/scoring.golden.json` is replayed by the TypeScript suite and by `crates/scoring/tests/golden.rs`, so flipping one vector fails both and the two implementations cannot silently diverge.

---

## Good to know

- Your data lives on this device. Export a backup after big weeks so nothing is ever only in one place.
- There is no account yet, which is also why the app needs no sign-in.
- Later phases add accounts, cross-device sync, and the group features such as leaderboards, a heatmap, and a feed.

---

## License

Waveform is released under the MIT License.
