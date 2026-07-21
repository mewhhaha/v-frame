import { createEffect, createRoot, createSignal, onCleanup } from "solid-js";
import { render } from "solid-js/web";
import { Dialog } from "@kobalte/core/dialog";
import { Popover } from "@kobalte/core/popover";
import { Tooltip } from "@kobalte/core/tooltip";
import "./overlay-lab.css";

function OverlayLab() {
  return (
    <main class="overlay-lab" data-library="kobalte">
      <header>
        <p>Solid</p>
        <h1>Kobalte</h1>
      </header>
      <Tooltip openDelay={0} closeDelay={0}>
        <Tooltip.Trigger class="lab-button" data-testid="tooltip-trigger">Tooltip</Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content class="overlay-content tooltip-content" data-testid="tooltip-content">
            Solid tooltip
            <Tooltip.Arrow class="overlay-arrow" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip>

      <Popover>
        <Popover.Trigger class="lab-button" data-testid="popover-trigger">Popover</Popover.Trigger>
        <Popover.Portal>
          <Popover.Content class="overlay-content popover-content" data-testid="popover-content">
            <Popover.Title>Project settings</Popover.Title>
            <label>Project name<input data-testid="popover-input" value="Relay" /></label>
            <Popover.CloseButton class="close-button">Close</Popover.CloseButton>
            <Popover.Arrow class="overlay-arrow" />
          </Popover.Content>
        </Popover.Portal>
      </Popover>

      <Dialog>
        <Dialog.Trigger class="lab-button" data-testid="dialog-trigger">Modal</Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay class="dialog-overlay" />
          <div class="dialog-positioner">
            <Dialog.Content class="dialog-content" data-testid="dialog-content">
              <Dialog.Title>Solid modal</Dialog.Title>
              <Dialog.Description>Kobalte manages focus and dismissal.</Dialog.Description>
              <input data-testid="dialog-first" aria-label="Modal project name" value="Relay" />
              <Dialog.CloseButton class="close-button" data-testid="dialog-close">Close</Dialog.CloseButton>
            </Dialog.Content>
          </div>
        </Dialog.Portal>
      </Dialog>
      <p class="boundary-note">The dashed edge is the microfrontend rendering boundary.</p>
    </main>
  );
}

const pluginPage = document.getElementById("plugins-page");
const libraryPage = document.getElementById("library-page");
const overlayLab = document.getElementById("overlay-lab");
const surface = new URL(document.URL).searchParams.get("surface");
if (!pluginPage || !libraryPage || !overlayLab) {
  throw new Error("solid-app: workspace pages are missing from index.html");
}

if (surface === "overlays") {
  render(() => <OverlayLab />, overlayLab);
}
if (surface !== "overlays") {
  const visiblePage = surface === "library" ? libraryPage : pluginPage;
  visiblePage.hidden = false;
}

createRoot(() => {
  const pluginButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-plugin-toggle]"));
  const [enabledPlugins, setEnabledPlugins] = createSignal(
    new Set(pluginButtons.filter((button) => button.ariaPressed === "true").map((button) => button.dataset.pluginName ?? "")),
  );
  const removePluginListeners = pluginButtons.map((button) => {
    const pluginName = button.dataset.pluginName;
    if (!pluginName) throw new Error("solid-app: plugin toggle is missing its plugin name");
    const togglePlugin = () => {
      setEnabledPlugins((currentPlugins) => {
        const nextPlugins = new Set(currentPlugins);
        if (nextPlugins.has(pluginName)) nextPlugins.delete(pluginName);
        else nextPlugins.add(pluginName);
        return nextPlugins;
      });
    };
    button.addEventListener("click", togglePlugin);
    return () => button.removeEventListener("click", togglePlugin);
});

  createEffect(() => {
    for (const button of pluginButtons) {
      const pluginName = button.dataset.pluginName ?? "";
      const enabled = enabledPlugins().has(pluginName);
      button.ariaPressed = String(enabled);
      button.textContent = enabled ? "✓" : "+";
      button.setAttribute("aria-label", `${enabled ? "Disable" : "Enable"} ${pluginName}`);
    }
  });

  onCleanup(() => removePluginListeners.forEach((removeListener) => removeListener()));
  });

const pluginSearch = document.querySelector<HTMLInputElement>("[name=plugin-search]");
const pluginCategories = Array.from(document.querySelectorAll<HTMLElement>(".plugin-category"));
const filterPlugins = () => {
  const searchTerm = pluginSearch?.value.trim().toLocaleLowerCase() ?? "";
  for (const category of pluginCategories) {
    const plugins = Array.from(category.querySelectorAll<HTMLElement>(".plugin-row"));
    for (const plugin of plugins) {
      plugin.hidden = searchTerm !== "" && !plugin.textContent?.toLocaleLowerCase().includes(searchTerm);
    }
    category.hidden = plugins.every((plugin) => plugin.hidden);
  }
};
pluginSearch?.addEventListener("input", filterPlugins);

const librarySearch = document.querySelector<HTMLInputElement>("[name=library-search]");
const libraryRows = Array.from(document.querySelectorAll<HTMLTableRowElement>("#library-entries tbody tr"));
const filterLibrary = () => {
  const searchTerm = librarySearch?.value.trim().toLocaleLowerCase() ?? "";
  for (const row of libraryRows) {
    row.hidden = searchTerm !== "" && !row.textContent?.toLocaleLowerCase().includes(searchTerm);
  }
};
librarySearch?.addEventListener("input", filterLibrary);
