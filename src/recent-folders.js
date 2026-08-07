// Pure list logic for the "recent folders" dropdown. Storage and rendering live
// in main.js; everything here works on plain arrays so it can be tested directly.

export const RECENTS_CAP = 15;

const normalize = (p) =>
  typeof p === "string" && p.startsWith("/") ? p.replace(/(.)\/+$/, "$1") : null;

// newest first, one entry per folder, bounded — returns a NEW array
export function addRecent(list, path) {
  const p = normalize(path);
  if (!p) return [...list];
  return [p, ...list.filter((x) => x !== p)].slice(0, RECENTS_CAP);
}

// match on a path boundary so /Users/x never shortens /Users/xavier
export function shortenHome(path, home) {
  if (!home) return path;
  if (path === home) return "~";
  return path.startsWith(home + "/") ? "~" + path.slice(home.length) : path;
}

export function splitPath(path) {
  const clean = path.replace(/(.)\/+$/, "$1");
  const cut = clean.lastIndexOf("/");
  return { base: clean.slice(cut + 1), parent: cut === 0 ? "/" : clean.slice(0, cut) };
}
