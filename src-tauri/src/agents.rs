// DevCLI — surface the user's Claude Code agents and skills in the side panel.
// Reads markdown frontmatter (name/description) from the global (~/.claude) and
// project (<cwd>/.claude) locations.
use std::path::Path;

use serde::Serialize;
use walkdir::WalkDir;

#[derive(Serialize)]
pub struct Item {
    pub name: String,
    pub description: String,
    pub scope: String, // "global" | "project"
    pub kind: String,  // "agent" | "skill" | "task"
    pub path: String,
    pub mtime: u64, // last-modified epoch secs
}

fn mtime_of(p: &Path) -> u64 {
    std::fs::metadata(p)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn truncate(s: &str, n: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= n {
        s.to_string()
    } else {
        s.chars().take(n).collect::<String>() + "…"
    }
}

/// Pull `name:` and `description:` out of a leading `---` YAML frontmatter block.
fn parse_frontmatter(raw: &str) -> (Option<String>, Option<String>) {
    let rest = match raw.strip_prefix("---\n") {
        Some(r) => r,
        None => return (None, None),
    };
    let end = match rest.find("\n---") {
        Some(e) => e,
        None => return (None, None),
    };
    let mut name = None;
    let mut desc = None;
    for line in rest[..end].lines() {
        let t = line.trim();
        if let Some(v) = t.strip_prefix("name:") {
            name = Some(v.trim().trim_matches('"').trim_matches('\'').to_string());
        } else if let Some(v) = t.strip_prefix("description:") {
            desc = Some(v.trim().trim_matches('"').trim_matches('\'').to_string());
        }
    }
    (name, desc)
}

// Walk the agents dir (and any subfolders — plugins/namespaces) for `*.md`
// agent definitions. Only files with YAML frontmatter count, so stray docs
// (README, notes) are skipped.
fn read_agents(dir: &Path, scope: &str, out: &mut Vec<Item>) {
    for entry in WalkDir::new(dir).max_depth(6).into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        let p = entry.path();
        if p.extension().and_then(|x| x.to_str()) != Some("md") {
            continue;
        }
        let fname = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if fname.eq_ignore_ascii_case("README.md") {
            continue;
        }
        let raw = std::fs::read_to_string(p).unwrap_or_default();
        let (n, d) = parse_frontmatter(&raw);
        if n.is_none() && d.is_none() {
            continue; // no frontmatter → not an agent definition
        }
        let name = n.unwrap_or_else(|| {
            p.file_stem().and_then(|s| s.to_str()).unwrap_or("agent").to_string()
        });
        out.push(Item {
            name,
            description: truncate(&d.unwrap_or_default(), 160),
            scope: scope.to_string(),
            kind: "agent".to_string(),
            path: p.to_string_lossy().to_string(),
            mtime: mtime_of(p),
        });
    }
}

// Walk the skills dir (and subfolders) for any `SKILL.md` at any depth.
fn read_skills(dir: &Path, scope: &str, out: &mut Vec<Item>) {
    for entry in WalkDir::new(dir).max_depth(8).into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() || entry.file_name() != "SKILL.md" {
            continue;
        }
        let skill_md = entry.path();
        let raw = std::fs::read_to_string(skill_md).unwrap_or_default();
        let (n, d) = parse_frontmatter(&raw);
        let name = n.unwrap_or_else(|| {
            skill_md
                .parent()
                .and_then(|d| d.file_name())
                .and_then(|s| s.to_str())
                .unwrap_or("skill")
                .to_string()
        });
        out.push(Item {
            name,
            description: truncate(&d.unwrap_or_default(), 160),
            scope: scope.to_string(),
            kind: "skill".to_string(),
            path: skill_md.to_string_lossy().to_string(),
            mtime: mtime_of(skill_md),
        });
    }
}

#[tauri::command]
pub fn agents_list(state: tauri::State<'_, crate::AppState>) -> Vec<Item> {
    let mut out = Vec::new();
    if let Some(h) = dirs::home_dir() {
        read_agents(&h.join(".claude").join("agents"), "global", &mut out);
    }
    read_agents(&state.dir().join(".claude").join("agents"), "project", &mut out);
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

#[tauri::command]
pub fn skills_list(state: tauri::State<'_, crate::AppState>) -> Vec<Item> {
    let mut out = Vec::new();
    if let Some(h) = dirs::home_dir() {
        read_skills(&h.join(".claude").join("skills"), "global", &mut out);
    }
    read_skills(&state.dir().join(".claude").join("skills"), "project", &mut out);
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}
