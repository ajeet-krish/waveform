import { Show } from "solid-js";

export default function PageHeader(props: { path: string; title: string; lede?: string }) {
  return (
    <header class="page-head">
      <p class="label">{props.path}</p>
      <h1 class="page-title">{props.title}</h1>
      <Show when={props.lede}>
        <p class="lede">{props.lede}</p>
      </Show>
    </header>
  );
}
