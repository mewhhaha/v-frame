import { createSignal } from "solid-js";

const widgetStyles = `
  :root {
    color: #20242c;
    font-family: Inter, ui-sans-serif, system-ui, sans-serif;
  }

  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background: #f4f8fb; }

  .signals {
    display: grid;
    min-height: 100vh;
    place-items: center;
    padding: 2rem;
  }

  .signals__panel {
    width: min(36rem, 100%);
    padding: 2rem;
    border: 1px solid #c9dce8;
    border-radius: 1.25rem;
    background: white;
    box-shadow: 0 1rem 3rem rgb(43 102 128 / 12%);
  }

  .signals__eyebrow {
    margin: 0 0 .5rem;
    color: #16718e;
    font-size: .75rem;
    font-weight: 700;
    letter-spacing: .12em;
    text-transform: uppercase;
  }

  h1 { margin: 0; font-size: clamp(2rem, 6vw, 3.25rem); line-height: 1; }
  p { color: #536270; line-height: 1.6; }

  button {
    padding: .75rem 1rem;
    border: 0;
    border-radius: .75rem;
    background: #126783;
    color: white;
    cursor: pointer;
    font: inherit;
    font-weight: 700;
  }

  button:hover { background: #0b5269; }
`;

export default function App() {
  const [reviewedSignals, setReviewedSignals] = createSignal(0);

  return (
    <>
      <style>{widgetStyles}</style>
      <main class="signals">
        <section class="signals__panel">
          <p class="signals__eyebrow">SolidStart · server rendered</p>
          <h1>Signal review</h1>
          <p>
            The widget owns its route, server render, client entry, and reactive state.
            The host only launches its document through v-frame.
          </p>
          <button
            type="button"
            onClick={() => setReviewedSignals((current) => current + 1)}
          >
            Reviewed signals: {reviewedSignals()}
          </button>
        </section>
      </main>
    </>
  );
}
