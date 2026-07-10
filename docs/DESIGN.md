# Sett — Visual Design (Warp-style)

Goal: the polish and font feel of warp.dev, adapted to a Claude-Code-native block terminal.

## 1. Typography

| Role | Font | Notes |
|---|---|---|
| Headings / brand | **Space Grotesk** | Geometric sans, the Warp marketing feel. |
| UI body / labels | **Inter** | Neutral, legible at small sizes. |
| Terminal / mono | **JetBrains Mono** | Free, ligatures, closest to Warp's default (Hack). |

- Terminal size: `13–14px`, line-height `1.5`.
- UI body: `13px`. Headings: `18–24px`, weight `500–600`.
- Enable mono ligatures in the terminal grid.

## 2. Color palette (Warp deep-space dark)

```css
:root {
  --bg-base:    #0C0C15;  /* near-black navy — app background */
  --bg-panel:   #16161E;  /* blocks, sidebars */
  --bg-elev:    #1E1E2A;  /* hover / elevated */
  --border:     #2A2A3C;  /* 1px hairlines */
  --text:       #E4E4F0;  /* primary */
  --text-dim:   #8A8AA0;  /* secondary / timestamps */
  --accent:     #A970FF;  /* signature purple */
  --accent-2:   #14B8C4;  /* teal / cyan */
  --success:    #4ADE80;
  --warn:       #FBBF24;
  --error:      #F87171;
  /* brand gradient */
  --grad: linear-gradient(135deg, #A970FF 0%, #14B8C4 100%);
}
```

Light mode later; dark is the hero.

## 3. Blocks (the core visual metaphor)

Each command + its output is a **card**, like Warp's blocks — but Sett adds Claude-Code block types.

```
┌─ prompt ─────────────────────────────────┐   ← accent-1 left bar
│  ▍ "add auth to the settings page"        │   saved ✓  #auth
└───────────────────────────────────────────┘

┌─ agent · code-reviewer ──────────────  ▸ ─┐   ← collapsible
│  ran 3 tools · edited 2 files · 4.2s      │
└───────────────────────────────────────────┘

┌─ diff · src/auth.ts ──────────────  revert ┐
│  - const t = expiry < now                  │   red/green hunks
│  + const t = expiry <= now                 │
└───────────────────────────────────────────┘

┌─ todo ────────────────────────────────────┐
│  ☑ read settings page   ☐ wire provider    │
└───────────────────────────────────────────┘
```

Rules:
- `border-radius: 10px`, `1px solid var(--border)`, `padding: 12–16px`.
- Active/running block: left accent bar (3px, `--accent`), soft glow.
- Hover: lift to `--bg-elev`, subtle shadow `0 4px 16px rgba(0,0,0,.3)`.
- Block header: dim label + type icon + right-aligned meta (time, tags, actions).
- Tool/agent blocks collapse by default when successful; expand on click.

## 4. Block type styling

| Type | Left bar | Icon | Collapsed default |
|---|---|---|---|
| prompt | `--accent` | ▍ | no |
| output | none | – | no |
| tool-use | `--accent-2` | ⚙ | yes (if ok) |
| agent | `--accent` | ◆ | yes |
| diff | `--warn` | ± | no |
| todo | `--success` | ☑ | no |
| error | `--error` | ✕ | no |

## 5. Layout

```
┌───────────────────────────────────────────────┐
│  ● ● ●   sett — ~/projects/app     [session ▾] │  titlebar
├──────────┬────────────────────────────────────┤
│ vault    │  block list (scroll)                │
│ #auth    │                                     │
│ #nextjs  │  … blocks …                         │
│ recent   │                                     │
│          ├────────────────────────────────────┤
│          │  ▍ input pill        [gradient ring]│  prompt input
└──────────┴────────────────────────────────────┘
                                       [timeline ▸]  scrubber (toggle)
```

- Left rail: prompt vault (tags + recent), collapsible.
- Center: block list.
- Bottom: rounded input pill; focus = gradient ring (`--grad`).
- Optional bottom timeline scrubber for session replay.

## 6. Motion

- Block append: fade + 4px rise, `150ms ease-out`.
- Collapse/expand: height + opacity, `120ms`.
- Saved-prompt toast: slide from bottom-right, auto-dismiss `2s`.
- Keep it subtle — snappy over flashy. Efficiency ethos applies to animation too.

## 7. Command palette (Cmd-K)

- Center-screen, `--bg-panel`, `border-radius: 12px`, gradient top hairline.
- Fuzzy search over vault prompts (FTS-backed) + commands.
- Rows: prompt title, dim snippet, tags, "run / edit / share" actions.

## 8. Assets to source

- Fonts: Space Grotesk, Inter, JetBrains Mono (all OFL/free) — bundle locally, no CDN (privacy).
- Icons: a lightweight set (Lucide) or hand-drawn SVGs for block types.
