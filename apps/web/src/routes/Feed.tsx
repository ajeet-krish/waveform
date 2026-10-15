import EmptyState from "../components/EmptyState";
import Panel from "../components/Panel";

export default function Feed() {
  return (
    <div class="stack">
      <EmptyState
        title="Nothing from the group yet"
        body="Finished sessions and kudos land here. Your group's boards and feed arrive in Phase 3."
        actions={[{ label: "See the boards", href: "/social/leaderboard" }]}
      />
      <Panel label="How kudos work">
        <p class="panel-note">
          Kudos are one tap per session: cheer a friend's workout without starting a comment
          thread. A session can collect one kudos from each member of the group.
        </p>
      </Panel>
    </div>
  );
}
