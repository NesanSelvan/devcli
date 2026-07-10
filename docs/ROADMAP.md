# Sett — Roadmap

Phased so each milestone is usable on its own. No milestone depends on cloud.

## Phase 0 — Scaffold (this doc set)
- [x] PRD, architecture, design system, roadmap.
- [ ] Tauri + Rust + Vite skeleton builds and opens an empty window.
- [ ] CI: build macOS/Linux, run empty test suite.

## Phase 1 — Real terminal (the floor)
Ship a Warp-styled terminal that runs a real shell. No Claude features yet.
- [ ] `pty/` — spawn shell via portable-pty, read/write/resize.
- [ ] `term/` — feed bytes to `alacritty_terminal`, expose grid to UI.
- [ ] UI grid render (GPU glyph atlas) + input pill.
- [ ] Block segmentation: split stream into command/output cards.
- [ ] Design pass: palette, fonts, block cards (DESIGN.md).
- **Exit:** you can use it as your daily terminal. RAM < 40 MB idle.

## Phase 2 — Claude Code awareness
Make it Claude-Code-native.
- [ ] `pty/session_proc.rs` — launch `claude` inside the PTY.
- [ ] `session/` — notify watcher on `~/.claude/projects/**/*.jsonl`.
- [ ] `session/parser.rs` — JSONL → `SessionEvent` (tolerant, fail-soft).
- [ ] Agent/tool/todo blocks render as collapsible cards.
- **Exit:** running Claude Code shows structured blocks, not raw scrollback.

## Phase 3 — Prompt vault (the headline)
- [ ] `vault/git.rs` + `vault/store.rs` — capture prompt → `.md` + git commit + FTS.
- [ ] Cmd-K palette: fuzzy search, re-run, edit.
- [ ] Tags, recent, left rail.
- **Exit:** every prompt is saved, searchable, re-runnable. Never lose a prompt.

## Phase 4 — Diffs + timeline
- [ ] `diff/` — git diff for agent-touched files, inline before/after.
- [ ] Per-hunk revert (`git apply -R`).
- [ ] Session timeline scrubber / replay.
- **Exit:** review any agent run and revert individual changes fast.

## Phase 5 — Share
- [ ] `vault/pack.rs` — `sett share <tag>` export, `sett import <src>` merge.
- [ ] Pack manifest (`pack.toml`), content-hash de-dup.
- [ ] (Optional) a simple public index / gallery for prompt-packs.
- **Exit:** developers exchange prompt-packs as repos.

## Phase 6 — Polish + platforms
- [ ] Light mode, themes.
- [ ] Linux parity, then Windows.
- [ ] Optional encrypted vault sync (feature-flagged, off by default).
- [ ] Multi-agent worktree kanban (reuses diff + session modules).

## Sequencing logic
Terminal → Claude awareness → vault → diffs → share.
Each phase leaves a shippable tool. Cloud/sync is always last and always optional — the privacy promise (NFR3/NFR4) holds from Phase 1.
