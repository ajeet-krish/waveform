/** Honest chrome for phase 0: the shell renders, the data plane does not exist yet. */
export default function PreviewBanner() {
  return (
    <p class="preview-banner" role="note">
      <span class="label">Preview shell</span>
      <span>Nothing is saved yet. Logging, sync, and sign-in switch on when the API lands.</span>
    </p>
  );
}
