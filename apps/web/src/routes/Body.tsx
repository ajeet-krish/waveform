/**
 * Body stats: the signed-in user's private weight and body-fat log.
 * One panel each for the latest reading, the 90-day trend, the log
 * form (which doubles as the edit surface), and the full readings
 * table. Only one live row can exist per day, so logging a date that
 * already has a reading updates it in place.
 */

import { createMemo, createSignal, For, Show, type JSX } from "solid-js";
import type { BodyStats } from "@waveform/api-types";
import { createLocalQuery } from "../db/query";
import type { Repos } from "../db";
import type { LocalRow } from "../db/types";
import ConfirmDialog from "../components/ConfirmDialog";
import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";
import Panel from "../components/Panel";
import BodyChart from "../components/body/BodyChart";
import BodyForm from "../components/body/BodyForm";
import { useAppData } from "../lib/appData";
import { bodySeries, buildBodyPoints } from "../lib/bodyChart";
import { errorMessage } from "../lib/errors";
import { formatDayHeading, formatWeight, localDateString, type WeightUnit } from "../lib/format";
import { createToday } from "../lib/today";

const TREND_DAYS = 90;

export default function Body(): JSX.Element {
  const app = useAppData();
  const today = createToday();
  const unit = (): WeightUnit => app.profile()?.settings.display_weight_unit ?? "kg";
  return (
    <div class="page">
      <PageHeader
        path="Metrics / Body"
        title="Body"
        lede="Weight and body fat over time. Only you see these numbers: they never appear on boards, feeds, or challenges."
      />
      <Show
        when={app.repos()}
        fallback={<p class="panel-note">Opening your log...</p>}
      >
        {(repos) => <BodyView repos={repos()} unit={unit()} today={today()} />}
      </Show>
    </div>
  );
}

function BodyView(props: { repos: Repos; unit: WeightUnit; today: Date }): JSX.Element {
  const trendFrom = (): string =>
    localDateString(
      new Date(
        props.today.getFullYear(),
        props.today.getMonth(),
        props.today.getDate() - TREND_DAYS,
      ),
    );

  const readings = createLocalQuery(() => props.repos.body.listAll());
  const trend = createLocalQuery(() => props.repos.body.listRange(trendFrom(), localDateString(props.today)));

  const rows = createMemo<LocalRow<BodyStats>[]>(() => readings.latest() ?? []);
  const latest = createMemo(() => rows()[0]);
  const series = createMemo(() => bodySeries(buildBodyPoints(trend.latest() ?? [])));

  const [editTarget, setEditTarget] = createSignal<LocalRow<BodyStats> | null>(null);
  const [deleteTarget, setDeleteTarget] = createSignal<LocalRow<BodyStats> | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  const remove = async (): Promise<void> => {
    const target = deleteTarget();
    if (!target) {
      return;
    }
    try {
      await props.repos.body.remove(target.id);
      setDeleteTarget(null);
      if (editTarget()?.id === target.id) {
        setEditTarget(null);
      }
    } catch (cause) {
      setDeleteTarget(null);
      setError(errorMessage(cause, "That reading could not be deleted."));
    }
  };

  return (
    <div class="stack">
      <Show when={error()}>
        <p class="form-status" role="alert">
          {error()}
        </p>
      </Show>

      <Show
        when={!readings.loading()}
        fallback={<p class="panel-note">Opening your log...</p>}
      >
        <Show
          when={rows().length > 0}
          fallback={
            <EmptyState
              title="No readings yet"
              body="Add a weight reading to start the trend. Relative e1RM, per kg of bodyweight, uses your latest weight."
            />
          }
        >
          <div class="panel-grid">
            <Show when={latest()} keyed>
              {(row) => (
                <Panel label="Latest reading" meta={formatDayHeading(row.local_date, props.today)}>
                  <dl class="stat-list">
                    <div class="stat">
                      <dt class="label">Weight</dt>
                      <dd class="stat-value">
                        {row.weight_kg !== null ? formatWeight(row.weight_kg, props.unit) : "n/a"}
                      </dd>
                    </div>
                    <div class="stat">
                      <dt class="label">Body fat</dt>
                      <dd class="stat-value">
                        {row.bodyfat_pct !== null ? (
                          <>
                            {row.bodyfat_pct} <span class="stat-unit">%</span>
                          </>
                        ) : (
                          "n/a"
                        )}
                      </dd>
                    </div>
                  </dl>
                </Panel>
              )}
            </Show>
            <Panel label="Trend" meta={`Last ${TREND_DAYS} days`}>
              <BodyChart
                weight={series().weight}
                bodyfat={series().bodyfat}
                unit={props.unit}
                today={props.today}
              />
            </Panel>
          </div>
        </Show>

        <Panel label="Log reading" meta={editTarget() ? "Editing a reading" : undefined}>
          <Show
            when={editTarget()}
            keyed
            fallback={<BodyForm repos={props.repos} />}
          >
            {(row) => (
              <div class="stack-tight">
                <BodyForm
                  repos={props.repos}
                  initial={row}
                  onSaved={() => setEditTarget(null)}
                />
                <div class="form-actions">
                  <button
                    type="button"
                    class="btn btn-quiet"
                    onClick={() => setEditTarget(null)}
                  >
                    Cancel edit
                  </button>
                </div>
              </div>
            )}
          </Show>
        </Panel>

        <Show when={rows().length > 0}>
          <Panel label="Readings" meta={`${rows().length} logged`}>
            <div class="table-wrap">
              <table class="data-table">
                <caption class="sr-only">
                  {`Body readings, newest first: date, weight in ${props.unit}, body fat percent, and row actions.`}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">{`Weight (${props.unit})`}</th>
                    <th scope="col">Body fat (%)</th>
                    <th scope="col">
                      <span class="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <For each={rows()}>
                    {(row) => (
                      <tr>
                        <td>{formatDayHeading(row.local_date, props.today)}</td>
                        <td>
                          <span class="num">
                            {row.weight_kg !== null ? formatWeight(row.weight_kg, props.unit) : "n/a"}
                          </span>
                        </td>
                        <td>
                          <span class="num">{row.bodyfat_pct !== null ? row.bodyfat_pct : "n/a"}</span>
                        </td>
                        <td>
                          <div class="row-actions">
                            <button
                              type="button"
                              class="btn btn-quiet"
                              onClick={() => setEditTarget(row)}
                              aria-label={`Edit the reading from ${formatDayHeading(row.local_date, props.today)}`}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              class="btn btn-quiet"
                              onClick={() => setDeleteTarget(row)}
                              aria-label={`Delete the reading from ${formatDayHeading(row.local_date, props.today)}`}
                            >
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </Panel>
        </Show>
      </Show>

      <ConfirmDialog
        open={deleteTarget() !== null}
        title="Delete this reading?"
        body={
          deleteTarget()
            ? `${formatDayHeading(deleteTarget()?.local_date ?? "", props.today)}: this cannot be undone.`
            : undefined
        }
        confirmLabel="Delete reading"
        onConfirm={() => {
          void remove();
        }}
        onCancel={() => setDeleteTarget(null)}
      />

      <p class="panel-note">Weights are stored in kg; lb is a display conversion only.</p>
    </div>
  );
}
