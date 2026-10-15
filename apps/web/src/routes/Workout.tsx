import { useNavigate } from "@solidjs/router";
import {
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  type JSX,
} from "solid-js";
import { createLocalQuery } from "../db/query";
import type { Repos } from "../db";
import type { WorkoutDraft } from "../db/types";
import ConfirmDialog from "../components/ConfirmDialog";
import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";
import Panel from "../components/Panel";
import ActiveSession from "../components/workout/ActiveSession";
import { useAppData } from "../lib/appData";
import { exerciseNameMap } from "../lib/catalog";
import { createDraftAutosave } from "../lib/draftAutosave";
import { errorIssues } from "../lib/errors";
import { formatDayHeading, localDateString, type WeightUnit } from "../lib/format";
import { createToday } from "../lib/today";
import { computeDurationMin, createEmptyDraft } from "../lib/workoutLog";

const SAVE_FALLBACK = "That could not be saved. Try again.";
const READ_FALLBACK = "The saved session could not be read.";

/**
 * The workout console. One draft at a time: it is loaded once, edited
 * only through workoutLog reducers, autosaved on a 400ms debounce with a
 * flush before any pagehide, and committed into the log on finish. A
 * draft from an earlier day is never overwritten; it waits on a resume
 * card until the owner resumes or discards it.
 */
export default function Workout(): JSX.Element {
  const app = useAppData();
  return (
    <div class="page">
      <PageHeader
        path="Training / Workout"
        title="Workout"
        lede="Log sets as you go. The in-progress session stays on this device until you finish it, then it is saved to this device's log."
      />
      <Show
        when={app.repos()}
        fallback={<p class="panel-note">Opening your log...</p>}
      >
        {(repos) => (
          <Show
            when={app.profile()}
            fallback={<p class="panel-note">Opening your log...</p>}
          >
            {(profile) => (
              <WorkoutConsole
                repos={repos()}
                unit={profile().settings.display_weight_unit}
              />
            )}
          </Show>
        )}
      </Show>
    </div>
  );
}

function WorkoutConsole(props: { repos: Repos; unit: WeightUnit }): JSX.Element {
  const navigate = useNavigate();
  const today = createToday();

  const [draft, setDraft] = createSignal<WorkoutDraft | null>(null);
  const [loaded, setLoaded] = createSignal(false);
  const [resumed, setResumed] = createSignal(false);
  const [issues, setIssues] = createSignal<string[]>([]);
  const [confirmDiscard, setConfirmDiscard] = createSignal(false);

  const exercises = createLocalQuery(() => props.repos.exercises.listLive());
  const names = createMemo(() => exerciseNameMap(exercises.latest() ?? []));
  const exerciseName = (exerciseId: string): string =>
    names().get(exerciseId) ?? "Unknown exercise";

  const autosave = createDraftAutosave<WorkoutDraft>({
    getDraft: () => draft(),
    save: (workout) => props.repos.drafts.save(workout),
    debounceMs: 400,
  });

  const flush = (): void => {
    void autosave.flush().catch(() => undefined);
  };

  const report = (cause: unknown, fallback: string): string[] => {
    const found = errorIssues(cause);
    return found.length > 0 ? found : [fallback];
  };

  onMount(() => {
    const flushIfHidden = (): void => {
      if (document.visibilityState === "hidden") {
        flush();
      }
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", flushIfHidden);
    onCleanup(() => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flushIfHidden);
      flush();
    });
    void (async () => {
      try {
        const existing = await props.repos.drafts.current();
        setDraft(existing ?? null);
      } catch (cause) {
        setIssues(report(cause, READ_FALLBACK));
      } finally {
        setLoaded(true);
      }
    })();
  });

  const mutate = (updater: (current: WorkoutDraft) => WorkoutDraft): void => {
    const current = draft();
    if (!current) {
      return;
    }
    const next = updater(current);
    if (next === current) {
      return;
    }
    setDraft(next);
    autosave.schedule();
  };

  const startSession = async (): Promise<void> => {
    const fresh = createEmptyDraft(new Date());
    try {
      await props.repos.drafts.save(fresh);
      setIssues([]);
      setResumed(false);
      setDraft(fresh);
      autosave.schedule();
    } catch (cause) {
      setIssues(report(cause, SAVE_FALLBACK));
    }
  };

  const finishSession = async (): Promise<void> => {
    const current = draft();
    if (!current) {
      return;
    }
    const finished: WorkoutDraft = {
      ...current,
      duration_min: computeDurationMin(current.started_at, new Date()),
    };
    setDraft(finished);
    // Persist the duration, then commit exactly what was persisted. A
    // failed commit aborts its transaction, so the draft survives.
    autosave.schedule();
    try {
      await autosave.flush();
      await props.repos.drafts.commit(finished.id);
      setIssues([]);
      setDraft(null);
      navigate(`/history/${finished.id}`);
    } catch (cause) {
      setIssues(report(cause, SAVE_FALLBACK));
    }
  };

  const discardSession = async (): Promise<void> => {
    const current = draft();
    if (!current) {
      return;
    }
    setDraft(null);
    setResumed(false);
    try {
      // Settles any armed or in-flight autosave before the delete, so no
      // late write can bring the draft back from the dead.
      await autosave.flush();
      await props.repos.drafts.discard(current.id);
      setIssues([]);
    } catch (cause) {
      setDraft(current);
      setIssues(report(cause, SAVE_FALLBACK));
    }
  };

  const todayKey = createMemo(() => localDateString(today()));
  const stale = (): boolean => {
    const current = draft();
    if (!current || resumed()) {
      return false;
    }
    return current.local_date !== todayKey();
  };
  const dayLabel = (): string => {
    const current = draft();
    return current ? formatDayHeading(current.local_date, today()) : "";
  };

  return (
    <div class="stack">
      <Show when={issues().length > 0}>
        <div class="form-status" role="alert">
          <ul class="stack-tight">
            <For each={issues()}>
              {(issue) => <li>{issue}</li>}
            </For>
          </ul>
        </div>
      </Show>

      <Show when={loaded()} fallback={<p class="panel-note">Opening your log...</p>}>
        <Show when={draft()} fallback={<StartCard onStart={() => void startSession()} />}>
          {(current) => (
            <Show
              when={!stale()}
              fallback={
                <ResumeCard
                  draft={current()}
                  dayLabel={dayLabel()}
                  onResume={() => setResumed(true)}
                  onDiscard={() => setConfirmDiscard(true)}
                />
              }
            >
              <ActiveSession
                draft={current()}
                unit={props.unit}
                exerciseName={exerciseName}
                repos={props.repos}
                mutate={mutate}
                onFinish={() => void finishSession()}
                onDiscard={() => setConfirmDiscard(true)}
              />
            </Show>
          )}
        </Show>
      </Show>

      <ConfirmDialog
        open={confirmDiscard()}
        title="Discard this session?"
        body="Every set you logged in this session disappears from the device. This cannot be undone."
        confirmLabel="Discard session"
        onConfirm={() => {
          setConfirmDiscard(false);
          void discardSession();
        }}
        onCancel={() => setConfirmDiscard(false)}
      />
    </div>
  );
}

function StartCard(props: { onStart(): void }): JSX.Element {
  return (
    <div class="stack">
      <EmptyState
        title="No session in progress"
        body="Start an empty session and log sets as you go. Everything stays on this device until you finish, then it lands in your history."
        actions={[
          { label: "Start empty session", onClick: props.onStart, variant: "primary" },
        ]}
        note="e1RM uses the Brzycki formula, weight divided by (1.0278 minus 0.0278 times reps), and is labeled e1RM (Brzycki) wherever it appears"
      />
    </div>
  );
}

function ResumeCard(props: {
  draft: WorkoutDraft;
  dayLabel: string;
  onResume(): void;
  onDiscard(): void;
}): JSX.Element {
  const exerciseCount = () => props.draft.entries.length;
  const setCount = (): number => {
    let count = 0;
    for (const entry of props.draft.entries) {
      count += entry.sets.length;
    }
    return count;
  };
  return (
    <Panel
      label="Unfinished session"
      meta={`${exerciseCount()} exercises · ${setCount()} sets`}
    >
      <p class="dialog-body">{`Session from ${props.dayLabel}. Resume or discard?`}</p>
      <div class="form-actions mt-4">
        <button type="button" class="btn btn-primary" onClick={props.onResume}>
          Resume session
        </button>
        <button type="button" class="btn btn-secondary" onClick={props.onDiscard}>
          Discard session
        </button>
      </div>
    </Panel>
  );
}
