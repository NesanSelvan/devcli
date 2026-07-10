<div align="center">

# ⌁ DevCLI

**A local-first terminal built for the Claude Code era.**

Your terminal, plus a Claude-native side panel — a git-backed prompt vault, your agents & skills & MCP servers at a glance, notes, and a one-key **Enhance** that turns rough ideas into sharp prompts.

[![release](https://img.shields.io/github/v/release/NesanSelvan/devcli?color=2DD4BF&label=release)](https://github.com/NesanSelvan/devcli/releases/latest)
[![build](https://img.shields.io/github/actions/workflow/status/NesanSelvan/devcli/release.yml?label=build)](https://github.com/NesanSelvan/devcli/actions)
[![platform](https://img.shields.io/badge/macOS-Apple%20Silicon-0D1117)](https://github.com/NesanSelvan/devcli/releases/latest)
[![stack](https://img.shields.io/badge/Rust%20%2B%20Tauri%20%2B%20xterm-2DD4BF)](#-tech)

</div>

---

## ✨ Why

Two worlds never met: **AI terminals** (fast, pretty, but agent-blind) and **Claude Code GUIs** (agent-aware, but not a real terminal). DevCLI is both — a real shell **and** a panel that understands your Claude Code workflow. Local-first, no login, cross-platform.

---

## 🚀 Features

| | |
|---|---|
| 🖥️ **Real terminal** | True PTY + your shell, GPU-accelerated rendering (xterm WebGL), 100k scrollback. |
| 🗂️ **Tabs** | One shell per tab — **rename** (double-click), **pin**, **color**, right-click menu. |
| 💬 **Prompt vault** | Every saved prompt is a git-tracked `.md` file. Search, tag into **groups**, re-use, share. |
| ✨ **Enhance & Refine** | Turn a rough note into a clean prompt via your local `claude` — then iterate with a change instruction. |
| 🤖 **Agents · Skills · MCP** | Your `~/.claude` (and project `.claude`) agents, skills, and MCP servers — searchable, groupable, **double-click to preview**. |
| 📝 **Notes** | Notes / tasks with pin, minimize, drag-to-reorder, and clickable links. |
| 📁 **Folder-aware** | The panel **follows your terminal's `cd`** — prompts, notes, agents auto-scope to the project you're in. |
| 🎨 **Themes** | Clean light + dark, teal accent. |
| ⬆️ **Auto-update** | Installed apps update themselves from GitHub Releases (signed). |

---

## 📦 Install

Download the latest **`.dmg`** from **[Releases](https://github.com/NesanSelvan/devcli/releases/latest)** (macOS, Apple Silicon), open it, drag DevCLI to Applications.

> After that, DevCLI keeps itself up to date — new releases install on the next launch.

---

## ⌨️ Shortcuts

| Key | Action |
|---|---|
| `⌘T` | New terminal tab |
| `⌘W` | Close tab |
| `⌘1…9` | Switch to tab N |
| `⌘E` | Enhance the prompt you're typing (in the terminal) |
| `⌘B` | Toggle the side panel |

Double-click a tab to **rename**, right-click for **pin / color / close**. Double-click an agent or skill to **preview** its file.

---

## 🗃️ How prompts are stored

Each saved prompt is a self-describing markdown file, git-versioned — the files are the source of truth, SQLite is just a search index.

```
<project>/.devcli/prompts/<slug>.md   # per-repo prompts
~/.devcli/prompts/<slug>.md           # global prompts
```

Full spec → [`docs/PROMPT-STORAGE.md`](docs/PROMPT-STORAGE.md).

---

## 🛠️ Tech

**Rust + Tauri v2** (native WebView — light, no bundled Chromium) · **xterm.js + WebGL** terminal · **SQLite + git** storage · **Vite** UI.

Idle footprint ~78 MB (release). Design notes in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · [`docs/DESIGN.md`](docs/DESIGN.md) · [`docs/PRD.md`](docs/PRD.md).

---

## 💻 Develop

```bash
pnpm install
pnpm tauri dev      # run the app (hot-reload UI)
pnpm tauri build    # produce a .dmg / .app
```

Requires Rust, Node 20+, pnpm.

---

## 🚢 Release

Push a version tag — CI (`.github/workflows/release.yml`) builds, signs, and publishes the GitHub Release + `latest.json`:

```bash
# bump version in src-tauri/tauri.conf.json and src-tauri/Cargo.toml
git tag v0.1.2 && git push origin v0.1.2
```

Installed apps auto-update on next launch. *(Signing uses the `TAURI_SIGNING_PRIVATE_KEY` repo secret — keep the private key safe; without it, updates break.)*

---

<div align="center">
<sub>Built with Rust, Tauri, and Claude Code.</sub>
</div>
