import { useLocation, useNavigate } from "@solidjs/router";
import { createEffect, Show, type JSX } from "solid-js";
import { AppDataProvider, useAppData } from "../lib/appData";
import CommandBar from "./CommandBar";
import TabBar from "./TabBar";
import WeekStrip from "./WeekStrip";

/**
 * App shell: command bar, week strip, routed page, tab bar, plus the
 * first-run guard. Until a profile exists every path redirects to setup;
 * once the profile is ready, setup redirects onward. The week strip and
 * tabs stand down on the setup screen, which is a form, not a console.
 */
export default function Shell(props: { children?: JSX.Element }) {
  return (
    <AppDataProvider>
      <ShellBody>{props.children}</ShellBody>
    </AppDataProvider>
  );
}

function ShellBody(props: { children?: JSX.Element }) {
  const app = useAppData();
  const location = useLocation();
  const navigate = useNavigate();
  const onSetup = () => location.pathname === "/setup";

  createEffect(() => {
    const status = app.status();
    if (status === "setup" && !onSetup()) {
      navigate("/setup", { replace: true });
    }
    if (status === "ready" && onSetup()) {
      navigate("/", { replace: true });
    }
  });

  return (
    <div class="shell">
      <a class="skip-link" href="#main">
        Skip to content
      </a>
      <CommandBar />
      <Show when={!onSetup()}>
        <WeekStrip />
      </Show>
      <main id="main" class="shell-main" tabIndex={-1}>
        {props.children}
      </main>
      <Show when={!onSetup()}>
        <TabBar />
      </Show>
    </div>
  );
}
