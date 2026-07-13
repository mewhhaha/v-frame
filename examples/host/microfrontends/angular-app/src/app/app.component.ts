import { Component, signal } from '@angular/core';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
})
export class AppComponent {
  protected readonly count = signal(0);

  protected increment(): void {
    this.count.update((value) => value + 1);
  }
}
