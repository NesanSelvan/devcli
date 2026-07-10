# Sett — Product Requirements

## 1. Problem

Vibe coders live in Claude Code but the terminal fights them:

- **Prompts vanish.** Once the initial prompts are lost, projects become nearly unmaintainable. There's no durable, searchable record of *what you asked* and *why*.
- **Agent runs are invisible.** Subagents, tool calls, and diffs scroll past as raw text. Review fatigue is real (PR volume up 40–60% in AI teams).
- **Session history is ugly.** Claude Code writes JSONL to `~/.claude/projects/<proj>/<session>.jsonl`. People built 4+ third-party viewers because raw logs are unreadable.
- **AI terminals are agent-blind.** Warp/Wave render blocks but don't understand Claude Code specifically. They also push cloud/login (privacy backlash on HN).
- **No prompt sharing for CC users.** Prompt libraries exist (PromptHub, Sourcegraph) but none are wired into the Claude Code loop or shareable as a repo.

## 2. Solution

A local-first terminal that:

1. Runs a real shell + Claude Code as a subprocess (real PTY, not a wrapper).
2. Renders Claude Code's session stream as **structured blocks** (prompts, tool calls, agent spawns, diffs, todos).
3. Auto-captures every prompt into a **git-versioned vault** that's searchable and shareable.
4. Stays **light** (Tauri, no Electron) and **private** (no forced login, no telemetry-by-default).

## 3. Target users

| Persona | Need |
|---|---|
| **Solo vibe coder** | Never lose a prompt; see what the agent did; revert bad diffs fast. |
| **Prompt author / creator** | Curate reusable prompt-packs, publish/share them with a community. |
| **Small team** | Share prompt conventions; review agent runs without wading through logs. |

Non-goal: enterprise SSO, cloud multi-tenant, or replacing the IDE. Terminal-first.

## 4. Scope

### In (v1)
- Warp-style block terminal (real PTY, real shell).
- Claude Code launch + JSONL session tailing → block rendering.
- Prompt vault: auto-capture, git commit, full-text search, tags.
- `sett share` / `sett import` prompt-pack format.
- Session timeline / replay view.
- Inline git-diff overlay per agent-touched file + revert.
- Agent/tool blocks (collapsible) + live todo checklist.
- Zero-login, all-local (SQLite + git).

### Out (v1, later)
- Cloud sync / accounts (optional add-on later).
- Multi-agent orchestration / worktree kanban (Conductor territory — phase 3).
- Mobile companion.
- Non-Claude agents (Codex, Gemini) — architecture allows, not v1.

## 5. Key user flows

**Capture & reuse a prompt**
1. User types a prompt to Claude Code in Sett.
2. Sett records it → `.sett/prompts/<slug>.md` + git commit + SQLite index.
3. User later `Cmd-K` → searches vault → re-runs or edits a saved prompt.

**Review an agent run**
1. Claude spawns a subagent / edits files.
2. Sett collapses the run into an **agent block** with a diff summary.
3. User expands → sees per-file before/after → clicks **Revert** on one hunk.

**Share a prompt-pack**
1. User tags a set of prompts `#nextjs-setup`.
2. `sett share nextjs-setup` → exports a self-contained repo (prompts + metadata).
3. Another dev `sett import <url>` → prompts appear in their vault.

## 6. Requirements

### Functional
- FR1 Real PTY hosting an interactive shell; Claude Code runs inside.
- FR2 Tail `~/.claude/projects/**/*.jsonl`; parse into typed events.
- FR3 Every user prompt persisted (file + git + index) within 1 s.
- FR4 Full-text prompt search < 50 ms on 10k prompts (SQLite FTS5).
- FR5 Block rendering: command, output, tool-call, agent, diff, todo.
- FR6 Diff overlay with per-hunk revert (git apply -R).
- FR7 Prompt-pack export/import (portable folder + manifest).
- FR8 Session timeline scrubber.

### Non-functional
- NFR1 **RAM baseline < 40 MB idle** (vs Warp ~150–300 MB). Efficiency is a headline promise.
- NFR2 Cold start < 500 ms.
- NFR3 **No network calls unless the user opts in.** No telemetry by default.
- NFR4 All data local; nothing leaves the machine without explicit `share`/`sync`.
- NFR5 Terminal throughput within 2x of Alacritty (uses its VTE crate).
- NFR6 macOS first; Linux second; Windows later.

## 7. Success metrics

- Prompts captured per active session (target: ~100% of sent prompts).
- Vault re-use rate (prompts re-run / prompts saved).
- Prompt-packs shared/imported.
- Idle RAM stays under budget (NFR1) — this is the differentiator vs Warp.

## 8. Risks

| Risk | Mitigation |
|---|---|
| Claude Code JSONL format changes | Version the parser; tolerate unknown event types; pin to schema, fail soft. |
| Terminal-emulator complexity | Reuse `alacritty_terminal` crate (don't hand-roll VTE). |
| "Just another CC GUI" perception | Lead with terminal + prompt-vault + local-first; those aren't in one tool yet. |
| Privacy trust | Local-only by default; open-source the core; document zero egress. |
