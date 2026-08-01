import "v-frame/register";
import "./overlay-lab.css";

interface OverlaySurface {
  framework: string;
  library: string;
  src: string;
}

const overlaySurfaces: readonly OverlaySurface[] = [
  { framework: "react", library: "Radix UI", src: "/frontends/react/" },
  {
    framework: "angular",
    library: "Angular Material",
    src: "/frontends/angular/?surface=overlays",
  },
  { framework: "solid", library: "Kobalte", src: "/frontends/solid/?surface=overlays" },
  {
    framework: "qwik",
    library: "Qwik UI Headless",
    src: "/frontends/qwik/?surface=overlays",
  },
];

const frameworkGrid = document.getElementById("framework-grid");
const resetFramesButton = document.getElementById("reset-frames");
if (!frameworkGrid || !(resetFramesButton instanceof HTMLButtonElement)) {
  throw new Error("overlay lab: required host elements are missing");
}

function renderFrames(): void {
  frameworkGrid.replaceChildren(
    ...overlaySurfaces.map(({ framework, library, src }) => {
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
    }),
  );
}

resetFramesButton.addEventListener("click", renderFrames);
renderFrames();
