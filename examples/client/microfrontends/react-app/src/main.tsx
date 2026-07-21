import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Dialog, Popover, Tooltip } from "radix-ui";
import "./styles.css";

function OverlayLab() {
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const tooltipTrigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const trigger = tooltipTrigger.current;
    if (!trigger) return;
    const closeTooltip = () => setTooltipOpen(false);
    trigger.addEventListener("pointerleave", closeTooltip);
    return () => trigger.removeEventListener("pointerleave", closeTooltip);
  }, []);

  return (
    <main className="overlay-lab" data-library="radix-ui">
      <header>
        <p>React</p>
        <h1>Radix UI</h1>
      </header>
      <Tooltip.Provider delayDuration={0}>
        <Tooltip.Root open={tooltipOpen} onOpenChange={setTooltipOpen}>
          <Tooltip.Trigger ref={tooltipTrigger} className="lab-button" data-testid="tooltip-trigger">Tooltip</Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content className="overlay-content tooltip-content" data-testid="tooltip-content" sideOffset={8}>
              React tooltip
              <Tooltip.Arrow className="overlay-arrow" />
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
      </Tooltip.Provider>

      <Popover.Root>
        <Popover.Trigger className="lab-button" data-testid="popover-trigger">Popover</Popover.Trigger>
        <Popover.Portal>
          <Popover.Content className="overlay-content popover-content" data-testid="popover-content" side="bottom" sideOffset={8}>
            <label>Project name<input data-testid="popover-input" defaultValue="Relay" /></label>
            <Popover.Close className="close-button">Close</Popover.Close>
            <Popover.Arrow className="overlay-arrow" />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>

      <Dialog.Root>
        <Dialog.Trigger className="lab-button" data-testid="dialog-trigger">Modal</Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content" data-testid="dialog-content">
            <Dialog.Title>React modal</Dialog.Title>
            <Dialog.Description>Radix manages focus and dismissal.</Dialog.Description>
            <input data-testid="dialog-first" aria-label="Modal project name" defaultValue="Relay" />
            <Dialog.Close className="close-button" data-testid="dialog-close">Close</Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <p className="boundary-note">The dashed edge is the microfrontend rendering boundary.</p>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("react-app: missing #root mount element in index.html");

createRoot(root).render(
  <StrictMode>
    <OverlayLab />
  </StrictMode>,
);
