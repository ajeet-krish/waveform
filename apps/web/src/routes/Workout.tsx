import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";

export default function Workout() {
  return (
    <div class="page">
      <PageHeader
        path="Training / Workout"
        title="Workout"
        lede="Log sets as you go. The in-progress session stays on this device until you finish it, then syncs when you are back online."
      />
      <div class="stack">
        <EmptyState
          title="No session in progress"
          body="Start an empty session or fork a routine. Sets save as you type, even with no signal."
          actions={[{ label: "Start empty session" }, { label: "Fork a routine" }]}
          note="Routine templates and the exercise catalog arrive with the training core"
        />
        <p class="panel-note">
          e1RM uses the Brzycki formula, weight divided by (1.0278 minus 0.0278 times reps), and
          is labeled e1RM (Brzycki) wherever it appears.
        </p>
      </div>
    </div>
  );
}
