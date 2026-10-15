import { A, useLocation } from "@solidjs/router";
import { For } from "solid-js";
import Icon from "./Icon";
import Logo from "./Logo";
import { isActivePath, SECTIONS } from "../lib/nav";

export default function CommandBar() {
  const location = useLocation();
  return (
    <header class="cmd">
      <A href="/" class="cmd-brand" aria-label="Waveform, go to the dashboard">
        <Logo height={20} />
        <span class="cmd-wordmark">Waveform</span>
        <span class="cmd-sub">training console</span>
      </A>
      <nav class="cmd-nav" aria-label="Sections">
        <For each={SECTIONS}>
          {(item) => (
            <A
              href={item.href}
              class="cmd-link"
              activeClass="is-active"
              end={item.end}
              aria-current={isActivePath(item, location.pathname) ? "page" : undefined}
            >
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
