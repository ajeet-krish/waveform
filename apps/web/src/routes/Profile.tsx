import {
  createEffect,
  createSignal,
  For,
  onMount,
  Show,
  type JSX,
} from "solid-js";
import { db } from "../db";
import ConfirmDialog from "../components/ConfirmDialog";
import PageHeader from "../components/PageHeader";
import Panel from "../components/Panel";
import { useAppData } from "../lib/appData";
import { exportBackupNow, type WaveformBackupV2 } from "../lib/backup";
import {
  applyBackupImport,
  parseImportFile,
  type ImportMode,
  type ImportSummary,
} from "../lib/backupImport";
import { errorIssues, errorMessage } from "../lib/errors";
import type { LengthUnit, WeightUnit } from "../lib/format";
import { importSummaryRows } from "../lib/importSummary";
import {
  ensurePersistentStorage,
  isQuotaExceeded,
  persistedStatus,
  type PersistState,
} from "../lib/storage";

const WEIGHT_UNITS: readonly WeightUnit[] = ["kg", "lb"];
const LENGTH_UNITS: readonly LengthUnit[] = ["cm", "in"];

const SAVE_FAILURE = "The settings could not be saved. Try again.";
const EXPORT_FAILURE = "The backup could not be created. Try again.";
const IMPORT_FAILURE = "The file could not be imported. Try again.";
const IMPORT_QUOTA_FAILURE =
  "This device is out of storage, so nothing was imported. Free some space, then try again.";

const REPLACE_PHRASE = "replace";
const REPLACE_TITLE = "Replace everything on this device?";
const REPLACE_BODY =
  "Every workout, activity, body stat, and exercise on this device will be replaced by the backup file, and queued changes are dropped. In-progress workout drafts are kept.";

/**
 * The device screen: what the console knows about you, where it keeps
 * it, and the backup that puts the whole log in your hands. Everything
 * here is local; the export file is the one path data takes off this
 * device, and the import is the one path it takes back on.
 */
export default function Profile(): JSX.Element {
  return (
    <div class="page">
      <PageHeader
        path="Console / Profile"
        title="Profile"
        lede="Your name, your units, and your backup. The console keeps everything in this browser, so the export file is what protects it."
      />
      <div class="panel-grid">
        <SettingsPanel />
        <DevicePanel />
        <BackupPanel />
      </div>
      <p class="panel-note mt-4">
        Weights are stored in kg and lengths in cm; lb and in are display only.
      </p>
    </div>
  );
}

/**
 * Display name and units, edited in place: the same validation Setup
 * runs (trimmed, 1 to 40 characters), then saveSettings writes the
 * profile row and the reactive profile signal, so every screen picks up
 * the new units without a reload.
 */
function SettingsPanel(): JSX.Element {
  const app = useAppData();
  const [displayName, setDisplayName] = createSignal("");
  const [nameTouched, setNameTouched] = createSignal(false);
  const [weightUnit, setWeightUnit] = createSignal<WeightUnit>("kg");
  const [lengthUnit, setLengthUnit] = createSignal<LengthUnit>("cm");
  const [saving, setSaving] = createSignal(false);
  const [saved, setSaved] = createSignal(false);
  const [saveError, setSaveError] = createSignal<string | null>(null);

  // Seed the fields from the local profile. A save writes the same
  // values back, so this refill never interrupts typing.
  createEffect(() => {
    const profile = app.profile();
    if (!profile) {
      return;
    }
    setDisplayName(profile.display_name);
    setWeightUnit(profile.settings.display_weight_unit);
    setLengthUnit(profile.settings.display_length_unit);
  });

  const trimmed = () => displayName().trim();

  const nameError = (): string | null => {
    if (!nameTouched()) {
      return null;
    }
    const length = trimmed().length;
    if (length < 1) {
      return "Enter a display name.";
    }
    if (length > 40) {
      return "Use 40 characters or fewer.";
    }
    return null;
  };

  const submit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    setNameTouched(true);
    setSaved(false);
    setSaveError(null);
    const value = trimmed();
    if (value.length < 1 || value.length > 40) {
      setSaveError("Check the highlighted fields.");
      return;
    }
    setSaving(true);
    try {
      await app.saveSettings({
        displayName: value,
        weightUnit: weightUnit(),
        lengthUnit: lengthUnit(),
      });
      setSaved(true);
    } catch (cause) {
      setSaveError(errorMessage(cause, SAVE_FAILURE));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel label="Settings">
      <form aria-label="Edit your settings" onSubmit={submit} novalidate>
        <div class="form-row">
          <label class="label" for="settings-display-name">
            Display name
          </label>
          <input
            class="input"
            id="settings-display-name"
            name="display-name"
            type="text"
            autocomplete="nickname"
            maxlength={40}
            placeholder="How your group sees you"
            value={displayName()}
            onInput={(event) => setDisplayName(event.currentTarget.value)}
            onBlur={() => setNameTouched(true)}
            aria-invalid={nameError() ? "true" : undefined}
            aria-describedby={nameError() ? "settings-display-name-error" : undefined}
          />
          <Show when={nameError()}>
            <p class="form-hint" id="settings-display-name-error">
              {nameError()}
            </p>
          </Show>
        </div>

        <div class="form-row">
          <span class="label" id="settings-weight-unit-label">
            Weight unit
          </span>
          <div class="seg" role="group" aria-labelledby="settings-weight-unit-label">
            <For each={WEIGHT_UNITS}>
              {(unit) => (
                <button
                  type="button"
                  class="seg-btn"
                  aria-pressed={weightUnit() === unit}
                  onClick={() => setWeightUnit(unit)}
                >
                  {unit}
                </button>
              )}
            </For>
          </div>
        </div>

        <div class="form-row">
          <span class="label" id="settings-length-unit-label">
            Length unit
          </span>
          <div class="seg" role="group" aria-labelledby="settings-length-unit-label">
            <For each={LENGTH_UNITS}>
              {(unit) => (
                <button
                  type="button"
                  class="seg-btn"
                  aria-pressed={lengthUnit() === unit}
                  onClick={() => setLengthUnit(unit)}
                >
                  {unit}
                </button>
              )}
            </For>
          </div>
        </div>

        <div class="form-actions">
          <button
            type="submit"
            class="btn btn-primary"
            disabled={saving() || app.profile() === null}
          >
            {saving() ? "Saving" : "Save"}
          </button>
        </div>

        <Show when={saved()}>
          <p class="form-status" role="status">
            Settings saved on this device.
          </p>
        </Show>
        <Show when={saveError()}>
          <p class="form-status" role="alert">
            {saveError()}
          </p>
        </Show>
      </form>
    </Panel>
  );
}

/** What this browser says about keeping Waveform's data around. */
function persistCopy(state: PersistState | null): string {
  switch (state) {
    case "persisted":
    case "granted":
      return "This browser keeps Waveform's data";
    case "denied":
      return "This browser may clear Waveform's data when storage runs low";
    case "unavailable":
      return "This browser does not say";
    default:
      return "Checking what this browser says...";
  }
}

/**
 * Where the log lives and how to keep it: the honest storage story plus
 * the persistence probe. Browsers evict non-persistent storage when
 * space runs low, so "Ask browser to keep data" is worth one tap.
 */
function DevicePanel(): JSX.Element {
  const [state, setState] = createSignal<PersistState | null>(null);
  const [askNote, setAskNote] = createSignal<string | null>(null);

  onMount(() => {
    void persistedStatus().then((result) => setState(result));
  });

  const askToKeep = async (): Promise<void> => {
    const result = await ensurePersistentStorage();
    setState(result);
    setAskNote(
      result === "denied"
        ? "This browser said no. An exported backup is your copy either way."
        : null,
    );
  };

  return (
    <Panel label="This device">
      <p class="panel-note">
        Waveform keeps your training log in this device's browser storage. Nothing is uploaded
        and no account is needed. Export a backup after big weeks: the JSON file is your only
        copy if this device's data is cleared.
      </p>
      <dl class="def-list mt-4">
        <div class="def-row">
          <dt class="label">Storage</dt>
          <dd class="def-value">{persistCopy(state())}</dd>
        </div>
      </dl>
      <Show when={state() === "denied"}>
        <div class="form-actions mt-4">
          <button type="button" class="btn btn-secondary" onClick={() => void askToKeep()}>
            Ask browser to keep data
          </button>
        </div>
      </Show>
      <Show when={askNote()}>
        <p class="form-status" role="status">
          {askNote()}
        </p>
      </Show>
      <Show when={state() === "unavailable"}>
        <p class="panel-note mt-3">
          This browser offers no persistence setting, so Waveform cannot ask it to keep your
          data. Keep an exported backup somewhere safe.
        </p>
      </Show>
    </Panel>
  );
}

type ExportState = "idle" | "working" | "done" | "error";

/**
 * Export puts the whole log in one JSON file; import reads that file
 * back. Merge writes only what is newer and is safe to repeat; replace
 * wipes this device's log behind the typed "replace" confirmation. Either
 * way the outcome is the per-store written and skipped counts plus how
 * many changes were queued.
 */
function BackupPanel(): JSX.Element {
  const [exportState, setExportState] = createSignal<ExportState>("idle");
  const [file, setFile] = createSignal<File | null>(null);
  const [mode, setMode] = createSignal<ImportMode>("merge");
  const [importing, setImporting] = createSignal(false);
  const [issues, setIssues] = createSignal<string[]>([]);
  const [warnings, setWarnings] = createSignal<string[]>([]);
  const [applied, setApplied] = createSignal<{
    backup: WaveformBackupV2;
    summary: ImportSummary;
  } | null>(null);
  const [confirmReplace, setConfirmReplace] = createSignal(false);
  let pending: WaveformBackupV2 | null = null;
  let fileInput: HTMLInputElement | undefined;

  const exportJson = async (): Promise<void> => {
    setExportState("working");
    try {
      await exportBackupNow(db);
      setExportState("done");
    } catch {
      setExportState("error");
    }
  };

  const clearImport = (): void => {
    setFile(null);
    if (fileInput) {
      fileInput.value = "";
    }
  };

  const applyParsed = async (
    backup: WaveformBackupV2,
    appliedMode: ImportMode,
  ): Promise<void> => {
    const result = await applyBackupImport(db, backup, {
      mode: appliedMode,
      confirmReplace: appliedMode === "replace",
    });
    setApplied({ backup, summary: result });
    clearImport();
  };

  const reportFailure = (cause: unknown): void => {
    // A quota failure's DOMException message is browser plumbing; the
    // storage bus already raised the StorageAlert, so the status region
    // gets one friendly sentence instead of the raw message.
    if (isQuotaExceeded(cause)) {
      setIssues([IMPORT_QUOTA_FAILURE]);
      return;
    }
    const found = errorIssues(cause);
    setIssues(found.length > 0 ? found : [IMPORT_FAILURE]);
  };

  const runImport = async (): Promise<void> => {
    const chosen = file();
    if (!chosen) {
      return;
    }
    setIssues([]);
    setWarnings([]);
    setApplied(null);
    setImporting(true);
    try {
      const parsed = parseImportFile(await chosen.text());
      if (!parsed.ok) {
        setIssues(parsed.issues);
        return;
      }
      setWarnings(parsed.warnings);
      if (mode() === "replace") {
        pending = parsed.backup;
        setConfirmReplace(true);
        return;
      }
      await applyParsed(parsed.backup, "merge");
    } catch (cause) {
      reportFailure(cause);
    } finally {
      setImporting(false);
    }
  };

  const confirmReplaceNow = async (): Promise<void> => {
    setConfirmReplace(false);
    const backup = pending;
    pending = null;
    if (!backup) {
      return;
    }
    setImporting(true);
    try {
      await applyParsed(backup, "replace");
    } catch (cause) {
      reportFailure(cause);
    } finally {
      setImporting(false);
    }
  };

  return (
    <Panel label="Backup">
      <p class="panel-note">
        One JSON file with your profile, the exercise catalog, and every session, entry, and set
        this device holds, deletions included. The v1 app's backup file gets its own import in
        Phase 2.
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
          {EXPORT_FAILURE}
        </p>
      </Show>
      <Show when={exportState() === "done"}>
        <p class="panel-note mt-3">Backup downloaded to this device.</p>
      </Show>

      <h3 class="label mt-4">Import</h3>
      <div class="form-row mt-3">
        <label class="label" for="backup-file">
          Backup file
        </label>
        <input
          class="input"
          id="backup-file"
          type="file"
          accept=".json,application/json"
          ref={(el) => {
            fileInput = el;
          }}
          onChange={(event) => {
            setFile(event.currentTarget.files?.[0] ?? null);
            setIssues([]);
            setWarnings([]);
            setApplied(null);
          }}
        />
      </div>
      <dl class="def-list">
        <div class="def-row">
          <dt class="label">File</dt>
          <dd classList={{ "def-value": true, "is-empty": file() === null }}>
            {file()?.name ?? "No file chosen"}
          </dd>
        </div>
      </dl>

      <div class="form-row mt-4">
        <span class="label" id="import-mode-label">
          Import mode
        </span>
        <div class="seg" role="group" aria-labelledby="import-mode-label">
          <button
            type="button"
            class="seg-btn"
            aria-pressed={mode() === "merge"}
            onClick={() => setMode("merge")}
          >
            Merge into this device
          </button>
          <button
            type="button"
            class="seg-btn"
            aria-pressed={mode() === "replace"}
            onClick={() => setMode("replace")}
          >
            Replace everything on this device
          </button>
        </div>
      </div>

      <div class="form-actions">
        <button
          type="button"
          class="btn btn-secondary"
          disabled={file() === null || importing()}
          onClick={() => void runImport()}
        >
          {importing() ? "Importing" : "Import"}
        </button>
      </div>

      <Show when={warnings().length > 0}>
        <For each={warnings()}>
          {(warning) => (
            <p class="panel-note mt-3">{warning}</p>
          )}
        </For>
      </Show>

      <Show when={issues().length > 0}>
        <div class="form-status" role="alert">
          <ul class="stack-tight">
            <For each={issues()}>
              {(issue) => <li>{issue}</li>}
            </For>
          </ul>
        </div>
      </Show>

      <Show when={applied()}>
        {(current) => (
          <div class="mt-4" role="status">
            <p class="label">
              {current().summary.mode === "replace"
                ? "Replace import finished"
                : "Merge import finished"}
            </p>
            <dl class="def-list mt-3">
              <For each={importSummaryRows(current().backup, current().summary)}>
                {(row) => (
                  <div class="def-row">
                    <dt class="label">{row.label}</dt>
                    <dd class="def-value">{`${row.written} written, ${row.skipped} skipped`}</dd>
                  </div>
                )}
              </For>
            </dl>
            <p class="panel-note mt-3">
              {current().summary.opsQueued === 1
                ? "1 change queued for this device's outbox."
                : `${current().summary.opsQueued} changes queued for this device's outbox.`}
            </p>
          </div>
        )}
      </Show>

      <ConfirmDialog
        open={confirmReplace()}
        title={REPLACE_TITLE}
        body={REPLACE_BODY}
        confirmLabel="Replace and import"
        confirmPhrase={REPLACE_PHRASE}
        onConfirm={() => void confirmReplaceNow()}
        onCancel={() => {
          setConfirmReplace(false);
          pending = null;
        }}
      />
    </Panel>
  );
}
