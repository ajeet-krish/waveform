import { A } from "@solidjs/router";
import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";

export default function Exercises() {
  return (
    <div class="page">
      <PageHeader
        path="Training / Exercises"
        title="Exercises"
        lede="The catalog behind every set: shared movements for the group, plus custom entries only you can see. Muscle groups and units live here, so every screen labels a squat the same way."
      />
      <div class="stack">
        <EmptyState
          title="The catalog is empty"
          body="The training core ships the seed catalog: squats, presses, pulls, and the rest. Custom exercises you add stay private to your account."
          actions={[{ label: "Add an exercise" }]}
          note="Browsing and adding exercises arrive with the training core"
        />
        <p class="panel-note">
          Sets log weight in kg and reps, and e1RM is computed with the Brzycki formula wherever
          an exercise appears.
        </p>
        <A class="link" href="/workout">
          Open the workout screen
        </A>
      </div>
    </div>
  );
}
