// GitHub Pages only serves files that exist. The app is one page that shows
// the guest, screen or host view depending on the address, so after a build
// this copies that page to every address the app answers on.
import { copyFileSync, mkdirSync } from "node:fs";

const dist = new URL("../dist/", import.meta.url).pathname;
for (const page of ["screen", "host"]) {
  mkdirSync(`${dist}${page}`, { recursive: true });
  copyFileSync(`${dist}index.html`, `${dist}${page}/index.html`);
}
// Any other address under the app's folder falls back to the guest page.
copyFileSync(`${dist}index.html`, `${dist}404.html`);
console.log("Pages routes written: /, /screen/, /host/, 404");
