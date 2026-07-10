// Sett — surface the user's Claude Code agents and skills in the side panel.
// Reads markdown frontmatter (name/description) from the global (~/.claude) and
// project (<cwd>/.claude) locations.
use std::path::Path;

use serde::Serialize;

#[derive(Serialize)]
pub struct Item {
    pub name: String,
    pub description: String,
    pub scope: String, // "global" | "project"
    pub kind: String,  // "agent" | "skill"
    pub path: String,
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

fn read_agents(dir: &Path, scope: &str, out: &mut Vec<Item>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("md") {
            continue;
        }
        let raw = std::fs::read_to_string(&p).unwrap_or_default();
        let (n, d) = parse_frontmatter(&raw);
        let name = n.unwrap_or_else(|| {
            p.file_stem().and_then(|s| s.to_str()).unwrap_or("agent").to_string()
        });
        out.push(Item {
            name,
            description: truncate(&d.unwrap_or_default(), 160),
            scope: scope.to_string(),
            kind: "agent".to_string(),
            path: p.to_string_lossy().to_string(),
        });
    }
}

fn read_skills(dir: &Path, scope: &str, out: &mut Vec<Item>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for e in entries.flatten() {
        let skill_md = e.path().join("SKILL.md");
        if !skill_md.exists() {
            continue;
        }
        let raw = std::fs::read_to_string(&skill_md).unwrap_or_default();
        let (n, d) = parse_frontmatter(&raw);
        let name = n.unwrap_or_else(|| {
            e.path().file_name().and_then(|s| s.to_str()).unwrap_or("skill").to_string()
        });
        out.push(Item {
            name,
            description: truncate(&d.unwrap_or_default(), 160),
            scope: scope.to_string(),
            kind: "skill".to_string(),
            path: skill_md.to_string_lossy().to_string(),
        });
    }
}

#[tauri::command]
pub fn agents_list() -> Vec<Item> {
    let mut out = Vec::new();
    if let Some(h) = dirs::home_dir() {
        read_agents(&h.join(".claude").join("agents"), "global", &mut out);
    }
    if let Ok(cwd) = std::env::current_dir() {
        read_agents(&cwd.join(".claude").join("agents"), "project", &mut out);
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

#[tauri::command]
pub fn skills_list() -> Vec<Item> {
    let mut out = Vec::new();
    if let Some(h) = dirs::home_dir() {
        read_skills(&h.join(".claude").join("skills"), "global", &mut out);
    }
    if let Ok(cwd) = std::env::current_dir() {
        read_skills(&cwd.join(".claude").join("skills"), "project", &mut out);
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}
