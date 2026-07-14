import { component$, render } from "@builder.io/qwik";

const App = component$(() => {
  return (
    <main class="qwik-app">
      <h1>Qwik microfrontend</h1>
      <p>
        Count: <strong id="count">0</strong>
      </p>
      <button id="increment" type="button">Increment</button>
    </main>
  );
});

const root = document.getElementById("app");
if (!root) throw new Error("qwik-app: missing #app mount element in index.html");

let count = 0;
const observer = new MutationObserver(() => {
  const incrementButton = document.getElementById("increment");
  const countOutput = document.getElementById("count");
  if (!incrementButton || !countOutput) return;

  observer.disconnect();
  incrementButton.addEventListener("click", () => {
    count++;
    countOutput.textContent = String(count);
  });
});
observer.observe(root, { childList: true, subtree: true });
render(root, <App />);
