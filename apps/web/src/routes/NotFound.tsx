import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";

export default function NotFound() {
  return (
    <div class="page">
      <PageHeader path="404" title="Off the console" />
      <EmptyState
        title="That page does not exist"
        body="The link may be old or mistyped. The dashboard shows today, this week, and your group in one place."
        actions={[{ label: "Go to the dashboard", href: "/" }]}
      />
    </div>
  );
}
