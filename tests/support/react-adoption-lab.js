import { createElement as h, useState } from "react";
import { hydrateRoot } from "react-dom/client";

function App() {
  const [name, setName] = useState("server");
  const [note, setNote] = useState("server-note");
  const [checked, setChecked] = useState(true);
  const [tick, setTick] = useState(0);
  return h(
    "form",
    null,
    h(
      "label",
      null,
      "Name",
      h("input", { id: "name", value: name, onChange: (e) => setName(e.target.value) }),
    ),
    h(
      "label",
      null,
      "Note",
      h("textarea", {
        id: "note",
        value: note,
        onChange: (e) => setNote(e.target.value),
      }),
    ),
    h(
      "label",
      null,
      "Enabled",
      h("input", {
        id: "enabled",
        type: "checkbox",
        checked,
        onChange: (e) => setChecked(e.target.checked),
      }),
    ),
    h("output", { id: "model" }, `${name}|${note}|${checked}`),
    h(
      "button",
      { type: "button", id: "rerender", onClick: () => setTick(tick + 1) },
      `Render ${tick}`,
    ),
  );
}

hydrateRoot(document.getElementById("react-root"), h(App), {
  onRecoverableError(error) {
    top.hydrationErrors.push(error.message);
  },
});
// React must have committed its listeners before the SSR handoff.
await new Promise((resolve) =>
  requestAnimationFrame(() => requestAnimationFrame(resolve)),
);
