/** The folder the app is served from, always ending in a slash: "/" on Vercel, "/mixer/" on GitHub Pages. */
export const BASE: string = import.meta.env.BASE_URL || "/";

/** The page being asked for, without the base folder or slashes: "", "host" or "screen". */
export function route(pathname: string, base: string = BASE): string {
  const rest = pathname.startsWith(base) ? pathname.slice(base.length) : pathname;
  return rest.replace(/^\/+|\/+$/g, "").replace(/\/index\.html$|^index\.html$/, "");
}
