import { provideAnimationsAsync } from "@angular/platform-browser/animations/async";
import { bootstrapApplication } from "@angular/platform-browser";

import { AppComponent } from "./app/app.component";

bootstrapApplication(AppComponent, {
  providers: [provideAnimationsAsync()],
}).catch((error: unknown) => {
  console.error("failed to bootstrap angular-app", error);
});
