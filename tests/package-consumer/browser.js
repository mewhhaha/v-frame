import "@mewhhaha/v-frame/register";
import { VFrameElement } from "@mewhhaha/v-frame";

if (customElements.get("v-frame") !== VFrameElement)
  throw new Error("Unexpected v-frame registration");
