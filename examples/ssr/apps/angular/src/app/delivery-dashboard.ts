import { Component, signal } from "@angular/core";

@Component({
  selector: "app-delivery-dashboard",
  template: `
    <main class="angular-dashboard">
      <header>
        <p>Angular SSR frontend</p>
        <h2>Delivery readiness</h2>
        <span>Rendered by Angular and hydrated in its isolated realm.</span>
      </header>
      <section aria-label="Release checks" class="release-checks">
        @for (check of checks; track check.name) {
          <article>
            <span>{{ check.name }}</span>
            <strong>{{ check.value }}</strong>
            <small>{{ check.note }}</small>
          </article>
        }
      </section>
      <button type="button" (click)="recordReview()">
        Record review · {{ reviewCount() }}
      </button>
    </main>
  `,
  styles: [
    `
      :host {
        display: block;
        min-height: 100%;
      }
      * {
        box-sizing: border-box;
      }
      .angular-dashboard {
        min-height: 100%;
        padding: 3rem 1.5rem;
        background: #000;
        color: #f5f5f5;
        font-family: Inter, ui-sans-serif, system-ui, sans-serif;
      }
      .angular-dashboard > * {
        width: min(100%, 48rem);
        margin-inline: auto;
      }
      header p {
        margin: 0;
        color: #f97316;
        font:
          600 0.6875rem ui-monospace,
          SFMono-Regular,
          Menlo,
          monospace;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      h2 {
        margin: 0.5rem 0 0;
        font-size: 1.75rem;
        font-weight: 500;
        letter-spacing: -0.035em;
      }
      header span {
        display: block;
        margin-top: 0.45rem;
        color: #a0a0a0;
        font-size: 0.875rem;
      }
      .release-checks {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        margin-top: 3rem;
        border-block: 1px solid #252525;
      }
      article {
        min-width: 0;
        padding: 1.25rem 1.5rem;
        border-left: 1px solid #252525;
      }
      article:first-child {
        padding-left: 0;
        border-left: 0;
      }
      article span,
      article small {
        display: block;
        color: #a0a0a0;
        font-size: 0.75rem;
      }
      article strong {
        display: block;
        margin: 0.7rem 0 0.2rem;
        font-size: 1.55rem;
        font-weight: 500;
      }
      button {
        display: block;
        min-height: 2.35rem;
        margin: 2.5rem auto 0;
        padding: 0.4rem 0.85rem;
        border: 1px solid #3a3a3a;
        border-radius: 999px;
        background: #212121;
        color: #ececec;
        cursor: pointer;
        font: inherit;
        font-size: 0.8125rem;
      }
      button:focus-visible {
        outline: 2px solid #f97316;
        outline-offset: 2px;
      }
      @media (max-width: 36rem) {
        .angular-dashboard {
          padding: 1.5rem 1rem;
        }
        .release-checks {
          grid-template-columns: 1fr;
        }
        article,
        article:first-child {
          padding: 1rem 0;
          border-left: 0;
          border-top: 1px solid #252525;
        }
        article:first-child {
          border-top: 0;
        }
        button {
          min-height: 3rem;
          font-size: 1rem;
        }
      }
    `,
  ],
})
export class DeliveryDashboard {
  protected readonly checks = [
    { name: "SSR response", value: "Ready", note: "HTML arrived with the shell" },
    { name: "Client hydration", value: "Active", note: "Angular event replay enabled" },
    { name: "Style boundary", value: "Local", note: "Selectors stay in this frame" },
  ] as const;
  protected readonly reviewCount = signal(0);

  protected recordReview(): void {
    this.reviewCount.update((currentCount) => currentCount + 1);
  }
}
