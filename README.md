# Waveform: the complete training tracker for lifting, running, climbing, and more

[![Live on GitHub Pages](https://img.shields.io/badge/Live-GitHub%20Pages-2ea44f.svg)](https://ajeet-krish.github.io/waveform/)
[![SolidJS](https://img.shields.io/badge/SolidJS-1.9-2c4f7c.svg?logo=solid&logoColor=white)](https://www.solidjs.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Rust](https://img.shields.io/badge/Rust-2021-000000.svg?logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

Waveform is a workout tracker for strength training that grew into a full fitness companion. Log every set with a live e1RM, track your runs, rides, climbs, hikes, and swims in one history, keep a year-long consistency grid going, and take it to the boards against your crew. Built for people who lift and also run, ride, climb, or swim, and who want their training to be social without giving up a real logbook.

Track your training. Watch it add up. Out-train your friends.

---

## Demo

Waveform is live at https://ajeet-krish.github.io/waveform/.

---

## Track everything you do

- **Strength training**: log every set by weight and reps and read a live Brzycki e1RM estimate as you type, so the number tells you how strong the set really was.
- **Five more disciplines**: running, cycling, climbing, hiking, and swimming each get their own screen and land in the same history as your lifting.
- **Climbing scored the right way**: record how many problems you sent at each V grade. Waveform sums V-points, so a hard send counts for more than a pile of easy ones.
- **Rides and runs by the numbers**: distance, elevation, duration, and pace, with climbing and distance totals that roll into the boards.
- **Body stats with a trend**: weight, body fat, and tape circumferences, one reading per day, with a trend line so the direction matters more than any single morning.
- **A catalog of over a hundred movements**, plus custom exercises you create and keep.

## Log fast, then get out of the gym

- **Routines**: save the exercises, their order, and the targets you aim for. Start one and it seeds a fresh session; nothing is logged until you finish it.
- **Sessions that autosave**: a workout in progress saves itself, so a reload or a closed tab never costs you the work you just entered.
- **Live e1RM on every set**: type the weight and reps and the estimate updates as you go.
- **Editable units**: switch between kg and lb for weight and cm and in for lengths whenever you like.
- **History you can actually read**: sessions grouped into Monday-start weeks, with a detail view for every session and a searchable exercise history for each lift.
- **JSON backup**: export everything and import it to restore or move your log.

## Show up every day

- **The effort grid**: a GitHub-style calendar of your training year. One square per day, weeks starting Monday, shaded by how hard you went.
- **Effort Points**: every session scores itself from minutes times intensity, with bonuses for PRs, sends, and elevation, so lifting, riding, and climbing all light up the same grid.
- **Streaks**: keep the chain alive. The grid makes a rest day a visible choice instead of an accident.

## Compete with your crew

- **Leaderboards across every discipline**: consistency, lifting, cycling, and climbing boards that rank your group over 7 days, 4 weeks, or 12 weeks.
- **Consistency board**: active days and weekly streaks, so showing up counts as much as lifting heavy.
- **Lifting boards**: total volume, best e1RM for your marquee lifts, and relative strength (e1RM divided by bodyweight) so a lighter lifter gets their due.
- **Cycling and climbing boards**: distance, elevation, V-points, and hardest send.
- **Kudos and the group feed**: cheer a friend's session with one tap. A session can collect one kudos from each member of the group. The feed is rolling out now.
- **Your crew, not the world**: boards compare the people you train with, and your body stats stay private to you.

---

## Application Walkthrough

### Dashboard

Open on the current week: sessions completed, volume lifted, and active days, next to your effort grid, your crew's latest sessions, and the boards.

### Workout

Start a session, add exercises from the catalog or create your own, and log each set by weight and reps. The live e1RM estimate, labeled as Brzycki, updates as you type. Finish the session when you are done, or discard it if it was a mistake.

### Routines

Save a plan, then start it to seed a session in the right order with your targets in place. Starting a routine copies it into a draft, and nothing is logged until you finish.

### Activities

Cycling, running, climbing, hiking, and swimming each have a screen. Log a ride with distance, elevation, and duration; a run or swim with distance, duration, and pace; a hike with distance, elevation, and time on foot. Climbing records the grades you sent.

### Climbing

Pick the date, set how many problems you sent at each V grade, and watch the V-points total update. The hardest grade you sent comes along for the boards.

### Consistency grid

Your training year as a calendar of squares. Days shade darker as your Effort Points climb, across lifting, riding, running, climbing, hiking, and swimming alike. Scroll back through the weeks and watch the streak build.

### Leaderboards

Pick a window: 7 days, 4 weeks, or 12 weeks. Boards rank your crew on consistency, lifting volume, best e1RM per marquee lift, relative strength, cycling distance, and climbing. Ties share a rank.

### Body

One reading per day for weight and body fat, plus tape circumferences such as arms, chest, and waist. A weight trend draws over time. These numbers stay on your side: they never appear on boards, feeds, or challenges.

### Account

Sign up with an email and password, and your log syncs across your devices. The account screen shows sync status and lets you point the app at your own server.

### Backup

Export your whole log as JSON and import it later to restore, or to move to another account. Merge adds to what is there; replace starts fresh behind a typed confirmation.

---

## Step by step

### Get started

1. Open https://ajeet-krish.github.io/waveform/.
2. Sign up under Account with an email and password.
3. Choose your units: kg or lb for weight, cm or in for lengths.

### Log a workout

1. Start a new session, or start a routine.
2. Add exercises from the catalog, or create a custom one.
3. Enter each set as weight and reps.
4. Read the live e1RM, labeled as Brzycki, as you go.
5. Finish the session, or discard it if it was a mistake.

### Log a ride, run, swim, or hike

1. Open the activity's screen.
2. Enter distance, duration, and elevation where they apply.
3. Save it. It lands in your history and counts toward the grid and the boards.

### Log a climb

1. Pick the date of the session.
2. Set how many problems you sent at each V grade.
3. Watch the V-points total update.
4. Save the session.

### Keep the streak alive

1. Open the consistency grid.
2. Find today's square and the weeks behind it.
3. Train, and watch today light up.

### Compete

1. Sign in and open the boards.
2. Pick a window.
3. Compare your consistency, lifting, riding, and climbing against your crew.
4. Tap kudos on a session you liked.

### Protect your data

1. Export a JSON backup from settings.
2. Keep that file somewhere safe.
3. Import it on another device to restore everything.
4. Choose merge to add data, or replace behind a typed confirmation.

---

## Architecture

```
waveform/
  apps/
    api/                  # Rust Axum API: auth, sync, social boards, handlers, config
    web/                  # SolidJS + Vite frontend, the shipped app
      public/             # icons and favicon
      src/
        components/       # shell, panels, forms, charts, activity, body, routine, social, sync
        db/               # IndexedDB core: Dexie schema, repos, outbox, seed
          repos/          # workouts, exercises, activities, body, drafts, profile, routines
          seed/           # exercise catalog seed and UUIDv5 helpers
        lib/              # view models and helpers: week stats, history, social, heat, backup
        routes/           # Dashboard, Workout, History, Exercises, Routines, Activities,
                          # Climbing, Cycling, Running, Hikes, Swims, Body, Social, Account
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
  infra/                  # docker-compose (Postgres + Mailpit)
  docs/                   # architecture, decisions, research, reviews, tests
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | SolidJS + Vite |
| **Language** | TypeScript 5.9 |
| **Data** | IndexedDB via Dexie, synced to Postgres |
| **Backend** | Rust with Axum, SQLx, Postgres |
| **Build** | pnpm + Turborepo (JS), Cargo (Rust) |
| **Testing** | Vitest (web and scoring), cargo test (Rust) |
| **Hosting** | GitHub Pages (web), Render (API) |

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
| Web (`apps/web`) | 51 | 598 | Vitest over the IndexedDB core, the lib view models, and the social boards |
| Scoring (`packages/scoring`) | 4 | 43 | Brzycki, climbing, effort, and the golden fence |
| Rust workspace | 4 crates | 209 | Unit and integration tests across auth, sync, social, and the crates |

The scoring golden fence spans both languages. `packages/scoring/golden/scoring.golden.json` is replayed by the TypeScript suite and by `crates/scoring/tests/golden.rs`, so flipping one vector fails both and the two implementations cannot silently diverge.

---

## Good to know

- Your log syncs to your account and follows you across devices, and you can always export a JSON backup.
- Boards compare your group, not strangers. Body stats stay private and never appear on boards, feeds, or challenges.
- Kudos and the group feed are rolling out now; the boards and the grid are live.

---

## License

Waveform is released under the MIT License.
