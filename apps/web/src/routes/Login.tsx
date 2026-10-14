import { createSignal } from "solid-js";
import PageHeader from "../components/PageHeader";

const STATUS =
  "Preview shell: codes do not send yet. Sign-in switches on when the API is live.";

export default function Login() {
  const [status, setStatus] = createSignal("");

  const block = (event: SubmitEvent | MouseEvent) => {
    event.preventDefault();
    setStatus(STATUS);
  };

  return (
    <div class="page">
      <PageHeader
        path="Account / Sign in"
        title="Sign in"
        lede="LiftLog is invite only. Enter your email, then type the 6 digit code it sends you."
      />
      <form class="auth-card" onSubmit={block} novalidate>
        <div class="form-row">
          <label class="label" for="email">
            Email
          </label>
          <input
            class="input"
            id="email"
            name="email"
            type="email"
            autocomplete="email"
            placeholder="you@example.com"
            required
          />
        </div>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary">
            Send code
          </button>
        </div>

        <div class="divider" aria-hidden="true">
          or
        </div>

        <div class="form-row">
          <label class="label" for="otp">
            One-time code
          </label>
          <input
            class="input input-otp"
            id="otp"
            name="otp"
            type="text"
            inputmode="numeric"
            autocomplete="one-time-code"
            pattern="[0-9]{6}"
            maxlength={6}
            placeholder="000000"
            aria-describedby="otp-hint"
          />
          <p class="label form-hint" id="otp-hint">
            6 digits, typed by hand
          </p>
        </div>
        <div class="form-actions">
          <button type="submit" class="btn btn-secondary">
            Verify code
          </button>
          <button type="button" class="btn btn-quiet" onClick={block}>
            Continue with GitHub
          </button>
        </div>

        <p class="form-status" role="status">
          {status()}
        </p>
      </form>
      <p class="panel-note mt-4">
        Codes are typed by hand on purpose: magic links break inside the iOS home screen app. Ask
        whoever runs your group for an invite.
      </p>
    </div>
  );
}
