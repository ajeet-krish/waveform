import { Show, type JSX } from "solid-js";

export default function Panel(props: {
  label: string;
  meta?: string;
  class?: string;
  children: JSX.Element;
}) {
  return (
    <section
      classList={{ panel: true, [props.class ?? ""]: Boolean(props.class) }}
      aria-label={props.label}
    >
      <div class="panel-head">
        <h2 class="label">{props.label}</h2>
        <Show when={props.meta}>
          <span class="panel-meta">{props.meta}</span>
        </Show>
      </div>
      <div class="panel-body">{props.children}</div>
    </section>
  );
}
