import { render } from "solid-js/web";
import { App } from "./App";

const root = document.getElementById("app");
if (!root) throw new Error("solid-app: missing #app mount element in index.html");

render(() => <App />, root);
