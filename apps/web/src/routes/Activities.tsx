/**
 * Activities overview: the discipline card grid. Each live discipline
 * card carries a real 30-day summary (rides and endurance sessions in
 * km, climbs in V-points) and links to its own page.
 */

import { A } from "@solidjs/router";
import { createMemo, createSignal, For, Show, type JSX } from "solid-js";
import type { ActivityType } from "@waveform/api-types";
import { createLocalQuery } from "../db/query";
import type { Repos } from "../db";
import PageHeader from "../components/PageHeader";
import { useAppData } from "../lib/appData";
import {
  DISCIPLINES,
  summarizeDiscipline,
  type DisciplineActivity,
  type DisciplineCard,
  type DisciplineSummary,
} from "../lib/activities";
import { disciplineWindowSummary } from "../lib/activitySummary";
import { localDateString } from "../lib/format";
import { createToday } from "../lib/today";

const WINDOW_DAYS = 30;

export default function Activities(): JSX.Element {
  const app = useAppData();
  const today = createToday();
  return (
    <div class="page">
      <PageHeader
        path="Activities"
        title="Activities"
        lede="Time outside the gym: rides, climbs, and everything else you tracked. Activities count toward consistency and your daily Effort Points."
      />
      <Show
        when={app.repos()}
        fallback={<p class="panel-note">Opening your log...</p>}
      >
        {(repos) => <ActivitiesView repos={repos()} today={today()} />}
      </Show>
    </div>
  );
}

function ActivitiesView(props: { repos: Repos; today: Date }): JSX.Element {
  const windowFrom = (): string =>
    localDateString(
      new Date(
        props.today.getFullYear(),
        props.today.getMonth(),
        props.today.getDate() - WINDOW_DAYS,
      ),
    );
  const windowTo = (): string => localDateString(props.today);

  // Climbing rows need their histograms attached so V-points total
  // correctly; cycling, running, hike, and swim rows summarize distance
  // from the row itself.
  const windowRows = createLocalQuery<DisciplineActivity[]>(async () => {
    const rows = await props.repos.activities.listByDateRange(windowFrom(), windowTo());
    const climbs = await props.repos.activities.listClimbs();
    const sendsById = new Map(climbs.map((log) => [log.activity.id, log.sends?.counts]));
    return rows.map((row) =>
      row.type === "climbing" ? { ...row, sends: sendsById.get(row.id) ?? [] } : row,
    );
  });

  const summaries = createMemo<Map<ActivityType, DisciplineSummary>>(() => {
    const activities = windowRows.latest() ?? [];
    const map = new Map<ActivityType, DisciplineSummary>();
    for (const card of DISCIPLINES) {
      map.set(card.type, summarizeDiscipline(card.type, activities, windowFrom(), windowTo()));
    }
    return map;
  });

  const metaLine = (card: DisciplineCard): string | undefined => {
    if (card.pending) {
      return undefined;
    }
    const summary = summaries().get(card.type);
    if (!summary) {
      return undefined;
    }
    return disciplineWindowSummary(summary);
  };

  return (
    <div class="stack">
      <div class="discipline-grid">
        <For each={DISCIPLINES}>
          {(discipline) =>
            discipline.href && !discipline.pending ? (
              <A class="discipline" href={discipline.href}>
                <p class="discipline-name">{discipline.label}</p>
                <p class="discipline-blurb">{discipline.blurb}</p>
                <Show when={metaLine(discipline)}>
                  <p class="discipline-window num">{metaLine(discipline)}</p>
                </Show>
                <p class="discipline-metric label">{discipline.metric}</p>
              </A>
            ) : (
              <div class="discipline is-pending">
                <p class="discipline-name">{discipline.label}</p>
                <p class="discipline-blurb">{discipline.blurb}</p>
                <p class="discipline-metric label">{discipline.metric}</p>
              </div>
            )
          }
        </For>
      </div>
    </div>
  );
}
