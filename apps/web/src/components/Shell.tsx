import { useLocation, useNavigate } from "@solidjs/router";
import { createEffect, Show, type JSX } from "solid-js";
import { AppDataProvider, useAppData } from "../lib/appData";
import { isIndexedDbAvailable } from "../lib/storage";
import CommandBar from "./CommandBar";
import StorageAlert from "./StorageAlert";
import StorageBlocked from "./StorageBlocked";
import TabBar from "./TabBar";
import WeekStrip from "./WeekStrip";

/**
 * App shell: command bar, week strip, routed page, tab bar, plus the
 * first-run guard. Until a profile exists every path redirects to setup;
 * once the profile is ready, setup redirects onward. The week strip and
 * tabs stand down on the setup screen, which is a form, not a console.
 *
 * Storage health rides on top: a log that cannot open replaces the page
 * with StorageBlocked (its "Try again" re-runs the bootstrap), and a
 * quota failure surfaces as a StorageAlert bar above the page.
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
  const storageBlocked = () => app.status() === "error" || !isIndexedDbAvailable();

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
        <Show when={!storageBlocked()}>
          <Show when={app.storage().failure()?.kind === "quota"}>
            <StorageAlert onDismiss={app.dismissStorageAlert} />
          </Show>
          {props.children}
        </Show>
        <Show when={storageBlocked()}>
          <StorageBlocked message={app.error()} onRetry={() => void app.retryBootstrap()} />
        </Show>
      </main>
      <Show when={!onSetup()}>
        <TabBar />
      </Show>
    </div>
  );
}
