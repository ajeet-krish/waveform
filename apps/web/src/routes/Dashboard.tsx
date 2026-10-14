import { A } from "@solidjs/router";
import PageHeader from "../components/PageHeader";
import Panel from "../components/Panel";
import { HEAT_LEVEL_RANGES } from "../lib/heat";

export default function Dashboard() {
  const todayLabel = () =>
    new Date().toLocaleDateString(undefined, {
      weekday: "long",
      day: "numeric",
      month: "long",
    });

  return (
    <div class="page">
      <PageHeader
        path="Console"
        title="Today"
        lede="Sessions, rides, sends, and the days you showed up. Everything your group logs lands on this console."
      />

      <section class="quick-actions" aria-label="Quick actions">
        <A class="btn btn-primary" href="/workout">
          Start a session
        </A>
        <A class="btn btn-secondary" href="/activities/cycling">
          Log a ride
        </A>
        <A class="btn btn-secondary" href="/activities/climbing">
          Log a climb
        </A>
        <A class="btn btn-quiet" href="/body">
          Body stats
        </A>
      </section>

      <div class="panel-grid">
        <Panel label="Week at a glance" meta={todayLabel()}>
          <dl class="stat-list">
            <div class="stat">
              <dt class="label">Sessions</dt>
              <dd class="stat-value">0</dd>
            </div>
            <div class="stat">
              <dt class="label">Volume lifted</dt>
              <dd class="stat-value">
                0 <span class="stat-unit">kg</span>
              </dd>
            </div>
            <div class="stat">
              <dt class="label">Active days</dt>
              <dd class="stat-value">
                0 <span class="stat-unit">of 7</span>
              </dd>
            </div>
          </dl>
          <p class="panel-note mt-4">
            Your first finished session of the week fills this panel.
          </p>
        </Panel>

        <Panel label="Effort grid" meta="0 to 100 EP per day">
          <ul class="heat-legend">
            {HEAT_LEVEL_RANGES.map((range) => (
              <li class="legend-item">
                <span class="heat-swatch" data-level={range.level} />
                {range.label}
              </li>
            ))}
          </ul>
          <p class="panel-note mt-4">
            One square per training day. Levels track Effort Points: minutes times intensity,
            capped at 100.
          </p>
          <A class="link" href="/social/heatmap">
            Open the heatmap
          </A>
        </Panel>

        <Panel label="From the group">
          <p class="panel-note">
            No finished sessions or kudos yet. When your group trains, it shows up here.
          </p>
          <A class="link" href="/social/feed">
            Open the feed
          </A>
        </Panel>

        <Panel label="On the boards">
          <p class="panel-note">
            Boards open when the first session syncs. Consistency counts active days and breaks
            ties on weekly streaks.
          </p>
          <A class="link" href="/social/leaderboard">
            Open the leaderboard
          </A>
        </Panel>
      </div>
    </div>
  );
}
