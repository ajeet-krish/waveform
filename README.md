# Waveform: Training Tracker

Your training log for lifting, climbing, and cycling, running entirely in your browser.

Open it here: https://ajeet-krish.github.io/waveform/

Waveform keeps every workout, climb, ride, and body reading on your own device.

## What you can do

### Workouts

Start a session, add exercises from the catalog or invent your own, and log each set by weight and reps. As you type, Waveform shows a live e1RM estimate so you can see the strength behind the numbers, not just the numbers. A session in progress saves itself as a draft, so a reload or a closed tab will not cost you the work. When you are done, finish the session or discard it.

### Climbing

Log a climbing session by picking a date and recording how many problems you sent at each V grade. Waveform turns those sends into V-points, a simple score that rewards harder grades, so a good session adds up to something you can compare over time.

### Cycling

Record a ride with distance, elevation, and duration. It is a plain, honest ride log that sits alongside your lifting and climbing in the same history.

### Body

Track weight, body fat, and tape circumferences such as arms, chest, and waist. You keep one reading per day, and Waveform draws a weight trend so the direction matters more than any single day.

### Dashboard

Get a week at a glance: how many sessions you completed, how much volume you lifted, and how many days you were active. It is the fast answer to "how did this week go?"

### Exercises

Browse a catalog of well over a hundred movements, covering the usual lifts and plenty of variations. If something is missing, create a custom exercise and it becomes part of your catalog.

### Backup and settings

Set your display name and choose kg or lb for weight and cm or in for lengths. Your data never leaves the device on its own, so Waveform also gives you a JSON backup you can export and later import to bring everything back.

## Screenshots

These images are placeholders, to be captured from the live app.

![Dashboard screen showing the week at a glance](docs/screenshots/dashboard.png)

The dashboard sums up the week: sessions, volume lifted, and active days.

![Workout screen with exercises and sets](docs/screenshots/workout.png)

Logging a workout, with exercises, sets, and the live e1RM reading.

![History screen grouped by weeks](docs/screenshots/history.png)

History is grouped into Monday-start weeks, with a detail view for each session.

![Exercises screen showing the catalog](docs/screenshots/exercises.png)

The exercise catalog, plus any custom movements you have added.

![Climbing screen with V grade counts](docs/screenshots/climbing.png)

Climbing sessions count sends per V grade and total the V-points.

![Cycling screen with a ride entry](docs/screenshots/cycling.png)

A cycling ride, captured with distance, elevation, and duration.

![Body screen showing stats and weight trend](docs/screenshots/body.png)

Body stats with one reading per day and a weight trend over time.

![Profile and settings screen](docs/screenshots/profile.png)

Settings for your name, units, and the JSON backup tools.

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

## Good to know

- Your data lives on this device. Export a backup after big weeks so nothing is ever only in one place.
- There is no account yet, which is also why the app needs no sign-in.
- Later phases add accounts, cross-device sync, and the group features such as leaderboards, a heatmap, and a feed.

## For developers

Waveform is a monorepo. The frontend is a SolidJS and Vite PWA, and the backend is Rust with Axum, SQLx, and Postgres. JavaScript packages use pnpm and Turbo, and the Rust side uses Cargo.

- `pnpm install`, `pnpm build`, `pnpm lint`, `pnpm test`, `pnpm dev` for the JS workspace.
- `cargo build`, `cargo test`, `cargo clippy`, `cargo fmt` for the Rust workspace.
- `cargo test export_ts` regenerates the API types.

See [AGENTS.md](AGENTS.md) for commands and conventions, and the `docs/` folder for depth: [architecture](docs/architecture.md), [decisions](docs/decisions.md), and [tests](docs/tests.md).
