import { A } from "@solidjs/router";
import { For } from "solid-js";
import GridMark from "./GridMark";
import Icon from "./Icon";
import { SECTIONS } from "../lib/nav";

export default function CommandBar() {
  return (
    <header class="cmd">
      <A href="/" class="cmd-brand" aria-label="LiftLog, go to the dashboard">
        <GridMark height={15} />
        <span class="cmd-wordmark">LiftLog</span>
        <span class="cmd-sub">training console</span>
      </A>
      <nav class="cmd-nav" aria-label="Sections">
        <For each={SECTIONS}>
          {(item) => (
            <A href={item.href} class="cmd-link" activeClass="is-active" end={item.end}>
              {item.label}
            </A>
          )}
        </For>
      </nav>
      <div class="cmd-status">
        <span class="cmd-chip">sync idle</span>
        <A href="/profile" class="cmd-profile" aria-label="Profile">
          <Icon name="user" />
        </A>
      </div>
    </header>
  );
}
