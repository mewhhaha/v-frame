import { component$, render } from "@builder.io/qwik";

const wikipediaArticles = {
  migration: {
    title: "Blue–green deployment",
    extract: "A release strategy that runs two production environments so traffic can move to a new version with a quick rollback path.",
    href: "https://en.wikipedia.org/wiki/Blue%E2%80%93green_deployment",
  },
  research: {
    title: "Thematic analysis",
    extract: "A qualitative research method for identifying, analyzing, and reporting recurring patterns within a collection of material.",
    href: "https://en.wikipedia.org/wiki/Thematic_analysis",
  },
  brief: {
    title: "Executive summary",
    extract: "A short document or section that presents the purpose, major findings, and recommendations of a longer report.",
    href: "https://en.wikipedia.org/wiki/Executive_summary",
  },
} as const;

type WikipediaArticleKey = keyof typeof wikipediaArticles;

const ProfileWidget = component$(() => (
  <section class="profile-widget" aria-label="Account">
    <button type="button" class="profile-trigger" popovertarget="account-menu">
      <span class="profile-avatar" aria-hidden="true">AM</span>
      <span class="profile-copy"><strong>Avery Morgan</strong><small>Team workspace</small></span>
      <span class="profile-more" aria-hidden="true">···</span>
    </button>
    <div id="account-menu" class="account-menu" popover="auto">
      <p>Avery Morgan</p>
      <button type="button">Settings</button>
      <button type="button">Keyboard shortcuts</button>
      <button type="button">Sign out</button>
    </div>
  </section>
));

const ComposerWidget = component$(() => (
  <form class="composer-widget">
    <div class="composer-row">
      <button type="button" class="attach-button" aria-label="Attach files">+</button>
      <textarea name="message" aria-label="Message Relay" placeholder="Ask anything" />
      <button type="submit" class="send-button" aria-label="Send message">↑</button>
    </div>
    <p aria-live="polite">Relay can make mistakes. Check important details.</p>
  </form>
));

const UsagePage = component$(() => (
  <main class="usage-page">
    <header class="usage-heading">
      <div><h1>Usage</h1><p class="frontend-copy">Workspace activity for the current billing period.</p></div>
      <button type="button">July 2026⌄</button>
    </header>
    <section id="usage-summary" class="usage-overview" aria-label="Usage summary">
      <article><span>Messages</span><strong>1,284</strong><small>32% of plan</small></article>
      <article><span>Context</span><strong>3.8M</strong><small>tokens processed</small></article>
      <article><span>Plugin calls</span><strong>216</strong><small>this month</small></article>
    </section>
    <section id="usage-breakdown" class="usage-breakdown" aria-labelledby="usage-breakdown-title">
      <div class="section-heading"><h2 id="usage-breakdown-title">Usage by frontend</h2><span>Messages</span></div>
      <table>
        <tbody>
          <tr><td><span class="frontend-mark angular-mark" />Angular conversations</td><td>796</td><td>62%</td></tr>
          <tr><td><span class="frontend-mark qwik-mark" />Qwik composer and widgets</td><td>347</td><td>27%</td></tr>
          <tr><td><span class="frontend-mark solid-mark" />Solid workspace pages</td><td>141</td><td>11%</td></tr>
        </tbody>
      </table>
    </section>
  </main>
));

const surface = new URL(document.URL).searchParams.get("surface");
const articleKey = new URL(document.URL).searchParams.get("article");
const wikipediaArticle = wikipediaArticles[
  articleKey && articleKey in wikipediaArticles ? articleKey as WikipediaArticleKey : "migration"
];

const WikipediaPreviewWidget = component$(() => (
  <article class="wikipedia-preview">
    <p class="wikipedia-source">Wikipedia</p>
    <h1>{wikipediaArticle.title}</h1>
    <p class="wikipedia-extract">{wikipediaArticle.extract}</p>
    <a href={wikipediaArticle.href} target="_blank" rel="noreferrer">Read the article</a>
  </article>
));

const App = component$(() => {
  if (surface === "wikipedia") return <WikipediaPreviewWidget />;
  if (surface === "composer") return <ComposerWidget />;
  if (surface === "profile") return <ProfileWidget />;
  return <UsagePage />;
});

const root = document.getElementById("app");
if (!root) throw new Error("qwik-app: missing #app mount element in index.html");

void render(root, <App />).then(() => {
  if (surface !== "composer") return;

  const form = root.querySelector<HTMLFormElement>(".composer-widget");
  const message = root.querySelector<HTMLTextAreaElement>("textarea");
  const status = root.querySelector<HTMLElement>("[aria-live]");
  if (!form || !message || !status) {
    throw new Error("qwik-app: composer surface rendered without its form controls");
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (message.value.trim() === "") return;
    message.value = "";
    status.textContent = "Message sent.";
  });
  message.addEventListener("input", () => {
    status.textContent = "Relay can make mistakes. Check important details.";
  });
});
