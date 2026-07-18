import {
  Component,
  CUSTOM_ELEMENTS_SCHEMA,
  ElementRef,
  inject,
  OnDestroy,
  signal,
  ViewChild,
} from '@angular/core';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';

interface TranscriptStep {
  detail: string;
  title: string;
}

interface ThreadTranscript {
  articleKey: 'brief' | 'migration' | 'research';
  articleTitle: string;
  checkpoint: string;
  prompt: string;
  response: string;
  steps: readonly TranscriptStep[];
  title: string;
}

const threadTranscripts = {
  migration: {
    articleKey: 'migration',
    articleTitle: 'blue–green deployment',
    checkpoint: 'Do not migrate writes until mirrored reads match for seven consecutive days.',
    prompt: 'Help me plan the platform migration. I need a safe rollout sequence that keeps the current API available while teams move over.',
    response: 'I’d split the migration into three reversible stages so each team can move independently.',
    steps: [
      { title: 'Stabilize the boundary.', detail: 'Put the current API behind an adapter and record the contracts teams actually use.' },
      { title: 'Run both paths.', detail: 'Mirror reads to the new service, compare results, and keep writes on the established path.' },
      { title: 'Move ownership.', detail: 'Shift one team at a time, with a short rollback window after every cutover.' },
    ],
    title: 'Platform migration conversation',
  },
  research: {
    articleKey: 'research',
    articleTitle: 'thematic analysis',
    checkpoint: 'Validate the top three themes with five customers before changing the roadmap.',
    prompt: 'Turn our customer interviews into a focused research readout. I need themes, evidence, and a clear next decision.',
    response: 'I’d organize the interviews around repeated needs, then separate observations from product implications.',
    steps: [
      { title: 'Code the evidence.', detail: 'Tag concrete statements without translating them into feature requests yet.' },
      { title: 'Group repeated needs.', detail: 'Cluster related observations and note which customer segments share each pattern.' },
      { title: 'Choose the next question.', detail: 'Use the strongest unresolved theme to shape a small follow-up study.' },
    ],
    title: 'Customer research conversation',
  },
  brief: {
    articleKey: 'brief',
    articleTitle: 'executive summary',
    checkpoint: 'Keep the update to one screen and make every unresolved decision explicit.',
    prompt: 'Draft a weekly brief for stakeholders. It should cover progress, risks, and the decisions we need next week.',
    response: 'I’d lead with the change in status, then give each risk an owner and a dated next action.',
    steps: [
      { title: 'State the movement.', detail: 'Open with what changed since last week, not a recap of the entire project.' },
      { title: 'Name the exposure.', detail: 'Describe each risk in terms of impact, likelihood, owner, and mitigation.' },
      { title: 'Request decisions.', detail: 'End with the smallest set of choices that will unblock the coming week.' },
    ],
    title: 'Weekly brief conversation',
  },
} as const satisfies Record<string, ThreadTranscript>;

type ThreadKey = keyof typeof threadTranscripts;

@Component({
  selector: 'app-overlay-dialog',
  imports: [MatDialogModule],
  template: `
    <section class="overlay-dialog" data-testid="dialog-content" (keydown)="cycleDialogFocus($event)">
      <h2 mat-dialog-title>Angular modal</h2>
      <mat-dialog-content>Angular Material manages focus and dismissal.</mat-dialog-content>
      <label>Project name<input data-testid="dialog-first" aria-label="Modal project name" value="Relay" /></label>
      <mat-dialog-actions>
        <button type="button" mat-dialog-close data-testid="dialog-close">Close</button>
      </mat-dialog-actions>
    </section>
  `,
  styles: [`
    .overlay-dialog { display: grid; gap: 0.75rem; color: #f5f5f5; }
    h2, mat-dialog-content { margin: 0; padding: 0; }
    mat-dialog-content { color: #b4b4b4; font-size: 0.8rem; }
    label { display: grid; gap: 0.35rem; color: #b4b4b4; font-size: 0.75rem; }
    input { min-height: 2.25rem; padding: 0.4rem 0.55rem; border: 1px solid #555; border-radius: 0.4rem; background: #171717; color: white; font: inherit; }
    mat-dialog-actions { min-height: 0; padding: 0; }
    button { min-height: 2.25rem; padding: 0.4rem 0.75rem; border: 1px solid #444; border-radius: 0.55rem; background: #242424; color: #f5f5f5; font: inherit; }
  `],
})
export class OverlayDialogComponent {
  protected cycleDialogFocus(event: KeyboardEvent): void {
    if (event.key !== 'Tab') return;
    const dialog = event.currentTarget;
    if (!(dialog instanceof HTMLElement)) return;
    const controls = Array.from(dialog.querySelectorAll<HTMLElement>('input, button'))
      .filter((control) => !control.hasAttribute('disabled'));
    const firstControl = controls[0];
    const lastControl = controls.at(-1);
    if (!firstControl || !lastControl) return;

    if (!event.shiftKey && document.activeElement === lastControl) {
      event.preventDefault();
      firstControl.focus();
    } else if (event.shiftKey && document.activeElement === firstControl) {
      event.preventDefault();
      lastControl.focus();
    }
  }
}

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
  imports: [MatDialogModule, MatMenuModule, MatTooltipModule],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
})
export class AppComponent implements OnDestroy {
  @ViewChild('overlayPopoverTrigger')
  private overlayPopoverTrigger?: ElementRef<HTMLButtonElement>;

  @ViewChild('overlayDialogTrigger')
  private overlayDialogTrigger?: ElementRef<HTMLButtonElement>;

  @ViewChild('wikipediaPopover')
  private wikipediaPopover?: ElementRef<HTMLElement>;

  private closePreviewTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly dialog = inject(MatDialog);

  protected readonly isOverlayLab = new URL(document.URL).searchParams.get('surface') === 'overlays';
  protected readonly savedNotes = signal(2);
  protected readonly transcript = this.readThread();
  protected readonly wikipediaPreviewUrl = this.transcript
    ? `http://localhost:43173/?surface=wikipedia&article=${this.transcript.articleKey}`
    : '';

  ngOnDestroy(): void {
    if (this.closePreviewTimer) clearTimeout(this.closePreviewTimer);
  }

  protected saveSummary(): void {
    this.savedNotes.update((value) => value + 1);
  }

  protected openOverlayDialog(): void {
    const dialog = this.dialog.open(OverlayDialogComponent, {
      autoFocus: '[data-testid="dialog-first"]',
      panelClass: 'overlay-dialog-panel',
      width: '20rem',
    });
    dialog.afterClosed().subscribe(() => this.overlayDialogTrigger?.nativeElement.focus());
  }

  protected positionOverlayMenu(): void {
    requestAnimationFrame(() => {
      const trigger = this.overlayPopoverTrigger?.nativeElement;
      const content = document.querySelector<HTMLElement>('[data-testid="popover-content"]');
      const pane = content?.closest<HTMLElement>('.cdk-overlay-pane');
      if (!trigger || !content || !pane) return;

      const triggerBounds = trigger.getBoundingClientRect();
      const contentBounds = content.getBoundingClientRect();
      pane.style.translate = [
        `${triggerBounds.left - contentBounds.left}px`,
        `${triggerBounds.bottom + 8 - contentBounds.top}px`,
      ].join(' ');
    });
  }

  protected showWikipediaPreview(event: Event): void {
    if (this.closePreviewTimer) clearTimeout(this.closePreviewTimer);
    const popover = this.wikipediaPopover?.nativeElement;
    const trigger = event.currentTarget;
    if (!popover || !(trigger instanceof HTMLElement)) return;

    const triggerBounds = trigger.getBoundingClientRect();
    const viewportWidth = window.parent.innerWidth;
    const viewportHeight = window.parent.innerHeight;
    const previewWidth = Math.min(360, viewportWidth - 24);
    const left = Math.min(
      Math.max(12, triggerBounds.left),
      viewportWidth - previewWidth - 12,
    );
    const spaceBelow = viewportHeight - triggerBounds.bottom;
    const top = spaceBelow >= 224
      ? triggerBounds.bottom + 8
      : Math.max(12, triggerBounds.top - 208);

    popover.style.setProperty('--preview-left', `${left}px`);
    popover.style.setProperty('--preview-top', `${top}px`);
    if (!popover.matches(':popover-open')) popover.showPopover();
  }

  protected keepWikipediaPreviewOpen(): void {
    if (this.closePreviewTimer) clearTimeout(this.closePreviewTimer);
  }

  protected scheduleWikipediaPreviewClose(): void {
    if (this.closePreviewTimer) clearTimeout(this.closePreviewTimer);
    this.closePreviewTimer = setTimeout(() => {
      const popover = this.wikipediaPopover?.nativeElement;
      if (popover?.matches(':popover-open')) popover.hidePopover();
    }, 120);
  }

  private readThread(): ThreadTranscript | undefined {
    const requestedThread = new URL(document.URL).searchParams.get('thread');
    if (requestedThread === 'new') return undefined;
    if (requestedThread && requestedThread in threadTranscripts) {
      return threadTranscripts[requestedThread as ThreadKey];
    }
    return threadTranscripts.migration;
  }
}
