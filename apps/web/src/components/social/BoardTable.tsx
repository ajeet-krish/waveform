/**
 * One ranked board: a Panel with a data table of shared-rank rows. The
 * first two columns are always Rank and Member; the rest come from the
 * board's own metric columns. An empty board keeps its heading and shows
 * the direction note instead of a table.
 */

import { For, Show, type JSX } from "solid-js";
import type { BoardView } from "../../lib/social";
import Panel from "../Panel";

export default function BoardTable(props: { view: BoardView }): JSX.Element {
  const view = () => props.view;
  return (
    <Panel label={view().title}>
      <Show
        when={view().rows.length > 0}
        fallback={<p class="panel-note">{view().emptyNote}</p>}
      >
        <div class="table-wrap">
          <table class="data-table">
            <caption class="sr-only">{`${view().title}: rank, member, and metric.`}</caption>
            <thead>
              <tr>
                <th scope="col">Rank</th>
                <th scope="col">Member</th>
                <For each={view().columns}>{(column) => <th scope="col">{column}</th>}</For>
              </tr>
            </thead>
            <tbody>
              <For each={view().rows}>
                {(row) => (
                  <tr>
                    <td>{row.rankLabel}</td>
                    <td>{row.member}</td>
                    <For each={row.cells}>
                      {(cell) => <td classList={{ "is-empty": row.empty }}>{cell}</td>}
                    </For>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
    </Panel>
  );
}
