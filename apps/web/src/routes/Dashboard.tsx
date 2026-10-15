/**
 * Dashboard: quick actions plus the week-at-a-glance strip computed
 * from this week's workout trees and activities. The phase 3 social
 * panels stay as placeholders underneath.
 */

import { A } from "@solidjs/router";
import { createMemo, Show, type JSX } from "solid-js";
import type { Activity } from "@waveform/api-types";
import { createLocalQuery } from "../db/query";
import type { Repos } from "../db";
import type { WorkoutTree } from "../db/repos/workouts";
import type { LocalRow } from "../db/types";
import PageHeader from "../components/PageHeader";
import Panel from "../components/Panel";
import { useAppData } from "../lib/appData";
import { HEAT_LEVEL_RANGES } from "../lib/heat";
import { localDateString, toDisplayWeight, type WeightUnit } from "../lib/format";
import { buildWeekStats, type WeekStats } from "../lib/weekStats";
import { weekDays } from "../lib/week";
import { createToday } from "../lib/today";

export default function Dashboard(): JSX.Element {
  const app = useAppData();
  const today = createToday();
  const todayLabel = () =>
    today().toLocaleDateString(undefined, {
      weekday: "long",
      day: "numeric",
      month: "long",
    });
  const unit = (): WeightUnit => app.profile()?.settings.display_weight_unit ?? "kg";

  return (
    <div class="page">
      <PageHeader
        path="Console"
        title="Today"
        lede="Sessions, rides, sends, and the days you showed up. Everything your group logs lands on this console."
      />

      <section class="quick-actions" aria-label="Quick actions">
        <A class="btn btn-primary" href="/workout">
          Start a session
        </A>
        <A class="btn btn-secondary" href="/activities/cycling">
          Log a ride
        </A>
        <A class="btn btn-secondary" href="/activities/climbing">
          Log a climb
        </A>
        <A class="btn btn-quiet" href="/body">
          Body stats
        </A>
      </section>

      <div class="panel-grid">
        <Panel label="Week at a glance" meta={todayLabel()}>
          <Show
            when={app.repos()}
            fallback={<p class="panel-note">Opening your log...</p>}
          >
            {(repos) => <WeekStrip repos={repos()} unit={unit()} today={today()} />}
          </Show>
        </Panel>

        <Panel label="Effort grid" meta="0 to 100 EP per day">
          <ul class="heat-legend">
            {HEAT_LEVEL_RANGES.map((range) => (
              <li class="legend-item">
                <span class="heat-swatch" data-level={range.level} />
                {range.label}
              </li>
            ))}
          </ul>
          <p class="panel-note mt-4">
            One square per training day. Levels track Effort Points: minutes times intensity,
            capped at 100.
          </p>
          <A class="link" href="/social/heatmap">
            Open the heatmap
          </A>
        </Panel>

        <Panel label="From the group">
          <p class="panel-note">
            No finished sessions or kudos yet. When your group trains, it shows up here.
          </p>
          <A class="link" href="/social/feed">
            Open the feed
          </A>
        </Panel>

        <Panel label="On the boards">
          <p class="panel-note">
            Boards open when the backend lands. Consistency counts active days and breaks
            ties on weekly streaks.
          </p>
          <A class="link" href="/social/leaderboard">
            Open the leaderboard
          </A>
        </Panel>
      </div>
    </div>
  );
}

function WeekStrip(props: { repos: Repos; unit: WeightUnit; today: Date }): JSX.Element {
  const week = createMemo(() => weekDays(props.today));
  const firstDay = (): string => week()[0]?.iso ?? localDateString(props.today);
  const lastDay = (): string => week()[6]?.iso ?? localDateString(props.today);

  const trees = createLocalQuery<WorkoutTree[]>(() =>
    props.repos.workouts.listTreesByDateRange(firstDay(), lastDay()),
  );
  const activities = createLocalQuery<LocalRow<Activity>[]>(() =>
    props.repos.activities.listByDateRange(firstDay(), lastDay()),
  );

  const stats = createMemo<WeekStats>(() =>
    buildWeekStats({
      trees: trees.latest() ?? [],
      activities: activities.latest() ?? [],
      week: week(),
    }),
  );
  const allZero = (): boolean =>
    stats().sessions === 0 && stats().workingVolumeKg === 0 && stats().activeDays === 0;

  return (
    <>
      <dl class="stat-list">
        <div class="stat">
          <dt class="label">Sessions</dt>
          <dd class="stat-value">{stats().sessions}</dd>
        </div>
        <div class="stat">
          <dt class="label">Volume lifted</dt>
          <dd class="stat-value">
            {toDisplayWeight(stats().workingVolumeKg, props.unit)}{" "}
            <span class="stat-unit">{props.unit}</span>
          </dd>
        </div>
        <div class="stat">
          <dt class="label">Active days</dt>
          <dd class="stat-value">
            {stats().activeDays} <span class="stat-unit">of 7</span>
          </dd>
        </div>
      </dl>
      <Show when={allZero()}>
        <p class="panel-note mt-4">
          Your first finished session of the week fills this panel.
        </p>
      </Show>
    </>
  );
}
