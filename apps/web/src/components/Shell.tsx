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
 * A foreign or unknown device (app.writeBlocked) is not a console either:
 * the shell routes to the Account screen, which owns the foreign-log
 * panel, and hides the console chrome so the log it holds cannot be
 * edited or queued against.
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
  const onAccount = () => location.pathname === "/account";
  const storageBlocked = () => app.status() === "error" || !isIndexedDbAvailable();
  /** A foreign or unknown device holds a log the console must not touch. */
  const ownershipBlocked = () => app.writeBlocked();

  createEffect(() => {
    const status = app.status();
    if (status === "setup" && !onSetup()) {
      navigate("/setup", { replace: true });
      return;
    }
    if (status === "ready" && onSetup()) {
      navigate("/", { replace: true });
      return;
    }
    if (status === "ready" && ownershipBlocked() && !onAccount()) {
      // The Account screen is the only console-adjacent surface a foreign
      // or unknown device may show.
      navigate("/account", { replace: true });
    }
  });

  return (
    <div class="shell">
      <a class="skip-link" href="#main">
        Skip to content
      </a>
      <CommandBar />
      <Show when={!onSetup() && !ownershipBlocked()}>
        <WeekStrip />
      </Show>
      <main id="main" class="shell-main" tabIndex={-1}>
        <Show when={!storageBlocked()}>
          <Show when={app.storage().failure()?.kind === "quota"}>
            <StorageAlert onDismiss={app.dismissStorageAlert} />
          </Show>
          <Show when={!ownershipBlocked() || onAccount()}>{props.children}</Show>
        </Show>
        <Show when={storageBlocked()}>
          <StorageBlocked message={app.error()} onRetry={() => void app.retryBootstrap()} />
        </Show>
      </main>
      <Show when={!onSetup() && !ownershipBlocked()}>
        <TabBar />
      </Show>
    </div>
  );
}
