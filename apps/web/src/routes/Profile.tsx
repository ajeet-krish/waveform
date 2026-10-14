import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";
import Panel from "../components/Panel";

const FIELDS = [
  { label: "Display name", value: "Not set" },
  { label: "Email", value: "Not signed in" },
  { label: "GitHub", value: "Not linked" },
  { label: "Units", value: "kg and cm" },
  { label: "Invite", value: "Required" },
];

export default function Profile() {
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
            {FIELDS.map((field) => (
              <div class="def-row">
                <dt class="label">{field.label}</dt>
                <dd class="def-value is-empty">{field.value}</dd>
              </div>
            ))}
          </dl>
        </Panel>
        <Panel label="Session">
          <EmptyState
            title="You are not signed in"
            body="Sign in with a one-time code sent to your email, or with GitHub. Sessions survive reinstalls on the home screen app."
            actions={[{ label: "Go to sign in", href: "/login" }]}
            note="Weights are stored in kg and lengths in cm; lb and in are display only"
          />
        </Panel>
      </div>
    </div>
  );
}
