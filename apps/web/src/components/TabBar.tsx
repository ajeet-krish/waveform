import { A, useLocation } from "@solidjs/router";
import { For } from "solid-js";
import Icon from "./Icon";
import { isActivePath, TABS, TAB_ICONS } from "../lib/nav";

export default function TabBar() {
  const location = useLocation();
  return (
    <nav class="tabbar" aria-label="Primary">
      <For each={TABS}>
        {(item) => (
          <A
            href={item.href}
            class="tab"
            activeClass="is-active"
            end={item.end}
            aria-current={isActivePath(item, location.pathname) ? "page" : undefined}
          >
            <Icon name={TAB_ICONS[item.label] ?? "grid"} />
            <span>{item.label}</span>
          </A>
        )}
      </For>
    </nav>
  );
}
