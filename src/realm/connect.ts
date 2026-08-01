// Bootstrapping the hidden execution realm: an empty same-origin srcdoc iframe,
// rewritten to a blank document at the guest's URL, with a Trusted Types policy
// minted inside it.
//
// This module also holds the handful of types the rest of src/realm/ shares. It
// is the one module in the directory that imports nothing from its siblings, so
// keeping them here is what makes the directory's imports acyclic.

import type {
  VFrameErrorPhase,
  VFrameTrustedTypesPolicyDefinition,
  VFrameWindow,
} from "../types.js";

export interface RealmFailure {
  phase: VFrameErrorPhase;
  url: string;
  error: unknown;
}

export interface RealmTrustedTypes {
  createHTML(source: string): string;
  createScript(source: string): string;
  createScriptURL(source: string): string;
}

export interface ConnectedRealmIframe {
  iframe: HTMLIFrameElement;
  trustedTypes: RealmTrustedTypes;
}

/** The realm window shape `connectRealmIframe` has already proven exists. */
export type NavigationWindow = VFrameWindow & {
  readonly NavigateEvent: typeof NavigateEvent;
  readonly navigation: Navigation;
};

interface TrustedTypePolicyFactoryLike {
  readonly emptyHTML: unknown;
  createPolicy(
    name: string,
    policy: Omit<VFrameTrustedTypesPolicyDefinition, "name">,
  ): Omit<VFrameTrustedTypesPolicyDefinition, "name">;
}

export function abortError(): DOMException {
  return new DOMException("The v-frame load was superseded", "AbortError");
}

export async function connectRealmIframe(
  shadowRoot: ShadowRoot,
  signal: AbortSignal,
  locationURL: string,
  trustedTypesPolicy: VFrameTrustedTypesPolicyDefinition | null,
): Promise<ConnectedRealmIframe> {
  if (signal.aborted) {
    throw abortError();
  }

  const iframe = shadowRoot.ownerDocument.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.tabIndex = -1;
  iframe.style.setProperty("position", "absolute", "important");
  iframe.style.setProperty("top", "0", "important");
  iframe.style.setProperty("left", "0", "important");
  iframe.style.setProperty("width", "1px", "important");
  iframe.style.setProperty("height", "1px", "important");
  iframe.style.setProperty("border", "0", "important");
  iframe.style.setProperty("opacity", "0", "important");
  iframe.style.setProperty("pointer-events", "none", "important");
  const hostWindow = shadowRoot.ownerDocument.defaultView;
  const hostTrustedTypes = (
    hostWindow as (Window & { trustedTypes?: TrustedTypePolicyFactoryLike }) | null
  )?.trustedTypes;
  try {
    iframe.srcdoc = (hostTrustedTypes?.emptyHTML ?? "") as string;
  } catch (error) {
    throw new Error("v-frame could not create its empty srcdoc execution realm", {
      cause: error,
    });
  }

  let realmTrustedTypes: RealmTrustedTypes | null = null;

  await new Promise<void>((resolve, reject) => {
    let replacementDocumentOpened = false;
    const loaded = () => {
      if (replacementDocumentOpened) {
        return;
      }
      const document = iframe.contentDocument;
      const realmWindow = iframe.contentWindow as NavigationWindow | null;
      if (document === null || realmWindow === null) {
        cleanup();
        iframe.remove();
        reject(new Error("The connected iframe has no same-origin srcdoc realm"));
        return;
      }
      if (
        !("navigation" in realmWindow) ||
        !("NavigateEvent" in realmWindow) ||
        typeof realmWindow.navigation?.addEventListener !== "function" ||
        typeof realmWindow.NavigateEvent?.prototype?.intercept !== "function"
      ) {
        cleanup();
        iframe.remove();
        reject(
          new Error(
            "v-frame requires Navigation API support to isolate native Location changes",
          ),
        );
        return;
      }

      replacementDocumentOpened = true;
      queueMicrotask(() => {
        if (signal.aborted) {
          return;
        }
        try {
          if (trustedTypesPolicy === null) {
            realmTrustedTypes = {
              createHTML: (source) => source,
              createScript: (source) => source,
              createScriptURL: (source) => source,
            };
          } else {
            const policyRules = {
              createHTML: (source: string) => trustedTypesPolicy.createHTML(source),
              createScript: (source: string) => trustedTypesPolicy.createScript(source),
              createScriptURL: (source: string) =>
                trustedTypesPolicy.createScriptURL(source),
            };
            const factory = (
              realmWindow as unknown as { trustedTypes?: TrustedTypePolicyFactoryLike }
            ).trustedTypes;
            if (factory === undefined) {
              realmTrustedTypes = policyRules;
            } else {
              try {
                const policy = factory.createPolicy(trustedTypesPolicy.name, policyRules);
                realmTrustedTypes = {
                  createHTML: (source) => policy.createHTML(source) as unknown as string,
                  createScript: (source) =>
                    policy.createScript(source) as unknown as string,
                  createScriptURL: (source) =>
                    policy.createScriptURL(source) as unknown as string,
                };
              } catch (error) {
                throw new Error(
                  `v-frame could not create Trusted Types policy ${JSON.stringify(trustedTypesPolicy.name)} for ${locationURL}`,
                  { cause: error },
                );
              }
            }
          }
          document.open();
          document.write(realmTrustedTypes.createHTML("<!doctype html>"));
          document.close();
          realmWindow.setTimeout(() => {
            try {
              realmWindow.history.replaceState(null, "", locationURL);
              cleanup();
              resolve();
            } catch (error) {
              cleanup();
              iframe.remove();
              reject(
                new Error(
                  `v-frame could not initialize its execution realm at ${locationURL}`,
                  { cause: error },
                ),
              );
            }
          }, 0);
        } catch (error) {
          cleanup();
          iframe.remove();
          reject(error);
        }
      });
    };
    const aborted = () => {
      cleanup();
      iframe.remove();
      reject(abortError());
    };
    const cleanup = () => {
      iframe.removeEventListener("load", loaded);
      signal.removeEventListener("abort", aborted);
    };

    iframe.addEventListener("load", loaded);
    signal.addEventListener("abort", aborted, { once: true });
    shadowRoot.append(iframe);
  });

  if (signal.aborted) {
    iframe.remove();
    throw abortError();
  }

  if (realmTrustedTypes === null) {
    iframe.remove();
    throw new Error(`v-frame did not initialize its execution realm at ${locationURL}`);
  }
  return { iframe, trustedTypes: realmTrustedTypes };
}
