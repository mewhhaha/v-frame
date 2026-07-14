import { createEffect, createRoot, createSignal, onCleanup } from "solid-js";

const counter = document.getElementById("counter");
const countOutput = document.getElementById("count");
if (!counter || !countOutput) {
  throw new Error("solid-app: missing #counter or #count element in index.html");
}

createRoot(() => {
  const [count, setCount] = createSignal(0);
  const increment = () => setCount((currentCount) => currentCount + 1);

  counter.addEventListener("click", increment);
  onCleanup(() => counter.removeEventListener("click", increment));
  createEffect(() => {
    countOutput.textContent = String(count());
  });
});
