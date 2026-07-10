// DevCLI — local-first, Warp-styled terminal for Claude Code vibe coders.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agents;
mod session;
mod vault;

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Mutex;
use std::thread;

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
    data: Vec<u8>,
}
#[derive(Clone, Serialize)]
struct PtyId {
    id: String,
}

// ---- terminal (multi-pane, keyed by id) ----

#[tauri::command]
fn pty_spawn(app: AppHandle, state: State<'_, AppState>, id: String, rows: u16, cols: u16) -> Result<(), String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut cmd = CommandBuilder::new(shell);
    cmd.cwd(state.dir()); // open new terminals in the last-used folder
    cmd.env("TERM", "xterm-256color");

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let child_pid = child.process_id();
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    state
        .ptys
        .lock()
        .unwrap()
        .insert(id.clone(), Pty { master: pair.master, writer, child_pid });

    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let _ = app.emit("pty-data", PtyChunk { id: id.clone(), data: buf[..n].to_vec() });
                }
            }
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

#[tauri::command]
fn pty_cwd(state: State<'_, AppState>, id: String) -> Option<String> {
    let pid = state.ptys.lock().unwrap().get(&id).and_then(|p| p.child_pid)?;
    shell_cwd(pid)
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

/// Open a URL in the user's default browser.
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    std::process::Command::new(opener).arg(&url).spawn().map_err(|e| e.to_string())?;
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
    if let Ok(txt) = std::fs::read_to_string(cwd.join(".mcp.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
            parse_mcp(&v, "project", &mut out);
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

fn build_meta(draft: &str, base: Option<&str>) -> String {
    match base {
        Some(b) if !b.trim().is_empty() => format!(
            "You are a prompt engineer for a coding agent. Improve the EXISTING prompt by \
             incorporating the requested change. Keep the original intent. Return ONLY the \
             improved prompt text — no preamble, no explanation, no code fences.\n\n\
             EXISTING PROMPT:\n{b}\n\nCHANGE TO APPLY:\n{draft}"
        ),
        _ => format!(
            "You are a prompt engineer for a coding agent. Rewrite the draft into a clear, \
             specific, well-structured prompt. Preserve the user's intent; add helpful \
             structure and precision but do not invent requirements. Return ONLY the improved \
             prompt text — no preamble, no explanation, no code fences.\n\nDRAFT:\n{draft}"
        ),
    }
}

/// Blocking claude call with a watchdog timeout. Runs off the UI thread.
fn run_claude(meta: &str) -> Result<String, String> {
    use std::time::{Duration, Instant};
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut child = std::process::Command::new(&shell)
        .arg("-lc")
        .arg("claude -p")
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
async fn rephrase_prompt(draft: String, base: Option<String>) -> Result<String, String> {
    if draft.trim().is_empty() {
        return Err("nothing to rephrase".into());
    }
    let meta = build_meta(&draft, base.as_deref());
    tauri::async_runtime::spawn_blocking(move || run_claude(&meta))
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
            set_project_dir,
            prompts_search,
            prompts_get,
            prompts_save,
            prompts_tag,
            prompts_delete,
            notes_add,
            notes_list,
            notes_toggle,
            notes_delete,
            notes_pin,
            notes_collapse,
            notes_reorder,
            groups_add,
            groups_list,
            groups_delete,
            item_set_group,
            item_hide,
            item_meta_list,
            read_doc,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running DevCLI");
}
