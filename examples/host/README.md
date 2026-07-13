# v-frame host example

A React host application that composes three independent microfrontends —
Angular, Solid, and Qwik — through a single `<v-frame>` element. Switching
tabs changes the element's `src`; `v-frame` fetches the selected app's built
HTML and runs it in its own realm inside the host page.

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
| host | 5170 | `vite` dev server |
| angular-app | 5171 | `microfrontends/angular-app/dist/angular-app/browser` |
| solid-app | 5172 | `microfrontends/solid-app/dist` |
| qwik-app | 5173 | `microfrontends/qwik-app/dist` |

The host page on 5170 loads each microfrontend from its own origin (5171,
5172, or 5173) via `fetch`, so every microfrontend's static server must send
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
server and the three static servers together. Open http://localhost:5170.

Other scripts, run from `examples/host/`:

- `build:mfe` — builds the three microfrontend apps.
- `serve:mfe` — serves the three already-built microfrontends, without
  rebuilding.
- `build` — builds the host app itself (`vite build`).
