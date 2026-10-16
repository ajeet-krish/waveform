import { RULE_CONSTANTS } from "@waveform/api-types";
import { Show, createEffect, createSignal, onMount, type JSX } from "solid-js";
import ConfirmDialog from "../components/ConfirmDialog";
import PageHeader from "../components/PageHeader";
import Panel from "../components/Panel";
import { useAppData, type AdoptionChoice } from "../lib/appData";
import { errorMessage } from "../lib/errors";
import { formatSyncStamp } from "../lib/format";
import { syncChip, type SyncChipInput } from "../lib/sync/chip";
import type { SyncStatus } from "../lib/sync/engine";

const MIN_PASSWORD = RULE_CONSTANTS.password.minPasswordLength;

const SIGNUP_FAILURE = "The account could not be created. Check the fields and try again.";
const LOGIN_FAILURE = "Sign-in failed. Check your email and password.";
const SIGNOUT_FAILURE = "The server could not be reached, but you are signed out on this device.";
const ADOPTION_FAILURE = "The data choice could not be applied. Try again.";
const ADDRESS_FAILURE = "The API address could not be saved.";

const EMPTY_PHRASE = "empty";
const EMPTY_TITLE = "Start empty on this device?";
const EMPTY_BODY =
  "Every workout, activity, body stat, and exercise stored on this device is deleted, queued changes are dropped, and your account's rows download fresh. In-progress workout drafts are kept. This cannot be undone here.";

/** The state sentence under the readout; alert states announce themselves. */
function statusSentence(status: SyncStatus, pending: number): string {
  switch (status) {
    case "syncing":
      return "Syncing with the server now.";
    case "waking":
      return "Waiting for the server to answer. Free-tier hosts wake up slowly.";
    case "offline":
      return "Offline. Changes stay queued on this device and retry automatically.";
    case "auth-expired":
      return "Your session expired. Sign in again to keep syncing.";
    case "error":
      return "Sync could not reach the server. It retries with a growing delay.";
    case "idle":
    default:
      return pending > 0
        ? "Changes are queued and push on the next sync."
        : "Up to date: every change is on the server.";
  }
}

function statusAlerts(status: SyncStatus): boolean {
  return status === "offline" || status === "auth-expired" || status === "error";
}

/**
 * The account screen: who this device is signed in as, the first-sign-in
 * choice about its pre-account data, the sync readout, and where sync
 * points. Signed out it is two forms and the address override; signed in
 * it is the session, the data choice when owed, and the sync telemetry.
 */
export default function Account(): JSX.Element {
  const app = useAppData();
  const signedIn = () => app.auth.state() === "signed-in";
  return (
    <div class="page">
      <PageHeader
        path="Account / Sync"
        title="Account"
        lede="One account carries your log between devices. This device always keeps its own copy first; syncing is what lets the same rows show up on your other screen."
      />
      <div class="panel-grid">
        <Show
          when={signedIn()}
          fallback={
            <>
              <SignInPanel />
              <SignUpPanel />
            </>
          }
        >
          <SessionPanel />
          <Show when={app.adoptionNeeded() === true}>
            <AdoptionPanel />
          </Show>
          <Show when={app.adoptionNeeded() !== true}>
            <SyncPanel />
          </Show>
        </Show>
        <AdvancedPanel />
      </div>
      <p class="panel-note mt-4">
        While you are signed in, sync runs on its own: queued edits push first, then every newer
        row on the server pulls down. Weights are stored in kg and lengths in cm.
      </p>
    </div>
  );
}

/** Email and password sign-in for an existing account. */
function SignInPanel(): JSX.Element {
  const app = useAppData();
  const [email, setEmail] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [failure, setFailure] = createSignal<string | null>(null);

  const submit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setFailure(null);
    try {
      await app.account.login({ email: email().trim(), password: password() });
    } catch (cause) {
      setFailure(errorMessage(cause, LOGIN_FAILURE));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel label="Sign in">
      <Show when={app.auth.state() === "auth-expired"}>
        <p class="form-status" role="alert">
          Your session expired. Sign in again to pick up where syncing stopped.
        </p>
      </Show>
      <form aria-label="Sign in with email and password" onSubmit={submit}>
        <div class="form-row">
          <label class="label" for="signin-email">
            Email
          </label>
          <input
            class="input"
            id="signin-email"
            name="email"
            type="email"
            autocomplete="email"
            placeholder="you@example.com"
            required
            value={email()}
            onInput={(event) => setEmail(event.currentTarget.value)}
          />
        </div>
        <div class="form-row">
          <label class="label" for="signin-password">
            Password
          </label>
          <input
            class="input"
            id="signin-password"
            name="password"
            type="password"
            autocomplete="current-password"
            required
            value={password()}
            onInput={(event) => setPassword(event.currentTarget.value)}
          />
        </div>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary" disabled={busy()}>
            {busy() ? "Signing in" : "Sign in"}
          </button>
        </div>
        <Show when={failure()}>
          <p class="form-status" role="alert">
            {failure()}
          </p>
        </Show>
      </form>
    </Panel>
  );
}

/** Email, password, and display name account creation. */
function SignUpPanel(): JSX.Element {
  const app = useAppData();
  const [email, setEmail] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [displayName, setDisplayName] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [failure, setFailure] = createSignal<string | null>(null);

  const submit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setFailure(null);
    try {
      await app.account.signup({
        email: email().trim(),
        password: password(),
        display_name: displayName().trim(),
      });
    } catch (cause) {
      setFailure(errorMessage(cause, SIGNUP_FAILURE));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel label="Create account">
      <p class="panel-note">
        Your training log already lives on this device. An account is what lets the same rows
        appear on another one.
      </p>
      <form aria-label="Create an account" onSubmit={submit}>
        <div class="form-row">
          <label class="label" for="signup-email">
            Email
          </label>
          <input
            class="input"
            id="signup-email"
            name="email"
            type="email"
            autocomplete="email"
            placeholder="you@example.com"
            required
            value={email()}
            onInput={(event) => setEmail(event.currentTarget.value)}
          />
        </div>
        <div class="form-row">
          <label class="label" for="signup-password">
            Password
          </label>
          <input
            class="input"
            id="signup-password"
            name="password"
            type="password"
            autocomplete="new-password"
            minlength={MIN_PASSWORD}
            required
            aria-describedby="signup-password-hint"
            value={password()}
            onInput={(event) => setPassword(event.currentTarget.value)}
          />
          <p class="label form-hint" id="signup-password-hint">
            {MIN_PASSWORD} characters or more
          </p>
        </div>
        <div class="form-row">
          <label class="label" for="signup-display-name">
            Display name
          </label>
          <input
            class="input"
            id="signup-display-name"
            name="display-name"
            type="text"
            autocomplete="nickname"
            maxlength={40}
            placeholder="How your group sees you"
            required
            value={displayName()}
            onInput={(event) => setDisplayName(event.currentTarget.value)}
          />
        </div>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary" disabled={busy()}>
            {busy() ? "Creating" : "Create account"}
          </button>
        </div>
        <Show when={failure()}>
          <p class="form-status" role="alert">
            {failure()}
          </p>
        </Show>
      </form>
    </Panel>
  );
}

/** The signed-in account, with the one action that ends the session. */
function SessionPanel(): JSX.Element {
  const app = useAppData();
  const [busy, setBusy] = createSignal(false);
  const [failure, setFailure] = createSignal<string | null>(null);

  const signOut = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      await app.account.logout();
    } catch (cause) {
      setFailure(errorMessage(cause, SIGNOUT_FAILURE));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel label="Account" meta="signed in">
      <dl class="def-list">
        <div class="def-row">
          <dt class="label">Name</dt>
          <dd class="def-value">{app.auth.user()?.display_name ?? ""}</dd>
        </div>
        <div class="def-row">
          <dt class="label">Email</dt>
          <dd class="def-value">{app.auth.user()?.email ?? ""}</dd>
        </div>
      </dl>
      <div class="form-actions mt-4">
        <button type="button" class="btn btn-secondary" disabled={busy()} onClick={() => void signOut()}>
          {busy() ? "Signing out" : "Sign out"}
        </button>
      </div>
      <Show when={failure()}>
        <p class="form-status" role="alert">
          {failure()}
        </p>
      </Show>
    </Panel>
  );
}

/**
 * The first-sign-in choice: upload keeps the local log and rebases it
 * onto the account; start empty wipes the synced stores behind the typed
 * "empty" confirmation and pulls the account down fresh.
 */
function AdoptionPanel(): JSX.Element {
  const app = useAppData();
  const [queued, setQueued] = createSignal<number | null>(null);
  const [busy, setBusy] = createSignal<AdoptionChoice | null>(null);
  const [failure, setFailure] = createSignal<string | null>(null);
  const [confirmEmpty, setConfirmEmpty] = createSignal(false);

  onMount(() => {
    const current = app.repos();
    if (current === null) {
      return;
    }
    void current.outbox
      .count()
      .then((count) => setQueued(count))
      .catch(() => setQueued(null));
  });

  const apply = async (choice: AdoptionChoice): Promise<void> => {
    setBusy(choice);
    setFailure(null);
    try {
      await app.account.adoptionChoice(choice);
    } catch (cause) {
      setFailure(errorMessage(cause, ADOPTION_FAILURE));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel label="First sign-in" meta="choice needed">
      <p class="panel-note">
        This device kept a training log before your account existed. Choose what happens to it.
        Syncing starts as soon as you choose.
      </p>
      <Show when={queued() !== null}>
        <p class="panel-note mt-3">
          {queued() === 1
            ? "1 local change is waiting on this device."
            : `${queued() ?? 0} local changes are waiting on this device.`}
        </p>
      </Show>
      <div class="form-actions mt-4">
        <button
          type="button"
          class="btn btn-primary"
          disabled={busy() !== null}
          onClick={() => void apply("upload")}
        >
          {busy() === "upload" ? "Uploading" : "Upload my existing local data"}
        </button>
        <button
          type="button"
          class="btn btn-secondary"
          disabled={busy() !== null}
          onClick={() => setConfirmEmpty(true)}
        >
          Start empty
        </button>
      </div>
      <Show when={failure()}>
        <p class="form-status" role="alert">
          {failure()}
        </p>
      </Show>
      <ConfirmDialog
        open={confirmEmpty()}
        title={EMPTY_TITLE}
        body={EMPTY_BODY}
        confirmLabel="Delete local data and start empty"
        confirmPhrase={EMPTY_PHRASE}
        onConfirm={() => {
          setConfirmEmpty(false);
          void apply("start-empty");
        }}
        onCancel={() => setConfirmEmpty(false)}
      />
    </Panel>
  );
}

/**
 * The sync readout: one lamp-and-word line in the command chip's own
 * vocabulary, the sentence that explains it, and the telemetry rows
 * (queued, paused, last synced, conflicts) straight from the engine.
 */
function SyncPanel(): JSX.Element {
  const app = useAppData();
  const view = () => app.sync();
  const chipInput = (): SyncChipInput => ({
    auth: app.auth.state(),
    adoptionNeeded: app.adoptionNeeded(),
    status: view().status(),
    pending: view().pendingCount(),
  });

  return (
    <Panel label="Sync" meta={view().status() === "idle" ? undefined : view().status()}>
      <Show
        when={app.adoptionNeeded() === false}
        fallback={
          <p class="form-status" role="status">
            Checking what this device already holds...
          </p>
        }
      >
        <div class="sync-readout" data-tone={syncChip(chipInput()).tone}>
          <span class="sync-readout-lamp" aria-hidden="true" />
          <span class="sync-readout-word">{syncChip(chipInput()).label}</span>
        </div>
        <Show
          when={statusAlerts(view().status())}
          fallback={
            <p class="form-status" role="status">
              {statusSentence(view().status(), view().pendingCount())}
            </p>
          }
        >
          <p class="form-status" role="alert">
            {statusSentence(view().status(), view().pendingCount())}
          </p>
        </Show>
        <dl class="def-list mt-4">
          <div class="def-row">
            <dt class="label">Queued changes</dt>
            <dd class="def-value">{view().pendingCount()}</dd>
          </div>
          <div class="def-row">
            <dt class="label">Paused changes</dt>
            <dd class="def-value">{view().quarantinedCount()}</dd>
          </div>
          <div class="def-row">
            <dt class="label">Last synced</dt>
            <dd class="def-value">{formatSyncStamp(view().lastSyncedAt())}</dd>
          </div>
          <Show when={view().conflicts() > 0}>
            <div class="def-row">
              <dt class="label">Newer server rows won</dt>
              <dd class="def-value">{view().conflicts()}</dd>
            </div>
          </Show>
        </dl>
        <Show when={view().quarantinedCount() > 0}>
          <p class="form-status" role="alert">
            {view().quarantinedCount() === 1
              ? "1 change is paused after repeated failures and will not retry on its own."
              : `${view().quarantinedCount()} changes are paused after repeated failures and will not retry on their own.`}
          </p>
        </Show>
        <div class="form-actions mt-4">
          <button
            type="button"
            class="btn btn-secondary"
            disabled={view().status() === "syncing" || view().status() === "waking"}
            onClick={() => view().syncNow()}
          >
            Sync now
          </button>
        </div>
      </Show>
    </Panel>
  );
}

/**
 * Advanced: the API address override. Most devices never open this; it
 * exists for a misconfigured deploy or pointing a dev build at a local
 * API.
 */
function AdvancedPanel(): JSX.Element {
  const app = useAppData();
  const [draft, setDraft] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [note, setNote] = createSignal<string | null>(null);
  const [failure, setFailure] = createSignal<string | null>(null);

  createEffect(() => {
    setDraft(app.apiBaseUrlOverride() ?? "");
  });

  const save = async (raw: string): Promise<void> => {
    setBusy(true);
    setNote(null);
    setFailure(null);
    try {
      await app.account.setApiBaseUrl(raw);
      setNote(
        raw.trim().length === 0
          ? "Back to the address this build shipped with."
          : "Address saved. Sync now points there.",
      );
    } catch (cause) {
      setFailure(errorMessage(cause, ADDRESS_FAILURE));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel label="Advanced">
      <dl class="def-list">
        <div class="def-row">
          <dt class="label">Using</dt>
          <dd classList={{ "def-value": true, "is-empty": app.apiBaseUrl() === null }}>
            {app.apiBaseUrl() ?? "No API address configured"}
          </dd>
        </div>
      </dl>
      <form
        aria-label="Set the API address override"
        class="mt-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save(draft());
        }}
      >
        <div class="form-row">
          <label class="label" for="api-base-url">
            API address override
          </label>
          <input
            class="input"
            id="api-base-url"
            name="api-base-url"
            type="url"
            inputmode="url"
            autocomplete="off"
            spellcheck={false}
            placeholder="https://waveform-api-94et.onrender.com"
            aria-describedby="api-base-url-hint"
            value={draft()}
            onInput={(event) => setDraft(event.currentTarget.value)}
          />
          <p class="label form-hint" id="api-base-url-hint">
            Leave empty to use the built-in address
          </p>
        </div>
        <div class="form-actions">
          <button type="submit" class="btn btn-secondary" disabled={busy()}>
            {busy() ? "Saving" : "Save address"}
          </button>
          <Show when={app.apiBaseUrlOverride() !== null}>
            <button
              type="button"
              class="btn btn-quiet"
              disabled={busy()}
              onClick={() => void save("")}
            >
              Use built-in address
            </button>
          </Show>
        </div>
        <Show when={note()}>
          <p class="form-status" role="status">
            {note()}
          </p>
        </Show>
        <Show when={failure()}>
          <p class="form-status" role="alert">
            {failure()}
          </p>
        </Show>
      </form>
    </Panel>
  );
}
