// Integration wiring for the CPE page slices (D83). Each slice exports `page`; registering by the
// same id replaces the built-in page that App.tsx registered first.
import { registerPage } from "./registry";
import { page as cost } from "./cost";

export function wirePages(): void {
  for (const p of [cost]) registerPage(p);
}
