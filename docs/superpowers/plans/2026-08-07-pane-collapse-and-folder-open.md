# Pane Collapse-to-Strip + Open-Terminal-From-Folder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a split pane collapse to a thin labelled strip that restores on click, and let the ＋ control open a terminal in a chosen folder with a list of recent folders.

**Architecture:** Collapse is a `collapsed: true` flag on a *leaf* of the existing binary split tree; `renderNode` wraps a collapsed leaf in a strip while keeping the pane element mounted but `display:none`, so xterm is never handed a zero-size node. Folder-open adds `tauri-plugin-dialog` for a native directory picker and a small localStorage-backed recents list fed by the existing `syncProjectDir` cwd detection. Both features extract their pure logic into small new modules so it can be unit-tested away from the DOM.

**Tech Stack:** Vanilla JS + Vite frontend (`src/main.js`), Tauri 2 / Rust backend (`src-tauri/src/main.rs`), xterm.js terminals, portable-pty. Vitest is introduced by Task 1 as the first test framework in this repo.

## Global Constraints

- Split tree node shapes are fixed: internal `{ dir: "row"|"col", sizeA, a, b }`, leaf `{ paneId }`. `isLeaf` is `(n) => n && n.paneId != null` (`src/main.js:170`) — never add a `paneId` to an internal node.
- The saved-layout leaf shape is `{ cwd, claude }` (no `paneId`); `buildSaved` distinguishes internal from leaf by `node.dir` (`src/main.js:1006`). Keep that discriminator.
- Collapsed strip thickness is exactly `26px`.
- Recents cap is exactly 15 entries, deduplicated, most-recent-first.
- localStorage keys: layout stays `devcli-layout`; recents is `devcli-recent-folders`.
- Never resize a PTY to 0 rows/cols — `fitTab` must skip collapsed panes.
- The pane object is `{ id, term, fit, search, draft, el, tabId, kittyKbd }` (`src/main.js:553`). It has **no** `cwd` — this plan adds `pane.cwd` as a write-through cache (Task 4 and Task 8 populate it); a pane's real folder is only knowable via the async `invoke("pty_cwd", { id })`.
- After Task 2, tree primitives live only in `src/split-tree.js`. `main.js` must not redefine `isLeaf` or `leafIds`.
- Existing code style: 2-space indent, double quotes, no semicolon-free lines, comments explain *why*. Match it.
- The app has no test framework before Task 1. Do not add any framework other than `vitest`.

---

## File Structure

**Created:**
- `src/split-tree.js` — pure split-tree queries and transforms (collapse flag, visibility, focus target). No DOM, no imports from `main.js`.
- `src/recent-folders.js` — pure recents list logic (add, cap, dedupe, clear). No DOM, no storage calls.
- `src/split-tree.test.js`, `src/recent-folders.test.js` — vitest unit tests.

**Modified:**
- `src/main.js` — rendering, fitting, focus, menu, persistence, ＋ dropdown wiring.
- `src/styles/theme.css` — strip and dropdown styling.
- `src-tauri/src/main.rs` — dialog plugin registration.
- `src-tauri/Cargo.toml`, `package.json`, `src-tauri/capabilities/default.json` — dialog dependency + permission.

`main.js` is already ~2260 lines. This plan does not restructure it, but every piece of logic that can be pure is moved out into the two new modules rather than added inline — that is what makes the tasks testable.

---

# Phase 1 — Collapse pane to strip

### Task 1: Test harness + pure split-tree collapse logic

**Files:**
- Modify: `package.json` (devDependency + script)
- Create: `src/split-tree.js`
- Test: `src/split-tree.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `isLeafNode(n) -> boolean`
  - `leafIdsOf(node) -> string[]`
  - `findLeaf(node, paneId) -> leaf|null`
  - `visibleLeafIds(node) -> string[]` — leaf ids that are not collapsed
  - `canCollapse(root, paneId) -> boolean`
  - `setCollapsed(root, paneId, value) -> void` — mutates in place
  - `nextFocusAfterCollapse(root, paneId) -> string|null`

- [ ] **Step 1: Add vitest**

```bash
pnpm add -D vitest
```

Then add to `package.json` `scripts`:

```json
"test": "vitest run"
```

- [ ] **Step 2: Write the failing tests**

Create `src/split-tree.test.js`:

```js
import { describe, it, expect } from "vitest";
import {
  isLeafNode, leafIdsOf, findLeaf, visibleLeafIds,
  canCollapse, setCollapsed, nextFocusAfterCollapse,
} from "./split-tree.js";

// a row split of two leaves: [1 | 2]
const pair = () => ({ dir: "row", sizeA: 0.5, a: { paneId: "1" }, b: { paneId: "2" } });
// [1 | [2 / 3]]
const nested = () => ({
  dir: "row", sizeA: 0.5,
  a: { paneId: "1" },
  b: { dir: "col", sizeA: 0.5, a: { paneId: "2" }, b: { paneId: "3" } },
});

describe("isLeafNode", () => {
  it("is true for a leaf and false for a split", () => {
    expect(isLeafNode({ paneId: "1" })).toBe(true);
    expect(isLeafNode(pair())).toBe(false);
    expect(isLeafNode(null)).toBe(false);
  });
});

describe("leafIdsOf", () => {
  it("walks the tree left to right", () => {
    expect(leafIdsOf(nested())).toEqual(["1", "2", "3"]);
  });
});

describe("findLeaf", () => {
  it("returns the leaf node itself so callers can mutate it", () => {
    const root = nested();
    expect(findLeaf(root, "3")).toBe(root.b.b);
  });

  it("returns null for an unknown id", () => {
    expect(findLeaf(nested(), "nope")).toBe(null);
  });
});

describe("visibleLeafIds", () => {
  it("omits collapsed leaves", () => {
    const root = nested();
    root.b.a.collapsed = true;
    expect(visibleLeafIds(root)).toEqual(["1", "3"]);
  });
});

describe("canCollapse", () => {
  it("is false when the tab has a single pane", () => {
    expect(canCollapse({ paneId: "1" }, "1")).toBe(false);
  });

  it("is true when a sibling would stay visible", () => {
    expect(canCollapse(pair(), "1")).toBe(true);
  });

  it("is false when it would hide the last visible pane", () => {
    const root = pair();
    root.a.collapsed = true;
    expect(canCollapse(root, "2")).toBe(false);
  });

  it("is false for an unknown pane", () => {
    expect(canCollapse(pair(), "nope")).toBe(false);
  });
});

describe("setCollapsed", () => {
  it("sets and clears the flag on the right leaf", () => {
    const root = pair();
    setCollapsed(root, "2", true);
    expect(root.b.collapsed).toBe(true);
    setCollapsed(root, "2", false);
    expect(root.b.collapsed).toBe(false);
  });
});

describe("nextFocusAfterCollapse", () => {
  it("picks a still-visible leaf", () => {
    const root = nested();
    expect(nextFocusAfterCollapse(root, "1")).toBe("2");
  });

  it("skips leaves that are already collapsed", () => {
    const root = nested();
    root.b.a.collapsed = true;
    expect(nextFocusAfterCollapse(root, "1")).toBe("3");
  });

  it("returns null when nothing else is visible", () => {
    expect(nextFocusAfterCollapse({ paneId: "1" }, "1")).toBe(null);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test`
Expected: FAIL — `Failed to resolve import "./split-tree.js"`

- [ ] **Step 4: Write the implementation**

Create `src/split-tree.js`:

```js
// Pure queries and transforms over a tab's binary split tree.
// Internal node: { dir: "row"|"col", sizeA, a, b }.  Leaf: { paneId, collapsed? }.
// Kept DOM-free so the collapse rules can be unit-tested on plain objects.

export const isLeafNode = (n) => !!n && n.paneId != null;

export const leafIdsOf = (node) =>
  isLeafNode(node) ? [node.paneId] : node ? [...leafIdsOf(node.a), ...leafIdsOf(node.b)] : [];

// return the leaf OBJECT (not a copy) so callers can flip flags on it in place
export function findLeaf(node, paneId) {
  if (!node) return null;
  if (isLeafNode(node)) return node.paneId === paneId ? node : null;
  return findLeaf(node.a, paneId) || findLeaf(node.b, paneId);
}

export const visibleLeafIds = (node) =>
  isLeafNode(node)
    ? node.collapsed ? [] : [node.paneId]
    : node ? [...visibleLeafIds(node.a), ...visibleLeafIds(node.b)] : [];

// a pane may collapse only while some OTHER pane stays visible — otherwise the
// tab would show nothing but strips and there'd be no way back except the menu
export function canCollapse(root, paneId) {
  const leaf = findLeaf(root, paneId);
  if (!leaf || leaf.collapsed) return false;
  return visibleLeafIds(root).some((id) => id !== paneId);
}

export function setCollapsed(root, paneId, value) {
  const leaf = findLeaf(root, paneId);
  if (leaf) leaf.collapsed = !!value;
}

// where focus should land when `paneId` collapses: the first still-visible leaf
export function nextFocusAfterCollapse(root, paneId) {
  return visibleLeafIds(root).find((id) => id !== paneId) ?? null;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test`
Expected: PASS — 12 tests across 7 describe blocks

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/split-tree.js src/split-tree.test.js
git commit -m "test: add vitest and pure split-tree collapse logic"
```

---

### Task 2: Render a collapsed leaf as a strip

**Files:**
- Modify: `src/main.js:813-820` (`renderNode`), `src/main.js:831-858` (`makeDivider`)
- Modify: `src/styles/theme.css`

**Interfaces:**
- Consumes: `isLeafNode`, `findLeaf` from `src/split-tree.js` (Task 1)
- Produces: `.pane-collapsed` wrapper elements carrying `data-id="<paneId>"`, and a `stripLabel(paneId) -> string` helper used by Task 4's restore handler

- [ ] **Step 1: Import the tree helpers and retire the local duplicates**

`src/split-tree.js` now owns the tree primitives, so `main.js` must stop defining its
own. At the top of `src/main.js`, after the existing imports (`src/main.js:12`), add:

```js
import {
  canCollapse, isLeafNode, leafIdsOf, nextFocusAfterCollapse, setCollapsed, visibleLeafIds,
} from "./split-tree.js";
```

Then delete `isLeaf` and `leafIds` (`src/main.js:170-171`) and rewrite `tabLeafIds`:

```js
const tabLeafIds = (tab) => (tab?.root ? leafIdsOf(tab.root) : []);
```

Update the five remaining `isLeaf(` call sites to `isLeafNode(` — `src/main.js:175`,
`:182`, `:683`, `:814`, `:984`. (`:814` is inside `renderNode`, which Step 3 rewrites
wholesale; the other four are one-word edits.)

- [ ] **Step 2: Add the strip renderer**

Insert directly above `renderNode` (`src/main.js:813`):

```js
// A collapsed leaf renders as a thin strip PLUS its pane element kept mounted at
// display:none. Detaching the pane instead would leave xterm measuring a node
// outside the document and fit() would return NaN, so it stays in the tree.
function renderCollapsed(node, dir) {
  const wrap = el("div", "pane-collapsed pane-collapsed-" + dir);
  wrap.dataset.id = node.paneId;
  const strip = el("div", "pane-strip");
  strip.appendChild(el("span", "pane-strip-chevron", "▸"));
  strip.appendChild(el("span", "pane-strip-label", stripLabel(node.paneId)));
  wrap.appendChild(strip);
  const pane = panes.get(node.paneId)?.el;
  if (pane) { pane.style.display = "none"; wrap.appendChild(pane); }
  return wrap;
}
// strips are narrow, so label with the folder basename rather than the full path.
// pane.cwd is a cache written by syncProjectDir and by collapsePane (Task 4) —
// resolving it here is impossible, since pty_cwd is async and this runs mid-render.
function stripLabel(paneId) {
  const cwd = panes.get(paneId)?.cwd;
  const base = cwd ? cwd.replace(/(.)\/+$/, "$1").split("/").pop() : "";
  return base || "terminal";
}
```

- [ ] **Step 3: Teach `renderNode` about collapsed children**

Replace `renderNode` (`src/main.js:813-820`) with:

```js
function renderNode(node, parentDir) {
  if (isLeaf(node)) {
    if (node.collapsed) return renderCollapsed(node, parentDir || "col");
    const pane = panes.get(node.paneId)?.el;
    if (pane) pane.style.display = "";        // undo a previous collapse
    return pane || el("div", "term-pane");
  }
  const box = el("div", "split split-" + node.dir);
  const ca = renderNode(node.a, node.dir);
  const cb = renderNode(node.b, node.dir);
  // a collapsed side is fixed at the strip thickness; the sibling takes the rest.
  // node.sizeA is deliberately left untouched so the old ratio returns on restore.
  const aOff = isLeaf(node.a) && node.a.collapsed;
  const bOff = isLeaf(node.b) && node.b.collapsed;
  ca.style.flex = aOff ? "0 0 26px" : bOff ? "1 1 0" : node.sizeA + " 1 0";
  cb.style.flex = bOff ? "0 0 26px" : aOff ? "1 1 0" : (1 - node.sizeA) + " 1 0";
  box.append(ca, makeDivider(node, box, ca, cb, aOff || bOff), cb);
  return box;
}
```

- [ ] **Step 4: Make the divider inert next to a strip**

In `makeDivider` (`src/main.js:831`), change the signature and add an early return:

```js
function makeDivider(node, box, elA, elB, inert) {
  const d = el("div", "divider divider-" + node.dir + (inert ? " divider-inert" : ""));
  if (inert) return d;                        // nothing to drag against a fixed-width strip
  d.addEventListener("mousedown", (e) => {
```

The rest of the function body is unchanged.

- [ ] **Step 5: Style the strip**

Append to `src/styles/theme.css`:

```css
/* a collapsed pane: thin clickable strip, its terminal hidden but still mounted */
.pane-collapsed { display: flex; overflow: hidden; min-width: 0; min-height: 0; }
.pane-strip {
  display: flex; align-items: center; gap: 6px;
  background: var(--bg-panel); color: var(--text-dim);
  font-size: 11px; cursor: pointer; user-select: none;
  transition: background 120ms ease, color 120ms ease;
}
.pane-strip:hover { background: var(--bg-elev); color: var(--text); }
/* stacked split -> full-width bar, text reads normally */
.pane-collapsed-col { flex-direction: column; }
.pane-collapsed-col .pane-strip { width: 100%; height: 26px; padding: 0 10px; }
/* side-by-side split -> narrow column, text rotated a quarter turn */
.pane-collapsed-row { flex-direction: row; }
.pane-collapsed-row .pane-strip {
  width: 26px; height: 100%; flex-direction: column; padding: 10px 0;
}
.pane-collapsed-row .pane-strip-label { writing-mode: vertical-rl; }
.pane-strip-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pane-strip-chevron { flex: 0 0 auto; font-size: 9px; }
.divider-inert { pointer-events: none; opacity: .4; }
```

- [ ] **Step 6: Verify the build is clean**

Run: `npx vite build`
Expected: `✓ built` with no errors

- [ ] **Step 7: Commit**

```bash
git add src/main.js src/styles/theme.css
git commit -m "feat: render a collapsed split pane as a thin strip"
```

---

### Task 3: Skip collapsed panes when fitting, and move focus off them

**Files:**
- Modify: `src/main.js:243-250` (`fitTab`), `src/main.js:252-257` (`markActiveLeaf`)

**Interfaces:**
- Consumes: `visibleLeafIds` from `src/split-tree.js` (Task 1)
- Produces: `fitTab` and `markActiveLeaf` that ignore collapsed leaves

- [ ] **Step 1: Fit only visible leaves**

Replace `fitTab` (`src/main.js:243-250`) with:

```js
function fitTab(tab) {
  // Collapsed panes are display:none, so fit() would measure 0 and we'd resize the
  // PTY to 0x0 — that wrecks the shell's line editing. Only fit what's on screen.
  for (const id of visibleLeafIds(tab?.root)) {
    const p = panes.get(id);
    if (!p) continue;
    try { p.fit.fit(); } catch (_) {}
    invoke("pty_resize", { id: p.id, rows: p.term.rows, cols: p.term.cols });
  }
}
```

- [ ] **Step 2: Base the split outline on visible panes**

Replace `markActiveLeaf` (`src/main.js:252-257`) with:

```js
function markActiveLeaf() {
  const multi = visibleLeafIds(tabs.get(activeTab)?.root).length > 1;
  for (const [id, p] of panes) {
    p.el.classList.toggle("multi", multi && p.tabId === activeTab);
    p.el.classList.toggle("active", multi && id === activeId);
  }
}
```

- [ ] **Step 3: Verify the build is clean**

Run: `npx vite build`
Expected: `✓ built` with no errors

- [ ] **Step 4: Commit**

```bash
git add src/main.js
git commit -m "fix: never fit or resize a collapsed pane's PTY"
```

---

### Task 4: Collapse from the pane menu, restore by clicking the strip

**Files:**
- Modify: `src/main.js:917-940` (`openPaneMenu`)
- Modify: `src/main.js` — new `collapsePane` / `restorePane`, and a click handler on `#terms`

**Interfaces:**
- Consumes: `canCollapse`, `setCollapsed`, `nextFocusAfterCollapse` from `src/split-tree.js`; `layoutTab` (`src/main.js:822`); `markActiveLeaf` (`src/main.js:252`); the module-level `activeId` and `activeTab` variables. There is no `focusPane` helper — focusing a pane is `panes.get(id)?.term?.focus()`, and the outline follows from setting `activeId` then calling `markActiveLeaf()`.
- Produces: `collapsePane(paneId)` (async — it awaits `pty_cwd`), `restorePane(paneId)`

- [ ] **Step 1: Add collapse/restore**

Insert directly above `openPaneMenu` (`src/main.js:917`):

```js
// collapse a split pane to a strip; its shell keeps running behind the strip
async function collapsePane(paneId) {
  const tab = tabs.get(panes.get(paneId)?.tabId);
  if (!tab || !canCollapse(tab.root, paneId)) return;
  // syncProjectDir only ever caches cwd for the ACTIVE pane, and collapsing moves
  // focus away — so resolve this pane's folder now, while we still can, or the
  // strip would be stuck reading "terminal".
  const p = panes.get(paneId);
  const cwd = await invoke("pty_cwd", { id: paneId }).catch(() => null);
  if (p && cwd) p.cwd = cwd;
  setCollapsed(tab.root, paneId, true);
  // never leave focus on a hidden terminal — keystrokes would vanish into it
  if (tab.activeLeaf === paneId) {
    const next = nextFocusAfterCollapse(tab.root, paneId);
    if (next) { tab.activeLeaf = next; activeId = next; }
  }
  layoutTab(tab);
  markActiveLeaf();
  scheduleSave();
}
function restorePane(paneId) {
  const tab = tabs.get(panes.get(paneId)?.tabId);
  if (!tab) return;
  setCollapsed(tab.root, paneId, false);
  tab.activeLeaf = paneId;
  activeId = paneId;
  layoutTab(tab);
  markActiveLeaf();
  panes.get(paneId)?.term?.focus();
  scheduleSave();
}
```

- [ ] **Step 2: Add the menu item**

In `openPaneMenu`, immediately after the `Split down` line (`src/main.js:928`), add:

```js
  item("▁", "Collapse pane", () => collapsePane(paneId),
       !canCollapse(tabs.get(panes.get(paneId)?.tabId)?.root, paneId));
```

- [ ] **Step 3: Restore on strip click**

Add this near the other `#terms` listeners in the startup wiring (alongside `src/main.js:2210`'s `#tab-add` handler):

```js
  // strips are rebuilt on every layout, so listen on the container instead
  $("#terms").addEventListener("click", (e) => {
    const strip = e.target.closest?.(".pane-collapsed");
    if (strip) restorePane(strip.dataset.id);
  });
```

- [ ] **Step 4: Verify the build is clean**

Run: `npx vite build`
Expected: `✓ built` with no errors

- [ ] **Step 5: Manual check in the app**

Run: `pnpm tauri dev`

Verify, in order:
1. Single-pane tab → right-click → `Collapse pane` is greyed out.
2. Split right → right-click the left pane → `Collapse pane` → it becomes a 26px vertical strip with a rotated label; the right pane fills the rest.
3. Run `while true; do date; sleep 1; done` in a pane, collapse it, wait 10s, restore → the missed seconds are in the scrollback (the shell kept running).
4. Restore → the pre-collapse divider ratio is back and the terminal reflows cleanly.
5. Split down and repeat 2–4 → the strip is a full-width horizontal bar with upright text.
6. Collapse the focused pane → typing goes to the pane that stayed visible.

- [ ] **Step 6: Commit**

```bash
git add src/main.js
git commit -m "feat: collapse a pane from the menu, restore by clicking its strip"
```

---

### Task 5: Persist the collapsed state across restarts

**Files:**
- Modify: `src/main.js:983-992` (`serializeNode`), `src/main.js:1005-1012` (`buildSaved`)

**Interfaces:**
- Consumes: the saved leaf shape `{ cwd, claude }`
- Produces: saved leaf shape `{ cwd, claude, collapsed }`; restored leaves carry `collapsed`

- [ ] **Step 1: Write the collapsed flag out**

Replace the leaf return in `serializeNode` (`src/main.js:991`) with:

```js
  return { cwd: cwd || null, claude: !!claude, collapsed: !!node.collapsed };
```

- [ ] **Step 2: Read it back**

Replace the leaf branch of `buildSaved` (`src/main.js:1009-1011`) with:

```js
  const pane = createLeafPane(tabId, node && node.cwd);
  if (node && node.claude) claudePanes.push(pane.id);
  return node && node.collapsed ? { paneId: pane.id, collapsed: true } : { paneId: pane.id };
```

- [ ] **Step 3: Guard the restored focus**

In `restoreTab` (`src/main.js:1013`), replace the `activeLeaf` assignment:

```js
  // a restored tab must not focus a pane that came back collapsed
  tab.activeLeaf = visibleLeafIds(tab.root)[0] || tabLeafIds(tab)[0];
```

- [ ] **Step 4: Verify the build is clean**

Run: `npx vite build`
Expected: `✓ built` with no errors

- [ ] **Step 5: Manual check**

Run: `pnpm tauri dev`. Collapse a pane, quit the app, reopen → the pane is still a strip, and focus is on a visible pane. Restore it → it works normally.

- [ ] **Step 6: Commit**

```bash
git add src/main.js
git commit -m "feat: persist collapsed panes across restarts"
```

---

# Phase 2 — Open terminal from folder + recents

### Task 6: Add the native folder picker dependency

**Files:**
- Modify: `src-tauri/Cargo.toml`, `src-tauri/src/main.rs:806-807`, `src-tauri/capabilities/default.json`, `package.json`

**Interfaces:**
- Consumes: nothing
- Produces: `open` from `@tauri-apps/plugin-dialog`, callable from the frontend

- [ ] **Step 1: Add the Rust crate**

In `src-tauri/Cargo.toml`, under the auto-update block, add:

```toml
# native folder picker for "open terminal from folder"
tauri-plugin-dialog = "2"
```

- [ ] **Step 2: Register the plugin**

In `src-tauri/src/main.rs`, after `.plugin(tauri_plugin_process::init())` (`:807`), add:

```rust
        .plugin(tauri_plugin_dialog::init())
```

- [ ] **Step 3: Grant the permission**

In `src-tauri/capabilities/default.json`, extend `permissions` to:

```json
  "permissions": ["core:default", "core:window:allow-destroy", "updater:default", "process:default", "dialog:allow-open"]
```

- [ ] **Step 4: Add the JS binding**

```bash
pnpm add @tauri-apps/plugin-dialog
```

- [ ] **Step 5: Verify both sides compile**

Run: `cd src-tauri && cargo check`
Expected: `Finished` with only the pre-existing `SessionEvent::Unknown` dead-code warning

Run: `npx vite build`
Expected: `✓ built`

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/main.rs src-tauri/capabilities/default.json package.json pnpm-lock.yaml
git commit -m "build: add tauri-plugin-dialog for the folder picker"
```

---

### Task 7: Pure recent-folders logic

**Files:**
- Create: `src/recent-folders.js`
- Test: `src/recent-folders.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `RECENTS_CAP = 15`
  - `addRecent(list, path) -> string[]` — new array, most-recent-first, deduped, capped
  - `shortenHome(path, home) -> string` — `/Users/x/p` → `~/p`
  - `splitPath(path) -> { base, parent }`

- [ ] **Step 1: Write the failing tests**

Create `src/recent-folders.test.js`:

```js
import { describe, it, expect } from "vitest";
import { RECENTS_CAP, addRecent, shortenHome, splitPath } from "./recent-folders.js";

describe("addRecent", () => {
  it("puts the newest path first", () => {
    expect(addRecent(["/a"], "/b")).toEqual(["/b", "/a"]);
  });

  it("moves an existing path to the front instead of duplicating it", () => {
    expect(addRecent(["/a", "/b", "/c"], "/c")).toEqual(["/c", "/a", "/b"]);
  });

  it("caps the list", () => {
    const many = Array.from({ length: RECENTS_CAP }, (_, i) => `/p${i}`);
    const out = addRecent(many, "/new");
    expect(out).toHaveLength(RECENTS_CAP);
    expect(out[0]).toBe("/new");
    expect(out).not.toContain(`/p${RECENTS_CAP - 1}`);
  });

  it("ignores empty or non-absolute paths", () => {
    expect(addRecent(["/a"], "")).toEqual(["/a"]);
    expect(addRecent(["/a"], "relative/dir")).toEqual(["/a"]);
    expect(addRecent(["/a"], null)).toEqual(["/a"]);
  });

  it("strips a trailing slash so /a and /a/ are one entry", () => {
    expect(addRecent(["/a"], "/a/")).toEqual(["/a"]);
  });

  it("does not mutate the input", () => {
    const list = ["/a"];
    addRecent(list, "/b");
    expect(list).toEqual(["/a"]);
  });
});

describe("shortenHome", () => {
  it("replaces the home prefix with ~", () => {
    expect(shortenHome("/Users/x/Projects", "/Users/x")).toBe("~/Projects");
  });

  it("leaves unrelated paths alone", () => {
    expect(shortenHome("/opt/tools", "/Users/x")).toBe("/opt/tools");
  });

  it("does not match a partial folder name", () => {
    expect(shortenHome("/Users/xavier/p", "/Users/x")).toBe("/Users/xavier/p");
  });
});

describe("splitPath", () => {
  it("separates the basename from its parent", () => {
    expect(splitPath("/Users/x/Projects/devcli")).toEqual({
      base: "devcli", parent: "/Users/x/Projects",
    });
  });

  it("handles a root-level folder", () => {
    expect(splitPath("/opt")).toEqual({ base: "opt", parent: "/" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test`
Expected: FAIL — `Failed to resolve import "./recent-folders.js"`

- [ ] **Step 3: Write the implementation**

Create `src/recent-folders.js`:

```js
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test`
Expected: PASS — all `split-tree` and `recent-folders` tests green

- [ ] **Step 5: Commit**

```bash
git add src/recent-folders.js src/recent-folders.test.js
git commit -m "test: add pure recent-folders list logic"
```

---

### Task 8: Record folders as terminals visit them

**Files:**
- Modify: `src/main.js:2107-2136` (`syncProjectDir`)
- Modify: `src/main.js` — new recents storage helpers

**Interfaces:**
- Consumes: `addRecent` from `src/recent-folders.js` (Task 7)
- Produces: `loadRecents() -> string[]`, `rememberFolder(path)`, `clearRecents()`

- [ ] **Step 1: Add the storage helpers**

Insert above `syncProjectDir` (`src/main.js:2107`):

```js
// ---------- recent folders ----------
const RECENTS_KEY = "devcli-recent-folders";
function loadRecents() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENTS_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((p) => typeof p === "string") : [];
  } catch (_) { return []; }
}
function rememberFolder(path) {
  const next = addRecent(loadRecents(), path);
  try { localStorage.setItem(RECENTS_KEY, JSON.stringify(next)); } catch (_) {}
}
function clearRecents() {
  try { localStorage.removeItem(RECENTS_KEY); } catch (_) {}
}
```

- [ ] **Step 2: Import `addRecent`**

Extend the Task 2 import block at the top of `src/main.js`:

```js
import { addRecent, shortenHome, splitPath } from "./recent-folders.js";
```

- [ ] **Step 3: Record on every folder change, and cache cwd on the pane**

In `syncProjectDir`, immediately after the `set_project_dir` invoke (`src/main.js:2130`), add:

```js
    rememberFolder(cwd);   // any folder a terminal sits in becomes a recent
```

Separately, right after `syncProjectDir` resolves `cwd` (`src/main.js:2117`, the
`if (!cwd) return;` line), cache it on the pane so the collapse strip in Task 2 has a
label to read:

```js
  const activePane = panes.get(activeId);
  if (activePane) activePane.cwd = cwd;
```

- [ ] **Step 4: Verify the build is clean**

Run: `npx vite build`
Expected: `✓ built`

- [ ] **Step 5: Commit**

```bash
git add src/main.js
git commit -m "feat: record every folder a terminal visits as a recent"
```

---

### Task 9: ＋ dropdown — open a folder, or pick a recent

**Files:**
- Modify: `index.html:13` (the ＋ button)
- Modify: `src/main.js:967-974` (`createTab`), `src/main.js:2210` (＋ wiring)
- Modify: `src/styles/theme.css`

**Interfaces:**
- Consumes: `loadRecents`, `clearRecents` (Task 8); `shortenHome`, `splitPath` (Task 7); `open` from `@tauri-apps/plugin-dialog` (Task 6)
- Produces: `openFolderInNewTab(path)`, `openTabMenuFromAdd()`

- [ ] **Step 1: Let `createTab` take a folder**

Replace `createTab` (`src/main.js:967-974`) with:

```js
function createTab(name, cwd) {
  const tab = createTabShell(name);
  const pane = createLeafPane(tab.id, cwd);
  tab.root = { paneId: pane.id };
  tab.activeLeaf = pane.id;
  layoutTab(tab);
  return tab;
}
```

- [ ] **Step 2: Import the dialog and home dir**

Add to the imports at the top of `src/main.js`:

```js
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { homeDir } from "@tauri-apps/api/path";
```

- [ ] **Step 3: Add the open + dropdown logic**

Insert above the `renderTermTabs` definition (`src/main.js:278`):

```js
// open a folder in a NEW tab (not a split) — the tab self-names from the folder
async function openFolderInNewTab(path) {
  if (!path) return;
  rememberFolder(path);
  const tab = createTab(null, path);
  activeTab = tab.id;
  showActive();
  scheduleSave();
}
async function pickFolder() {
  const picked = await openDialog({ directory: true, multiple: false }).catch(() => null);
  if (typeof picked === "string") await openFolderInNewTab(picked);
}
// ▾ next to ＋: open-folder plus the recent list
async function openAddMenu(x, y) {
  const menu = $("#ctx");
  menu.innerHTML = "";
  const item = (glyph, label, fn, hint) => {
    const r = el("div", "ctx-item");
    r.appendChild(el("span", "ctx-glyph", glyph || ""));
    r.appendChild(el("span", null, label));
    if (hint) r.appendChild(el("span", "ctx-hint", hint));
    r.addEventListener("click", () => { closeMenu(); fn(); });
    menu.appendChild(r);
  };
  item("📂", "Open folder…", pickFolder, "⌘⇧O");
  const home = await homeDir().catch(() => "");
  // a folder can be deleted or unmounted after we recorded it — filter at render
  // time rather than pruning the store, so a temporary absence isn't permanent
  const recents = [];
  for (const p of loadRecents()) {
    if (await invoke("path_is_dir", { path: p }).catch(() => false)) recents.push(p);
  }
  if (recents.length) {
    menu.appendChild(el("div", "ctx-sep"));
    menu.appendChild(el("div", "ctx-head", "RECENT"));
    for (const p of recents) {
      const { base, parent } = splitPath(p);
      item("", base, () => openFolderInNewTab(p), shortenHome(parent, home.replace(/\/+$/, "")));
    }
    menu.appendChild(el("div", "ctx-sep"));
    item("", "Clear recents", clearRecents);
  }
  menu.classList.remove("hidden");
  const mw = 260, mh = menu.offsetHeight || 160;
  menu.style.left = Math.min(x, window.innerWidth - mw - 8) + "px";
  menu.style.top = Math.min(y, window.innerHeight - mh - 8) + "px";
}
```

- [ ] **Step 4: Add the `path_is_dir` command**

In `src-tauri/src/main.rs`, next to `set_project_dir` (`:353`), add:

```rust
/// Cheap existence check so the recents menu can hide folders that went away.
#[tauri::command]
fn path_is_dir(path: String) -> bool {
    std::path::Path::new(&path).is_dir()
}
```

Then add `path_is_dir` to the `tauri::generate_handler![...]` list.

- [ ] **Step 5: Split the ＋ control into two hit zones**

Replace `index.html:13` with:

```html
        <button class="tab-add" id="tab-add" title="New terminal (⌘T)">＋</button>
        <button class="tab-add tab-add-menu" id="tab-add-menu" title="Open folder / recent (⌘⇧O)">▾</button>
```

In `renderTermTabs` (`src/main.js:283`), grab and re-append the second button alongside the first:

```js
  const addBtn = $("#tab-add");
  const addMenuBtn = $("#tab-add-menu");
```

and after `if (addBtn) bar.appendChild(addBtn);` (`src/main.js:313`):

```js
  if (addMenuBtn) bar.appendChild(addMenuBtn);
```

In `sizeTabs` (`src/main.js:332`), widen the reserved space:

```js
  const addW = ($("#tab-add")?.offsetWidth || 30) + ($("#tab-add-menu")?.offsetWidth || 18);
```

- [ ] **Step 6: Wire the button and the shortcut**

Next to the existing ＋ handler (`src/main.js:2210`):

```js
  $("#tab-add-menu").addEventListener("click", (e) => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    openAddMenu(r.left, r.bottom + 4);
  });
```

In the global shortcut handler (`src/main.js:2218`), which has already destructured
`mod` and `k`, add a branch in the existing `else if` chain — put it next to the `k === "t"`
branch so the two tab-opening shortcuts sit together:

```js
    else if (k === "o" && e.shiftKey) { e.preventDefault(); pickFolder(); }
```

Note the house pattern: this chain runs only when `mod` is set, tests a lowercased `k`,
and does not `return` — match it rather than adding a standalone `if`.

- [ ] **Step 7: Style the menu additions**

Append to `src/styles/theme.css`:

```css
.tab-add-menu { font-size: 9px; padding: 0 4px; opacity: .7; }
.tab-add-menu:hover { opacity: 1; }
.ctx-head { padding: 4px 10px 2px; font-size: 9px; letter-spacing: .08em; color: var(--text-dim); }
.ctx-hint { margin-left: auto; padding-left: 14px; font-size: 10px; color: var(--text-dim); }
.ctx-item { display: flex; align-items: center; }
```

- [ ] **Step 8: Verify both sides build**

Run: `cd src-tauri && cargo check`
Expected: `Finished`, only the pre-existing dead-code warning

Run: `pnpm test && npx vite build`
Expected: all tests PASS, `✓ built`

- [ ] **Step 9: Manual check in the app**

Run: `pnpm tauri dev`

Verify, in order:
1. ＋ still opens a plain new terminal.
2. ▾ opens the dropdown with `Open folder…` and `⌘⇧O` shown.
3. `Open folder…` → pick a folder → a new tab opens already in it, self-named from the basename.
4. `cd` to a different folder in a terminal → reopen ▾ → that folder is listed, newest first.
5. Click a recent → new tab opens there.
6. `mv` a recorded folder away → reopen ▾ → it is gone from the list.
7. `Clear recents` → only `Open folder…` remains.
8. `⌘⇧O` opens the picker directly.

- [ ] **Step 10: Commit**

```bash
git add index.html src/main.js src/styles/theme.css src-tauri/src/main.rs
git commit -m "feat: open a terminal from a folder, with a recent-folders menu"
```

---

## Self-Review Notes

Spec coverage checked section by section:

| Spec requirement | Task |
|---|---|
| `collapsed` on a leaf | 1, 5 |
| strip + pane kept mounted at `display:none` | 2 |
| `flex: 0 0 26px`, sibling `1 1 0`, `sizeA` preserved | 2 |
| inert divider next to a strip | 2 |
| `col` horizontal bar / `row` rotated column | 2 |
| chevron + folder basename, fallback `terminal` | 2 |
| click restores, right-click opens pane menu | 4 (the existing `contextmenu` handler is on the pane, which stays mounted inside the wrapper) |
| `fitTab` skips collapsed, no 0x0 PTY resize | 3 |
| focus leaves a collapsing pane | 4, 5 |
| menu item + both disable guards | 4 |
| persistence across restart | 5 |
| ＋ / ▾ two hit zones | 9 |
| dropdown layout incl. `⌘⇧O` hint | 9 |
| new tab (not split), auto-named | 9 |
| `tauri-plugin-dialog` + capability | 6 |
| recents from `syncProjectDir` | 8 |
| dedupe, newest-first, cap 15 | 7 |
| basename + `~`-shortened parent | 7, 9 |
| missing folders filtered at render | 9 |
| `Clear recents` | 8, 9 |

**Known deviation to confirm during Task 9:** the spec describes one ＋ control with two zones; the plan implements that as two adjacent buttons, which is simpler than hit-testing halves of one button and reads the same. Flag it if the seam looks wrong in the app.
