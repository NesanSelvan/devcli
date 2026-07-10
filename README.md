# DevCLI

> Local-first, Warp-styled terminal built for Claude Code vibe coders.
> Every prompt saved. Every session git-versioned. Every agent run rendered beautiful.
> Share prompt-packs with other developers.


## Why

The market splits in two and nobody bridges it:

- **AI terminals** (Warp, Wave, Ghostty+tmux) — pretty, block-based, but agent-agnostic. They don't understand Claude Code's sessions, agents, or tool calls.
- **Claude Code GUIs** (opcode, Conductor, Nimbalyst, Vibe Kanban) — understand sessions, but are desktop apps, not terminals. You lose the raw shell.

DevCLI is a **real terminal** that natively renders Claude Code's inner life (agents, tool calls, todos, diffs) as beautiful blocks — while keeping full shell power. Local-first, **no forced login** (the #1 complaint against Warp).

## Five headline features

1. **Prompt vault (git-native)** — every prompt auto-committed to `.devcli/prompts/`. Searchable, taggable, replayable. `sett share` exports a prompt-pack repo others import.
2. **Session timeline** — parse Claude Code JSONL into a scrubber: prompts, tool calls, file diffs, agent spawns. A replay, not a raw log.
3. **Agent blocks** — subagent/tool runs collapse into labeled cards. Todos render as a live checklist.
4. **Git-diff overlay** — inline before/after per touched file, one-click revert.
5. **Local-first, zero-login** — SQLite + git, no server. Optional sync later.

## Stack

Rust core + Tauri v2 (system webview) + Solid/Svelte UI. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Chosen for **resource efficiency**: ~15 MB webview baseline vs Electron's ~150 MB. Directly beats Warp on RAM.

## Docs

- [docs/PRD.md](docs/PRD.md) — product requirements, personas, scope
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — system design, data model, module tree
- [docs/DESIGN.md](docs/DESIGN.md) — Warp-style visual system (fonts, palette, blocks)
- [docs/ROADMAP.md](docs/ROADMAP.md) — phased milestones

## Status

Pre-code. Architecture + scaffold only.
