import type { JSX } from "solid-js";
import CommandBar from "./CommandBar";
import PreviewBanner from "./PreviewBanner";
import TabBar from "./TabBar";
import WeekStrip from "./WeekStrip";

/** App shell: command bar, preview banner, week strip, routed page, tab bar. */
export default function Shell(props: { children?: JSX.Element }) {
  return (
    <div class="shell">
      <a class="skip-link" href="#main">
        Skip to content
      </a>
      <CommandBar />
      <PreviewBanner />
      <WeekStrip />
      <main id="main" class="shell-main" tabIndex={-1}>
        {props.children}
      </main>
      <TabBar />
    </div>
  );
}
