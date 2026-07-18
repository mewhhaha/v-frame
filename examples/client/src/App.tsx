import {
  Button,
  Dialog,
  DialogContent,
  DialogTrigger,
} from "@comp0/react";
import { useEffect, useRef, useState } from "react";
import { VFrameStatus } from "v-frame";
import type {
  VFrameElement,
  VFrameErrorEventDetail,
  VFrameStatusValue,
} from "v-frame";
import { microfrontends, type MicrofrontendKey } from "./microfrontends";
import "./App.css";

const hostSections = {
  new: {
    label: "New thread",
    frontend: "angular",
    url: `${microfrontends.angular.url}?thread=new`,
  },
  library: {
    label: "Library",
    frontend: "solid",
    url: `${microfrontends.solid.url}?surface=library`,
  },
  plugins: {
    label: "Plugins",
    frontend: "solid",
    url: `${microfrontends.solid.url}?surface=plugins`,
  },
  usage: {
    label: "Usage",
    frontend: "qwik",
    url: microfrontends.qwik.url,
  },
  migration: {
    label: "Platform migration",
    frontend: "angular",
    url: `${microfrontends.angular.url}?thread=migration`,
  },
  research: {
    label: "Customer research",
    frontend: "angular",
    url: `${microfrontends.angular.url}?thread=research`,
  },
  brief: {
    label: "Weekly brief",
    frontend: "angular",
    url: `${microfrontends.angular.url}?thread=brief`,
  },
} as const satisfies Record<string, {
  frontend: MicrofrontendKey;
  label: string;
  url: string;
}>;

type HostSectionKey = keyof typeof hostSections;

const allSections = Object.keys(hostSections) as HostSectionKey[];
const utilitySections: HostSectionKey[] = ["library", "plugins", "usage"];
const threadSections: HostSectionKey[] = ["migration", "research", "brief"];

const frontendLabels: Record<MicrofrontendKey, string> = {
  angular: "Angular",
  solid: "Solid",
  qwik: "Qwik",
};

const navigationMarks: Record<HostSectionKey, string> = {
  new: "+",
  library: "▱",
  plugins: "⌘",
  usage: "◫",
  migration: "P",
  research: "S",
  brief: "D",
};

interface HostNavigationProps {
  activeSection: HostSectionKey;
  onSelect: (section: HostSectionKey) => void;
}

function HostLink({
  activeSection,
  onSelect,
  section,
}: HostNavigationProps & { section: HostSectionKey }) {
  return (
    <Button
      className={section === activeSection ? "host-link host-link-active" : "host-link"}
      aria-current={section === activeSection ? "page" : undefined}
      onClick={() => onSelect(section)}
    >
      <span className="host-link-mark" aria-hidden="true">
        {navigationMarks[section]}
      </span>
      <span className="host-link-label">{hostSections[section].label}</span>
      <span className="host-link-owner">{frontendLabels[hostSections[section].frontend]}</span>
    </Button>
  );
}

function HostNavigation({ activeSection, onSelect }: HostNavigationProps) {
  return (
    <nav className="host-navigation" aria-label="Relay navigation">
      <ul className="utility-navigation" role="list">
        {utilitySections.map((section) => (
          <li key={section}>
            <HostLink activeSection={activeSection} onSelect={onSelect} section={section} />
          </li>
        ))}
      </ul>
      <div className="navigation-group">
        <p className="navigation-label">Recent</p>
        <ul role="list">
          {threadSections.map((section) => (
            <li key={section}>
              <HostLink activeSection={activeSection} onSelect={onSelect} section={section} />
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}

export function App() {
  const [activeSection, setActiveSection] = useState<HostSectionKey>("new");
  const [compositionVisible, setCompositionVisible] = useState(false);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [status, setStatus] = useState<VFrameStatusValue>(VFrameStatus.Idle);
  const frameElementsRef = useRef(new Map<HostSectionKey, VFrameElement>());
  const activeSectionRef = useRef<HostSectionKey>("new");
  const compositionVisibleRef = useRef(false);

  useEffect(() => {
    const removeListeners = allSections.map((section) => {
      const frame = frameElementsRef.current.get(section);
      if (!frame) return () => undefined;

      const handleLoadStart = () => {
        if (section !== activeSectionRef.current) return;
        setStatus(VFrameStatus.Loading);
      };
      const handleLoad = () => {
        frame.shadowRoot
          ?.querySelector("app-root")
          ?.toggleAttribute("data-composition-visible", compositionVisibleRef.current);

        if (section !== activeSectionRef.current) return;
        setStatus(VFrameStatus.Ready);
      };
      const handleError = (event: CustomEvent<VFrameErrorEventDetail>) => {
        if (section !== activeSectionRef.current) return;

        if (event.detail.fatal) {
          setStatus(VFrameStatus.Error);
        }
      };

      frame.addEventListener("v-frame-loadstart", handleLoadStart);
      frame.addEventListener("v-frame-load", handleLoad);
      frame.addEventListener("v-frame-error", handleError);

      return () => {
        frame.removeEventListener("v-frame-loadstart", handleLoadStart);
        frame.removeEventListener("v-frame-load", handleLoad);
        frame.removeEventListener("v-frame-error", handleError);
      };
    });

    return () => removeListeners.forEach((removeListener) => removeListener());
  }, []);

  useEffect(() => {
    compositionVisibleRef.current = compositionVisible;
    for (const frame of frameElementsRef.current.values()) {
      frame.shadowRoot
        ?.querySelector("app-root")
        ?.toggleAttribute("data-composition-visible", compositionVisible);
    }
  }, [activeSection, compositionVisible]);

  const selectSection = (nextSection: HostSectionKey) => {
    if (nextSection === activeSectionRef.current) return;

    const frame = frameElementsRef.current.get(nextSection);
    if (!frame) return;

    activeSectionRef.current = nextSection;
    setActiveSection(nextSection);
    setStatus(frame.status);
    setMobileNavigationOpen(false);
  };

  const activeTarget = hostSections[activeSection];
  const activeFrontend = activeTarget.frontend;
  const frontendOwner = microfrontends[activeFrontend].owner;

  return (
    <div
      className={sidebarOpen ? "host-app" : "host-app host-app-sidebar-closed"}
      data-composition-visible={compositionVisible ? "true" : undefined}
    >
      <aside id="host-sidebar" className="host-sidebar" data-composition-label="React host shell">
        <div className="brand-row">
          <a href="/" aria-label="Relay homepage" className="brand">
            Relay <span>Pro</span>
          </a>
          <Button className="sidebar-icon-button" aria-label="Search threads">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="10.5" cy="10.5" r="6.5" />
              <path d="m15.5 15.5 4.5 4.5" />
            </svg>
          </Button>
        </div>
        <Button className="new-thread" onClick={() => selectSection("new")}>
          <span aria-hidden="true">＋</span>
          <span className="host-link-label">New thread</span>
          <span className="host-link-owner">Angular</span>
        </Button>
        <HostNavigation activeSection={activeSection} onSelect={selectSection} />
        <div className="account-surface" data-composition-label="Qwik account frontend">
          <v-frame
            className="account-frame"
            src={microfrontends.qwik.profileUrl}
            aria-label="Account menu microfrontend"
            credentials="omit"
          />
        </div>
      </aside>

      <div className="host-content">
        <header className="mobile-header">
          <a href="/" aria-label="Relay homepage" className="brand">Relay <span>Pro</span></a>
          <Dialog open={mobileNavigationOpen} onToggle={setMobileNavigationOpen}>
            <DialogTrigger className="mobile-menu-trigger">Menu</DialogTrigger>
            <DialogContent className="mobile-navigation" aria-labelledby="mobile-navigation-title">
              <div className="mobile-navigation-heading">
                <h2 id="mobile-navigation-title">Navigation</h2>
                <form method="dialog"><Button className="mobile-close">Close</Button></form>
              </div>
              <Button className="new-thread" onClick={() => selectSection("new")}>＋ New thread</Button>
              <HostNavigation activeSection={activeSection} onSelect={selectSection} />
            </DialogContent>
          </Dialog>
        </header>

        <main className={activeFrontend === "angular" ? "page-shell" : "page-shell page-shell-standalone"}>
          <header className="conversation-header">
            <Button
              className="sidebar-toggle"
              aria-controls="host-sidebar"
              aria-expanded={sidebarOpen}
              onClick={() => setSidebarOpen((open) => !open)}
            >
              {sidebarOpen ? "Hide sidebar" : "Show sidebar"}
            </Button>
            <h1 className="sr-only">{activeTarget.label}</h1>
            <Button
              className="composition-trigger"
              aria-pressed={compositionVisible}
              onClick={() => setCompositionVisible((visible) => !visible)}
            >
              <span className="composition-swatches" aria-hidden="true"><span /><span /><span /></span>
              {compositionVisible ? "Hide frontends" : "Show frontends"}
            </Button>
          </header>

          <section
            className="frame-viewport"
            aria-label={`${microfrontends[activeFrontend].label} microfrontend`}
            aria-busy={status === VFrameStatus.Loading}
            data-composition-label={frontendOwner}
            data-frontend={activeFrontend}
          >
            {allSections.map((section) => (
              <v-frame
                key={section}
                ref={(element) => {
                  if (element) frameElementsRef.current.set(section, element);
                  else frameElementsRef.current.delete(section);
                }}
                src={hostSections[section].url}
                className={section === activeSection ? "frame-slot frame-slot-active" : "frame-slot frame-slot-inactive"}
                aria-hidden={section !== activeSection}
                inert={section !== activeSection}
                aria-label={`${hostSections[section].label} frontend surface`}
                credentials="omit"
              />
            ))}
          </section>
          {activeFrontend === "angular" ? (
            <section className="composer-surface" aria-label="Message composer" data-composition-label="Qwik composer frontend">
              <v-frame
                className="composer-frame"
                src={microfrontends.qwik.composerUrl}
                aria-label="Message composer microfrontend"
                credentials="omit"
              />
            </section>
          ) : null}
        </main>
      </div>
    </div>
  );
}
