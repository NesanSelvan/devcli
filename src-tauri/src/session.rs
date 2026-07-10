// Sett — Claude Code session awareness.
// Tails ~/.claude/projects/**/*.jsonl (read-only), parses each line into typed
// SessionEvents, streams them to the UI, and captures user prompts into the vault.
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::mpsc::channel;
use std::thread;

use notify::{RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::AppState;

#[derive(Serialize, Clone)]
pub struct TodoItem {
    pub content: String,
    pub status: String,
}

/// One meaningful thing that happened in a Claude Code session.
/// Tagged by `kind` so the UI can switch on it. Unknown lines fail soft.
#[derive(Serialize, Clone)]
#[serde(tag = "kind")]
pub enum SessionEvent {
    UserPrompt { ts: String, text: String, session: String },
    Thinking { ts: String, text: String },
    Assistant { ts: String, text: String },
    ToolUse { ts: String, tool: String, summary: String },
    ToolResult { ts: String, is_error: bool, summary: String },
    Todo { ts: String, items: Vec<TodoItem> },
    Unknown { ts: String, raw: String },
}

#[derive(Serialize)]
pub struct SessionFile {
    pub path: String,
    pub project: String,
    pub modified: u64,
    pub size: u64,
}

pub fn claude_projects_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("projects"))
}

fn truncate(s: &str, n: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= n {
        s.to_string()
    } else {
        s.chars().take(n).collect::<String>() + "…"
    }
}

/// Pull readable text out of a `content` value that may be a string or an
/// array of `{type,text}` / `{type,content}` blocks.
fn flatten_text(v: Option<&serde_json::Value>) -> String {
    match v {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Array(arr)) => arr
            .iter()
            .filter_map(|b| {
                b.get("text")
                    .and_then(|t| t.as_str())
                    .or_else(|| b.get("content").and_then(|t| t.as_str()))
            })
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    }
}

/// Short one-line summary of a tool call's input.
fn tool_summary(tool: &str, input: Option<&serde_json::Value>) -> String {
    let inp = match input {
        Some(i) => i,
        None => return String::new(),
    };
    let key = match tool {
        "Bash" => "command",
        "Read" | "Edit" | "Write" | "NotebookEdit" => "file_path",
        "Grep" | "Glob" => "pattern",
        "WebFetch" | "WebSearch" => "url",
        "Task" | "Agent" => "description",
        _ => "",
    };
    if !key.is_empty() {
        if let Some(s) = inp.get(key).and_then(|v| v.as_str()) {
            return truncate(s, 120);
        }
    }
    truncate(&inp.to_string(), 120)
}

fn parse_todos(input: Option<&serde_json::Value>) -> Vec<TodoItem> {
    input
        .and_then(|i| i.get("todos"))
        .and_then(|t| t.as_array())
        .map(|arr| {
            arr.iter()
                .map(|t| TodoItem {
                    content: t
                        .get("content")
                        .and_then(|c| c.as_str())
                        .unwrap_or("")
                        .to_string(),
                    status: t
                        .get("status")
                        .and_then(|c| c.as_str())
                        .unwrap_or("pending")
                        .to_string(),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Parse one JSONL line into zero or more events. Never panics; bad lines -> [].
pub fn parse_line(line: &str) -> Vec<SessionEvent> {
    let v: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    let ts = v.get("timestamp").and_then(|t| t.as_str()).unwrap_or("").to_string();
    let session = v
        .get("sessionId")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string();
    let typ = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
    let content = v.get("message").and_then(|m| m.get("content"));

    let mut out = Vec::new();
    match (typ, content) {
        ("user", Some(serde_json::Value::String(s))) => {
            out.push(SessionEvent::UserPrompt { ts, text: s.clone(), session });
        }
        ("user", Some(serde_json::Value::Array(blocks))) => {
            for b in blocks {
                match b.get("type").and_then(|t| t.as_str()) {
                    Some("tool_result") => out.push(SessionEvent::ToolResult {
                        ts: ts.clone(),
                        is_error: b.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false),
                        summary: truncate(&flatten_text(b.get("content")), 200),
                    }),
                    Some("text") => {
                        if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                            out.push(SessionEvent::UserPrompt {
                                ts: ts.clone(),
                                text: t.to_string(),
                                session: session.clone(),
                            });
                        }
                    }
                    _ => {}
                }
            }
        }
        ("assistant", Some(serde_json::Value::Array(blocks))) => {
            for b in blocks {
                match b.get("type").and_then(|t| t.as_str()) {
                    Some("thinking") => {
                        if let Some(t) = b.get("thinking").and_then(|t| t.as_str()) {
                            if !t.trim().is_empty() {
                                out.push(SessionEvent::Thinking { ts: ts.clone(), text: t.to_string() });
                            }
                        }
                    }
                    Some("text") => {
                        if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                            if !t.trim().is_empty() {
                                out.push(SessionEvent::Assistant {
                                    ts: ts.clone(),
                                    text: t.to_string(),
                                });
                            }
                        }
                    }
                    Some("tool_use") => {
                        let tool = b.get("name").and_then(|t| t.as_str()).unwrap_or("tool").to_string();
                        if tool == "TodoWrite" {
                            out.push(SessionEvent::Todo {
                                ts: ts.clone(),
                                items: parse_todos(b.get("input")),
                            });
                        } else {
                            out.push(SessionEvent::ToolUse {
                                ts: ts.clone(),
                                summary: tool_summary(&tool, b.get("input")),
                                tool,
                            });
                        }
                    }
                    _ => {}
                }
            }
        }
        _ => {} // summary/system/other -> ignored quietly
    }
    out
}

fn list_jsonl(dir: &Path) -> Vec<PathBuf> {
    walkdir::WalkDir::new(dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("jsonl"))
        .map(|e| e.path().to_path_buf())
        .collect()
}

/// Read bytes appended since the last offset, parse, emit, capture prompts.
fn read_new(app: &AppHandle, path: &Path, offsets: &mut HashMap<PathBuf, u64>) {
    let mut file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return,
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mut start = *offsets.get(path).unwrap_or(&0);
    if len < start {
        start = 0; // file was rotated/truncated
    }
    if file.seek(SeekFrom::Start(start)).is_err() {
        return;
    }
    let mut buf = String::new();
    if file.read_to_string(&mut buf).is_err() {
        return;
    }
    // only advance to the last complete line so a half-written line is retried
    let advance = match buf.rfind('\n') {
        Some(i) => i + 1,
        None => {
            return; // no complete line yet
        }
    };
    offsets.insert(path.to_path_buf(), start + advance as u64);

    for line in buf[..advance].lines() {
        if line.trim().is_empty() {
            continue;
        }
        for ev in parse_line(line) {
            // pure live feed — no vault writes (prompts are saved intentionally only)
            let _ = app.emit("session-event", &ev);
        }
    }
}

fn watch_loop(app: AppHandle, dir: PathBuf) {
    let (tx, rx) = channel();
    let mut watcher = match notify::recommended_watcher(move |res| {
        let _ = tx.send(res);
    }) {
        Ok(w) => w,
        Err(_) => return,
    };
    if watcher.watch(&dir, RecursiveMode::Recursive).is_err() {
        return;
    }

    // seed offsets at current EOF so we only stream *new* activity
    let mut offsets: HashMap<PathBuf, u64> = HashMap::new();
    for path in list_jsonl(&dir) {
        if let Ok(meta) = std::fs::metadata(&path) {
            offsets.insert(path, meta.len());
        }
    }

    // `watcher` stays owned here, alive for the life of the loop
    for res in rx {
        if let Ok(event) = res {
            for path in event.paths {
                if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                    read_new(&app, &path, &mut offsets);
                }
            }
        }
    }
}

/// Start streaming live Claude Code session activity to the UI.
#[tauri::command]
pub fn session_watch(app: AppHandle) -> Result<(), String> {
    let dir = claude_projects_dir().ok_or("no home dir")?;
    if !dir.exists() {
        return Err(format!("{} not found", dir.display()));
    }
    thread::spawn(move || watch_loop(app, dir));
    Ok(())
}

/// List the most recent session files (for the timeline picker).
#[tauri::command]
pub fn session_list() -> Result<Vec<SessionFile>, String> {
    let dir = claude_projects_dir().ok_or("no home dir")?;
    let mut files = Vec::new();
    for path in list_jsonl(&dir) {
        let meta = match std::fs::metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let modified = meta
            .modified()
            .ok()
            .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let project = path
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        files.push(SessionFile {
            path: path.to_string_lossy().to_string(),
            project,
            modified,
            size: meta.len(),
        });
    }
    files.sort_by(|a, b| b.modified.cmp(&a.modified));
    files.truncate(50);
    Ok(files)
}

/// Fully parse one session file into an event list (timeline replay).
#[tauri::command]
pub fn session_load(path: String) -> Result<Vec<SessionEvent>, String> {
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for line in content.lines() {
        if !line.trim().is_empty() {
            out.extend(parse_line(line));
        }
    }
    Ok(out)
}

// ---- prompt-folder watching (project <cwd>/.sett/prompts + global ~/.sett/prompts) ----
// Anything dropped here — saved by the user, written by Claude, or from a pack —
// gets indexed and shown in the Prompts panel.

fn prompt_dirs() -> (PathBuf, Option<PathBuf>) {
    let proj = std::env::current_dir()
        .unwrap_or_default()
        .join(".devcli")
        .join("prompts");
    let glob = dirs::home_dir().map(|h| h.join(".devcli").join("prompts"));
    (proj, glob)
}

fn reindex_all(app: &AppHandle) {
    let state = app.state::<AppState>();
    let _ = state.project.lock().unwrap().ingest_dir();
    let _ = state.global.lock().unwrap().ingest_dir();
    let _ = app.emit("prompts-changed", ());
}

fn prompt_watch_loop(app: AppHandle) {
    let (proj, glob) = prompt_dirs();
    let _ = std::fs::create_dir_all(&proj);
    if let Some(g) = &glob {
        let _ = std::fs::create_dir_all(g);
    }
    reindex_all(&app);

    let (tx, rx) = channel();
    let mut watcher = match notify::recommended_watcher(move |res| {
        let _ = tx.send(res);
    }) {
        Ok(w) => w,
        Err(_) => return,
    };
    let _ = watcher.watch(&proj, RecursiveMode::NonRecursive);
    if let Some(g) = &glob {
        let _ = watcher.watch(g, RecursiveMode::NonRecursive);
    }

    for res in rx {
        let event = match res {
            Ok(e) => e,
            Err(_) => continue,
        };
        let mut touched = false;
        for p in event.paths {
            if p.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let state = app.state::<AppState>();
            let in_global = glob.as_ref().map(|g| p.starts_with(g)).unwrap_or(false);
            let added = if in_global {
                state.global.lock().unwrap().ingest_file(&p).unwrap_or(false)
            } else {
                state.project.lock().unwrap().ingest_file(&p).unwrap_or(false)
            };
            touched = touched || added;
        }
        if touched {
            let _ = app.emit("prompts-changed", ());
        }
    }
}

/// Start indexing + watching the prompt folders. Emits `prompts-changed` on updates.
#[tauri::command]
pub fn prompts_watch(app: AppHandle) -> Result<(), String> {
    thread::spawn(move || prompt_watch_loop(app));
    Ok(())
}
