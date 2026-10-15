import { A } from "@solidjs/router";
import { For } from "solid-js";
import PageHeader from "../components/PageHeader";
import { DISCIPLINES } from "../lib/activities";

export default function Activities() {
  return (
    <div class="page">
      <PageHeader
        path="Activities"
        title="Activities"
        lede="Time outside the gym: rides, climbs, and everything else you tracked. Activities count toward consistency and your daily Effort Points."
      />
      <div class="discipline-grid">
        <For each={DISCIPLINES}>
          {(discipline) =>
            discipline.href && !discipline.pending ? (
              <A class="discipline" href={discipline.href}>
                <p class="discipline-name">{discipline.label}</p>
                <p class="discipline-blurb">{discipline.blurb}</p>
                <p class="discipline-metric label">{discipline.metric}</p>
              </A>
            ) : (
              <div class="discipline is-pending">
                <p class="discipline-name">{discipline.label}</p>
                <p class="discipline-blurb">{discipline.blurb}</p>
                <p class="discipline-metric label">{discipline.metric}</p>
              </div>
            )
          }
        </For>
      </div>
      <p class="panel-note mt-4">
        Running, hikes, and swims already log through the same entry form. Their own pages come
        after cycling and climbing.
      </p>
    </div>
  );
}
