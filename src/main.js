// DevCLI — frontend: iTerm2/Ghostty-style split-tree terminals + Claude Code panel.
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

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
  selectionBackground: "#264F78", black: "#161B22", brightBlack: "#8B949E", red: "#F85149",
  green: "#3FB950", yellow: "#D29922", blue: "#58A6FF", magenta: "#2DD4BF", cyan: "#39C5CF", white: "#E6EDF3",
};
const TERM_THEME_LIGHT = {
  background: "#FFFFFF", foreground: "#1B2230", cursor: "#0D9488", cursorAccent: "#FFFFFF",
  selectionBackground: "#CDE7E3", black: "#EDF1F5", brightBlack: "#5A6472", red: "#DC2626",
  green: "#16A34A", yellow: "#B45309", blue: "#0284C7", magenta: "#0D9488", cyan: "#0284C7", white: "#1B2230",
};
let currentTheme = localStorage.getItem("devcli-theme") || "light";
const termTheme = () => (currentTheme === "light" ? TERM_THEME_LIGHT : TERM_THEME_DARK);
function setTheme(name) {
  currentTheme = name;
  document.documentElement.setAttribute("data-theme", name);
  localStorage.setItem("devcli-theme", name);
  $("#btn-theme").textContent = name === "light" ? "☀" : "☾";
  for (const p of panes.values()) p.term.options.theme = termTheme();
}

// ---------- terminals as tabs (one full terminal per tab) ----------
const MAX_TABS = 24;
const panes = new Map(); // id -> { id, term, fit, draft, el, name, pinned, color }
let activeId = "1";
const TAB_COLORS = ["#2DD4BF", "#58A6FF", "#3FB950", "#D29922", "#F85149", "#A970FF", "#EC6CB9"];

function makeTerm() {
  return new Terminal({
    fontFamily: '"JetBrains Mono", ui-monospace, "SF Mono", monospace',
    fontSize: 13, lineHeight: 1.5, cursorBlink: true, allowProposedApi: true,
    scrollback: 100000, // keep the whole session scrollable (default was 1000)
    theme: termTheme(),
  });
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
function orderedPanes() {
  return [...panes.values()].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
}
// show only the active tab's terminal; hide the rest.
// only toggles the .active class on existing tabs (no rebuild) so a
// double-click on the tab name survives to trigger rename.
function showActive() {
  for (const [id, p] of panes) p.el.style.display = id === activeId ? "" : "none";
  const p = panes.get(activeId);
  if (p) {
    try { p.fit.fit(); } catch (_) {}
    invoke("pty_resize", { id: p.id, rows: p.term.rows, cols: p.term.cols });
    p.term.focus();
  }
  document.querySelectorAll(".term-tab").forEach((t) => t.classList.toggle("active", t.dataset.id === activeId));
}

// top bar: one tab per terminal — rename, pin, color, close
function renderTermTabs() {
  const bar = $("#term-tabs");
  if (!bar) return;
  bar.innerHTML = "";
  for (const p of orderedPanes()) {
    const tab = el("div", "term-tab" + (p.id === activeId ? " active" : "") + (p.pinned ? " pinned" : ""));
    tab.dataset.id = p.id;
    if (p.color) { tab.style.setProperty("--tab-color", p.color); tab.classList.add("colored"); }
    if (p.pinned) { const pin = el("span", "term-tab-pin", "●"); if (p.color) pin.style.color = p.color; tab.appendChild(pin); }
    else if (p.color) { const dot = el("span", "term-tab-dot"); dot.style.background = p.color; tab.appendChild(dot); }
    const name = el("span", "term-tab-name", p.name);
    name.addEventListener("dblclick", (e) => { e.stopPropagation(); renameTab(p, name); });
    tab.appendChild(name);
    const x = el("button", "term-tab-close", "✕");
    x.addEventListener("click", (e) => { e.stopPropagation(); closeTab(p.id); });
    tab.appendChild(x);
    tab.addEventListener("click", () => { activeId = p.id; showActive(); });
    tab.addEventListener("contextmenu", (e) => { e.preventDefault(); openTabMenu(e.clientX, e.clientY, p.id); });
    bar.appendChild(tab);
  }
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

function createPane(id) {
  const wrap = el("div", "term-pane");
  wrap.dataset.id = id;
  $("#terms").appendChild(wrap);

  const term = makeTerm();
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(wrap);
  // GPU-accelerated rendering; fall back to canvas if WebGL is unavailable
  try {
    const gl = new WebglAddon();
    gl.onContextLoss(() => gl.dispose());
    term.loadAddon(gl);
  } catch (_) { /* canvas fallback */ }
  fit.fit();

  const pane = { id, term, fit, draft: "", el: wrap, name: `Terminal ${id}`, pinned: false, color: null };
  panes.set(id, pane);

  term.onData((data) => {
    invoke("pty_write", { id, data });
    trackDraft(pane, data);
  });
  const focusThis = () => { activeId = id; showActive(); };
  wrap.addEventListener("mousedown", focusThis);
  if (term.textarea) term.textarea.addEventListener("focus", focusThis);

  invoke("pty_spawn", { id, rows: term.rows, cols: term.cols });
  return pane;
}

function refitAll() {
  const p = panes.get(activeId);
  if (!p) return;
  try { p.fit.fit(); } catch (_) {}
  invoke("pty_resize", { id: p.id, rows: p.term.rows, cols: p.term.cols });
}

const nextFreeId = () => {
  for (let i = 1; i <= MAX_TABS; i++) if (!panes.has(String(i))) return String(i);
  return null;
};

// open a brand-new terminal tab and switch to it
function newTab() {
  if (panes.size >= MAX_TABS) return status("max tabs reached");
  const id = nextFreeId();
  createPane(id);
  activeId = id;
  renderTermTabs();
  showActive();
}
function closeTab(id) {
  if (panes.size <= 1) return; // keep at least one terminal
  const p = panes.get(id);
  if (!p) return;
  invoke("pty_close", { id });
  p.term.dispose();
  p.el.remove();
  panes.delete(id);
  if (activeId === id) activeId = [...panes.keys()][0];
  renderTermTabs();
  showActive();
}
function togglePin(id) { const p = panes.get(id); if (p) { p.pinned = !p.pinned; renderTermTabs(); } }
function setTabColor(id, color) { const p = panes.get(id); if (p) { p.color = color; renderTermTabs(); } }

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

async function enhanceActive() {
  const pane = panes.get(activeId);
  if (!pane) return;
  const draft = pane.draft.trim();
  const base = selectedBase?.text || null;
  if (!draft && !base) return status("type a prompt first (or pick a base from Prompts)");
  const context = draft || "Incorporate the current project context.";
  status(base ? "merging base + context via claude…" : "enhancing via claude…", true);
  try {
    const improved = await invoke("rephrase_prompt", { draft: context, base });
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
  const p = panes.get(id);
  if (nameEl && p) renameTab(p, nameEl);
}
// right-click a tab: rename / pin / color / close
function openTabMenu(x, y, id) {
  const p = panes.get(id);
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
  item("✕", "Close tab", () => closeTab(id), panes.size <= 1);
  menu.classList.remove("hidden");
  const mw = 210, mh = menu.offsetHeight || 200;
  menu.style.left = Math.min(x, window.innerWidth - mw - 8) + "px";
  menu.style.top = Math.min(y, window.innerHeight - mh - 8) + "px";
}

// ---------- session blocks ----------
function blockShell(kind, label, ts) {
  const b = el("div", `block block--${kind}`);
  const head = el("div", "block__head");
  head.appendChild(el("span", "block__label", label));
  if (ts) head.appendChild(el("span", "block__time", hhmm(ts)));
  b.appendChild(head);
  return b;
}
// collapsible card: shows a preview, tap to expand full text
function makeExpandable(b, fullText, mono) {
  const long = fullText.length > 180;
  const preview = long ? fullText.slice(0, 180) + "…" : fullText;
  const body = el("div", "block__body" + (mono ? " block__mono" : ""), preview);
  b.appendChild(body);
  if (long) {
    b.classList.add("block--tap");
    let open = false;
    b.addEventListener("click", () => {
      open = !open;
      body.textContent = open ? fullText : preview;
      b.classList.toggle("open", open);
    });
  }
  return b;
}
function renderEvent(ev) {
  switch (ev.kind) {
    case "UserPrompt":
      return makeExpandable(blockShell("prompt", "you", ev.ts), ev.text, true);
    case "Thinking":
      return makeExpandable(blockShell("thinking", "💭 thinking", ev.ts), ev.text, false);
    case "Assistant":
      return makeExpandable(blockShell("assistant", "claude", ev.ts), ev.text, false);
    case "ToolUse":
      return makeExpandable(blockShell("tool", `⚙ ${ev.tool}`, ev.ts), ev.summary || "(no input)", true);
    case "ToolResult":
      return makeExpandable(
        blockShell(ev.is_error ? "error" : "result", ev.is_error ? "✕ result" : "✓ result", ev.ts),
        ev.summary || "(empty)", true);
    case "Todo": {
      const b = blockShell("todo", "todos", ev.ts);
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
function buildPromptRow(h) {
  const row = el("div", "vault-row");
  const head = el("div", "item-head");
  const title = h.title || h.text.split("\n")[0].slice(0, 70);
  head.appendChild(el("span", "vault-title", title));
  head.appendChild(scopeBadge(h.scope));

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
  head.appendChild(editBtn);

  const baseBtn = el("button", "row-ico", "⚡");
  baseBtn.title = "Use as base for Enhance (keeps it, merges your context)";
  baseBtn.addEventListener("click", (e) => { e.stopPropagation(); setBase(h.text, title.slice(0, 40)); });
  head.appendChild(baseBtn);

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
  head.appendChild(delBtn);

  row.appendChild(head);
  row.appendChild(el("div", "vault-meta", `${h.source || "manual"} · ${new Date(h.created_at * 1000).toLocaleDateString()}`));
  row.addEventListener("click", async () => {
    const full = await invoke("prompts_get", { scope: h.scope, slug: h.slug }).catch(() => h.text);
    insertIntoActive(full);
    status("inserted into terminal");
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
    const out = await invoke("rephrase_prompt", { draft: instr, base });
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

  const body = el("div", "grp-items");
  if (!shown.length) body.appendChild(el("div", "empty", "Nothing here — right-click an item to add it to a group."));
  for (const e of shown) body.appendChild(e.el);
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
    ta.value = await invoke("rephrase_prompt", { draft: t, base: null });
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
    const out = await invoke("rephrase_prompt", { draft: instr, base });
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
    const titleEl = el("span", "note-title", (n.text || "").split("\n")[0].slice(0, 60) || "(empty)");
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
function wireTabs() {
  document.querySelectorAll(".tab").forEach((t) => {
    t.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
      t.classList.add("active");
      const which = t.dataset.tab;
      for (const p of ["prompts", "agents", "skills", "mcp", "notes"])
        $("#pane-" + p).classList.toggle("hidden", p !== which);
      if (which === "prompts") refreshPrompts($("#prompts-search").value);
      if (which === "agents") refreshAgents();
      if (which === "skills") refreshSkills();
      if (which === "mcp") refreshMcp();
      if (which === "notes") refreshNotes();
    });
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
  if (which === "prompts") refreshPrompts($("#prompts-search").value);
  else if (which === "agents") refreshAgents();
  else if (which === "skills") refreshSkills();
  else if (which === "mcp") refreshMcp();
  else if (which === "notes") refreshNotes();
}
async function syncProjectDir() {
  const cwd = await invoke("pty_cwd", { id: activeId }).catch(() => null);
  if (!cwd || cwd === currentDir) return;
  currentDir = cwd;
  await invoke("set_project_dir", { path: cwd }).catch(() => {});
  $("#cwd-label").textContent = "📁 " + (cwd.split("/").filter(Boolean).pop() || cwd);
  $("#cwd-label").title = cwd + " — the panel follows this folder";
  refreshActivePanel();
}

// ---------- boot ----------
async function init() {
  setTheme(currentTheme);
  checkForUpdates(); // non-blocking; only does anything in a release build

  await listen("pty-data", (e) => panes.get(e.payload.id)?.term.write(new Uint8Array(e.payload.data)));
  await listen("pty-exit", (e) =>
    panes.get(e.payload.id)?.term.write("\r\n\x1b[38;5;244m[process exited]\x1b[0m\r\n"));

  createPane("1");
  renderTermTabs();
  showActive();

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
    if (e.key === "Escape") { closeMenu(); hidePeek(true); return; }
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (k === "t") { e.preventDefault(); newTab(); }
    else if (k === "e") { e.preventDefault(); enhanceActive(); }
    else if (k === "b") { e.preventDefault(); setPanel($("#panel").classList.contains("hidden")); }
    else if (k === "w") { e.preventDefault(); closeTab(activeId); }
    else if (/^[1-9]$/.test(k)) { // ⌘1..9 switch to that tab
      const list = orderedPanes();
      const idx = parseInt(k, 10) - 1;
      if (list[idx]) { e.preventDefault(); activeId = list[idx].id; showActive(); }
    }
  });

  panes.get("1").term.focus();
  setTimeout(syncProjectDir, 800);      // initial folder detect
  setInterval(syncProjectDir, 1500);    // follow `cd` in the active terminal
}

init().catch((err) => {
  document.body.textContent = "DevCLI failed to start: " + err;
});
