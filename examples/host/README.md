# v-frame host example

A React host application that composes three independent microfrontends —
Angular, Solid, and Qwik — through `<v-frame>` elements. When a tab is selected,
the next app loads in an inactive frame while the current app remains visible.
After `v-frame-load` fires, the host promotes the ready frame with the browser's
View Transition API. A failed load leaves the current app in place.

## Layout

```
examples/host/
  src/                    host React app (tabs, status panel, the <v-frame>)
  scripts/serve-static.mjs  static file server used for the built microfrontends
  microfrontends/
    angular-app/          Angular 22 standalone app
    solid-app/             SolidJS app
    qwik-app/              Qwik app (client-rendered, no Qwik City)
```

Each microfrontend app builds independently to its own `dist/` and has no
runtime dependency on the host or on each other.

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

Angular's build requires Node `^22.22.3 || ^24.15.0 || >=26.0.0` (see the
repo's `.nvmrc`); an older Node 24 patch will fail `ng build` with a version
check.

## Run it

From the repo root:

```sh
pnpm install
pnpm --filter example-host run dev
```

`dev` builds all three microfrontends once, then starts the host's `vite` dev
server and the three static servers together. Open http://localhost:43170.

Other scripts, run from `examples/host/`:

- `build:mfe` — builds the three microfrontend apps.
- `serve:mfe` — serves the three already-built microfrontends, without
  rebuilding.
- `build` — builds the host app itself (`vite build`).
