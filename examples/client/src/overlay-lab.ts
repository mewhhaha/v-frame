import { defineVFrame } from "v-frame";
import "./overlay-lab.css";

interface OverlaySurface {
  framework: string;
  library: string;
  src: string;
}

const overlaySurfaces: readonly OverlaySurface[] = [
  { framework: "react", library: "Radix UI", src: "http://localhost:43174/" },
  { framework: "angular", library: "Angular Material", src: "http://localhost:43171/?surface=overlays" },
  { framework: "solid", library: "Kobalte", src: "http://localhost:43172/?surface=overlays" },
  { framework: "qwik", library: "Qwik UI Headless", src: "http://localhost:43173/?surface=overlays" },
];

defineVFrame();

const frameworkGrid = document.getElementById("framework-grid");
const resetFramesButton = document.getElementById("reset-frames");
if (!frameworkGrid || !(resetFramesButton instanceof HTMLButtonElement)) {
  throw new Error("overlay lab: required host elements are missing");
}

function renderFrames(): void {
  frameworkGrid.replaceChildren(...overlaySurfaces.map(({ framework, library, src }) => {
    const card = document.createElement("article");
    card.className = "framework-card";
    card.dataset.framework = framework;

    const label = document.createElement("p");
    label.className = "frame-label";
    label.textContent = `${framework} · ${library}`;

    const viewport = document.createElement("div");
    viewport.className = "frame-viewport";

    const frame = document.createElement("v-frame");
    frame.setAttribute("src", src);
    frame.setAttribute("credentials", "omit");
    frame.setAttribute("aria-label", `${framework} ${library} overlay test`);
    frame.dataset.testid = `${framework}-frame`;

    viewport.append(frame);
    card.append(label, viewport);
    return card;
  }));
}

resetFramesButton.addEventListener("click", renderFrames);
renderFrames();
