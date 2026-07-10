# DevCLI — Prompt storage

How DevCLI stores a prompt. Same layout for **project** (this repo) and **global**
(across every repo); only the base directory differs.

## Where

| Scope | Base | Vault path |
|---|---|---|
| project | the repo you opened DevCLI in | `<repo>/.devcli/` |
| global | your home | `~/.devcli/` |

Both are real git repos — every save is a commit, so history is auditable and
the folder is portable (copy it, push it, share it).

## Layout

```
<base>/.devcli/
├── prompts/
│   ├── README.md              # explains the format (written on init)
│   └── <slug>.md              # one prompt per file — source of truth, git-tracked
├── devcli.db                    # SQLite index over the files (fast search; rebuildable)
└── .git/                      # one commit per saved prompt
```

The `.md` files are authoritative. `devcli.db` is just an index for instant search
and can be regenerated from the files. `.gitignore` excludes `devcli.db`.

## File format

`<slug>.md` — YAML frontmatter, then the raw prompt body:

```markdown
---
id: 3f2a9c                       # short stable id = first 6 hex of the content hash
title: Add auth to the settings page
slug: add-auth-to-the-settings-3f2a9c
scope: project                   # project | global
source: capture                  # capture | manual | enhanced | imported
session: 612acf0e-18a1-...        # originating Claude Code session (empty if manual)
project: /Users/me/repo          # repo the prompt came from
tags: []
created_at: 2026-07-10T19:20:00Z
updated_at: 2026-07-10T19:20:00Z
uses: 3                          # times re-inserted into a terminal
---

Add authentication to the settings page. Use the existing auth provider,
guard the route, and show a signed-out state.
```

- **slug** = kebab of the title + `-<id>`, so filenames are readable and unique.
- **Dedup** is by content hash — saving the same text twice is a no-op.
- **source** tells you where it came from: `capture` (auto from a live Claude Code
  session), `manual` (you hit Save), `enhanced` (rephrased via ⌘E then saved),
  `imported` (from a shared prompt-pack).

## Sharing (prompt-packs)

`export` copies selected `.md` files plus a `pack.toml` manifest into a folder:

```
mypack/
├── pack.toml        # name, description, version, count
└── prompts/
    └── *.md
```

`import` reads a pack's `prompts/*.md`, strips frontmatter, and re-captures each
into your vault as `source: imported` (dedup by hash). A pack is just a folder or
git repo, so sharing = push/clone.

## Index schema (devcli.db)

```sql
prompts(
  id, pid, slug, title, text, scope, source,
  session, project, hash UNIQUE, created_at, updated_at, uses
)
tags(prompt_id, tag)
```
