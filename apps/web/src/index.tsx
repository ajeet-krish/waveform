import { render } from "solid-js/web";
import { registerSW } from "virtual:pwa-register";
import App from "./App";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/shell.css";
import "./styles/app.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Root element #root is missing from index.html");
}

render(() => <App />, root);

// Service worker updates itself; the console re-renders on the next reload.
registerSW({ immediate: true });
