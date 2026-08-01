import { Button, Dialog, DialogContent, DialogTrigger } from "@comp0/react";
import { useEffect, useRef, useState } from "react";
import { VFrameStatus } from "v-frame";
import type { VFrameElement, VFrameErrorEventDetail, VFrameStatusValue } from "v-frame";
import "./App.css";

/**
 * The guest is one independently built Solid application, reached through the single
 * same-origin route the host proxies to it. That public route is what gives the guest a
 * consistent Location, relative URLs, storage and network origin; `v-frame` itself needs
 * no special proxy response.
 */
const solidFrontend = "/frontends/solid/";

const hostSections = {
  plugins: {
    label: "Plugins",
    url: `${solidFrontend}?surface=plugins`,
  },
  library: {
    label: "Library",
    url: `${solidFrontend}?surface=library`,
  },
  overlays: {
    label: "Overlays",
    url: `${solidFrontend}?surface=overlays`,
  },
} as const satisfies Record<string, { label: string; url: string }>;

type HostSectionKey = keyof typeof hostSections;

const allSections = Object.keys(hostSections) as HostSectionKey[];

const navigationMarks: Record<HostSectionKey, string> = {
  plugins: "⌘",
  library: "▱",
  overlays: "◫",
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
      <span className="host-link-owner">Solid</span>
    </Button>
  );
}

function HostNavigation({ activeSection, onSelect }: HostNavigationProps) {
  return (
    <nav className="host-navigation" aria-label="Relay navigation">
      <ul className="utility-navigation" role="list">
        {allSections.map((section) => (
          <li key={section}>
            <HostLink
              activeSection={activeSection}
              onSelect={onSelect}
              section={section}
            />
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function App() {
  const [activeSection, setActiveSection] = useState<HostSectionKey>("plugins");
  const [compositionVisible, setCompositionVisible] = useState(false);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [status, setStatus] = useState<VFrameStatusValue>(VFrameStatus.Idle);
  const frameElementsRef = useRef(new Map<HostSectionKey, VFrameElement>());
  const activeSectionRef = useRef<HostSectionKey>("plugins");

  useEffect(() => {
    const removeListeners = allSections.map((section) => {
      const frame = frameElementsRef.current.get(section);
      if (!frame) return () => undefined;

      const handleLoadStart = () => {
        if (section !== activeSectionRef.current) return;
        setStatus(VFrameStatus.Loading);
      };
      const handleLoad = () => {
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

  return (
    <div
      className={sidebarOpen ? "host-app" : "host-app host-app-sidebar-closed"}
      data-composition-visible={compositionVisible ? "true" : undefined}
    >
      <aside
        id="host-sidebar"
        className="host-sidebar"
        data-composition-label="React host shell"
      >
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
        <HostNavigation activeSection={activeSection} onSelect={selectSection} />
      </aside>

      <div className="host-content">
        <header className="mobile-header">
          <a href="/" aria-label="Relay homepage" className="brand">
            Relay <span>Pro</span>
          </a>
          <Dialog open={mobileNavigationOpen} onToggle={setMobileNavigationOpen}>
            <DialogTrigger className="mobile-menu-trigger">Menu</DialogTrigger>
            <DialogContent
              className="mobile-navigation"
              aria-labelledby="mobile-navigation-title"
            >
              <div className="mobile-navigation-heading">
                <h2 id="mobile-navigation-title">Navigation</h2>
                <form method="dialog">
                  <Button className="mobile-close">Close</Button>
                </form>
              </div>
              <HostNavigation activeSection={activeSection} onSelect={selectSection} />
            </DialogContent>
          </Dialog>
        </header>

        <main className="page-shell">
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
              <span className="composition-swatches" aria-hidden="true">
                <span />
                <span />
              </span>
              {compositionVisible ? "Hide frontends" : "Show frontends"}
            </Button>
          </header>

          <section
            className="frame-viewport"
            aria-label="Solid microfrontend"
            aria-busy={status === VFrameStatus.Loading}
            data-composition-label="Solid frontend"
          >
            {allSections.map((section) => (
              <v-frame
                key={section}
                ref={(element) => {
                  if (element) frameElementsRef.current.set(section, element);
                  else frameElementsRef.current.delete(section);
                }}
                src={hostSections[section].url}
                className={
                  section === activeSection
                    ? "frame-slot frame-slot-active"
                    : "frame-slot frame-slot-inactive"
                }
                aria-hidden={section !== activeSection}
                inert={section !== activeSection}
                aria-label={`${hostSections[section].label} frontend surface`}
                credentials="omit"
              />
            ))}
          </section>
        </main>
      </div>
    </div>
  );
}
