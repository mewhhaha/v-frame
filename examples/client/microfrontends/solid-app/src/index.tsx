import { createEffect, createRoot, createSignal, onCleanup } from "solid-js";

const pluginPage = document.getElementById("plugins-page");
const libraryPage = document.getElementById("library-page");
const surface = new URL(document.URL).searchParams.get("surface");
if (!pluginPage || !libraryPage) {
  throw new Error("solid-app: workspace pages are missing from index.html");
}

const visiblePage = surface === "library" ? libraryPage : pluginPage;
visiblePage.hidden = false;

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
