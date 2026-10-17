/**
 * One logged session row: the day heading, the discipline, a spoken
 * summary for that discipline's figures, and the Edit and Delete
 * actions. Climbing rows carry their send histogram, so the summary
 * speaks in sends and V-points; cycling rows speak in km, m, and
 * minutes; running and hike rows speak in duration, distance, elevation,
 * and pace; swim rows speak duration, distance, and pace per 100 m.
 * Delete confirms in place before the route removes the row.
 */

import { createSignal, Show, type JSX } from "solid-js";
import type { Activity } from "@waveform/api-types";
import type { LocalRow } from "../../db/types";
import { climbBreakdownSummary } from "../../lib/climbing";
import { enduranceSummary, rideSummary } from "../../lib/activitySummary";
import { errorMessage } from "../../lib/errors";
import { formatDayHeading } from "../../lib/format";
import ConfirmDialog from "../ConfirmDialog";

export default function ActivityCard(props: {
  activity: LocalRow<Activity>;
  /** The send histogram for climbing rows; absent for other types. */
  sends?: readonly number[];
  today: Date;
  onEdit(): void;
  onDelete(): Promise<void> | void;
}): JSX.Element {
  const [confirming, setConfirming] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const heading = (): string => formatDayHeading(props.activity.local_date, props.today);

  const summary = (): string => {
    if (props.activity.type === "climbing") {
      return climbBreakdownSummary(props.sends ?? [], props.today);
    }
    if (props.activity.type === "cycling") {
      return rideSummary({
        distanceKm: props.activity.distance_km,
        elevationM: props.activity.elevation_m,
        durationMin: props.activity.duration_min,
      });
    }
    if (
      props.activity.type === "running" ||
      props.activity.type === "hike" ||
      props.activity.type === "swim"
    ) {
      return enduranceSummary(
        {
          distanceKm: props.activity.distance_km,
          elevationM: props.activity.elevation_m,
          durationMin: props.activity.duration_min,
        },
        { per100m: props.activity.type === "swim" },
      );
    }
    return rideSummary({
      distanceKm: props.activity.distance_km,
      elevationM: null,
      durationMin: props.activity.duration_min,
    });
  };

  const remove = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await props.onDelete();
      setConfirming(false);
    } catch (cause) {
      setError(errorMessage(cause, "That session could not be deleted."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article class="panel">
      <div class="panel-head">
        <h3 class="label">{heading()}</h3>
        <span class="panel-meta">{props.activity.type}</span>
      </div>
      <p class="session-summary">{summary()}</p>
      <Show when={props.activity.notes !== null && props.activity.notes !== ""}>
        <p class="panel-note mt-3">{props.activity.notes}</p>
      </Show>
      <div class="row-actions mt-3">
        <button
          type="button"
          class="btn btn-quiet"
          onClick={props.onEdit}
          aria-label={`Edit the ${props.activity.type} session from ${heading()}`}
        >
          Edit
        </button>
        <button
          type="button"
          class="btn btn-quiet"
          disabled={busy()}
          onClick={() => setConfirming(true)}
          aria-label={`Delete the ${props.activity.type} session from ${heading()}`}
        >
          Delete
        </button>
      </div>
      <Show when={error()}>
        <p class="form-status" role="alert">
          {error()}
        </p>
      </Show>
      <ConfirmDialog
        open={confirming()}
        title={`Delete this ${props.activity.type} session?`}
        body={`${heading()}: ${summary()} This cannot be undone.`}
        confirmLabel="Delete session"
        onConfirm={() => {
          void remove();
        }}
        onCancel={() => setConfirming(false)}
      />
    </article>
  );
}
