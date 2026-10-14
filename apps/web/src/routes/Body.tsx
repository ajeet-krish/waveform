import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";
import Panel from "../components/Panel";

export default function Body() {
  return (
    <div class="page">
      <PageHeader
        path="Metrics / Body"
        title="Body"
        lede="Weight, height, and body fat over time. Only you see these numbers: they never appear on boards, feeds, or challenges."
      />
      <div class="panel-grid">
        <Panel label="Latest reading">
          <dl class="stat-list">
            <div class="stat">
              <dt class="label">Weight</dt>
              <dd class="stat-value">
                0 <span class="stat-unit">kg</span>
              </dd>
            </div>
            <div class="stat">
              <dt class="label">Height</dt>
              <dd class="stat-value">
                0 <span class="stat-unit">cm</span>
              </dd>
            </div>
            <div class="stat">
              <dt class="label">Body fat</dt>
              <dd class="stat-value">
                0 <span class="stat-unit">%</span>
              </dd>
            </div>
          </dl>
        </Panel>
        <Panel label="Trend">
          <EmptyState
            title="No readings yet"
            body="Add a weight reading to start the trend. Relative e1RM, per kg of bodyweight, uses your latest weight."
            actions={[{ label: "Log body stats" }]}
          />
        </Panel>
      </div>
      <p class="panel-note mt-4">
        Weights are stored in kg and lengths in cm. lb and in are display conversions only.
      </p>
    </div>
  );
}
