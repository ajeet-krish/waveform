import { useNavigate } from "@solidjs/router";
import { createSignal, For, onMount, Show } from "solid-js";
import Logo from "../components/Logo";
import PageHeader from "../components/PageHeader";
import { useAppData } from "../lib/appData";

type WeightUnit = "kg" | "lb";
type LengthUnit = "cm" | "in";

const WEIGHT_UNITS: readonly WeightUnit[] = ["kg", "lb"];
const LENGTH_UNITS: readonly LengthUnit[] = ["cm", "in"];

const FAILURE = "The profile could not be saved. Try again.";

/**
 * First run: one device, one profile. The form validates the display name
 * itself (trimmed, 1 to 40 characters), then hands the units to setup and
 * lets the app move on to the workout console.
 */
export default function Setup() {
  const app = useAppData();
  const navigate = useNavigate();

  const [displayName, setDisplayName] = createSignal("");
  const [nameTouched, setNameTouched] = createSignal(false);
  const [weightUnit, setWeightUnit] = createSignal<WeightUnit>("kg");
  const [lengthUnit, setLengthUnit] = createSignal<LengthUnit>("cm");
  const [submitting, setSubmitting] = createSignal(false);
  const [statusMessage, setStatusMessage] = createSignal("");

  onMount(() => {
    if (app.status() === "ready") {
      navigate("/", { replace: true });
    }
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

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    setNameTouched(true);
    const value = trimmed();
    if (value.length < 1 || value.length > 40) {
      setStatusMessage("Check the highlighted fields.");
      return;
    }
    setSubmitting(true);
    setStatusMessage("Creating your profile.");
    try {
      await app.completeSetup({
        displayName: value,
        weightUnit: weightUnit(),
        lengthUnit: lengthUnit(),
      });
      navigate("/workout", { replace: true });
    } catch (cause) {
      setSubmitting(false);
      setStatusMessage(
        cause instanceof Error && cause.message ? cause.message : FAILURE,
      );
    }
  };

  return (
    <div class="page">
      <div class="login-mark">
        <Logo height={28} />
      </div>
      <PageHeader
        path="Console / Setup"
        title="Console setup"
        lede="Waveform keeps your log on this device, so it opens with or without a connection. Pick a display name and the units you train in."
      />
      <div class="auth-card">
        <form aria-label="Create your profile" onSubmit={submit} novalidate>
          <div class="form-row">
            <label class="label" for="display-name">
              Display name
            </label>
            <input
              class="input"
              id="display-name"
              name="display-name"
              type="text"
              autocomplete="nickname"
              maxlength={40}
              placeholder="How your group sees you"
              value={displayName()}
              onInput={(event) => setDisplayName(event.currentTarget.value)}
              onBlur={() => setNameTouched(true)}
              aria-invalid={nameError() ? "true" : undefined}
              aria-describedby={nameError() ? "display-name-error" : undefined}
            />
            <Show when={nameError()}>
              <p class="form-hint" id="display-name-error">
                {nameError()}
              </p>
            </Show>
          </div>

          <div class="form-row">
            <span class="label" id="weight-unit-label">
              Weight unit
            </span>
            <div class="seg" role="group" aria-labelledby="weight-unit-label">
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
            <span class="label" id="length-unit-label">
              Length unit
            </span>
            <div class="seg" role="group" aria-labelledby="length-unit-label">
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
            <button type="submit" class="btn btn-primary" disabled={submitting()}>
              {submitting() ? "Creating profile" : "Create profile"}
            </button>
          </div>

          <Show when={statusMessage() !== ""}>
            <p class="form-status" role="alert">
              {statusMessage()}
            </p>
          </Show>
        </form>
      </div>
      <p class="panel-note mt-4">
        Sets are stored in kilograms and lengths in centimeters. Your chosen units change how
        numbers read, never what is saved.
      </p>
    </div>
  );
}
