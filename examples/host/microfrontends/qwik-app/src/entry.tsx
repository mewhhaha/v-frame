import { component$, render, useSignal } from "@builder.io/qwik";

const App = component$(() => {
  const count = useSignal(0);

  return (
    <main class="qwik-app">
      <h1>Qwik microfrontend</h1>
      <p>
        Count: <strong>{count.value}</strong>
      </p>
      <button onClick$={() => count.value++}>Increment</button>
    </main>
  );
});

render(document.querySelector("#app")!, <App />);
