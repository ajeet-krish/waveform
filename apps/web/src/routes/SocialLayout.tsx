import { A, type RouteSectionProps } from "@solidjs/router";
import { For } from "solid-js";
import PageHeader from "../components/PageHeader";

const SUB_SECTIONS = [
  { label: "Leaderboard", href: "/social/leaderboard" },
  { label: "Heatmap", href: "/social/heatmap" },
  { label: "Feed", href: "/social/feed" },
];

export default function SocialLayout(props: RouteSectionProps) {
  return (
    <div class="page">
      <PageHeader
        path="Group / Social"
        title="Social"
        lede="Boards rank the crew across consistency, lifting, cycling, and climbing. The effort grid stays local to this device, and the feed arrives with a later phase."
      />
      <nav class="seg" aria-label="Social views">
        <For each={SUB_SECTIONS}>
          {(item) => (
            <A href={item.href} class="seg-btn" activeClass="is-active" end>
              {item.label}
            </A>
          )}
        </For>
      </nav>
      {props.children}
    </div>
  );
}
