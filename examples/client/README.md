# Client-composed microfrontends

A React host presents a dark workspace whose entire content area is rendered by an
independently built Solid application. The host owns the shell — sidebar, SPA
navigation, and the `<v-frame>` elements — and nothing else.

**Show frontends** reveals the boundary: the React host shell and the Solid surface
inside it are outlined and labelled.

Plugins, Library, and Overlays use host-owned SPA navigation. When a section is
selected the next surface loads in an inactive frame while the current one stays
visible; a failed load leaves the current surface in place.

## Layout

```
examples/client/
  src/                      React shell (sidebar, SPA navigation, the <v-frame>)
  scripts/serve-static.mjs  static file server used for the built microfrontend
  microfrontends/
    solid-app/              SolidJS app, with Kobalte overlays on ?surface=overlays
```

The microfrontend builds independently to its own `dist/` and has no runtime
dependency on the host, on `v-frame`, or on the host's framework. Its links, History
calls, and document navigation remain guest-owned; the host only chooses which frame
is visible. The React host uses the headless dialog and button primitives from
`@comp0/react`; the guest keeps its own framework and visual state.

## Ports

| App | Port | Served from |
| --- | --- | --- |
| host | 43170 | `vite` dev server |
| solid-app | 43172 | `microfrontends/solid-app/dist` |

The microfrontend stays independently served on port 43172 while the host exposes it
through the same-origin `/frontends/solid/*` route. Vite proxies document and asset
requests to the owning server, and the built application uses a matching base path so
its assets continue through the proxy.

This same-origin public route is required even when the application is deployed
elsewhere. It gives guest Location, relative URLs, storage, and network calls one
consistent public origin; `v-frame` itself requires no special proxy response or
iframe route.

## Run it

From the repo root:

```sh
pnpm install
pnpm --filter example-client run dev
```

`dev` builds the microfrontend once, then starts the host's `vite` dev server and the
static server together. Open http://localhost:43170.

Other scripts, run from `examples/client/`:

- `build:mfe` — builds the microfrontend app.
- `serve:mfe` — serves the already-built microfrontend, without rebuilding.
- `build` — builds the host app itself (`vite build`).

## Overlays

The **Overlays** section mounts Kobalte's tooltip, popover, and modal primitives
inside a deliberately clipped frame. Inside the child realm `document.body` is the
rendered `v-body`, layout and hit-testing are reported in frame-local coordinates, and
native popovers are translated back into that coordinate space after the browser
promotes them to the top layer.

Regular body portals remain descendants of `v-body` and therefore obey the frame's
clipping boundary. Libraries that need to cross it must use a native popover or dialog
shell, or a host-owned overlay bridge.

This section is a demonstration, not a test. The overlay lifecycle, focus, portal
containment, and top-layer positioning contracts are asserted by
`tests/overlays.spec.ts` in the repository root, which runs on every build in Chromium
and Firefox.
