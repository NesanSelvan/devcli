// DevCLI — local-first, Warp-styled terminal for Claude Code vibe coders.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agents;
mod session;
mod vault;

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::Mutex;
use std::thread;

use base64::Engine;

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use vault::{PromptHit, Vault};

/// One live PTY: master (resize) + writer (input) + the shell's pid.
struct Pty {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child_pid: Option<u32>,
}

pub struct AppState {
    ptys: Mutex<HashMap<String, Pty>>,
    /// the folder the panel is scoped to (follows the active terminal's cwd)
    pub project_dir: Mutex<PathBuf>,
    /// prompts saved in the current project folder (<dir>/.devcli)
    pub project: Mutex<Vault>,
    /// prompts shared across every project (~/.devcli)
    pub global: Mutex<Vault>,
}

fn lastdir_file() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".devcli").join("lastdir"))
}

impl AppState {
    fn new() -> Self {
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
        let launch = std::env::current_dir().unwrap_or_else(|_| home.clone());
        // start in the last folder used (persisted), else the launch dir
        let start = lastdir_file()
            .and_then(|f| std::fs::read_to_string(f).ok())
            .map(|s| PathBuf::from(s.trim()))
            .filter(|p| p.is_dir())
            .unwrap_or(launch);
        let project = Vault::open(&start, "project").unwrap_or_else(|e| {
            eprintln!("[devcli] project vault failed: {e}");
            Vault::open(&std::env::temp_dir().join("devcli-proj"), "project").expect("tmp vault")
        });
        let global = Vault::open(&home, "global").unwrap_or_else(|e| {
            eprintln!("[devcli] global vault failed: {e}");
            Vault::open(&std::env::temp_dir().join("devcli-global"), "global").expect("tmp vault")
        });
        AppState {
            ptys: Mutex::new(HashMap::new()),
            project_dir: Mutex::new(start),
            project: Mutex::new(project),
            global: Mutex::new(global),
        }
    }

    /// Re-scope the panel to `dir`: re-open the project vault, index prompts, remember it.
    fn set_dir(&self, dir: &std::path::Path) {
        *self.project_dir.lock().unwrap() = dir.to_path_buf();
        if let Some(f) = lastdir_file() {
            if let Some(parent) = f.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::write(&f, dir.to_string_lossy().as_bytes());
        }
        if let Ok(mut v) = Vault::open(dir, "project") {
            v.ingest_dir();
            *self.project.lock().unwrap() = v;
        }
    }
    pub fn dir(&self) -> PathBuf {
        self.project_dir.lock().unwrap().clone()
    }

    fn vault_for(&self, scope: &str) -> &Mutex<Vault> {
        if scope == "global" {
            &self.global
        } else {
            &self.project
        }
    }
}

#[derive(Clone, Serialize)]
struct PtyChunk {
    id: String,
    data: String, // base64 of the coalesced PTY bytes
}
#[derive(Clone, Serialize)]
struct PtyId {
    id: String,
}

// ---- terminal (multi-pane, keyed by id) ----

#[tauri::command]
fn pty_spawn(app: AppHandle, state: State<'_, AppState>, id: String, rows: u16, cols: u16, cwd: Option<String>) -> Result<(), String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut cmd = CommandBuilder::new(shell);
    // restore into the pane's saved folder if given + still valid, else the last-used folder
    let start = cwd
        .map(std::path::PathBuf::from)
        .filter(|p| p.is_dir())
        .unwrap_or_else(|| state.dir());
    cmd.cwd(start);
    cmd.env("TERM", "xterm-256color");
    // Advertise Kitty keyboard-protocol support so Claude Code turns it on and
    // reads Shift+Enter (CSI 13;2u, sent by the frontend) as a newline instead
    // of submit. Claude's detection skips the KITTY_WINDOW_ID signal when
    // TERM_PROGRAM names an unknown terminal, so drop any value leaked from the
    // launch env (Finder/iTerm/VSCode) before advertising.
    cmd.env_remove("TERM_PROGRAM");
    cmd.env_remove("TERM_PROGRAM_VERSION");
    cmd.env("KITTY_WINDOW_ID", "1");

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let child_pid = child.process_id();
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    state
        .ptys
        .lock()
        .unwrap()
        .insert(id.clone(), Pty { master: pair.master, writer, child_pid });

    // Reader thread: pull raw bytes off the PTY and hand each chunk to the
    // emitter. Reading and emitting are split so a slow IPC hop never stalls the
    // read — bursts pile up in the channel and get coalesced below.
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break, // EOF / shell hung up
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break; // emitter gone
                    }
                }
            }
        }
        // dropping tx closes the channel → emitter drains + exits
    });

    // Emitter thread: coalesce a burst of reads into ONE event. recv() blocks for
    // the first chunk (idle = immediate, low latency); try_recv() then drains
    // whatever else queued while the last emit was in flight (flood = batched),
    // capped so one event never gets unboundedly large. Payload is base64 — a
    // Vec<u8> over Tauri's JSON bridge bloats to a number-array (~4-6× the bytes).
    const COALESCE_CAP: usize = 256 * 1024;
    thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            let mut batch = first;
            while batch.len() < COALESCE_CAP {
                match rx.try_recv() {
                    Ok(more) => batch.extend_from_slice(&more),
                    Err(_) => break,
                }
            }
            let data = base64::engine::general_purpose::STANDARD.encode(&batch);
            let _ = app.emit("pty-data", PtyChunk { id: id.clone(), data });
        }
        let _ = child.wait();
        let _ = app.emit("pty-exit", PtyId { id: id.clone() });
    });

    Ok(())
}

#[tauri::command]
fn pty_write(state: State<'_, AppState>, id: String, data: String) -> Result<(), String> {
    if let Some(pty) = state.ptys.lock().unwrap().get_mut(&id) {
        pty.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        pty.writer.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn pty_resize(state: State<'_, AppState>, id: String, rows: u16, cols: u16) -> Result<(), String> {
    if let Some(pty) = state.ptys.lock().unwrap().get(&id) {
        pty.master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn pty_close(state: State<'_, AppState>, id: String) {
    state.ptys.lock().unwrap().remove(&id); // dropping the master hangs up the shell
}

/// Current working directory of a terminal's shell (so the panel can follow `cd`).
fn shell_cwd(pid: u32) -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("lsof")
            .args(["-a", "-d", "cwd", "-p", &pid.to_string(), "-Fn"])
            .output()
            .ok()?;
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .find_map(|l| l.strip_prefix('n').map(|p| p.to_string()))
    }
    #[cfg(not(target_os = "macos"))]
    {
        std::fs::read_link(format!("/proc/{pid}/cwd")).ok().map(|p| p.to_string_lossy().to_string())
    }
}

/// Async + off-thread: `lsof` is slow, and a sync command would run it on the
/// main thread — freezing the UI on every tab switch (syncProjectDir calls this).
#[tauri::command]
async fn pty_cwd(state: State<'_, AppState>, id: String) -> Result<Option<String>, String> {
    let pid = state.ptys.lock().unwrap().get(&id).and_then(|p| p.child_pid);
    match pid {
        Some(pid) => tauri::async_runtime::spawn_blocking(move || shell_cwd(pid))
            .await
            .map_err(|e| e.to_string()),
        None => Ok(None),
    }
}

/// True if the terminal's shell has a descendant process running Claude Code
/// (used to warn on quit + mark panes to auto-resume with `claude --continue`).
fn has_claude_descendant(root: u32) -> bool {
    let out = match std::process::Command::new("ps").args(["-Ao", "pid=,ppid=,command="]).output() {
        Ok(o) => o,
        Err(_) => return false,
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    let mut cmd: HashMap<u32, String> = HashMap::new();
    for line in text.lines() {
        let toks: Vec<&str> = line.split_whitespace().collect();
        if toks.len() < 3 {
            continue;
        }
        if let (Ok(pid), Ok(ppid)) = (toks[0].parse::<u32>(), toks[1].parse::<u32>()) {
            children.entry(ppid).or_default().push(pid);
            cmd.insert(pid, toks[2..].join(" "));
        }
    }
    let mut stack = vec![root];
    let mut seen = std::collections::HashSet::new();
    while let Some(p) = stack.pop() {
        if !seen.insert(p) {
            continue;
        }
        if p != root {
            if let Some(c) = cmd.get(&p) {
                if c.to_lowercase().contains("claude") {
                    return true;
                }
            }
        }
        if let Some(kids) = children.get(&p) {
            stack.extend(kids);
        }
    }
    false
}

/// Async + off-thread: scans the whole process table via `ps`; must not block
/// the main thread (called on every tab switch + on a 2.5s interval).
#[tauri::command]
async fn pty_has_claude(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    let pid = state.ptys.lock().unwrap().get(&id).and_then(|p| p.child_pid);
    match pid {
        Some(pid) => tauri::async_runtime::spawn_blocking(move || has_claude_descendant(pid))
            .await
            .map_err(|e| e.to_string()),
        None => Ok(false),
    }
}

/// True if the shell has a foreground child process — i.e. a command is running
/// (at an idle prompt zsh/bash have no children). Used to warn before closing.
fn has_child_process(root: u32) -> bool {
    let out = match std::process::Command::new("ps").args(["-Ao", "ppid="]).output() {
        Ok(o) => o,
        Err(_) => return false,
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .any(|l| l.trim().parse::<u32>() == Ok(root))
}

/// Async + off-thread: also a `ps` scan — keep it off the main thread.
#[tauri::command]
async fn pty_busy(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    let pid = state.ptys.lock().unwrap().get(&id).and_then(|p| p.child_pid);
    match pid {
        Some(pid) => tauri::async_runtime::spawn_blocking(move || has_child_process(pid))
            .await
            .map_err(|e| e.to_string()),
        None => Ok(false),
    }
}

/// Current git branch for a folder (drives the terminal's context-chip bar).
/// None when the folder isn't a repo or git is unavailable.
fn git_branch_blocking(path: &str) -> Option<String> {
    let out = std::process::Command::new("git")
        .args(["-C", path, "rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let b = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if b.is_empty() { None } else { Some(b) }
}

/// Async + off-thread: spawns `git`; runs on every tab switch, so keep it off
/// the main thread.
#[tauri::command]
async fn git_branch(path: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || git_branch_blocking(&path))
        .await
        .map_err(|e| e.to_string())
}

/// Re-scope the panel (prompts/notes/agents/skills/mcp) to a folder.
#[tauri::command]
fn set_project_dir(state: State<'_, AppState>, path: String) {
    let p = std::path::PathBuf::from(&path);
    if p.is_dir() {
        state.set_dir(&p);
    }
}

// ---- prompts (dual scope: project + global) ----

#[tauri::command]
fn prompts_search(state: State<'_, AppState>, query: String) -> Result<Vec<PromptHit>, String> {
    let mut hits = state.project.lock().unwrap().search(&query)?;
    hits.extend(state.global.lock().unwrap().search(&query)?);
    hits.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(hits)
}

#[tauri::command]
fn prompts_get(state: State<'_, AppState>, scope: String, slug: String) -> Result<String, String> {
    state.vault_for(&scope).lock().unwrap().get(&slug)
}

#[tauri::command]
fn prompts_save(state: State<'_, AppState>, scope: String, text: String, source: Option<String>) -> Result<(), String> {
    let src = source.unwrap_or_else(|| "manual".into());
    state.vault_for(&scope).lock().unwrap().capture(&text, "", &src)
}

#[tauri::command]
fn prompts_tag(state: State<'_, AppState>, scope: String, slug: String, tag: String) -> Result<(), String> {
    state.vault_for(&scope).lock().unwrap().tag(&slug, &tag)
}

#[tauri::command]
fn prompts_delete(state: State<'_, AppState>, scope: String, slug: String) -> Result<(), String> {
    state.vault_for(&scope).lock().unwrap().delete(&slug)
}

#[tauri::command]
fn prompts_set_title(state: State<'_, AppState>, scope: String, slug: String, title: String) -> Result<(), String> {
    state.vault_for(&scope).lock().unwrap().set_title(&slug, &title)
}

// ---- notes / tasks / links (project scope) ----

#[tauri::command]
fn notes_add(state: State<'_, AppState>, kind: String, text: String, url: String) -> Result<(), String> {
    state.project.lock().unwrap().note_add(&kind, &text, &url)
}

#[tauri::command]
fn notes_list(state: State<'_, AppState>) -> Result<Vec<vault::Note>, String> {
    state.project.lock().unwrap().note_list()
}

#[tauri::command]
fn notes_toggle(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    state.project.lock().unwrap().note_toggle(id)
}

#[tauri::command]
fn notes_delete(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    state.project.lock().unwrap().note_delete(id)
}

#[tauri::command]
fn notes_pin(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    state.project.lock().unwrap().note_pin(id)
}

#[tauri::command]
fn notes_collapse(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    state.project.lock().unwrap().note_collapse(id)
}

#[tauri::command]
fn notes_reorder(state: State<'_, AppState>, ids: Vec<i64>) -> Result<(), String> {
    state.project.lock().unwrap().note_reorder(ids)
}

#[tauri::command]
fn notes_set_title(state: State<'_, AppState>, id: i64, title: String) -> Result<(), String> {
    state.project.lock().unwrap().note_set_title(id, &title)
}

// ---- groups + hide (prompts / agents / skills) ----

#[tauri::command]
fn groups_add(state: State<'_, AppState>, kind: String, name: String) -> Result<(), String> {
    state.project.lock().unwrap().group_add(&kind, &name)
}

#[tauri::command]
fn groups_list(state: State<'_, AppState>, kind: String) -> Result<Vec<String>, String> {
    state.project.lock().unwrap().group_list(&kind)
}

#[tauri::command]
fn groups_delete(state: State<'_, AppState>, kind: String, name: String) -> Result<(), String> {
    state.project.lock().unwrap().group_delete(&kind, &name)
}

#[tauri::command]
fn item_set_group(state: State<'_, AppState>, kind: String, item_id: String, group: String) -> Result<(), String> {
    state.project.lock().unwrap().item_set_group(&kind, &item_id, &group)
}

#[tauri::command]
fn item_hide(state: State<'_, AppState>, kind: String, item_id: String, hidden: bool) -> Result<(), String> {
    state.project.lock().unwrap().item_hide(&kind, &item_id, hidden)
}

#[tauri::command]
fn item_meta_list(state: State<'_, AppState>, kind: String) -> Result<Vec<vault::ItemMeta>, String> {
    state.project.lock().unwrap().item_meta_list(&kind)
}

/// Read a local doc (skill/agent markdown) for the peek preview.
#[tauri::command]
fn read_doc(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Expand a leading `~` / `~/` to the user's home dir. Shells print home-relative
/// paths constantly; without this they resolve to a bogus absolute path.
fn expand_home(path: &str) -> std::path::PathBuf {
    if path == "~" || path.starts_with("~/") {
        if let Ok(home) = std::env::var("HOME") {
            let rest = path.trim_start_matches('~').trim_start_matches('/');
            return std::path::Path::new(&home).join(rest);
        }
    }
    std::path::PathBuf::from(path)
}

/// Read a text file for the side-panel preview. Relative paths resolve against
/// the active project dir. Rejects oversized / binary files.
#[tauri::command]
fn read_file(state: State<'_, AppState>, path: String) -> Result<String, String> {
    let pb = expand_home(&path);
    let full = if pb.is_absolute() { pb } else { state.dir().join(pb) };
    let meta = std::fs::metadata(&full).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a file".into());
    }
    if meta.len() > 1_048_576 {
        return Err(format!("file too large to preview ({} KB)", meta.len() / 1024));
    }
    let bytes = std::fs::read(&full).map_err(|e| e.to_string())?;
    if bytes.iter().take(8000).any(|&b| b == 0) {
        return Err("binary file — can't preview".into());
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Open a URL in the user's default browser.
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    std::process::Command::new(opener).arg(&url).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

/// Reveal a file in Finder / the system file manager. Relative paths resolve
/// against the active project dir (same rule as read_file).
#[tauri::command]
fn reveal_file(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let pb = expand_home(&path);
    let full = if pb.is_absolute() { pb } else { state.dir().join(pb) };
    if !full.exists() {
        return Err(format!("not found: {}", full.display()));
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R") // reveal + select in Finder
            .arg(&full)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        // no portable "reveal"; open the containing folder
        let dir = full.parent().unwrap_or(&full);
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---- MCP servers (from ~/.claude.json and ./.mcp.json) ----

#[derive(Serialize)]
struct McpItem {
    name: String,
    scope: String,
    kind: String,
    detail: String,
}

fn parse_mcp(v: &serde_json::Value, scope: &str, out: &mut Vec<McpItem>) {
    let obj = match v.get("mcpServers").and_then(|m| m.as_object()) {
        Some(o) => o,
        None => return,
    };
    for (name, cfg) in obj {
        let kind = cfg
            .get("type")
            .and_then(|t| t.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| if cfg.get("url").is_some() { "http".into() } else { "stdio".into() });
        let detail = if let Some(url) = cfg.get("url").and_then(|u| u.as_str()) {
            url.to_string()
        } else {
            let cmd = cfg.get("command").and_then(|c| c.as_str()).unwrap_or("");
            let args = cfg
                .get("args")
                .and_then(|a| a.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(" "))
                .unwrap_or_default();
            format!("{cmd} {args}").trim().to_string()
        };
        out.push(McpItem { name: name.clone(), scope: scope.into(), kind, detail });
    }
}

#[tauri::command]
fn mcp_list(state: State<'_, AppState>) -> Vec<McpItem> {
    let mut out = Vec::new();
    let cwd = state.dir();
    if let Some(home) = dirs::home_dir() {
        if let Ok(txt) = std::fs::read_to_string(home.join(".claude.json")) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
                parse_mcp(&v, "global", &mut out);
                if let Some(proj) = v.get("projects").and_then(|p| p.get(cwd.to_string_lossy().as_ref())) {
                    parse_mcp(proj, "project", &mut out);
                }
            }
        }
    }
    // any `.mcp.json` in the project dir or its subfolders (monorepo subprojects)
    const SKIP: &[&str] = &["node_modules", "target", "dist", "build", ".git", ".next", "vendor"];
    for entry in walkdir::WalkDir::new(&cwd)
        .max_depth(5)
        .into_iter()
        .filter_entry(|e| {
            if e.depth() == 0 {
                return true;
            }
            let n = e.file_name().to_string_lossy();
            !(e.file_type().is_dir() && SKIP.contains(&n.as_ref()))
        })
        .filter_map(|e| e.ok())
    {
        if entry.file_type().is_file() && entry.file_name() == ".mcp.json" {
            if let Ok(txt) = std::fs::read_to_string(entry.path()) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
                    parse_mcp(&v, "project", &mut out);
                }
            }
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out.dedup_by(|a, b| a.name == b.name);
    out
}

#[tauri::command]
fn prompts_export(state: State<'_, AppState>, scope: String, tag: String, dest: String) -> Result<usize, String> {
    state.vault_for(&scope).lock().unwrap().export_pack(&tag, std::path::Path::new(&dest))
}

#[tauri::command]
fn prompts_import(state: State<'_, AppState>, scope: String, src: String) -> Result<usize, String> {
    state.vault_for(&scope).lock().unwrap().import_pack(std::path::Path::new(&src))
}

// ---- rephrase (uses the user's local `claude` CLI in print mode; no API key) ----

fn build_meta(draft: &str, base: Option<&str>, kind: &str) -> String {
    let is_note = kind == "note";
    match base {
        Some(b) if !b.trim().is_empty() => {
            let subject = if is_note { "note editor" } else { "prompt editor" };
            let note_rule = if is_note {
                " Keep the OUTPUT formatted as a note: a short TITLE on the first line, then \
                 concise bullet points below (each starting with \"- \"), never a paragraph, \
                 unless the instruction explicitly asks otherwise."
            } else {
                ""
            };
            format!(
                "You are a {subject}. You are given EXISTING TEXT and an EDIT INSTRUCTION describing \
                 HOW to transform it (for example: \"make it shorter\", \"condense to 2 lines\", \
                 \"add error handling\", \"more formal\").\n\n\
                 Apply the edit instruction to rewrite the existing text. The edit instruction is a \
                 directive about how to change it — it is NOT content to add. Do NOT copy the \
                 instruction's words into the output, do NOT append it, and do NOT treat phrases like \
                 \"2 lines\" as text to insert. If it asks for a length or format (e.g. 2 lines, one \
                 paragraph, bullet points), make the OUTPUT itself match that.{note_rule} Preserve the \
                 original intent.\n\n\
                 Return ONLY the rewritten text — no preamble, no explanation, no quotes, no code \
                 fences.\n\nEXISTING TEXT:\n{b}\n\nEDIT INSTRUCTION:\n{draft}"
            )
        }
        _ if is_note => format!(
            "You are refining a quick note or to-do for a task list. Rewrite the draft into a \
             short TITLE on the FIRST line (a few words, no trailing punctuation, no markdown \
             heading marks), then the key details as concise bullet points below — one per line, \
             each starting with \"- \". Use imperative phrasing, cut filler, keep any links or IDs \
             intact. If the draft is trivial with nothing to break out, a title plus a single \
             bullet is fine. Return ONLY the note text (title line + bullets) — no preamble, no \
             explanation, no quotes, no code fences.\n\nDRAFT:\n{draft}"
        ),
        _ => format!(
            "You are a prompt engineer for a coding agent. Rewrite the draft into a clear, \
             specific, well-structured prompt. Preserve the user's intent; add helpful \
             structure and precision but do not invent requirements. Return ONLY the improved \
             prompt text — no preamble, no explanation, no code fences.\n\nDRAFT:\n{draft}"
        ),
    }
}

/// Keep only shell-safe chars so the model name can't inject into the `-lc` string.
fn safe_model(model: Option<&str>) -> Option<String> {
    let m: String = model?
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':'))
        .collect();
    if m.is_empty() { None } else { Some(m) }
}

/// Blocking claude call with a watchdog timeout. Runs off the UI thread.
/// `model` is a `claude` alias ("haiku" / "sonnet" / "opus") or a full model id;
/// None uses the CLI's default. Enhance runs in plain print mode (no think keywords)
/// so it stays low-latency — "low thinking" by construction.
fn run_claude(meta: &str, model: Option<&str>) -> Result<String, String> {
    use std::time::{Duration, Instant};
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let cmd = match safe_model(model) {
        Some(m) => format!("claude -p --model {m}"),
        None => "claude -p".to_string(),
    };
    let mut child = std::process::Command::new(&shell)
        .arg("-lc")
        .arg(&cmd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not start claude: {e}"))?;
    child
        .stdin
        .take()
        .ok_or("no stdin")?
        .write_all(meta.as_bytes())
        .map_err(|e| e.to_string())?; // ChildStdin drops here -> EOF

    let start = Instant::now();
    let status = loop {
        if let Some(st) = child.try_wait().map_err(|e| e.to_string())? {
            break st;
        }
        if start.elapsed() > Duration::from_secs(90) {
            let _ = child.kill();
            return Err("claude timed out (90s) — run `claude` once in the terminal to check it's authenticated".into());
        }
        std::thread::sleep(Duration::from_millis(120));
    };

    let mut out = String::new();
    if let Some(mut so) = child.stdout.take() {
        let _ = so.read_to_string(&mut out);
    }
    if !status.success() {
        let mut err = String::new();
        if let Some(mut se) = child.stderr.take() {
            let _ = se.read_to_string(&mut err);
        }
        return Err(format!("claude failed: {}", err.trim()));
    }
    let text = out.trim().to_string();
    if text.is_empty() {
        return Err("claude returned nothing".into());
    }
    Ok(text)
}

/// Rephrase a draft (optionally updating an existing prompt) via `claude -p`.
/// Async + off-thread so the UI never freezes while claude runs.
#[tauri::command]
async fn rephrase_prompt(
    draft: String,
    base: Option<String>,
    model: Option<String>,
    kind: Option<String>,
) -> Result<String, String> {
    if draft.trim().is_empty() {
        return Err("nothing to rephrase".into());
    }
    let meta = build_meta(&draft, base.as_deref(), kind.as_deref().unwrap_or("prompt"));
    tauri::async_runtime::spawn_blocking(move || run_claude(&meta, model.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            pty_resize,
            pty_close,
            pty_cwd,
            pty_has_claude,
            pty_busy,
            git_branch,
            set_project_dir,
            prompts_search,
            prompts_get,
            prompts_save,
            prompts_tag,
            prompts_delete,
            prompts_set_title,
            notes_add,
            notes_list,
            notes_toggle,
            notes_delete,
            notes_pin,
            notes_collapse,
            notes_reorder,
            notes_set_title,
            groups_add,
            groups_list,
            groups_delete,
            item_set_group,
            item_hide,
            item_meta_list,
            read_doc,
            read_file,
            reveal_file,
            open_external,
            mcp_list,
            prompts_export,
            prompts_import,
            rephrase_prompt,
            session::session_watch,
            session::session_list,
            session::session_load,
            session::prompts_watch,
            agents::agents_list,
            agents::skills_list,
            agents::item_delete,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DevCLI");
}
