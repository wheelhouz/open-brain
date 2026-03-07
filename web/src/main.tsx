import { render } from "preact";
import { App } from "./components/App";
import { initShortcuts } from "./lib/shortcuts";
import "./styles/globals.css";

render(<App />, document.getElementById("app")!);
initShortcuts();
