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

The host page on 43170 loads each microfrontend from its own origin (43171,
43172, or 43173) via `fetch`, so every microfrontend's static server must send
`Access-Control-Allow-Origin: *`; without it, the browser blocks the
cross-origin response before `v-frame` ever sees it. `scripts/serve-static.mjs`
sets that header on every response it serves.

The Angular frontend stays on Angular 21 so the full example supports Node
24.12 as well as the repository's Node 26 default.

## Run it

From the repo root:

```sh
pnpm install
pnpm --filter example-client run dev
```

`dev` builds all three microfrontends once, then starts the host's `vite` dev
server and the three static servers together. Open http://localhost:43170.

Other scripts, run from `examples/client/`:

- `build:mfe` — builds the three microfrontend apps.
- `serve:mfe` — serves the three already-built microfrontends, without
  rebuilding.
- `build` — builds the host app itself (`vite build`).
