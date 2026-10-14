import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";
import type { ActivityType } from "../types/api";

const DISCIPLINE: ActivityType = "climbing";

export default function Climbing() {
  return (
    <div class="page">
      <PageHeader
        path="Activities / Climbing"
        title="Climbing"
        lede={`Log a session as activity type "${DISCIPLINE}": the grades you sent and how many of each.`}
      />
      <div class="stack">
        <EmptyState
          title="No climbing sessions logged"
          body="Log a session with the grades you sent. V-points sum 2^grade, so quality beats volume on the climbing board."
          actions={[{ label: "Log a climb" }]}
          note="Climbs weight daily Effort Points at 1.1 per minute"
        />
        <p class="panel-note">
          Grades are stored as the label you logged, for example V4, alongside a numeric value
          used for V-points.
        </p>
      </div>
    </div>
  );
}
