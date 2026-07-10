# Sett — Architecture

## 1. Principles

- **Local-first.** SQLite + git on disk. No server in the loop. Network only on explicit `share`/`sync`.
- **Efficient.** System webview (Tauri), not Electron. Reuse the Alacritty VTE crate, don't hand-roll a terminal.
- **Real terminal, not a wrapper.** A true PTY hosts a real shell; Claude Code runs inside it like anywhere else.
- **Observe, don't intercept.** Claude Code already writes structured JSONL. Sett *tails* it for the pretty view — it never needs to fake or proxy the agent protocol.
- **Fail soft.** Unknown JSONL event types render as raw fallback blocks, never crash.

## 2. High-level diagram

```
┌──────────────────────────────────────────────────────────┐
│  UI  (Tauri webview — Solid/Svelte + CSS)                  │
│   • Block list (command / output / tool / agent / diff)    │
│   • Prompt vault palette (Cmd-K)                           │
│   • Session timeline scrubber                              │
│   • Diff overlay + per-hunk revert                        │
│         ▲  IPC (Tauri commands + events)  ▼                │
├──────────────────────────────────────────────────────────┤
│  CORE  (Rust)                                              │
│                                                            │
│  pty ──── portable-pty ── real shell ── claude code proc   │
│   │                                                        │
│  term ─── alacritty_terminal (VTE parse) ── grid state     │
│   │                                                        │
│  session ─ notify watcher on ~/.claude/projects/**/*.jsonl │
│   │        └─ parser → typed SessionEvent stream           │
│   │                                                        │
│  vault ── git2-rs (commit) + SQLite/FTS5 (search)          │
│   │        └─ prompt capture, tag, pack export/import      │
│   │                                                        │
│  diff ──── git2-rs (status/diff/apply -R for revert)       │
└──────────────────────────────────────────────────────────┘
                         ▼ disk
   ~/.claude/projects/**   (read-only tail)
   <repo>/.sett/prompts/   (git-tracked prompt vault)
   <repo>/.sett/sett.db    (SQLite index + FTS)
```

## 3. Rust module tree (`src-tauri/src/`)

```
main.rs            # Tauri bootstrap, command/event registration
pty/
  mod.rs           # spawn shell via portable-pty, resize, write, read loop
  session_proc.rs  # detect & launch `claude` inside the PTY
term/
  mod.rs           # alacritty_terminal Term, feed bytes, expose grid + damage
  blocks.rs        # segment raw stream into command/output blocks (prompt markers)
session/
  mod.rs           # notify watcher on ~/.claude/projects/**/*.jsonl
  parser.rs        # JSONL line -> SessionEvent (typed enum, tolerant)
  model.rs         # SessionEvent: UserPrompt, ToolUse, ToolResult, AgentSpawn,
                   #   Todo, FileEdit, Message, Unknown{raw}
vault/
  mod.rs           # capture prompt -> file + git commit + index row
  store.rs         # SQLite (rusqlite) schema + FTS5 queries
  git.rs           # git2-rs: init .sett, commit, log
  pack.rs          # share/import: manifest + folder <-> tarball/repo
diff/
  mod.rs           # git2 status/diff for agent-touched files
  revert.rs        # `git apply -R` a single hunk
ipc/
  commands.rs      # #[tauri::command] fns called from UI
  events.rs        # emit block/session/diff updates to UI
config.rs          # paths, feature flags (sync off by default), no-telemetry
```

## 4. Data model

### SessionEvent (from Claude Code JSONL)

```rust
enum SessionEvent {
    UserPrompt   { ts, text, session_id },
    Message      { ts, role, text },
    ToolUse      { ts, tool, input, id },
    ToolResult   { ts, id, output, is_error },
    AgentSpawn   { ts, agent_type, prompt, id },
    Todo         { ts, items: Vec<TodoItem> },
    FileEdit     { ts, path, before, after },
    Unknown      { ts, raw: serde_json::Value },   // fail-soft
}
```

The parser reads each JSONL line, matches on `type`/`role`, and maps to the above. Anything unrecognized becomes `Unknown` and renders as a raw fallback block — the app never breaks on a schema change.

### Vault (SQLite)

```sql
CREATE TABLE prompts (
  id         INTEGER PRIMARY KEY,
  slug       TEXT UNIQUE,          -- kebab, also the .md filename
  text       TEXT NOT NULL,
  session_id TEXT,
  project    TEXT,
  git_sha    TEXT,                 -- commit that saved it
  created_at INTEGER
);
CREATE TABLE tags (prompt_id INTEGER, tag TEXT);
CREATE VIRTUAL TABLE prompts_fts USING fts5(text, content='prompts', content_rowid='id');
```

On disk each prompt is also a file: `.sett/prompts/<slug>.md` with YAML frontmatter (tags, session, timestamp). File is source of truth; SQLite is the index. Git versions the folder.

### Prompt-pack (share format)

```
mypack/
  pack.toml           # name, author, description, version, prompt list
  prompts/
    setup-nextjs.md
    add-auth.md
```

`sett share <tag>` collects tagged prompts into this layout (a plain git repo or tarball). `sett import <path|url>` merges them into the local vault, de-duping by content hash.

## 5. Key flows (sequence)

**Prompt capture**
```
UI keypress → pty.write(bytes) → shell/claude receives
session watcher sees new JSONL line (UserPrompt)
 → parser → vault.capture() → write .md + git commit + FTS insert
 → emit "prompt.saved" event → UI toast
```

**Agent block render**
```
JSONL: AgentSpawn / ToolUse / ToolResult
 → session::model events → ipc::events emit "block.append"
 → UI groups by agent id → collapsible card + todo checklist
```

**Diff + revert**
```
FileEdit event → diff::mod computes git diff for path
 → UI shows before/after hunks
 → user clicks Revert → diff::revert git apply -R that hunk
```

## 6. IPC surface (Tauri commands)

```
pty_spawn(shell, cwd) -> pty_id
pty_write(pty_id, bytes)
pty_resize(pty_id, cols, rows)
launch_claude(pty_id, cwd)
vault_search(query, tags) -> [PromptHit]
vault_get(slug) -> Prompt
vault_rerun(slug, pty_id)
pack_export(tag, dest) -> path
pack_import(src) -> count
session_timeline(session_id) -> [SessionEvent]
diff_for_file(path) -> Diff
diff_revert(path, hunk_id)
```

Events emitted to UI: `block.append`, `block.update`, `prompt.saved`, `session.event`, `diff.changed`, `todo.update`.

## 7. Efficiency budget

| Component | Strategy | Target |
|---|---|---|
| UI shell | Tauri system webview | ~15 MB baseline |
| Terminal | `alacritty_terminal` crate, GPU glyph atlas | throughput within 2x Alacritty |
| Session tail | `notify` fs-watch, no polling | near-zero idle CPU |
| Vault search | SQLite FTS5, indexed | < 50 ms @ 10k prompts |
| **Total idle** | | **< 40 MB RAM** (NFR1) |

## 8. Privacy / trust

- No network client compiled into the default build path except the opt-in `sync` feature (Cargo feature flag, off).
- No analytics SDK. `config.telemetry = false` and there's no code path to flip it remotely.
- `sett` reads `~/.claude/projects` read-only. Writes only under `<repo>/.sett/`.
- Core intended open-source so the zero-egress claim is auditable.

## 9. Build / tooling

- `cargo` + `tauri-cli` for the Rust/app side.
- `pnpm` + Vite for the UI.
- `cargo test` for parser/vault; snapshot tests on JSONL fixtures.
- CI: build macOS + Linux, run parser fixtures, check RAM smoke test.

## 10. Extension points (post-v1)

- **Other agents.** `session::parser` is agent-specific; add a `codex.rs` / `gemini.rs` parser behind the same `SessionEvent` enum.
- **Sync.** Optional encrypted vault sync (feature flag) — vault is already git, so this is "push a repo."
- **Multi-agent kanban.** Worktree-per-agent board reusing the diff + session modules.
