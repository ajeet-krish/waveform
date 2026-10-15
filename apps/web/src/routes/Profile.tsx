import { createSignal, For, Show, type JSX } from "solid-js";
import { db } from "../db";
import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";
import Panel from "../components/Panel";
import { collectBackup, downloadBackup } from "../lib/backup";
import { useAppData } from "../lib/appData";

type ExportState = "idle" | "working" | "done" | "error";

/**
 * The account screen: what this device knows about you, the sign-in
 * section (arriving with the backend), and the export that puts the
 * whole local log in your hands as one JSON file.
 */
export default function Profile(): JSX.Element {
  const app = useAppData();
  const [exportState, setExportState] = createSignal<ExportState>("idle");

  const exportJson = async (): Promise<void> => {
    setExportState("working");
    try {
      downloadBackup(await collectBackup(db));
      setExportState("done");
    } catch {
      setExportState("error");
    }
  };

  const rows = (): Array<{ label: string; value: string; empty: boolean }> => {
    const profile = app.profile();
    return [
      {
        label: "Display name",
        value: profile ? profile.display_name : "Not set",
        empty: !profile,
      },
      { label: "Email", value: profile?.email ?? "Not signed in", empty: !profile?.email },
      { label: "GitHub", value: "Not linked", empty: true },
      {
        label: "Units",
        value: profile
          ? `${profile.settings.display_weight_unit} and ${profile.settings.display_length_unit}`
          : "kg and cm",
        empty: !profile,
      },
      { label: "Invite", value: "Required", empty: true },
    ];
  };

  return (
    <div class="page">
      <PageHeader
        path="Account / Profile"
        title="Profile"
        lede="Your account, your units, your invite. Sign-in is invite only: someone in your group has to vouch for you."
      />
      <div class="panel-grid">
        <Panel label="Account">
          <dl class="def-list">
            <For each={rows()}>
              {(field) => (
                <div class="def-row">
                  <dt class="label">{field.label}</dt>
                  <dd classList={{ "def-value": true, "is-empty": field.empty }}>
                    {field.value}
                  </dd>
                </div>
              )}
            </For>
          </dl>
        </Panel>

        <Panel label="Session">
          <EmptyState
            title="You are not signed in"
            body="Sessions live on this device: removing the home screen app usually wipes them, so plan on a fresh code after a reinstall."
            actions={[{ label: "Go to sign in", href: "/login" }]}
            note="One-time codes and GitHub sign-in arrive with the backend; the console works without an account"
          />
        </Panel>

        <Panel label="Your data">
          <p class="panel-note">
            One JSON file with your profile, the exercise catalog, and every session,
            entry, and set this device holds, deletions included. It is the same file the
            v1 import wizard reads.
          </p>
          <div class="form-actions mt-4">
            <button
              type="button"
              class="btn btn-secondary"
              disabled={exportState() === "working"}
              onClick={() => void exportJson()}
            >
              {exportState() === "working" ? "Exporting" : "Export JSON"}
            </button>
          </div>
          <Show when={exportState() === "error"}>
            <p class="form-status" role="alert">
              The backup could not be created. Try again.
            </p>
          </Show>
          <Show when={exportState() === "done"}>
            <p class="panel-note mt-3">Backup downloaded to this device.</p>
          </Show>
        </Panel>
      </div>
      <p class="panel-note mt-4">
        Weights are stored in kg and lengths in cm; lb and in are display only.
      </p>
    </div>
  );
}
