import type { Routes } from "@angular/router";

import { DeliveryDashboard } from "./delivery-dashboard";

export const routes: Routes = [
  { path: "dashboard", component: DeliveryDashboard },
  { path: "", pathMatch: "full", redirectTo: "dashboard" },
];
