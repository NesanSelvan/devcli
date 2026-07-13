// DevCLI — frontend: iTerm2/Ghostty-style split-tree terminals + Claude Code panel.
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getCurrentWindow } from "@tauri-apps/api/window";
import hljs from "highlight.js/lib/common";

// ---------- DOM helpers ----------
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const hhmm = (ts) => {
  if (!ts) return "";
  const d = new Date(ts);
  return isNaN(d) ? "" : d.toTimeString().slice(0, 5);
};
// decode a base64 pty-data payload into raw bytes for term.write (xterm decodes
// the UTF-8 itself, so binary/multibyte output survives chunk boundaries)
function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
// Copy the selection as a visual grid: one line per on-screen row with a real
// newline between them. xterm's getSelection() joins rows it thinks are "wrapped"
// (any row that fills the last column — which box-drawing tables always do),
// collapsing the columns into interleaved garbage. Reading the buffer row-by-row
// keeps the table aligned when pasted.
function selectionGrid(term) {
  const r = term.getSelectionPosition?.();
  if (!r) { const s = term.getSelection(); return s && s.length ? s : ""; }
  const buf = term.buffer.active;
  const rows = [];
  for (let y = r.start.y; y <= r.end.y; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    const startX = y === r.start.y ? r.start.x : 0;
    const endX = y === r.end.y ? r.end.x : undefined; // undefined → to end of row
    rows.push(line.translateToString(true, startX, endX));
  }
  return rows.join("\n");
}
// grow a textarea to fit its content, up to a max, then scroll
function autoGrow(ta, max = 260) {
  if (!ta) return;
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, max) + "px";
}
let _statusTimer;
// sticky=true keeps it visible with a shimmer until the next status() call
function status(msg, sticky) {
  const s = $("#status");
  s.textContent = msg || "";
  s.classList.toggle("show", !!msg);
  s.classList.toggle("shimmer", !!sticky);
  clearTimeout(_statusTimer);
  if (msg && !sticky) {
    _statusTimer = setTimeout(() => { s.textContent = ""; s.classList.remove("show", "shimmer"); }, 4500);
  }
}

// ---------- theme ----------
const TERM_THEME_DARK = {
  background: "#0D1117", foreground: "#E6EDF3", cursor: "#2DD4BF", cursorAccent: "#0D1117",
  // clear, uniform selection: a solid blue with forced white text so any coloured
  // token stays readable when highlighted (was a muted blue with mixed text colours)
  selectionBackground: "#3563A9", selectionForeground: "#FFFFFF", selectionInactiveBackground: "#2A3D5A",
  black: "#161B22", brightBlack: "#8B949E", red: "#F85149",
  green: "#3FB950", yellow: "#D29922", blue: "#58A6FF", magenta: "#2DD4BF", cyan: "#39C5CF", white: "#E6EDF3",
};
// GitHub-light ANSI palette — clean, readable colored output on a white terminal
const TERM_THEME_LIGHT = {
  background: "#FFFFFF", foreground: "#24292F", cursor: "#2563EB", cursorAccent: "#FFFFFF",
  selectionBackground: "#AACDF7", selectionForeground: "#0A2540", selectionInactiveBackground: "#D6E4F7",
  black: "#24292F", brightBlack: "#6E7781",
  red: "#CF222E", brightRed: "#A40E26",
  green: "#116329", brightGreen: "#1A7F37",
  yellow: "#9A6700", brightYellow: "#7D4E00",
  blue: "#0550AE", brightBlue: "#0969DA",
  magenta: "#8250DF", brightMagenta: "#6639BA",
  cyan: "#1B7C83", brightCyan: "#3192A0",
  white: "#6E7781", brightWhite: "#24292F",
};
let currentTheme = localStorage.getItem("devcli-theme") || "light";
const termTheme = () => (currentTheme === "light" ? TERM_THEME_LIGHT : TERM_THEME_DARK);
function setTheme(name) {
  currentTheme = name;
  document.documentElement.setAttribute("data-theme", name);
  localStorage.setItem("devcli-theme", name);
  $("#btn-theme").textContent = name === "light" ? "☀" : "☾";
  for (const p of panes.values()) {
    p.term.options.theme = termTheme();
    // light bg: force a floor on fg/bg contrast so Claude's dim text (tuned for
    // dark terminals) stays readable on white; dark theme is already high-contrast
    p.term.options.minimumContrastRatio = name === "light" ? 4.5 : 1;
  }
}

// ---------- terminals: tabs of split-panes ----------
// A tab holds a binary layout tree of leaf terminals (split right / down,
// recursively). `panes` = every leaf terminal; `tabs` = the groups shown in
// the top bar. `activeId` stays the *focused leaf* so search / insert / cwd
// keep working on the pane you're actually typing in.
const MAX_TABS = 24;
const panes = new Map(); // paneId -> { id, term, fit, search, draft, el, tabId }
const tabs = new Map();  // tabId  -> { id, name, pinned, color, el, root, activeLeaf }
let activeId = "1";      // focused leaf paneId
let activeTab = "t1";
let paneSeq = 0, tabSeq = 0;
const nextPaneId = () => String(++paneSeq);
const nextTabId = () => "t" + (++tabSeq);
const TAB_COLORS = ["#2DD4BF", "#58A6FF", "#3FB950", "#D29922", "#F85149", "#A970FF", "#EC6CB9"];

// ── layout tree helpers ──────────────────────────────────────────────
// node is either a leaf { paneId } or a split { dir:'row'|'col', a, b, sizeA }
const isLeaf = (n) => n && n.paneId != null;
const leafIds = (n) => (isLeaf(n) ? [n.paneId] : [...leafIds(n.a), ...leafIds(n.b)]);
const tabLeafIds = (tab) => (tab?.root ? leafIds(tab.root) : []);
// replace the leaf carrying paneId with `repl` (used by split)
function replaceLeaf(node, paneId, repl) {
  if (isLeaf(node)) return node.paneId === paneId ? repl : node;
  node.a = replaceLeaf(node.a, paneId, repl);
  node.b = replaceLeaf(node.b, paneId, repl);
  return node;
}
// drop the leaf carrying paneId; a split with one survivor collapses to it
function removeLeaf(node, paneId) {
  if (isLeaf(node)) return node.paneId === paneId ? null : node;
  const a = removeLeaf(node.a, paneId);
  const b = removeLeaf(node.b, paneId);
  if (!a) return b;
  if (!b) return a;
  node.a = a; node.b = b;
  return node;
}

let fontSize = Math.max(8, Math.min(28, parseInt(localStorage.getItem("devcli-fontsize") || "13", 10) || 13));
function makeTerm() {
  return new Terminal({
    fontFamily: '"JetBrains Mono", ui-monospace, "SF Mono", monospace',
    fontSize, lineHeight: 1.5,
    cursorBlink: true, cursorStyle: "bar", cursorInactiveStyle: "outline", cursorWidth: 2,
    allowProposedApi: true,
    smoothScrollDuration: 0, scrollSensitivity: 3, // snap to whole rows — sub-pixel smooth scroll jags box-drawing lines (│) in tables
    scrollback: 100000, // keep the whole session scrollable (default was 1000)
    minimumContrastRatio: currentTheme === "light" ? 4.5 : 1, // keep dim text readable on white
    theme: termTheme(),
  });
}
// live font zoom — ⌘+ / ⌘- / ⌘0. Applies to every pane, then refits.
function setFontSize(n) {
  fontSize = Math.max(8, Math.min(28, n));
  localStorage.setItem("devcli-fontsize", String(fontSize));
  for (const p of panes.values()) p.term.options.fontSize = fontSize;
  refitAll();
  status(`Font size ${fontSize}px`);
}
function trackDraft(pane, data) {
  for (const ch of data) {
    const code = ch.charCodeAt(0);
    if (ch === "\r" || ch === "\n") pane.draft = "";
    else if (code === 127 || code === 8) pane.draft = pane.draft.slice(0, -1);
    else if (code === 21 || code === 3) pane.draft = "";
    else if (code === 23) pane.draft = pane.draft.replace(/\s*\S+\s*$/, "");
    else if (code >= 32 && code !== 127) pane.draft += ch;
  }
}
// pinned tabs first, then insertion order
function orderedTabs() {
  return [...tabs.values()].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
}
// show only the active tab's split-tree; hide the rest, then fit its leaves.
function showActive() {
  for (const [id, t] of tabs) t.el.style.display = id === activeTab ? "" : "none";
  const tab = tabs.get(activeTab);
  if (tab) {
    // keep the focused leaf valid after closes / tab switches
    const leaves = tabLeafIds(tab);
    if (!leaves.includes(activeId)) tab.activeLeaf = leaves[0];
    activeId = tab.activeLeaf;
    fitTab(tab);
    markActiveLeaf();
    panes.get(activeId)?.term.focus();
  }
  document.querySelectorAll(".term-tab").forEach((t) => t.classList.toggle("active", t.dataset.id === activeTab));
  if (typeof syncProjectDir === "function") syncProjectDir(); // instant folder sync on tab switch
}
// fit + resize every leaf terminal of a tab (call after layout / resize)
function fitTab(tab) {
  for (const id of tabLeafIds(tab)) {
    const p = panes.get(id);
    if (!p) continue;
    try { p.fit.fit(); } catch (_) {}
    invoke("pty_resize", { id: p.id, rows: p.term.rows, cols: p.term.cols });
  }
}
// outline the focused leaf when a tab is split into more than one pane
function markActiveLeaf() {
  const multi = tabLeafIds(tabs.get(activeTab)).length > 1;
  for (const [id, p] of panes) {
    p.el.classList.toggle("multi", multi && p.tabId === activeTab);
    p.el.classList.toggle("active", multi && id === activeId);
  }
}

// reorder the tabs Map so `draggedId` lands before/after `targetId`
function reorderTabs(draggedId, targetId, before) {
  if (draggedId === targetId) return;
  const ids = [...tabs.keys()];
  const from = ids.indexOf(draggedId);
  if (from < 0) return;
  ids.splice(from, 1);
  let to = ids.indexOf(targetId);
  if (to < 0) return;
  if (!before) to += 1;
  ids.splice(to, 0, draggedId);
  const entries = ids.map((id) => [id, tabs.get(id)]);
  tabs.clear();
  for (const [id, t] of entries) tabs.set(id, t);
  renderTermTabs();
  saveLayout(); // persist the new order now (not debounced) so it survives a quick quit
}
// top bar: one tab per terminal — rename, pin, color, close, drag-to-reorder
function renderTermTabs() {
  const bar = $("#term-tabs");
  if (!bar) return;
  // grab ＋ and the drag filler BEFORE clearing — they live inside the row now,
  // so innerHTML="" would destroy them (holding refs keeps the elements alive)
  const addBtn = $("#tab-add"), dragFill = $("#appbar-drag");
  bar.innerHTML = "";
  for (const p of orderedTabs()) {
    const nLeaves = tabLeafIds(p).length;
    const tab = el("div", "term-tab" + (p.id === activeTab ? " active" : "") + (p.pinned ? " pinned" : ""));
    tab.dataset.id = p.id;
    if (p.color) { tab.style.setProperty("--tab-color", p.color); tab.classList.add("colored"); }
    if (p.pinned) { const pin = el("span", "term-tab-pin", "●"); if (p.color) pin.style.color = p.color; tab.appendChild(pin); }
    else if (p.color) { const dot = el("span", "term-tab-dot"); dot.style.background = p.color; tab.appendChild(dot); }
    const name = el("span", "term-tab-name", p.name + (nLeaves > 1 ? ` ⊞${nLeaves}` : ""));
    name.addEventListener("dblclick", (e) => { e.stopPropagation(); renameTab(p, name); });
    tab.appendChild(name);
    const x = el("button", "term-tab-close", "✕");
    x.addEventListener("mousedown", (e) => { e.stopPropagation(); e.preventDefault(); closeTab(p.id); });
    x.addEventListener("click", (e) => { e.stopPropagation(); });
    tab.appendChild(x);
    tab.addEventListener("click", () => { if (!tabDragMoved) { activeTab = p.id; showActive(); } });
    tab.addEventListener("contextmenu", (e) => { e.preventDefault(); openTabMenu(e.clientX, e.clientY, p.id); });
    // pointer-based drag-to-reorder (HTML5 DnD loses to the window drag-region;
    // stopPropagation on mousedown keeps Tauri from grabbing the window instead)
    tab.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || e.target === x) return;
      e.stopPropagation();
      e.preventDefault(); // don't let the drag text-select the tab label
      startTabDrag(p.id, e);
    });
    bar.appendChild(tab);
  }
  // keep ＋ right after the last tab, then the draggable filler — both live
  // inside the tab row so the ＋ never floats off in empty space
  if (addBtn) bar.appendChild(addBtn);
  if (dragFill) bar.appendChild(dragFill);
}
let tabDragMoved = false;
// drag a tab horizontally to reorder; a blue edge marks the drop slot
function startTabDrag(id, e0) {
  const bar = $("#term-tabs");
  const startX = e0.clientX;
  tabDragMoved = false;
  const clear = () => bar.querySelectorAll(".drop-before,.drop-after").forEach((t) => t.classList.remove("drop-before", "drop-after"));
  const draggedEl = () => bar.querySelector(`.term-tab[data-id="${id}"]`);
  const onMove = (e) => {
    if (!tabDragMoved && Math.abs(e.clientX - startX) < 5) return;
    tabDragMoved = true;
    draggedEl()?.classList.add("dragging");
    clear();
    const over = [...bar.querySelectorAll(".term-tab")].find((t) => {
      const r = t.getBoundingClientRect();
      return e.clientX >= r.left && e.clientX <= r.right;
    });
    if (over && over.dataset.id !== id) {
      const r = over.getBoundingClientRect();
      over.classList.add(e.clientX < r.left + r.width / 2 ? "drop-before" : "drop-after");
    }
  };
  const onUp = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    draggedEl()?.classList.remove("dragging");
    if (tabDragMoved) {
      const target = bar.querySelector(".drop-before, .drop-after");
      if (target) reorderTabs(id, target.dataset.id, target.classList.contains("drop-before"));
      clear();
    }
    setTimeout(() => { tabDragMoved = false; }, 0); // let click read it, then reset
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}
function renameTab(pane, nameEl) {
  const inp = el("input", "term-tab-input");
  inp.value = pane.name;
  nameEl.replaceWith(inp);
  inp.focus();
  inp.select();
  const commit = () => { pane.name = inp.value.trim() || pane.name; renderTermTabs(); };
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit();
    else if (e.key === "Escape") renderTermTabs();
  });
  inp.addEventListener("blur", commit);
}

// match file paths / filenames in terminal output (e.g. dummy.txt, src/main.rs,
// ./x.js:12). Requires a "." + 2–8 char extension so prose like "e.g" is ignored.
const FILE_PATH_RE = /(?:\.{0,2}\/)?[\w@.+\-]+(?:\/[\w@.+\-]+)*\.[A-Za-z][A-Za-z0-9]{1,7}(?::\d+)?/g;
function registerFilePathLinks(term, paneId) {
  term.registerLinkProvider({
    provideLinks(y, callback) {
      const line = term.buffer.active.getLine(y - 1);
      if (!line) { callback(undefined); return; }
      const text = line.translateToString(true);
      const links = [];
      FILE_PATH_RE.lastIndex = 0;
      let m;
      while ((m = FILE_PATH_RE.exec(text)) !== null) {
        const raw = m[0];
        const before = text.slice(Math.max(0, m.index - 3), m.index);
        if (before.includes("//")) continue;              // inside a URL (web-links owns those)
        links.push({
          range: { start: { x: m.index + 1, y }, end: { x: m.index + raw.length, y } },
          text: raw,
          // resolve relative paths against THIS terminal's live cwd (not the panel dir)
          activate: (_e, t) => { const p = t.replace(/:\d+$/, ""); previewFile(p, p, paneId); },
        });
      }
      callback(links.length ? links : undefined);
    },
  });
}

// one leaf terminal (xterm + PTY) living inside a tab's split-tree
function createLeafPane(tabId, cwd) {
  const id = nextPaneId();
  const wrap = el("div", "term-pane");
  wrap.dataset.id = id;
  tabs.get(tabId).el.appendChild(wrap); // mount in DOM so xterm can size itself

  const term = makeTerm();
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  // URLs in the terminal become clickable — open in the default browser
  term.loadAddon(new WebLinksAddon((_e, uri) => invoke("open_external", { url: uri })));
  registerFilePathLinks(term, id); // file paths → preview, resolved against this pane's cwd
  term.open(wrap);
  // GPU-accelerated rendering; fall back to canvas if WebGL is unavailable
  try {
    const gl = new WebglAddon();
    gl.onContextLoss(() => gl.dispose());
    term.loadAddon(gl);
  } catch (_) { /* canvas fallback */ }
  fit.fit();

  // Force a full repaint on every scroll. WKWebView's WebGL renderer only
  // repaints the rows it thinks changed when the viewport scrolls, so the rest
  // keep stale glyph fragments — box-drawing borders (│) break into segments and
  // ghost characters bleed between rows. A fresh render is always clean, so
  // marking every visible row dirty on scroll reproduces that clean frame.
  term.onScroll(() => term.refresh(0, term.rows - 1));

  // At a plain shell prompt (normal buffer) scroll the local scrollback and
  // swallow the wheel — otherwise a TUI that left mouse-tracking on makes the
  // trackpad leak raw SGR mouse codes (<65;..M) into the shell as garbage.
  wrap.addEventListener("wheel", (e) => {
    if (term.buffer.active.type !== "normal") return; // in an app's alt-screen: let it handle scroll
    const lines = e.deltaMode === 1 ? e.deltaY : e.deltaY / 24;
    term.scrollLines(Math.trunc(lines) || Math.sign(e.deltaY));
    e.preventDefault();
    e.stopImmediatePropagation();
  }, { capture: true, passive: false });

  const pane = { id, term, fit, search, draft: "", el: wrap, tabId };
  panes.set(id, pane);

  // copy-on-select — highlighting text puts it on the clipboard (iTerm/Warp behaviour)
  term.onSelectionChange(() => {
    const sel = selectionGrid(term);
    if (sel) navigator.clipboard?.writeText(sel).catch(() => {});
  });

  term.onData((data) => {
    invoke("pty_write", { id, data });
    trackDraft(pane, data);
  });
  const focusThis = () => {
    if (activeTab !== pane.tabId) { activeTab = pane.tabId; showActive(); return; }
    activeId = id;
    tabs.get(pane.tabId).activeLeaf = id;
    markActiveLeaf();
    if (typeof syncProjectDir === "function") syncProjectDir();
  };
  wrap.addEventListener("mousedown", focusThis);
  if (term.textarea) term.textarea.addEventListener("focus", focusThis);
  wrap.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); openPaneMenu(e.clientX, e.clientY, id); });

  // drag grip (shown when a tab is split) — pointer-drag it onto another pane to swap positions.
  // pointer events (not HTML5 DnD) so it works reliably over the xterm canvas.
  const grip = el("div", "pane-grip", "⠿ drag");
  grip.title = "drag onto another pane to swap positions";
  grip.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); startPaneDrag(id, wrap, e); });
  wrap.appendChild(grip);

  // one-click close ✕ on split panes (shown only when the tab is split, like the grip).
  // Act on mousedown, not click — WKWebView sometimes drops the first click here.
  const closeBtn = el("button", "pane-close", "✕");
  closeBtn.title = "Close pane (⌘W)";
  closeBtn.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); closeLeaf(id); });
  closeBtn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); });
  wrap.appendChild(closeBtn);

  // refit when the pane actually gets a new size — covers window minimize→restore,
  // maximize, and split-resize, which don't always emit a usable 'resize' event.
  const ro = new ResizeObserver(() => {
    if (!wrap.clientWidth || !wrap.clientHeight) return;
    try { fit.fit(); invoke("pty_resize", { id, rows: term.rows, cols: term.cols }); } catch (_) {}
  });
  ro.observe(wrap);
  pane.ro = ro;

  invoke("pty_spawn", { id, rows: term.rows, cols: term.cols, cwd: cwd || null });
  return pane;
}

// pointer-driven pane drag: a ghost follows the cursor, target pane highlights, swap on release
function startPaneDrag(srcId, srcWrap, e0) {
  const src = panes.get(srcId);
  if (!src || tabLeafIds(tabs.get(src.tabId)).length < 2) return;
  srcWrap.classList.add("drag-src");
  document.body.classList.add("pane-dragging");

  // a floating snapshot-ish ghost so the terminal visibly moves with the cursor
  const rect = srcWrap.getBoundingClientRect();
  const ghost = el("div", "pane-drag-ghost", "⠿ " + (tabs.get(src.tabId)?.name || "terminal"));
  ghost.style.width = Math.min(rect.width, 280) + "px";
  ghost.style.height = Math.min(rect.height, 170) + "px";
  document.body.appendChild(ghost);
  const moveGhost = (x, y) => { ghost.style.left = x + "px"; ghost.style.top = y + "px"; };
  moveGhost(e0.clientX, e0.clientY);

  const paneUnder = (x, y) => { ghost.style.display = "none"; const p = document.elementFromPoint(x, y)?.closest(".term-pane"); ghost.style.display = ""; return p; };
  const clearOver = () => document.querySelectorAll(".term-pane.drag-over").forEach((n) => n.classList.remove("drag-over"));
  const validTarget = (p) => p && p.dataset.id !== srcId && panes.get(p.dataset.id)?.tabId === src.tabId;
  const onMove = (e) => {
    moveGhost(e.clientX, e.clientY);
    clearOver();
    const p = paneUnder(e.clientX, e.clientY);
    if (validTarget(p)) p.classList.add("drag-over");
  };
  const onUp = (e) => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    document.body.classList.remove("pane-dragging");
    srcWrap.classList.remove("drag-src");
    clearOver();
    const p = paneUnder(e.clientX, e.clientY);
    ghost.remove();
    if (validTarget(p)) swapLeaves(srcId, p.dataset.id);
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

// drag one pane onto another (same tab) to swap their slots in the layout
function swapInTree(node, idA, idB) {
  if (isLeaf(node)) {
    if (node.paneId === idA) node.paneId = idB;
    else if (node.paneId === idB) node.paneId = idA;
    return;
  }
  swapInTree(node.a, idA, idB);
  swapInTree(node.b, idA, idB);
}
function swapLeaves(idA, idB) {
  if (!idA || idA === idB) return;
  const pa = panes.get(idA), pb = panes.get(idB);
  if (!pa || !pb || pa.tabId !== pb.tabId) return; // swap only within the same tab
  const tab = tabs.get(pa.tabId);
  swapInTree(tab.root, idA, idB);
  layoutTab(tab);
  markActiveLeaf();
  status("panes swapped");
}

// ── split-tree rendering ─────────────────────────────────────────────
function renderNode(node) {
  if (isLeaf(node)) return panes.get(node.paneId)?.el || el("div", "term-pane");
  const box = el("div", "split split-" + node.dir);
  const ca = renderNode(node.a); ca.style.flex = node.sizeA + " 1 0";
  const cb = renderNode(node.b); cb.style.flex = (1 - node.sizeA) + " 1 0";
  box.append(ca, makeDivider(node, box, ca, cb), cb);
  return box;
}
// rebuild a tab's DOM from its tree (pane wraps are moved, not recreated)
function layoutTab(tab) {
  for (const id of tabLeafIds(tab)) { const p = panes.get(id); p?.el.parentNode?.removeChild(p.el); }
  tab.el.innerHTML = "";
  const rootEl = renderNode(tab.root);
  rootEl.style.flex = "1 1 0";
  tab.el.appendChild(rootEl);
  requestAnimationFrame(() => fitTab(tab));
}
// draggable splitter between the two children of a split
function makeDivider(node, box, elA, elB) {
  const d = el("div", "divider divider-" + node.dir);
  d.addEventListener("mousedown", (e) => {
    e.preventDefault(); e.stopPropagation();
    const horiz = node.dir === "row";
    const rect = box.getBoundingClientRect();
    const total = horiz ? rect.width : rect.height;
    const start = horiz ? e.clientX : e.clientY;
    const startA = node.sizeA;
    const onMove = (ev) => {
      const pos = horiz ? ev.clientX : ev.clientY;
      const a = Math.max(0.08, Math.min(0.92, startA + (pos - start) / (total || 1)));
      node.sizeA = a;
      elA.style.flex = a + " 1 0";
      elB.style.flex = (1 - a) + " 1 0";
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      fitTab(tabs.get(activeTab));
    };
    document.body.style.cursor = horiz ? "col-resize" : "row-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
  return d;
}

// split the focused leaf: dir 'row' = side-by-side (right), 'col' = stacked (down)
function splitLeaf(paneId, dir) {
  const pane = panes.get(paneId);
  if (!pane) return;
  const tab = tabs.get(pane.tabId);
  if (!tab) return;
  if (tabLeafIds(tab).length >= 12) return status("max splits in this tab");
  const np = createLeafPane(tab.id);
  tab.root = replaceLeaf(tab.root, paneId, { dir, a: { paneId }, b: { paneId: np.id }, sizeA: 0.5 });
  tab.activeLeaf = np.id;
  activeId = np.id;
  layoutTab(tab);
  markActiveLeaf();
  renderTermTabs(); // update the ⊞ leaf-count badge
  np.term.focus();
  scheduleSave();
}
// warn before killing a running Claude session or command; returns false to abort
async function confirmCloseIfBusy(paneIds, what) {
  let claude = false, task = false;
  await Promise.all(paneIds.map(async (id) => {
    if (await invoke("pty_has_claude", { id }).catch(() => false)) claude = true;
    else if (await invoke("pty_busy", { id }).catch(() => false)) task = true;
  }));
  if (!claude && !task) return true;
  const detail = claude
    ? "A Claude session is running here — closing will end it."
    : "A command is still running here — closing will stop it.";
  return confirmDialog(`Close ${what}?`, detail, "Close");
}

// close one leaf; the last leaf of a tab closes the whole tab
async function closeLeaf(paneId) {
  const pane = panes.get(paneId);
  if (!pane) return;
  const tab = tabs.get(pane.tabId);
  if (tabLeafIds(tab).length <= 1) { closeTab(tab.id); return; }
  if (!(await confirmCloseIfBusy([paneId], "this pane"))) return;
  if (!panes.get(paneId)) return; // bailed out / already gone while confirming
  invoke("pty_close", { id: paneId });
  // guard teardown — a throw here (WebGL dispose can, in WKWebView) must NOT
  // abort the collapse below, else the pane's shell dies but the split stays
  try { pane.ro?.disconnect(); } catch (_) {}
  try { pane.term.dispose(); } catch (_) {}
  pane.el.remove();
  panes.delete(paneId);
  tab.root = removeLeaf(tab.root, paneId);
  if (tab.activeLeaf === paneId) tab.activeLeaf = tabLeafIds(tab)[0];
  activeId = tab.activeLeaf;
  layoutTab(tab);
  markActiveLeaf();
  renderTermTabs();
  panes.get(activeId)?.term.focus();
  scheduleSave();
}

// right-click a terminal pane → split / close
function openPaneMenu(x, y, paneId) {
  const menu = $("#ctx");
  menu.innerHTML = "";
  const item = (glyph, label, fn, disabled) => {
    const r = el("div", "ctx-item" + (disabled ? " disabled" : ""));
    r.appendChild(el("span", "ctx-glyph", glyph || ""));
    r.appendChild(el("span", null, label));
    if (!disabled) r.addEventListener("click", () => { closeMenu(); fn(); });
    menu.appendChild(r);
  };
  item("▐", "Split right", () => splitLeaf(paneId, "row"));
  item("▄", "Split down", () => splitLeaf(paneId, "col"));
  menu.appendChild(el("div", "ctx-sep"));
  item("✕", "Close pane", () => closeLeaf(paneId), panes.size <= 1);
  menu.classList.remove("hidden");
  const mw = 200, mh = menu.offsetHeight || 160;
  menu.style.left = Math.min(x, window.innerWidth - mw - 8) + "px";
  menu.style.top = Math.min(y, window.innerHeight - mh - 8) + "px";
}

// a tab = a container in #terms holding one split-tree of leaf terminals
function createTab(name) {
  const id = nextTabId();
  const container = el("div", "term-tab-root");
  container.dataset.tab = id;
  $("#terms").appendChild(container);
  const tab = { id, name: name || `Terminal ${tabSeq}`, pinned: false, color: null, el: container, root: null, activeLeaf: null };
  tabs.set(id, tab);
  const pane = createLeafPane(id);
  tab.root = { paneId: pane.id };
  tab.activeLeaf = pane.id;
  layoutTab(tab);
  return tab;
}

function refitAll() {
  const tab = tabs.get(activeTab);
  if (tab) fitTab(tab);
}

// ── session persistence: restore tabs/splits/folders on reopen ────────
// leaf → { cwd, claude }   split → { dir, sizeA, a, b }
async function serializeNode(node) {
  if (!isLeaf(node)) {
    return { dir: node.dir, sizeA: node.sizeA, a: await serializeNode(node.a), b: await serializeNode(node.b) };
  }
  const [cwd, claude] = await Promise.all([
    invoke("pty_cwd", { id: node.paneId }).catch(() => null),
    invoke("pty_has_claude", { id: node.paneId }).catch(() => false),
  ]);
  return { cwd: cwd || null, claude: !!claude };
}
async function saveLayout() {
  try {
    const list = orderedTabs();
    const out = [];
    for (const t of list) out.push({ name: t.name, pinned: t.pinned, color: t.color, root: await serializeNode(t.root) });
    const activeIndex = Math.max(0, list.findIndex((t) => t.id === activeTab));
    localStorage.setItem("devcli-layout", JSON.stringify({ tabs: out, activeIndex }));
  } catch (_) { /* best-effort */ }
}
let _saveTimer;
function scheduleSave() { clearTimeout(_saveTimer); _saveTimer = setTimeout(saveLayout, 1200); }

function buildSaved(tabId, node, claudePanes) {
  if (node && node.dir) {
    return { dir: node.dir, sizeA: node.sizeA ?? 0.5, a: buildSaved(tabId, node.a, claudePanes), b: buildSaved(tabId, node.b, claudePanes) };
  }
  const pane = createLeafPane(tabId, node && node.cwd);
  if (node && node.claude) claudePanes.push(pane.id);
  return { paneId: pane.id };
}
function restoreTab(saved) {
  const id = nextTabId();
  const container = el("div", "term-tab-root");
  container.dataset.tab = id;
  $("#terms").appendChild(container);
  const tab = { id, name: saved.name || `Terminal ${tabSeq}`, pinned: !!saved.pinned, color: saved.color || null, el: container, root: null, activeLeaf: null };
  tabs.set(id, tab);
  const claudePanes = [];
  tab.root = buildSaved(tab.id, saved.root, claudePanes);
  tab.activeLeaf = tabLeafIds(tab)[0];
  layoutTab(tab);
  // resume Claude after the shell has settled (best-effort)
  for (const pid of claudePanes) {
    setTimeout(() => invoke("pty_write", { id: pid, data: "claude --continue\n" }).catch(() => {}), 1000);
  }
  return tab;
}
function restoreLayout() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem("devcli-layout") || "null"); } catch (_) { saved = null; }
  if (!saved || !Array.isArray(saved.tabs) || !saved.tabs.length) return false;
  let first = null;
  for (const st of saved.tabs) { const t = restoreTab(st); if (!first) first = t; }
  const list = orderedTabs();
  const pick = list[saved.activeIndex] || first;
  activeTab = pick.id;
  activeId = pick.activeLeaf;
  return true;
}
// true if any pane is running a Claude session (for the quit warning)
async function anyClaudeRunning() {
  for (const [id] of panes) {
    if (await invoke("pty_has_claude", { id }).catch(() => false)) return true;
  }
  return false;
}
// intercept window close: save layout, confirm, then destroy
async function wireCloseGuard() {
  try {
    const win = getCurrentWindow();
    await win.onCloseRequested(async (e) => {
      e.preventDefault();
      await saveLayout();
      const running = await anyClaudeRunning();
      const ok = await confirmDialog(
        "Quit DevCLI?",
        running
          ? "A terminal is running a Claude session. Quitting stops it — reopening this window resumes it with “claude --continue”."
          : "Your open terminals will close. Reopening restores this layout and its folders.",
        "Quit",
      );
      if (ok) await win.destroy();
    });
  } catch (_) { /* non-Tauri / no window API — skip */ }
}

// ── in-terminal search (⌘F) ─────────────────────────────────────────
const SEARCH_DECOR = {
  matchBackground: "#2DD4BF44", matchBorder: "#2DD4BF",
  activeMatchBackground: "#58A6FF", activeMatchColorOverviewRuler: "#58A6FF",
  matchOverviewRuler: "#2DD4BF",
};
function openSearch() {
  const bar = $("#term-search");
  bar.classList.remove("hidden");
  const inp = $("#term-search-input");
  inp.focus(); inp.select();
  if (inp.value) runSearch(1);
}
function closeSearch() {
  $("#term-search").classList.add("hidden");
  try { panes.get(activeId)?.search?.clearDecorations(); } catch (_) {}
  panes.get(activeId)?.term.focus();
}
function runSearch(dir) {
  const q = $("#term-search-input").value;
  const s = panes.get(activeId)?.search;
  if (!s) return;
  if (!q) { try { s.clearDecorations(); } catch (_) {} return; }
  const opts = { decorations: SEARCH_DECOR, regex: false, caseSensitive: false };
  if (dir < 0) s.findPrevious(q, opts); else s.findNext(q, opts);
}
function wireSearch() {
  const inp = $("#term-search-input");
  if (!inp) return;
  inp.addEventListener("input", () => runSearch(1));
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); runSearch(e.shiftKey ? -1 : 1); }
    else if (e.key === "Escape") { e.preventDefault(); closeSearch(); }
  });
  $("#term-search-next").addEventListener("click", () => runSearch(1));
  $("#term-search-prev").addEventListener("click", () => runSearch(-1));
  $("#term-search-close").addEventListener("click", closeSearch);
}

// open a brand-new terminal tab and switch to it
function newTab() {
  if (tabs.size >= MAX_TABS) return status("max tabs reached");
  const tab = createTab();
  activeTab = tab.id;
  activeId = tab.activeLeaf;
  renderTermTabs();
  showActive();
  scheduleSave();
}
async function closeTab(id) {
  if (tabs.size <= 1) return; // keep at least one terminal
  const tab = tabs.get(id);
  if (!tab) return;
  if (!(await confirmCloseIfBusy(tabLeafIds(tab), "this terminal"))) return;
  if (!tabs.get(id)) return; // gone while confirming
  for (const pid of tabLeafIds(tab)) {
    invoke("pty_close", { id: pid });
    const p = panes.get(pid);
    if (p) { try { p.ro?.disconnect(); p.term.dispose(); } catch (_) {} panes.delete(pid); }
  }
  tab.el.remove();
  tabs.delete(id);
  if (activeTab === id) activeTab = [...tabs.keys()][0];
  renderTermTabs();
  showActive();
  scheduleSave();
}
function togglePin(id) { const t = tabs.get(id); if (t) { t.pinned = !t.pinned; renderTermTabs(); scheduleSave(); } }
function setTabColor(id, color) { const t = tabs.get(id); if (t) { t.color = color; renderTermTabs(); } }

function insertIntoActive(text) {
  invoke("pty_write", { id: activeId, data: text });
  panes.get(activeId)?.term.focus();
}
// a previous prompt chosen as the base to combine with current context
let selectedBase = null; // { text, title }
function setBase(text, title) {
  selectedBase = text ? { text, title } : null;
  const chip = $("#base-chip");
  if (selectedBase) {
    $("#base-title").textContent = title || "saved prompt";
    chip.classList.remove("hidden");
    status("base set — type context, then ⌘E");
  } else {
    chip.classList.add("hidden");
  }
}

// model used by every Enhance / Refine call — user-picked, persisted
function enhanceModel() {
  return localStorage.getItem("devcli-enhance-model") || "haiku";
}
// keep the Prompts + Notes model dropdowns in sync and persisted
function wireEnhanceModel() {
  const sels = [$("#enhance-model"), $("#enhance-model-note")].filter(Boolean);
  const cur = enhanceModel();
  for (const s of sels) {
    s.value = cur;
    s.addEventListener("change", () => {
      localStorage.setItem("devcli-enhance-model", s.value);
      for (const o of sels) o.value = s.value;
      status(`Enhance model: ${s.options[s.selectedIndex].text.replace(/^[⚡ ]+/, "")}`);
    });
  }
}

async function enhanceActive() {
  const pane = panes.get(activeId);
  if (!pane) return;
  const draft = pane.draft.trim();
  const base = selectedBase?.text || null;
  if (!draft && !base) return status("type a prompt first (or pick a base from Prompts)");
  const context = draft || "Incorporate the current project context.";
  status(base ? "merging base + context via claude…" : "enhancing via claude…", true);
  try {
    const improved = await invoke("rephrase_prompt", { draft: context, base, model: enhanceModel() });
    const oneLine = improved.replace(/\s*\n\s*/g, " ").trim();
    invoke("pty_write", { id: activeId, data: "\x7f".repeat(pane.draft.length) }); // erase what was typed
    invoke("pty_write", { id: activeId, data: oneLine });                          // type the enhanced prompt
    pane.draft = oneLine;
    setBase(null);
    status("enhanced ✓");
  } catch (e) {
    status("⚠ " + e);
  }
}

// ---------- context menu (right-click a pane, or the Split button) ----------
let menuOnClose = null;
function closeMenu() {
  $("#ctx").classList.add("hidden");
  const f = menuOnClose;
  menuOnClose = null;
  if (f) f();
}
function startRename(id) {
  renderTermTabs();
  const nameEl = document.querySelector(`.term-tab[data-id="${id}"] .term-tab-name`);
  const p = tabs.get(id);
  if (nameEl && p) renameTab(p, nameEl);
}
// right-click a tab: rename / pin / color / split / close
function openTabMenu(x, y, id) {
  const p = tabs.get(id);
  if (!p) return;
  const menu = $("#ctx");
  menu.innerHTML = "";
  const item = (glyph, label, fn, disabled) => {
    const r = el("div", "ctx-item" + (disabled ? " disabled" : ""));
    r.appendChild(el("span", "ctx-glyph", glyph || ""));
    r.appendChild(el("span", null, label));
    if (!disabled) r.addEventListener("click", () => { closeMenu(); fn(); });
    menu.appendChild(r);
  };
  item("✎", "Rename", () => startRename(id));
  item("●", p.pinned ? "Unpin tab" : "Pin tab", () => togglePin(id));
  item("▐", "Split right", () => splitLeaf(p.activeLeaf, "row"));
  item("▄", "Split down", () => splitLeaf(p.activeLeaf, "col"));
  // color swatches
  const cw = el("div", "ctx-colors");
  const none = el("button", "ctx-swatch ctx-swatch-none");
  none.title = "no color";
  none.addEventListener("click", () => { closeMenu(); setTabColor(id, null); });
  cw.appendChild(none);
  for (const c of TAB_COLORS) {
    const s = el("button", "ctx-swatch");
    s.style.background = c;
    s.addEventListener("click", () => { closeMenu(); setTabColor(id, c); });
    cw.appendChild(s);
  }
  menu.appendChild(cw);
  menu.appendChild(el("div", "ctx-sep"));
  item("✕", "Close tab", () => closeTab(id), tabs.size <= 1);
  menu.classList.remove("hidden");
  const mw = 210, mh = menu.offsetHeight || 200;
  menu.style.left = Math.min(x, window.innerWidth - mw - 8) + "px";
  menu.style.top = Math.min(y, window.innerHeight - mh - 8) + "px";
}

// ---------- live Claude activity: collapsible cards (min/max per block) ----------
// each card starts minimized (header + 1-line preview); click the caret/header to maximize.
function activityCard(kind, label, ts, fullText, mono, openDefault) {
  const b = el("div", `block block--${kind} act-card`);
  const head = el("div", "block__head act-head");
  const caret = el("button", "act-caret", openDefault ? "▾" : "▸");
  const preview = el("span", "act-preview", (fullText || "").replace(/\s+/g, " ").trim().slice(0, 52));
  head.append(caret, el("span", "block__label", label), preview);
  if (ts) head.appendChild(el("span", "block__time", hhmm(ts)));
  b.appendChild(head);
  const body = el("div", "act-body" + (mono ? " block__mono" : ""));
  body.textContent = fullText;
  let open = !!openDefault;
  const apply = () => {
    body.style.display = open ? "" : "none";
    preview.style.display = open ? "none" : "";
    caret.textContent = open ? "▾" : "▸";
  };
  apply();
  head.addEventListener("click", () => { open = !open; apply(); });
  b.appendChild(body);
  return b;
}
function renderEvent(ev) {
  switch (ev.kind) {
    case "UserPrompt": return activityCard("prompt", "you", ev.ts, ev.text, true, true);
    case "Thinking":   return activityCard("thinking", "💭 thinking", ev.ts, ev.text, false, false);
    case "Assistant":  return activityCard("assistant", "claude", ev.ts, ev.text, false, false);
    case "ToolUse":    return activityCard("tool", `⚙ ${ev.tool}`, ev.ts, ev.summary || "(no input)", true, false);
    case "ToolResult": return activityCard(ev.is_error ? "error" : "result", ev.is_error ? "✕ result" : "✓ result", ev.ts, ev.summary || "(empty)", true, false);
    case "Todo": {
      const b = el("div", "block block--todo act-card");
      const head = el("div", "block__head");
      head.appendChild(el("span", "block__label", "todos"));
      if (ev.ts) head.appendChild(el("span", "block__time", hhmm(ev.ts)));
      b.appendChild(head);
      const list = el("div", "todo-list");
      for (const item of ev.items) {
        const done = item.status === "completed";
        const running = item.status === "in_progress";
        const row = el("div", "todo-row" + (done ? " todo-done" : ""));
        row.appendChild(el("span", "todo-mark", done ? "☑" : running ? "▸" : "☐"));
        row.appendChild(el("span", "todo-text", item.content));
        list.appendChild(row);
      }
      b.appendChild(list);
      return b;
    }
    default:
      return null;
  }
}
function appendEvent(ev) {
  const node = renderEvent(ev);
  if (!node) return;
  $("#activity-empty")?.remove();
  const pane = $("#pane-activity");
  if (!pane) return;
  pane.appendChild(node);
  pane.scrollTop = pane.scrollHeight;
}
// ---------- prompts ----------
const scopeBadge = (scope) => el("span", `badge badge-${scope}`, scope === "global" ? "global" : "folder");
// swap a label span for an inline text input; commit on Enter/blur, cancel on Esc
function renameInline(spanEl, current, onCommit) {
  const inp = el("input", "vault-rename");
  inp.value = current || "";
  spanEl.replaceWith(inp);
  inp.focus(); inp.select();
  let done = false;
  const finish = (commit) => {
    if (done) return; done = true;
    const val = inp.value.trim();
    inp.replaceWith(spanEl);
    if (commit && val && val !== current) onCommit(val);
  };
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  inp.addEventListener("blur", () => finish(true));
  inp.addEventListener("click", (e) => e.stopPropagation());
  inp.addEventListener("dblclick", (e) => e.stopPropagation());
}

function buildPromptRow(h) {
  const row = el("div", "vault-row");
  const head = el("div", "item-head");
  const title = h.title || h.text.split("\n")[0].slice(0, 70);
  const titleEl = el("span", "vault-title", title);
  titleEl.title = "double-click to rename";
  head.appendChild(titleEl);
  head.appendChild(scopeBadge(h.scope));

  const actions = el("div", "row-actions");
  const editBtn = el("button", "row-ico", "✎");
  editBtn.title = "Load into compose to update + enhance";
  editBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const ta = $("#compose-input");
    ta.value = h.text + "\n\n";
    autoGrow(ta);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    status("loaded — add your context below, then ✨ Enhance");
  });
  const baseBtn = el("button", "row-ico", "↯");
  baseBtn.title = "Use as base for Enhance (keeps it, merges your context)";
  baseBtn.addEventListener("click", (e) => { e.stopPropagation(); setBase(h.text, title.slice(0, 40)); });
  const delBtn = el("button", "row-ico row-del", "✕");
  delBtn.title = "Delete this prompt";
  delBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const ok = await confirmDialog("Delete this prompt?", h.title || (h.text || "").split("\n")[0].slice(0, 60), "Delete", delBtn);
    if (!ok) return;
    await invoke("prompts_delete", { scope: h.scope, slug: h.slug }).catch(() => {});
    refreshPrompts($("#prompts-search").value);
    status("deleted");
  });
  actions.append(editBtn, baseBtn, delBtn);
  head.appendChild(actions);

  row.appendChild(head);
  row.appendChild(el("div", "vault-meta", `${h.source || "manual"} · ${new Date(h.created_at * 1000).toLocaleDateString()}`));

  // single-click inserts (delayed so a double-click can rename instead)
  let clickTimer;
  row.addEventListener("click", (e) => {
    if (e.target.closest("button") || e.target.tagName === "INPUT") return;
    clearTimeout(clickTimer);
    clickTimer = setTimeout(async () => {
      const full = await invoke("prompts_get", { scope: h.scope, slug: h.slug }).catch(() => h.text);
      insertIntoActive(full);
      status("inserted into terminal");
    }, 200);
  });
  titleEl.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    clearTimeout(clickTimer);
    renameInline(titleEl, title, async (val) => {
      await invoke("prompts_set_title", { scope: h.scope, slug: h.slug, title: val }).catch(() => {});
      refreshPrompts($("#prompts-search").value);
      status("renamed");
    });
  });
  return row;
}
async function refreshPrompts(query) {
  const [hits, meta] = await Promise.all([
    invoke("prompts_search", { query: query || "" }).catch(() => []),
    invoke("item_meta_list", { kind: "prompt" }).catch(() => []),
  ]);
  const list = $("#prompts-list");
  if (!hits.length) {
    list.innerHTML = "";
    list.appendChild(el("div", "empty", "No saved prompts yet. Save what you're typing, or ask Claude to write prompt files into .devcli/prompts/ — they show up here automatically."));
    return;
  }
  const mm = new Map(meta.map((m) => [m.item_id, m]));
  const entries = hits.map((h) => {
    const m = mm.get(h.slug) || {};
    return { id: h.slug, el: buildPromptRow(h), group: m.group || "", hidden: !!m.hidden, label: h.title || h.text.split("\n")[0].slice(0, 50) };
  });
  renderGrouped("#prompts-list", "prompt", entries);
}
// compose a new prompt inside the Prompts panel
async function enhanceCompose() {
  const ta = $("#compose-input");
  const draft = ta.value.trim();
  const base = selectedBase?.text || null;
  if (!draft && !base) return status("write a prompt first");
  status(base ? "merging base + text via claude…" : "enhancing via claude…", true);
  const btn = $("#compose-enhance");
  btn.disabled = true;
  try {
    const improved = await invoke("rephrase_prompt", {
      draft: draft || "Improve clarity, specificity and structure.",
      base,
      model: enhanceModel(),
    });
    ta.value = improved;
    autoGrow(ta);
    setBase(null);
    $("#compose-refine-row").classList.remove("hidden"); // reveal refine to iterate
    status("enhanced ✓ — tweak it below with Refine");
  } catch (e) {
    status("⚠ " + e);
  } finally {
    btn.disabled = false;
  }
}
// iterate on the current compose text: "make it shorter", "use X instead"…
async function refineCompose() {
  const base = $("#compose-input").value.trim();
  const instr = $("#compose-refine").value.trim();
  if (!base) return status("nothing to refine — enhance or write a prompt first");
  if (!instr) return status("type what to change");
  const btn = $("#compose-refine-btn");
  btn.disabled = true;
  status("refining via claude…", true);
  try {
    const out = await invoke("rephrase_prompt", { draft: instr, base, model: enhanceModel() });
    const ta = $("#compose-input");
    ta.value = out;
    autoGrow(ta);
    $("#compose-refine").value = "";
    status("refined ✓");
  } catch (e) {
    status("⚠ " + e);
  } finally {
    btn.disabled = false;
  }
}
async function saveCompose(scope) {
  const ta = $("#compose-input");
  const t = ta.value.trim();
  if (!t) return status("nothing to save");
  try {
    await invoke("prompts_save", { scope, text: t, source: "manual" });
    status(`saved to ${scope === "global" ? "global" : "folder"} ✓`);
    ta.value = "";
    autoGrow(ta);
    refreshPrompts($("#prompts-search").value);
  } catch (e) {
    status("⚠ " + e);
  }
}

// ---------- grouping + hide (shared by prompts / agents / skills) ----------
const hiddenShown = { prompt: false, agent: false, skill: false };
const selectedGroup = { prompt: "__all", agent: "__all", skill: "__all" };
function refreshKind(kind) {
  if (kind === "prompt") refreshPrompts($("#prompts-search").value);
  else if (kind === "agent") refreshAgents();
  else refreshSkills();
}
// custom confirm (Tauri webview blocks window.confirm) -> Promise<boolean>.
// If `anchor` (an element) is given, shows a small popover near it instead of a centered modal.
function confirmDialog(title, detail, confirmLabel = "Confirm", anchor = null) {
  return new Promise((resolve) => {
    const overlay = el("div", "confirm-overlay" + (anchor ? " confirm-anchored" : ""));
    const box = el("div", "confirm-box" + (anchor ? " confirm-pop" : ""));
    box.appendChild(el("div", "confirm-title", title));
    if (detail) box.appendChild(el("div", "confirm-detail", detail));
    const actions = el("div", "confirm-actions");
    const cancel = el("button", "btn btn-sm", "Cancel");
    const ok = el("button", "btn btn-sm confirm-danger", confirmLabel);
    const done = (v) => { overlay.remove(); document.removeEventListener("keydown", onKey); resolve(v); };
    const onKey = (e) => { if (e.key === "Escape") done(false); else if (e.key === "Enter") done(true); };
    cancel.addEventListener("click", () => done(false));
    ok.addEventListener("click", () => done(true));
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) done(false); });
    document.addEventListener("keydown", onKey);
    actions.append(cancel, ok);
    box.appendChild(actions);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    if (anchor) {
      const r = anchor.getBoundingClientRect();
      const w = 260;
      box.style.top = Math.min(r.bottom + 6, window.innerHeight - box.offsetHeight - 8) + "px";
      box.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + "px";
    }
    ok.focus();
  });
}
// right-click an item: add-to-group / remove / hide — keeps the rows clean
function openItemMenu(x, y, kind, e, groups) {
  const menu = $("#ctx");
  menu.innerHTML = "";
  const item = (label, fn) => {
    const r = el("div", "ctx-item");
    r.appendChild(el("span", null, label));
    r.addEventListener("click", () => { closeMenu(); fn(); });
    menu.appendChild(r);
  };
  menu.appendChild(el("div", "ctx-label", "Add to group"));
  for (const g of groups) if (g !== e.group)
    item(g, async () => { await invoke("item_set_group", { kind, itemId: e.id, group: g }); refreshKind(kind); });
  const wrap = el("div", "ctx-newgroup");
  const inp = el("input", "field");
  inp.placeholder = "＋ new group…";
  inp.addEventListener("click", (ev) => ev.stopPropagation());
  inp.addEventListener("keydown", async (ev) => {
    if (ev.key !== "Enter") return;
    ev.preventDefault();
    const n = inp.value.trim();
    if (!n) return;
    closeMenu();
    await invoke("groups_add", { kind, name: n });
    await invoke("item_set_group", { kind, itemId: e.id, group: n });
    refreshKind(kind);
  });
  wrap.appendChild(inp);
  menu.appendChild(wrap);
  menu.appendChild(el("div", "ctx-sep"));
  if (e.group) item("− Remove from group", async () => { await invoke("item_set_group", { kind, itemId: e.id, group: "" }); refreshKind(kind); });
  item(e.hidden ? "Unhide" : "Hide", async () => { await invoke("item_hide", { kind, itemId: e.id, hidden: !e.hidden }); refreshKind(kind); });
  menu.classList.remove("hidden");
  const mw = 210, mh = menu.offsetHeight || 240;
  menu.style.left = Math.min(x, window.innerWidth - mw - 8) + "px";
  menu.style.top = Math.min(y, window.innerHeight - mh - 8) + "px";
  setTimeout(() => inp.focus(), 0);
}
// render entries [{id, el, group, hidden}] into collapsible group sections,
// with a group bar (+ new group, show hidden) and per-row group/hide controls
// checklist to toggle items in/out of the selected group (stays open for multi-add)
function openAddItems(x, y, kind, group, entries) {
  const menu = $("#ctx");
  menu.innerHTML = "";
  menu.appendChild(el("div", "ctx-label", `Items in “${group}”`));
  const box = el("div", "ctx-checklist");
  for (const e of entries) {
    const row = el("div", "ctx-item");
    const chk = el("span", "ctx-check", e.group === group ? "☑" : "☐");
    row.append(chk, el("span", "ctx-check-name", e.label || e.id));
    row.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const nowIn = chk.textContent === "☑";
      await invoke("item_set_group", { kind, itemId: e.id, group: nowIn ? "" : group });
      chk.textContent = nowIn ? "☐" : "☑";
      e.group = nowIn ? "" : group;
    });
    box.appendChild(row);
  }
  menu.appendChild(box);
  menu.classList.remove("hidden");
  menuOnClose = () => refreshKind(kind); // refresh the group view once done
  const mw = 260, mh = Math.min(360, menu.offsetHeight || 360);
  menu.style.left = Math.min(x, window.innerWidth - mw - 8) + "px";
  menu.style.top = Math.min(y, window.innerHeight - mh - 8) + "px";
}

// drag-to-reorder for panel lists — a per-kind custom order kept in localStorage,
// so you can pull favourite prompts/agents/skills to the top and they stay.
// Pointer-based (WKWebView's HTML5 drag-and-drop drop event is unreliable).
function startRowDrag(kind, shown, id, row, body, e0) {
  const startY = e0.clientY, startX = e0.clientX;
  let moved = false;
  const clear = () => body.querySelectorAll(".row-drop-before,.row-drop-after").forEach((r) => r.classList.remove("row-drop-before", "row-drop-after"));
  const onMove = (e) => {
    if (!moved && Math.abs(e.clientY - startY) < 6 && Math.abs(e.clientX - startX) < 6) return;
    moved = true;
    document.body.style.userSelect = "none";
    row.classList.add("row-dragging");
    clear();
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest(".vault-row");
    if (over && over !== row && body.contains(over)) {
      const r = over.getBoundingClientRect();
      over.classList.add(e.clientY < r.top + r.height / 2 ? "row-drop-before" : "row-drop-after");
    }
  };
  const onUp = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    document.body.style.userSelect = "";
    row.classList.remove("row-dragging");
    if (moved) {
      const target = body.querySelector(".row-drop-before, .row-drop-after");
      if (target) reorderItem(kind, shown, id, target.dataset.itemId, target.classList.contains("row-drop-before"));
      clear();
      // swallow the click that follows a drag (so it doesn't also "insert" the row)
      const stop = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
      row.addEventListener("click", stop, { capture: true });
      setTimeout(() => row.removeEventListener("click", stop, { capture: true }), 300);
    }
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}
const itemOrderKey = (kind) => `devcli-order-${kind}`;
function getItemOrder(kind) { try { return JSON.parse(localStorage.getItem(itemOrderKey(kind)) || "[]"); } catch (_) { return []; } }
function applyItemOrder(kind, entries) {
  const order = getItemOrder(kind);
  if (!order.length) return entries;
  const rank = (id) => { const i = order.indexOf(id); return i < 0 ? order.length + 1 : i; };
  return [...entries].sort((a, b) => rank(a.id) - rank(b.id)); // stable → unordered keep their place
}
function reorderItem(kind, shown, draggedId, targetId, before) {
  const ids = shown.map((e) => e.id);
  const from = ids.indexOf(draggedId);
  if (from < 0) return;
  ids.splice(from, 1);
  let to = ids.indexOf(targetId);
  if (to < 0) return;
  if (!before) to += 1;
  ids.splice(to, 0, draggedId);
  localStorage.setItem(itemOrderKey(kind), JSON.stringify(ids));
  refreshKind(kind);
}
async function renderGrouped(listSel, kind, entries) {
  const groups = await invoke("groups_list", { kind }).catch(() => []);
  const list = $(listSel);
  list.innerHTML = "";
  const sel = selectedGroup[kind] || "__all";

  // group tabs — one scrollable line; click one to show its items
  const chips = el("div", "group-chips");
  const addChip = (label, val) => {
    const c = el("button", "gchip" + (sel === val ? " active" : ""), label);
    c.addEventListener("click", () => { selectedGroup[kind] = val; refreshKind(kind); });
    chips.appendChild(c);
  };
  addChip("All", "__all");
  for (const g of groups) addChip(g, g);
  const inp = el("input", "gchip-input");
  inp.placeholder = "＋ group";
  inp.addEventListener("keydown", async (ev) => {
    if (ev.key !== "Enter") return;
    ev.preventDefault();
    const n = inp.value.trim();
    if (!n) return;
    await invoke("groups_add", { kind, name: n });
    selectedGroup[kind] = n;
    refreshKind(kind);
  });
  chips.appendChild(inp);
  // minimal hidden toggle — only in "All" view, right in the chip row
  const hiddenCount = entries.filter((e) => e.hidden).length;
  if (sel === "__all" && hiddenCount) {
    const h = el("button", "gchip gchip-ghost" + (hiddenShown[kind] ? " active" : ""), `⊘ ${hiddenCount}`);
    h.title = hiddenShown[kind] ? "hide hidden items" : "show hidden items";
    h.addEventListener("click", () => { hiddenShown[kind] = !hiddenShown[kind]; refreshKind(kind); });
    chips.appendChild(h);
  }
  list.appendChild(chips);

  // toolbar under the tabs: only when a group is selected (add items / remove group)
  if (sel !== "__all" && sel !== "") {
    const tools = el("div", "group-bar");
    const addItems = el("button", "btn btn-sm accent-btn", "＋ add items");
    addItems.addEventListener("click", (ev) => openAddItems(ev.clientX, ev.clientY, kind, sel, entries));
    tools.appendChild(addItems);
    const rm = el("button", "btn btn-sm", "✕ remove group");
    rm.title = "remove group (keeps items)";
    rm.addEventListener("click", async () => {
      const ok = await confirmDialog(`Remove group “${sel}”?`, "The items stay — they just go back to ungrouped.", "Remove group", rm);
      if (!ok) return;
      await invoke("groups_delete", { kind, name: sel });
      selectedGroup[kind] = "__all";
      refreshKind(kind);
    });
    tools.appendChild(rm);
    list.appendChild(tools);
  }

  // right-click any row to manage its group / hide (rows stay icon-free)
  for (const e of entries) {
    e.el.addEventListener("contextmenu", (ev) => { ev.preventDefault(); openItemMenu(ev.clientX, ev.clientY, kind, e, groups); });
  }

  // filter by the selected tab
  let shown = entries.filter((e) => hiddenShown[kind] || !e.hidden);
  if (sel === "") shown = shown.filter((e) => !e.group);
  else if (sel !== "__all") shown = shown.filter((e) => e.group === sel);
  shown = applyItemOrder(kind, shown); // honor the user's drag-to-reorder order

  const body = el("div", "grp-items");
  if (!shown.length) body.appendChild(el("div", "empty", "Nothing here — right-click an item to add it to a group."));
  for (const e of shown) {
    const row = e.el;
    row.dataset.itemId = e.id;
    // pointer-based drag (WKWebView's HTML5 drop doesn't fire reliably)
    row.addEventListener("mousedown", (ev) => {
      if (ev.button !== 0 || ev.target.closest("button,input")) return; // let row buttons work
      ev.preventDefault(); // stop the drag from text-selecting the row label
      startRowDrag(kind, shown, e.id, row, body, ev);
    });
    body.appendChild(row);
  }
  list.appendChild(body);
}

// ---------- agents & skills ----------
function buildItemRow(it) {
  const row = el("div", "vault-row");
  const head = el("div", "item-head");
  head.appendChild(el("span", "item-name", it.name));
  head.appendChild(scopeBadge(it.scope));
  row.appendChild(head);
  if (it.description) row.appendChild(el("div", "item-desc", it.description));
  const target = { title: it.name, load: () => invoke("read_doc", { path: it.path }) };
  let clickTimer;
  row.addEventListener("click", () => {
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => {
      insertIntoActive(it.kind === "skill" ? "/" + it.name + " " : `Use the ${it.name} agent to `);
      status("inserted into terminal");
    }, 200);
  });
  row.addEventListener("dblclick", () => {
    clearTimeout(clickTimer);
    peekPinned = true;
    $("#peek-pin").classList.add("active");
    showPeek(target);
  });
  return row;
}
async function refreshList(kind, cmd, listSel, searchSel) {
  const [items, meta] = await Promise.all([
    invoke(cmd).catch(() => []),
    invoke("item_meta_list", { kind }).catch(() => []),
  ]);
  const mm = new Map(meta.map((m) => [m.item_id, m]));
  const q = ($(searchSel)?.value || "").toLowerCase();
  const filtered = items.filter((it) => !q || it.name.toLowerCase().includes(q) || (it.description || "").toLowerCase().includes(q));
  if (!filtered.length) {
    $(listSel).innerHTML = "";
    $(listSel).appendChild(el("div", "empty", q ? "No matches." : `No ${kind}s found in ~/.claude or ./.claude.`));
    return;
  }
  const entries = filtered.map((it) => {
    const m = mm.get(it.name) || {};
    return { id: it.name, el: buildItemRow(it), group: m.group || "", hidden: !!m.hidden, label: it.name };
  });
  renderGrouped(listSel, kind, entries);
}
const refreshAgents = () => refreshList("agent", "agents_list", "#agents-list", "#agents-search");
const refreshSkills = () => refreshList("skill", "skills_list", "#skills-list", "#skills-search");

// ---------- MCP servers ----------
async function refreshMcp() {
  const items = await invoke("mcp_list").catch(() => []);
  const q = ($("#mcp-search")?.value || "").toLowerCase();
  const filtered = items.filter((m) => !q || m.name.toLowerCase().includes(q) || (m.detail || "").toLowerCase().includes(q));
  const list = $("#mcp-list");
  list.innerHTML = "";
  if (!filtered.length) {
    list.appendChild(el("div", "empty", q ? "No matches." : "No MCP servers found in ~/.claude.json or ./.mcp.json."));
    return;
  }
  for (const m of filtered) {
    const row = el("div", "vault-row");
    const head = el("div", "item-head");
    head.appendChild(el("span", "item-name", m.name));
    head.appendChild(el("span", "mcp-kind", m.kind));
    head.appendChild(el("span", `badge badge-${m.scope === "global" ? "global" : "project"}`, m.scope));
    row.appendChild(head);
    if (m.detail) row.appendChild(el("div", "item-desc block__mono", m.detail));
    list.appendChild(row);
  }
}

// ---------- file panel (click a terminal path → open a dedicated file panel) ----------
// Opens the standalone file panel showing one file. Relative paths resolve
// against the project dir (rust side). Triggered by clicking a path in the terminal.
// file extension → highlight.js language id (unknowns fall back to auto-detect)
const EXT_LANG = {
  sql: "sql", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", tsx: "typescript", py: "python", rs: "rust", go: "go", rb: "ruby",
  java: "java", kt: "kotlin", swift: "swift", c: "c", h: "c", cpp: "cpp", cc: "cpp",
  cs: "csharp", php: "php", sh: "bash", bash: "bash", zsh: "bash", json: "json",
  yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini", css: "css", scss: "scss",
  html: "xml", xml: "xml", svg: "xml", md: "markdown", markdown: "markdown",
  dockerfile: "dockerfile", makefile: "makefile", lua: "lua", r: "r", diff: "diff",
};
let filePanelRaw = ""; // raw content, for the copy button
async function previewFile(path, display, paneId) {
  // resolve a relative path against the clicked terminal's live shell cwd
  let resolved = path;
  if (paneId && !path.startsWith("/") && !path.startsWith("~")) {
    const cwd = await invoke("pty_cwd", { id: paneId }).catch(() => null);
    if (cwd) resolved = cwd.replace(/\/+$/, "") + "/" + path;
  }
  let content;
  try {
    content = await invoke("read_file", { path: resolved });
  } catch (e) {
    status("⚠ " + e); // not a real file / unreadable — don't open an empty panel
    return;
  }
  const panel = $("#file-panel");
  $("#file-panel-name").textContent = display || path;
  panel.dataset.path = resolved; // reveal-in-Finder uses the resolved absolute path
  filePanelRaw = content || "";
  const body = $("#file-panel-body");
  const ext = (path.split(".").pop() || "").toLowerCase();
  const base = (path.split("/").pop() || "").toLowerCase();
  const lang = EXT_LANG[ext] || EXT_LANG[base]; // e.g. Dockerfile / Makefile have no ext
  try {
    const res = lang && hljs.getLanguage(lang)
      ? hljs.highlight(filePanelRaw, { language: lang })
      : hljs.highlightAuto(filePanelRaw);
    body.innerHTML = res.value || "(empty)";
    body.className = "file-panel-body hljs";
  } catch (_) {
    body.textContent = filePanelRaw || "(empty)"; // never fail the preview over highlighting
    body.className = "file-panel-body";
  }
  panel.classList.remove("hidden"); // overlays the side panel; terminal keeps its width
}
function closeFilePanel() {
  $("#file-panel").classList.add("hidden");
}
// clamp + apply the preview width (right-anchored overlay)
function setFilePanelWidth(w) {
  const max = Math.max(360, window.innerWidth - 120);
  const width = Math.round(Math.max(280, Math.min(w, max)));
  $("#file-panel").style.width = width + "px";
  localStorage.setItem("devcli-filepanel-width", String(width));
}
function wireFilePanel() {
  $("#file-panel-close")?.addEventListener("click", closeFilePanel);
  $("#file-panel-open")?.addEventListener("click", () => {
    const p = $("#file-panel").dataset.path;
    if (p) invoke("reveal_file", { path: p }).catch((e) => status("⚠ " + e));
  });
  $("#file-panel-copy")?.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(filePanelRaw); status("copied file contents"); }
    catch { status("⚠ copy failed"); }
  });
  // restore saved width
  const saved = parseInt(localStorage.getItem("devcli-filepanel-width") || "", 10);
  if (saved) setFilePanelWidth(saved);
  // drag the left edge to resize (panel is anchored to the right)
  const rez = $("#file-panel-resizer");
  rez?.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const right = $("#file-panel").getBoundingClientRect().right;
    document.body.classList.add("filepanel-resizing");
    const onMove = (ev) => setFilePanelWidth(right - ev.clientX);
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("filepanel-resizing");
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
}

// ---------- notes (pin / minimize / drag-reorder / enhance / links) ----------
let currentNotes = [];
function wireNotes() {
  $("#note-add").addEventListener("click", addNote);
  $("#note-enhance").addEventListener("click", enhanceNote);
  $("#note-refine-toggle").addEventListener("click", () => $("#note-refine-row").classList.toggle("hidden"));
  $("#note-refine-btn").addEventListener("click", refineNote);
  $("#note-refine").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); refineNote(); } });
  $("#note-text").addEventListener("input", () => autoGrow($("#note-text")));
  $("#note-text").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); addNote(); }
  });
}
async function addNote() {
  const text = $("#note-text").value.trim();
  if (!text) return status("nothing to add");
  try {
    await invoke("notes_add", { kind: "note", text, url: "" });
    $("#note-text").value = "";
    refreshNotes();
  } catch (e) { status("⚠ " + e); }
}
async function enhanceNote() {
  const ta = $("#note-text");
  const t = ta.value.trim();
  if (!t) return status("write a note first");
  const btn = $("#note-enhance");
  btn.disabled = true;
  status("enhancing via claude…", true);
  try {
    ta.value = await invoke("rephrase_prompt", { draft: t, base: null, model: enhanceModel(), kind: "note" });
    autoGrow(ta);
    $("#note-refine-row").classList.remove("hidden"); // reveal refine to iterate
    status("enhanced ✓ — tweak with ↻ Refine");
  } catch (e) { status("⚠ " + e); } finally { btn.disabled = false; }
}
async function refineNote() {
  const base = $("#note-text").value.trim();
  const instr = $("#note-refine").value.trim();
  if (!base) return status("nothing to refine — write a note first");
  if (!instr) return status("type what to change");
  const btn = $("#note-refine-btn");
  btn.disabled = true;
  status("refining via claude…", true);
  try {
    const out = await invoke("rephrase_prompt", { draft: instr, base, model: enhanceModel(), kind: "note" });
    const ta = $("#note-text");
    ta.value = out;
    autoGrow(ta);
    $("#note-refine").value = "";
    status("refined ✓");
  } catch (e) { status("⚠ " + e); } finally { btn.disabled = false; }
}
function linkify(container, text) {
  for (const part of text.split(/(https?:\/\/[^\s]+)/g)) {
    if (/^https?:\/\//.test(part)) {
      const a = el("span", "note-url-link", part);
      a.title = part;
      a.addEventListener("click", (e) => { e.stopPropagation(); invoke("open_external", { url: part }).catch(() => {}); });
      container.appendChild(a);
    } else if (part) {
      container.appendChild(document.createTextNode(part));
    }
  }
}
function reorderNotes(fromId, toId) {
  if (fromId === toId) return;
  const ids = currentNotes.map((n) => n.id);
  const from = ids.indexOf(fromId), to = ids.indexOf(toId);
  if (from < 0 || to < 0) return;
  ids.splice(to, 0, ids.splice(from, 1)[0]);
  invoke("notes_reorder", { ids }).then(refreshNotes).catch(() => {});
}
async function refreshNotes() {
  currentNotes = await invoke("notes_list").catch(() => []);
  const list = $("#notes-list");
  list.innerHTML = "";
  if (!currentNotes.length) return list.appendChild(el("div", "empty", "No notes yet. Add one above — paste links and they become clickable."));
  for (const n of currentNotes) {
    const card = el("div", "note-card" + (n.done ? " note-done" : "") + (n.pinned ? " note-pinned" : ""));
    card.draggable = true;
    card.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", String(n.id)); card.classList.add("dragging"); });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
    card.addEventListener("dragover", (e) => e.preventDefault());
    card.addEventListener("drop", (e) => { e.preventDefault(); reorderNotes(Number(e.dataTransfer.getData("text/plain")), n.id); });

    const head = el("div", "note-head");
    const drag = el("span", "note-drag", "⠿"); drag.title = "drag to reorder";
    const chk = el("button", "row-ico", n.done ? "☑" : "☐"); chk.title = "done";
    chk.addEventListener("click", async (e) => { e.stopPropagation(); await invoke("notes_toggle", { id: n.id }).catch(() => {}); refreshNotes(); });
    const col = el("button", "row-ico", n.collapsed ? "▸" : "▾"); col.title = "minimize";
    col.addEventListener("click", async (e) => { e.stopPropagation(); await invoke("notes_collapse", { id: n.id }).catch(() => {}); refreshNotes(); });
    const titleEl = el("span", "note-title", n.title || (n.text || "").split("\n")[0].slice(0, 60) || "(empty)");
    titleEl.title = "double-click to rename";
    titleEl.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      renameInline(titleEl, n.title || "", async (val) => {
        await invoke("notes_set_title", { id: n.id, title: val }).catch(() => {});
        refreshNotes();
      });
    });
    const pin = el("button", "row-ico" + (n.pinned ? " active" : ""), "⊙"); pin.title = "pin";
    pin.addEventListener("click", async (e) => { e.stopPropagation(); await invoke("notes_pin", { id: n.id }).catch(() => {}); refreshNotes(); });
    const del = el("button", "row-ico row-del", "✕"); del.title = "delete";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      const ok = await confirmDialog("Delete this note?", (n.text || "").split("\n")[0].slice(0, 60), "Delete", del);
      if (!ok) return;
      await invoke("notes_delete", { id: n.id }).catch(() => {});
      refreshNotes();
    });
    head.append(drag, chk, col, titleEl, pin, del);
    card.appendChild(head);

    if (!n.collapsed) {
      const body = el("div", "note-body");
      linkify(body, n.text || n.url || "");
      card.appendChild(body);
    }
    list.appendChild(card);
  }
}

// ---------- peek (Quick-Look for skills/agents) ----------
let peekTarget = null; // { title, load: () => Promise<string> }
let peekPinned = false;
function showPeek(target) {
  if (!target) return;
  $("#peek-title").textContent = target.title;
  $("#peek-body").textContent = "loading…";
  $("#peek").classList.remove("hidden");
  Promise.resolve(target.load())
    .then((t) => { $("#peek-body").textContent = t || "(empty)"; })
    .catch(() => { $("#peek-body").textContent = "(couldn't load)"; });
}
function hidePeek(force) {
  if (peekPinned && !force) return;
  $("#peek").classList.add("hidden");
  peekPinned = false;
  $("#peek-pin").classList.remove("active");
}

// ---------- panel ----------
function setPanel(open) {
  $("#panel").classList.toggle("hidden", !open);
  $("#panel-reopen").classList.toggle("hidden", open);
  setTimeout(refitAll, 0);
}
const PANEL_PANES = ["prompts", "agents", "skills", "mcp", "notes"];
function loadPane(which) {
  if (which === "prompts") refreshPrompts($("#prompts-search").value);
  else if (which === "agents") refreshAgents();
  else if (which === "skills") refreshSkills();
  else if (which === "mcp") refreshMcp();
  else if (which === "notes") refreshNotes();
  // "files" has no list to load — it only shows a preview when a terminal path is clicked
}
// switch the side panel to a tab (and open the panel if collapsed)
function activatePanelTab(which) {
  document.querySelectorAll(".panel-tabs .tab").forEach((x) => x.classList.toggle("active", x.dataset.tab === which));
  for (const p of PANEL_PANES) $("#pane-" + p).classList.toggle("hidden", p !== which);
  if ($("#panel").classList.contains("hidden")) setPanel(true);
  loadPane(which);
}
function wireTabs() {
  document.querySelectorAll(".panel-tabs .tab").forEach((t) => {
    t.addEventListener("click", () => activatePanelTab(t.dataset.tab));
  });
}

// ---------- auto-update (from GitHub Releases) ----------
async function checkForUpdates() {
  try {
    const update = await check();
    if (update?.available) {
      status(`update ${update.version} available — installing…`, true);
      await update.downloadAndInstall();
      status("update installed — restarting…");
      await relaunch();
    }
  } catch (_) { /* offline, dev build, or no release yet — ignore */ }
}

// ---------- panel follows the active terminal's folder ----------
let currentDir = null;
function refreshActivePanel() {
  const which = document.querySelector(".panel-tabs .tab.active")?.dataset.tab;
  if (which) loadPane(which);
}
async function syncProjectDir() {
  const cwd = await invoke("pty_cwd", { id: activeId }).catch(() => null);
  if (!cwd) return;
  if (cwd !== currentDir) {
    currentDir = cwd;
    await invoke("set_project_dir", { path: cwd }).catch(() => {});
    const base = cwd.split("/").filter(Boolean).pop() || cwd;
    $("#cwd-label").textContent = "📁 " + base;
    $("#cwd-label").title = cwd + " — the panel follows this folder";
    $("#sb-folder-name").textContent = base;
    $("#sb-folder").title = cwd;
    refreshActivePanel();
    scheduleSave(); // remember the new folder for session restore
  }
  updateContextChips(cwd); // branch + agent can change without a cd — refresh each tick
}

// bottom Warp-style context bar: git-branch chip + live-agent chip for the active pane
async function updateContextChips(cwd) {
  const [branch, claude] = await Promise.all([
    invoke("git_branch", { path: cwd }).catch(() => null),
    invoke("pty_has_claude", { id: activeId }).catch(() => false),
  ]);
  const branchChip = $("#sb-branch");
  if (branch) { $("#sb-branch-name").textContent = branch; branchChip.classList.remove("hidden"); }
  else branchChip.classList.add("hidden");
  $("#sb-agent-name").textContent = claude ? "claude" : "shell";
  $("#sb-agent").classList.toggle("live", !!claude);
}

// ---------- boot ----------
async function init() {
  setTheme(currentTheme);
  checkForUpdates(); // non-blocking; only does anything in a release build

  await listen("pty-data", (e) => {
    const pane = panes.get(e.payload.id);
    if (pane) pane.term.write(b64ToBytes(e.payload.data));
  });
  await listen("pty-exit", (e) =>
    panes.get(e.payload.id)?.term.write("\r\n\x1b[38;5;244m[process exited]\x1b[0m\r\n"));

  // restore last session's tabs/splits/folders, else start one fresh terminal
  if (!restoreLayout()) {
    const first = createTab();
    activeTab = first.id;
    activeId = first.activeLeaf;
  }
  renderTermTabs();
  showActive();
  wireCloseGuard(); // warn before quitting (esp. with a running Claude session)

  // watch prompt folders; refresh the list when they change
  invoke("prompts_watch").catch(() => {});
  await listen("prompts-changed", () => refreshPrompts($("#prompts-search").value));

  wireTabs();
  wireNotes();
  refreshPrompts("");
  $("#base-clear").addEventListener("click", () => setBase(null));
  $("#peek-pin").addEventListener("click", () => {
    peekPinned = !peekPinned;
    $("#peek-pin").classList.toggle("active", peekPinned);
  });
  $("#peek-close").addEventListener("click", () => hidePeek(true));
  $("#prompts-search").addEventListener("input", (e) => refreshPrompts(e.target.value));
  $("#agents-search").addEventListener("input", refreshAgents);
  $("#skills-search").addEventListener("input", refreshSkills);
  $("#mcp-search").addEventListener("input", refreshMcp);
  $("#compose-enhance").addEventListener("click", enhanceCompose);
  $("#compose-save-proj").addEventListener("click", () => saveCompose("project"));
  $("#compose-save-glob").addEventListener("click", () => saveCompose("global"));
  $("#compose-insert").addEventListener("click", () => {
    const t = $("#compose-input").value;
    if (t.trim()) insertIntoActive(t);
  });
  $("#compose-refine-toggle").addEventListener("click", () => $("#compose-refine-row").classList.toggle("hidden"));
  $("#compose-refine-btn").addEventListener("click", refineCompose);
  $("#compose-refine").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); refineCompose(); } });
  $("#compose-input").addEventListener("input", () => autoGrow($("#compose-input")));
  $("#btn-theme").addEventListener("click", () => setTheme(currentTheme === "light" ? "dark" : "light"));
  $("#tab-add").addEventListener("click", newTab);
  $("#btn-collapse").addEventListener("click", () => setPanel(false));
  $("#panel-reopen").addEventListener("click", () => setPanel(true));

  document.addEventListener("mousedown", (e) => {
    if (!$("#ctx").classList.contains("hidden") && !$("#ctx").contains(e.target)) closeMenu();
  });
  window.addEventListener("resize", () => { closeMenu(); refitAll(); });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!$("#term-search").classList.contains("hidden")) { closeSearch(); return; }
      if (!$("#file-panel").classList.contains("hidden")) { closeFilePanel(); return; }
      closeMenu(); hidePeek(true); return;
    }
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (k === "t") { e.preventDefault(); newTab(); }
    else if (k === "e") { e.preventDefault(); enhanceActive(); }
    else if (k === "b") { e.preventDefault(); setPanel($("#panel").classList.contains("hidden")); }
    else if (k === "w") { e.preventDefault(); closeLeaf(activeId); }
    else if (k === "f") { e.preventDefault(); openSearch(); }
    else if (k === "d") { e.preventDefault(); splitLeaf(activeId, e.shiftKey ? "col" : "row"); }
    else if (k === "=" || k === "+") { e.preventDefault(); setFontSize(fontSize + 1); }
    else if (k === "-" || k === "_") { e.preventDefault(); setFontSize(fontSize - 1); }
    else if (k === "0") { e.preventDefault(); setFontSize(13); }
    else if (/^[1-9]$/.test(k)) { // ⌘1..9 switch to that tab
      const list = orderedTabs();
      const idx = parseInt(k, 10) - 1;
      if (list[idx]) { e.preventDefault(); activeTab = list[idx].id; showActive(); }
    }
  });
  wireSearch();
  wireEnhanceModel();
  wireFilePanel();

  panes.get("1").term.focus();
  setTimeout(syncProjectDir, 800);      // initial folder detect
  setInterval(syncProjectDir, 1500);    // follow `cd` in the active terminal
}

init().catch((err) => {
  document.body.textContent = "DevCLI failed to start: " + err;
});
