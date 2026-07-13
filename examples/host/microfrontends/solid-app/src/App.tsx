import { createSignal } from "solid-js";

export function App() {
  const [count, setCount] = createSignal(0);

  return (
    <div
      style={{
        "min-height": "100vh",
        "box-sizing": "border-box",
        margin: "0",
        padding: "3rem 2rem",
        background: "#1a3b5d",
        color: "#eaf2fb",
        "font-family": "system-ui, sans-serif",
        "text-align": "center",
      }}
    >
      <h1>Solid microfrontend</h1>
      <p>Rendered by SolidJS, mounted into a v-frame realm.</p>
      <button
        type="button"
        onClick={() => setCount((value) => value + 1)}
        style={{
          "font-size": "1.1rem",
          padding: "0.6rem 1.4rem",
          "border-radius": "0.5rem",
          border: "none",
          cursor: "pointer",
          background: "#4da3ff",
          color: "#0a1f33",
        }}
      >
        Count: {count()}
      </button>
    </div>
  );
}
