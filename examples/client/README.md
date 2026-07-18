# Client-composed microfrontends

A React host presents a dark composer workspace with an independently rendered
Angular transcript, Solid plugins page, and Qwik usage page. Additional Qwik
surfaces provide the persistent composer, the sidebar account menu, and the
Wikipedia preview nested inside each transcript.

The workspace reads as one product by default. **Show composition** reveals
the React host boundary and color-codes every Angular, Solid, and Qwik surface,
including the nested preview, composer, and account frontends.

The three recent threads, Plugins, and Usage use host-owned SPA navigation.
When a section is selected, the next frontend loads in an inactive frame while
the current one remains visible. After `v-frame-load` fires, the host promotes
the ready frame with the browser's View Transition API. A failed load leaves
the current frontend in place.

Transcript references use a manual native popover. The popover enters the
browser's top layer and contains a nested Qwik `v-frame`, so its Wikipedia
preview crosses the Angular frame's clipping boundary without moving ownership
into the host.

## Layout

```
examples/client/
  src/                    React shell (sidebar, SPA navigation, the <v-frame>)
  scripts/serve-static.mjs  static file server used for the built microfrontends
  microfrontends/
    angular-app/          Angular 21 standalone app
    react-app/            React overlay compatibility surface
    solid-app/             SolidJS app
    qwik-app/              Qwik app (client-rendered, no Qwik City)
```

Each microfrontend app builds independently to its own `dist/` and has no
runtime dependency on the host or on each other. The React host uses the
headless dialog and button primitives from `@comp0/react`; each frontend keeps
its own framework and visual state.

## Ports

| App | Port | Served from |
| --- | --- | --- |
| host | 43170 | `vite` dev server |
| angular-app | 43171 | `microfrontends/angular-app/dist/angular-app/browser` |
| solid-app | 43172 | `microfrontends/solid-app/dist` |
| qwik-app | 43173 | `microfrontends/qwik-app/dist` |
| react-app | 43174 | `microfrontends/react-app/dist` |

The host page on 43170 loads each microfrontend from its own origin (43171,
43172, 43173, or 43174) via `fetch`, so every microfrontend's static server must send
`Access-Control-Allow-Origin: *`; without it, the browser blocks the
cross-origin response before `v-frame` ever sees it. `scripts/serve-static.mjs`
sets that header on every response it serves.

Angular CLI 21 requires Node 22.22.3+, 24.15+, or 26+. Use the repository's
Node 26 default to build every microfrontend.

## Run it

From the repo root:

```sh
pnpm install
pnpm --filter example-client run dev
```

`dev` builds all four microfrontends once, then starts the host's `vite` dev
server and the four static servers together. Open http://localhost:43170.

Other scripts, run from `examples/client/`:

- `build:mfe` — builds the four microfrontend apps.
- `serve:mfe` — serves the four already-built microfrontends, without
  rebuilding.
- `build` — builds the host app itself (`vite build`).

## Overlay compatibility lab

`overlay-lab.html` mounts the same tooltip, popover, and modal exercise in four
clipped `v-frame` cards:

Inside every child realm, `document.body` is the rendered `v-body`. The runtime
also reports layout and hit-testing in frame-local coordinates and translates
native popovers back to that coordinate space after the browser promotes them
to the top layer.

| Framework | Library | Compatibility result inside `v-frame` |
| --- | --- | --- |
| React | Radix UI 1.6.2 | Tooltip, popover, and modal lifecycle checks pass. The example adds a direct boundary-leave listener because Radix's delegated tooltip leave does not cross the shadow boundary. |
| Angular | Angular Material 21.1.5 | Tooltip, menu, and dialog checks pass. The example rebases the CDK menu pane and explicitly cycles/restores dialog focus around the adopted shadow tree. |
| Solid | Kobalte 0.13.12 | Kobalte mounts after virtual template contents preserve native `template.content` behavior; tooltip, popover, and modal checks pass. |
| Qwik | Qwik UI Headless 0.7.7 | The explicit Qwik loader activates delegated handlers. Preserved `ToggleEvent` fields and top-layer viewport translation keep its tooltip, popover, and modal working. |

Regular body portals remain descendants of `v-body` and therefore obey the
frame's clipping boundary. Libraries that need to cross it must use a native
popover/dialog shell or a host-owned overlay bridge. The Playwright suite runs
the shared lifecycle, positioning, focus, and teardown contract in Chromium
and Firefox.

After building the microfrontends, run the lab tests with:

```sh
pnpm --filter example-client run test:overlays
```
