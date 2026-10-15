import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";
import type { ActivityType } from "../types/api";

const DISCIPLINE: ActivityType = "cycling";

export default function Cycling() {
  return (
    <div class="page">
      <PageHeader
        path="Activities / Cycling"
        title="Cycling"
        lede={`Log a ride as activity type "${DISCIPLINE}": distance in km, elevation in m, and time in the saddle.`}
      />
      <div class="stack">
        <EmptyState
          title="No rides logged"
          body="Log a ride with distance, elevation, and duration. Weekly distance and elevation place you on the cycling board."
          actions={[{ label: "Log a ride" }]}
          note="Rides weight daily Effort Points at 0.9 per minute"
        />
        <p class="panel-note">
          Distances are stored in km. A hard climb counts more than the flat spin home.
        </p>
      </div>
    </div>
  );
}
