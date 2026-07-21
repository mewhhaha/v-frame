import type { NativeDocumentHandles, DocumentFacade } from "./document-facade.js";
import type { VFrameCredentials, VFrameWindow } from "./types.js";

type ScriptCategory = "classic" | "module" | "importmap" | "inert";

export interface ScriptFailure {
  url: string;
  error: unknown;
}

interface ExternalModuleSettlement {
  readonly deferredModuleErrors: Set<DeferredModuleError>;
}

interface DeferredModuleError {
  readonly reason: unknown;
  readonly failure: ScriptFailure;
  readonly externalCandidates: Set<ExternalModuleSettlement>;
  readonly inlineCandidates: Set<InlineModuleSettlement>;
}

interface InlineModuleSettlement {
  readonly deferredModuleErrors: Set<DeferredModuleError>;
  status: "pending" | "fulfilled" | "rejected" | "aborted";
  fail(error: unknown): void;
}

interface InlineClassicCandidate {
  fail(error: unknown): void;
}

type ExternalModuleResult =
  | { status: "fulfilled" }
  | { status: "rejected"; error: unknown }
  | { status: "cancelled" }
  | { status: "aborted" };

interface ExternalModuleObservation {
  readonly settled: Promise<void>;
  start(): void;
  cancel(): void;
}

export interface ScriptRunnerOptions {
  window: VFrameWindow;
  native: NativeDocumentHandles;
  facade: DocumentFacade;
  scripts: readonly HTMLScriptElement[];
  signal: AbortSignal;
  credentials: VFrameCredentials;
  executionOrigin: string;
  getNonce(): string;
  getCurrentURL(): string;
  getNativeCurrentScript(): HTMLScriptElement | null;
  onError(failure: ScriptFailure): void;
  onRuntimeError(failure: ScriptFailure): void;
}

function scriptCategory(script: HTMLScriptElement): ScriptCategory {
  const type = script.getAttribute("type")?.trim().toLowerCase() ?? "";
  if (type === "module") {
    return "module";
  }
  if (type === "importmap") {
    return "importmap";
  }
  if (
    type === "" ||
    type === "text/javascript" ||
    type === "application/javascript" ||
    type === "application/x-ecmascript" ||
    type === "application/x-javascript" ||
    type === "text/ecmascript" ||
    type === "application/ecmascript" ||
    type === "text/javascript1.0" ||
    type === "text/javascript1.1" ||
    type === "text/javascript1.2" ||
    type === "text/javascript1.3" ||
    type === "text/javascript1.4" ||
    type === "text/javascript1.5" ||
    type === "text/jscript" ||
    type === "text/livescript" ||
    type === "text/x-ecmascript" ||
    type === "text/x-javascript"
  ) {
    return script.hasAttribute("nomodule") || script.noModule
      ? "inert"
      : "classic";
  }
  return "inert";
}

function hasExternalSource(script: HTMLScriptElement): boolean {
  return script.hasAttribute("src") && (script.getAttribute("src") ?? "") !== "";
}

function errorComesFromCurrentDocument(filename: string, currentURL: string): boolean {
  if (filename === "") {
    return true;
  }
  const currentDocumentURL = new URL(currentURL);
  currentDocumentURL.hash = "";
  return filename === currentDocumentURL.href ||
    filename.startsWith(`${currentDocumentURL.href} `) ||
    filename.startsWith(`${currentDocumentURL.href}:`);
}

export class ScriptRunner {
  readonly #window: VFrameWindow;
  readonly #native: NativeDocumentHandles;
  readonly #facade: DocumentFacade;
  readonly #scripts: readonly HTMLScriptElement[];
  readonly #signal: AbortSignal;
  readonly #credentials: VFrameCredentials;
  readonly #executionOrigin: string;
  readonly #getNonce: () => string;
  readonly #getCurrentURL: () => string;
  readonly #getNativeCurrentScript: () => HTMLScriptElement | null;
  readonly #onError: (failure: ScriptFailure) => void;
  readonly #onRuntimeError: (failure: ScriptFailure) => void;
  readonly #companions = new WeakMap<HTMLScriptElement, HTMLScriptElement>();
  readonly #externalModuleSettlements = new Set<ExternalModuleSettlement>();
  readonly #inlineModuleSettlements = new Set<InlineModuleSettlement>();
  readonly #inlineClassicCandidates: InlineClassicCandidate[] = [];
  readonly #deferredModuleErrors = new Set<DeferredModuleError>();
  readonly #claimedRuntimeErrors = new WeakSet<ErrorEvent>();
  readonly #bootstrapDynamicSettlements = new Set<Promise<void>>();
  #orderedInlineModuleQueue: Promise<void> = Promise.resolve();
  #trackBootstrapDynamicScripts = true;
  #reconcilingModuleErrors = false;
  #inlineModuleSequence = 0;
  #externalModuleSequence = 0;

  constructor(options: ScriptRunnerOptions) {
    this.#window = options.window;
    this.#native = options.native;
    this.#facade = options.facade;
    this.#scripts = options.scripts;
    this.#signal = options.signal;
    this.#credentials = options.credentials;
    this.#executionOrigin = options.executionOrigin;
    this.#getNonce = options.getNonce;
    this.#getCurrentURL = options.getCurrentURL;
    this.#getNativeCurrentScript = options.getNativeCurrentScript;
    this.#onError = options.onError;
    this.#onRuntimeError = options.onRuntimeError;
    const moduleErrorListener = (event: ErrorEvent) => {
      const currentURL = this.#getCurrentURL();
      const comesFromCurrentDocument =
        errorComesFromCurrentDocument(event.filename, currentURL) ||
        errorComesFromCurrentDocument(event.filename, this.#window.location.href);
      const externalCandidates = comesFromCurrentDocument
        ? new Set<ExternalModuleSettlement>()
        : new Set(this.#externalModuleSettlements);
      if (
        this.#inlineModuleSettlements.size === 0 &&
        externalCandidates.size === 0
      ) {
        return;
      }

      event.preventDefault();
      this.#claimedRuntimeErrors.add(event);
      const deferredModuleError: DeferredModuleError = {
        reason: event.error,
        failure: {
          url: comesFromCurrentDocument ? currentURL : (event.filename || currentURL),
          error: event.error ?? new Error(event.message),
        },
        externalCandidates,
        inlineCandidates: new Set(this.#inlineModuleSettlements),
      };
      this.#deferredModuleErrors.add(deferredModuleError);
      for (const settlement of deferredModuleError.externalCandidates) {
        settlement.deferredModuleErrors.add(deferredModuleError);
      }
      for (const settlement of deferredModuleError.inlineCandidates) {
        settlement.deferredModuleErrors.add(deferredModuleError);
      }
      this.#reconcileModuleErrors();
    };
    const nativeAddEventListener = this.#window.addEventListener.bind(this.#window);
    const nativeRemoveEventListener = this.#window.removeEventListener.bind(this.#window);
    nativeAddEventListener("error", moduleErrorListener);
    const securityPolicyViolationListener = (event: SecurityPolicyViolationEvent) => {
      if (
        event.disposition !== "enforce" ||
        event.blockedURI !== "inline" ||
        (event.effectiveDirective !== "script-src" &&
          event.effectiveDirective !== "script-src-elem")
      ) {
        return;
      }
      const candidate = this.#inlineClassicCandidates.shift();
      candidate?.fail(new Error(
        `Inline script blocked by ${event.effectiveDirective}: ${event.originalPolicy}`,
      ));
    };
    nativeAddEventListener("securitypolicyviolation", securityPolicyViolationListener);
    this.#signal.addEventListener("abort", () => {
      nativeRemoveEventListener("error", moduleErrorListener);
      nativeRemoveEventListener("securitypolicyviolation", securityPolicyViolationListener);
      this.#inlineClassicCandidates.length = 0;
    }, { once: true });
  }

  get currentScript(): HTMLScriptElement | null {
    const nativeScript = this.#getNativeCurrentScript();
    return nativeScript === null ? null : (this.#companions.get(nativeScript) ?? null);
  }

  claimsRuntimeError(event: ErrorEvent): boolean {
    return this.#claimedRuntimeErrors.has(event) || event.defaultPrevented;
  }

  #consumeModuleError(deferredModuleError: DeferredModuleError): void {
    if (!this.#deferredModuleErrors.delete(deferredModuleError)) {
      return;
    }
    for (const settlement of deferredModuleError.externalCandidates) {
      settlement.deferredModuleErrors.delete(deferredModuleError);
    }
    for (const settlement of deferredModuleError.inlineCandidates) {
      settlement.deferredModuleErrors.delete(deferredModuleError);
    }
    deferredModuleError.externalCandidates.clear();
    deferredModuleError.inlineCandidates.clear();
  }

  #removeInlineModuleSettlement(settlement: InlineModuleSettlement): void {
    this.#inlineModuleSettlements.delete(settlement);
    for (const deferredModuleError of settlement.deferredModuleErrors) {
      deferredModuleError.inlineCandidates.delete(settlement);
    }
    settlement.deferredModuleErrors.clear();
    this.#reconcileModuleErrors();
  }

  #reconcileModuleErrors(): void {
    if (this.#reconcilingModuleErrors) {
      return;
    }
    this.#reconcilingModuleErrors = true;
    try {
      while (true) {
        let routedError = false;
        for (const deferredModuleError of [...this.#deferredModuleErrors]) {
          if (
            deferredModuleError.externalCandidates.size > 0 ||
            deferredModuleError.inlineCandidates.size > 0
          ) {
            continue;
          }
          this.#consumeModuleError(deferredModuleError);
          if (!this.#signal.aborted) {
            this.#onRuntimeError(deferredModuleError.failure);
          }
          routedError = true;
        }
        if (routedError) {
          continue;
        }

        const visitedErrors = new Set<DeferredModuleError>();
        let settledComponent = false;
        for (const seed of this.#deferredModuleErrors) {
          if (seed.externalCandidates.size > 0 || visitedErrors.has(seed)) {
            continue;
          }

          const componentErrors = new Set<DeferredModuleError>();
          const componentSettlements = new Set<InlineModuleSettlement>();
          const pendingErrors = [seed];
          while (pendingErrors.length > 0) {
            const deferredModuleError = pendingErrors.pop();
            if (deferredModuleError === undefined || componentErrors.has(deferredModuleError)) {
              continue;
            }
            componentErrors.add(deferredModuleError);
            visitedErrors.add(deferredModuleError);
            for (const settlement of deferredModuleError.inlineCandidates) {
              if (settlement.status !== "pending" || componentSettlements.has(settlement)) {
                continue;
              }
              componentSettlements.add(settlement);
              for (const relatedError of settlement.deferredModuleErrors) {
                if (relatedError.externalCandidates.size === 0) {
                  pendingErrors.push(relatedError);
                }
              }
            }
          }

          const errorBySettlement = new Map<InlineModuleSettlement, DeferredModuleError>();
          const assignError = (
            deferredModuleError: DeferredModuleError,
            visitedSettlements: Set<InlineModuleSettlement>,
          ): boolean => {
            for (const settlement of deferredModuleError.inlineCandidates) {
              if (settlement.status !== "pending" || visitedSettlements.has(settlement)) {
                continue;
              }
              visitedSettlements.add(settlement);
              const assignedError = errorBySettlement.get(settlement);
              if (
                assignedError === undefined ||
                assignError(assignedError, visitedSettlements)
              ) {
                errorBySettlement.set(settlement, deferredModuleError);
                return true;
              }
            }
            return false;
          };
          for (const deferredModuleError of componentErrors) {
            assignError(deferredModuleError, new Set());
          }
          if (errorBySettlement.size !== componentSettlements.size) {
            continue;
          }

          const failures = [...errorBySettlement].map(([settlement, deferredModuleError]) => ({
            settlement,
            deferredModuleError,
          }));
          for (const { deferredModuleError } of failures) {
            this.#consumeModuleError(deferredModuleError);
          }
          for (const { settlement, deferredModuleError } of failures) {
            if (settlement.status === "pending") {
              settlement.fail(deferredModuleError.failure.error);
            }
          }
          settledComponent = true;
          break;
        }
        if (!settledComponent) {
          return;
        }
      }
    } finally {
      this.#reconcilingModuleErrors = false;
    }
  }

  async executeInitial(): Promise<void> {
    const asyncScripts: Promise<void>[] = [];
    const deferredScripts: HTMLScriptElement[] = [];

    for (const script of this.#scripts) {
      const category = scriptCategory(script);
      if (category === "inert") {
        continue;
      }

      const external = hasExternalSource(script);
      const asynchronous = script.hasAttribute("async") && (external || category === "module");
      if (asynchronous) {
        asyncScripts.push(this.#execute(script, "async"));
        continue;
      }

      const deferred = category === "module" || (external && script.hasAttribute("defer"));
      if (deferred) {
        deferredScripts.push(script);
        continue;
      }

      await this.#execute(script, "ordered");
    }

    if (this.#signal.aborted) {
      return;
    }

    this.#facade.setReadyState("interactive");
    const deferredExecutions = deferredScripts.map((script) =>
      this.#executeScript(script, "ordered")
    );
    await Promise.all(deferredExecutions);

    if (this.#signal.aborted) {
      return;
    }

    this.#facade.dispatchDocumentEvent("DOMContentLoaded", {
      bubbles: true,
      cancelable: false,
    });
    await Promise.all(asyncScripts);
    while (this.#bootstrapDynamicSettlements.size > 0) {
      await Promise.all([...this.#bootstrapDynamicSettlements]);
    }

    if (this.#signal.aborted) {
      return;
    }

    this.#trackBootstrapDynamicScripts = false;
    this.#facade.setReadyState("complete");
    this.#window.dispatchEvent(new this.#window.Event("load"));
  }

  executeDynamic(
    script: HTMLScriptElement,
    execution: "async" | "ordered",
  ): void {
    if (scriptCategory(script) === "inert" || this.#signal.aborted) {
      return;
    }
    const settlement = this.#execute(script, execution);
    if (!this.#trackBootstrapDynamicScripts || !hasExternalSource(script)) {
      void settlement;
      return;
    }

    const trackedSettlement = settlement.finally(() => {
      this.#bootstrapDynamicSettlements.delete(trackedSettlement);
    });
    this.#bootstrapDynamicSettlements.add(trackedSettlement);
  }

  async #execute(
    pseudoScript: HTMLScriptElement,
    execution: "async" | "ordered",
  ): Promise<void> {
    const inlineModule =
      scriptCategory(pseudoScript) === "module" && !hasExternalSource(pseudoScript);
    if (!inlineModule) {
      await this.#executeScript(pseudoScript, execution);
      return;
    }

    if (execution === "async") {
      await this.#executeScript(pseudoScript, execution);
      return;
    }

    const queuedExecution = this.#orderedInlineModuleQueue.then(() =>
      this.#executeScript(pseudoScript, execution),
    );
    this.#orderedInlineModuleQueue = queuedExecution.catch(() => undefined);
    await queuedExecution;
  }

  #prepareExternalModule(
    pseudoScript: HTMLScriptElement,
    source: string,
  ): ExternalModuleObservation {
    const sequence = this.#externalModuleSequence += 1;
    const fulfilledName = `__vFrameExternalModuleFulfilled${sequence}`;
    const rejectedName = `__vFrameExternalModuleRejected${sequence}`;
    const settlement: ExternalModuleSettlement = {
      deferredModuleErrors: new Set(),
    };
    this.#externalModuleSettlements.add(settlement);
    let started = false;
    let finished = false;
    let finish!: (result: ExternalModuleResult) => void;
    let abort!: () => void;
    const settled = new Promise<void>((resolve) => {
      finish = (result: ExternalModuleResult) => {
        if (finished) {
          return;
        }
        finished = true;
        this.#signal.removeEventListener("abort", abort);
        delete (this.#window as unknown as Record<string, unknown>)[fulfilledName];
        delete (this.#window as unknown as Record<string, unknown>)[rejectedName];
        this.#externalModuleSettlements.delete(settlement);

        let evaluationFailureClaimed = false;
        for (const deferredModuleError of [...settlement.deferredModuleErrors]) {
          deferredModuleError.externalCandidates.delete(settlement);
          const belongsToEvaluation =
            result.status === "rejected" &&
            !evaluationFailureClaimed &&
            Object.is(deferredModuleError.reason, result.error);
          if (belongsToEvaluation) {
            evaluationFailureClaimed = true;
            this.#consumeModuleError(deferredModuleError);
          }
        }
        settlement.deferredModuleErrors.clear();
        this.#reconcileModuleErrors();

        if (result.status === "rejected") {
          const error = result.error ?? new Error(`Script ${source} failed to execute`);
          pseudoScript.dispatchEvent(new this.#window.Event("error"));
          this.#onError({ url: source, error });
        }
        resolve();
      };
      abort = () => finish({ status: "aborted" });
      this.#signal.addEventListener("abort", abort, { once: true });
    });

    return {
      settled,
      start: () => {
        if (started || finished) {
          return;
        }
        started = true;
        const observer = this.#native.createElement("script");
        observer.type = "module";
        const nonce = this.#getNonce();
        if (nonce !== "") {
          observer.nonce = nonce;
        }
        observer.text = `import(${JSON.stringify(source)}).then(globalThis[${JSON.stringify(fulfilledName)}], globalThis[${JSON.stringify(rejectedName)}]);`;

        Object.defineProperty(this.#window, fulfilledName, {
          configurable: true,
          value: () => finish({ status: "fulfilled" }),
        });
        Object.defineProperty(this.#window, rejectedName, {
          configurable: true,
          value: (error: unknown) => finish({ status: "rejected", error }),
        });
        observer.addEventListener(
          "error",
          () => finish({
            status: "rejected",
            error: new Error(`Module observer for ${source} failed to execute`),
          }),
          { once: true },
        );

        try {
          this.#native.appendChild(this.#native.privateHead, observer);
        } catch (error) {
          finish({ status: "rejected", error });
        }
      },
      cancel: () => finish({ status: "cancelled" }),
    };
  }

  async #executeScript(
    pseudoScript: HTMLScriptElement,
    execution: "async" | "ordered",
  ): Promise<void> {
    if (this.#signal.aborted) {
      return;
    }

    if (
      pseudoScript.hasAttribute("src") &&
      (pseudoScript.getAttribute("src") ?? "") === ""
    ) {
      const url = this.#getCurrentURL();
      const error = new Error(`Script source is empty at ${url}`);
      pseudoScript.dispatchEvent(new this.#window.Event("error"));
      this.#onError({ url, error });
      return;
    }

    const companion = this.#native.createElement("script");
    for (const attributeName of pseudoScript.getAttributeNames()) {
      if (
        attributeName === "nonce" ||
        (attributeName.startsWith("on") && attributeName in companion)
      ) {
        continue;
      }
      const attributeValue = pseudoScript.getAttribute(attributeName);
      if (attributeValue !== null) {
        this.#native.setAttribute(companion, attributeName, attributeValue);
      }
    }

    const nonce = this.#getNonce();
    if (nonce !== "") {
      companion.nonce = nonce;
    }

    if (!pseudoScript.hasAttribute("crossorigin")) {
      if (this.#credentials === "include") {
        companion.crossOrigin = "use-credentials";
      } else if (this.#credentials === "omit") {
        companion.crossOrigin = "anonymous";
      } else if (hasExternalSource(pseudoScript)) {
        // An unresolvable src stays on the companion so its native load failure
        // reports a per-script error instead of failing the whole document.
        try {
          if (new URL(pseudoScript.src).origin !== this.#executionOrigin) {
            companion.crossOrigin = "anonymous";
          }
        } catch {}
      }
    }

    if (execution === "ordered") {
      companion.async = false;
    }

    this.#companions.set(companion, pseudoScript);
    const category = scriptCategory(pseudoScript);
    const external = hasExternalSource(pseudoScript);
    const inlineModule = category === "module" && !external;
    const externalModule = category === "module" && external;
    const needsSettlement = external || inlineModule;
    const completionName = inlineModule
      ? `__vFrameModuleCompletion${this.#inlineModuleSequence += 1}`
      : null;
    const externalModuleObservation = externalModule
      ? this.#prepareExternalModule(pseudoScript, companion.src)
      : null;

    if (!external) {
      companion.text = inlineModule
        ? `${pseudoScript.text}\n;globalThis[${JSON.stringify(completionName)}]();`
        : pseudoScript.text;
    }

    const settlementCallbacks: { fail?: (error?: unknown) => void } = {};
    if (category === "classic" && !needsSettlement) {
      let failureReported = false;
      const candidate: InlineClassicCandidate = {
        fail: (failure) => {
          if (failureReported || this.#signal.aborted) {
            return;
          }
          failureReported = true;
          const candidateIndex = this.#inlineClassicCandidates.indexOf(candidate);
          if (candidateIndex !== -1) {
            this.#inlineClassicCandidates.splice(candidateIndex, 1);
          }
          const url = this.#getCurrentURL();
          pseudoScript.dispatchEvent(new this.#window.Event("error"));
          this.#onError({ url, error: failure });
        },
      };
      this.#inlineClassicCandidates.push(candidate);
      // CSP violation events arrive in a later task than zero-delay timers in both engines.
      this.#window.setTimeout(() => {
        const candidateIndex = this.#inlineClassicCandidates.indexOf(candidate);
        if (candidateIndex !== -1) {
          this.#inlineClassicCandidates.splice(candidateIndex, 1);
        }
      }, 100);
      companion.addEventListener("error", () => {
        if (failureReported) {
          return;
        }
        const url = this.#getCurrentURL();
        candidate.fail(new Error(`Script ${url} failed to execute`));
      }, { once: true });
    }
    let inlineModuleSettlement: InlineModuleSettlement | null = null;
    const settled = new Promise<void>((resolve) => {
      if (!needsSettlement) {
        resolve();
        return;
      }

      let finished = false;
      const finish = () => {
        if (finished) {
          return;
        }
        finished = true;
        this.#signal.removeEventListener("abort", abort);
        externalModuleObservation?.cancel();
        if (completionName !== null) {
          delete (this.#window as unknown as Record<string, unknown>)[completionName];
          if (inlineModuleSettlement !== null) {
            this.#removeInlineModuleSettlement(inlineModuleSettlement);
          }
        }
        resolve();
      };
      const finishLoaded = () => {
        if (finished) {
          return;
        }
        if (inlineModuleSettlement !== null) {
          inlineModuleSettlement.status = "fulfilled";
        }
        pseudoScript.dispatchEvent(new this.#window.Event("load"));
        if (externalModuleObservation !== null) {
          externalModuleObservation.start();
          void externalModuleObservation.settled.then(finish);
          return;
        }
        finish();
      };
      const finishFailed = (failure?: unknown) => {
        if (finished) {
          return;
        }
        if (inlineModuleSettlement !== null) {
          inlineModuleSettlement.status = "rejected";
        }
        const url = pseudoScript.src || this.#getCurrentURL();
        const error = failure ?? new Error(`Script ${url} failed to load or execute`);
        pseudoScript.dispatchEvent(new this.#window.Event("error"));
        this.#onError({ url, error });
        finish();
      };
      settlementCallbacks.fail = finishFailed;

      if (completionName !== null) {
        inlineModuleSettlement = {
          deferredModuleErrors: new Set(),
          status: "pending",
          fail: finishFailed,
        };
        Object.defineProperty(this.#window, completionName, {
          configurable: true,
          value: finishLoaded,
        });
        this.#inlineModuleSettlements.add(inlineModuleSettlement);
      }
      companion.addEventListener(
        "load",
        finishLoaded,
        { once: true },
      );
      companion.addEventListener(
        "error",
        () => finishFailed(),
        { once: true },
      );
      const abort = () => {
        if (inlineModuleSettlement !== null) {
          inlineModuleSettlement.status = "aborted";
        }
        finish();
      };
      this.#signal.addEventListener("abort", abort, { once: true });
    });

    try {
      this.#native.appendChild(this.#native.privateHead, companion);
    } catch (error) {
      if (settlementCallbacks.fail !== undefined) {
        settlementCallbacks.fail(error);
        return;
      }
      const url = pseudoScript.src || this.#getCurrentURL();
      pseudoScript.dispatchEvent(new this.#window.Event("error"));
      this.#onError({ url, error });
      return;
    }

    await settled;
  }
}
