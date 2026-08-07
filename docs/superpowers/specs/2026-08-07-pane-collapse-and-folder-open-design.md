# Collapse-pane-to-strip + Open-terminal-from-folder

Date: 2026-08-07
Status: approved, ready for implementation plan

Two independent features for DevCLI, plus the two bug fixes that were made while
investigating them (recorded here for context only — those are already landed).

## Context

Relevant existing structure:

- A tab holds one binary split tree. Internal node: `{ dir: "row"|"col", sizeA, a, b }`.
  Leaf: `{ paneId }`. `renderNode` (`src/main.js:813`) turns the tree into DOM;
  `layoutTab` (`:822`) rebuilds a tab's DOM and calls `fitTab` on the next frame.
- `makeDivider` (`:831`) drives resizing by mutating `node.sizeA`.
- `openPaneMenu` (`:917`) is the pane right-click menu (split / move / close).
- Layout persists to `localStorage["devcli-layout"]` via `saveLayout` (`:993`) →
  `serializeNode`; it is rehydrated by `buildSaved` (`:1005`) / `restoreTab` (`:1013`).
- `createLeafPane(tabId, cwd)` already accepts a starting folder.
- There is no folder picker today. The project folder *follows* the active pane's
  shell cwd via `syncProjectDir` (`:2107`), which calls `set_project_dir` and updates
  `#cwd-label` and the statusbar.

## Feature A — Collapse a split pane to a thin strip

### Goal

In a split tab, shrink one pane to a thin labelled strip so a sibling gets the space.
The pane's shell keeps running. Click the strip to restore.

### Model

`collapsed: true` is set on a **leaf** node in the split tree.

Collapse is deliberately a leaf-level flag rather than a node-level one: a strip only
ever stands in for a single terminal, and keeping it on the leaf means the existing
tree operations (split, move, close, collapse-on-close) need no new cases.

### Rendering

`renderNode` renders a collapsed leaf as a `.pane-collapsed` wrapper containing:

1. `.pane-strip` — the visible bar
2. the pane element itself, `display: none`

The pane element stays **mounted**. Detaching it would hand xterm a zero-size node
and produce a NaN fit; `display:none` keeps the element measurable-adjacent and
matches how hidden tabs already behave.

Sizing, applied by the parent split:

- collapsed child → `flex: 0 0 26px`
- sibling → `flex: 1 1 0`
- the divider between them is inert (no drag) while either side is collapsed;
  `node.sizeA` is left untouched so the previous ratio returns on restore

Strip orientation follows the parent split's `dir`:

| parent `dir` | strip shape | label |
|---|---|---|
| `col` (stacked) | full-width bar, 26px tall | horizontal |
| `row` (side-by-side) | 26px-wide column, full height | rotated 90° |

Strip contents: a `▸` chevron plus the pane's folder basename, falling back to
`terminal`. Click anywhere on the strip restores. Right-click opens the normal
pane menu.

### Fitting and the PTY

`fitTab` skips collapsed panes. Without this it would compute 0 cols/rows and resize
the PTY to nothing, which corrupts the shell's line editing. On restore, the pane
rejoins the normal `fitTab` pass.

### Trigger

`openPaneMenu` gains `▁ Collapse pane`. It is disabled when:

- the pane is the tab's only leaf, or
- collapsing it would leave the tab with no visible pane

### Focus

Collapsing the tab's `activeLeaf` moves focus to the nearest visible leaf, so typing
never goes to a hidden terminal. Restoring a strip focuses the pane it restores.

### Persistence

`collapsed` is written by `serializeNode` and read by `buildSaved`, so a collapsed
strip survives an app restart.

## Feature B — Open a terminal from a folder, with recents

### Goal

Start a terminal already in a chosen folder, and reopen recent folders quickly.

### Entry point

The ＋ control splits into two hit zones:

- `＋` — new terminal in the current folder (unchanged behaviour)
- `▾` — opens a dropdown

Dropdown:

```
📂  Open folder…              ⌘⇧O
─────────────────────────────────
RECENT
   devcli           ~/Projects/Projects
   nutriscan-api    ~/Projects/NutriScan
─────────────────────────────────
   Clear recents
```

`⌘⇧O` opens the native folder picker directly, skipping the dropdown.

### Opening

A chosen folder creates a **new tab** (not a split) via `createTab(null, cwd)`,
threading `cwd` down to the existing `createLeafPane(tabId, cwd)`. Tab naming already
follows the folder, so the tab self-names from the basename.

### Folder picker

Uses `tauri-plugin-dialog` in directory mode. This is a new dependency and needs:

- `tauri-plugin-dialog` in `src-tauri/Cargo.toml` + registration in the builder
- `@tauri-apps/plugin-dialog` in `package.json`
- a `dialog:allow-open` entry in the capability file

### Recents

Recorded in `syncProjectDir`, which already resolves the active pane's cwd — so any
folder a terminal sits in is captured, including ones reached by a plain `cd`.

- stored in `localStorage["devcli-recent-folders"]` as an array of absolute paths
- deduplicated, most-recent-first, capped at 15
- rendered as basename + `~`-shortened parent path
- entries whose path no longer exists are filtered out at render time (not eagerly
  pruned, so a temporarily-unmounted volume does not lose its history)
- `Clear recents` empties the list

## Out of scope

- Collapsing a whole split subtree (only single leaves collapse)
- Reordering or pinning recent folders
- Opening a folder into a split rather than a new tab
- Any change to how the project folder follows the active pane

## Testing

Manual, in the running app:

**A.** Split a tab both ways → collapse each side → confirm the strip shows the right
label and orientation, the sibling takes the space, and the shell keeps producing
output while collapsed. Restore → confirm the pre-collapse ratio returns and the
terminal reflows without a stale/garbled buffer. Quit and reopen → collapsed state
persists. Confirm the menu item is disabled on a single-pane tab.

**B.** Open a folder via picker and via a recent entry → new tab starts in that folder
and self-names. `cd` somewhere in a terminal → that folder appears in recents.
Delete a recorded folder on disk → it disappears from the list. `Clear recents`
empties it. `⌘⇧O` opens the picker.

## Already landed (context)

Two bugs fixed during investigation:

- **Tab reorder right→left did nothing** (`src/main.js:409,418`). `finish()` stripped
  the `drop-before` class before it was read, so the drop side was always `false` →
  every drop meant "insert after target", which for a leftward drop resolves to the
  tab's existing slot. The side is now captured before `finish()`.
- **`claude failed: command not found`** (`src-tauri/src/main.rs`). `run_claude` used
  `$SHELL -lc`; a login non-interactive zsh sources `~/.zprofile` only, but `claude`
  is on PATH from `~/.zshrc` (interactive-only), and a GUI-launched app starts from
  launchd's bare PATH. Terminal panes were unaffected because their PTY shell is
  interactive. A new cached `claude_bin()` resolves the absolute path (known install
  dirs, then `$SHELL -lic 'command -v claude'`) and execs it directly.
