import { type BootstrapContext, bootstrapApplication } from "@angular/platform-browser";

import { App } from "./app/app";
import { serverConfig } from "./app/app.config.server";

export default function bootstrap(context: BootstrapContext) {
  return bootstrapApplication(App, serverConfig, context);
}
