// DevCLI — git-native prompt vault.
//
// STORAGE LAYOUT (identical for repo-local and global; see docs/PROMPT-STORAGE.md):
//
//   <base>/.devcli/                 base = <repo> for project scope, ~ for global
//   ├── prompts/
//   │   ├── README.md             explains the format
//   │   └── <slug>.md             one prompt per file, YAML frontmatter + body
//   ├── devcli.db                   SQLite index over the files (fast search)
//   └── .git/                     every save is a commit
//
// The .md files are the source of truth and are git-tracked; devcli.db is a
// rebuildable index. A prompt file looks like:
//
//   ---
//   id: 3f2a9c
//   title: Add auth to the settings page
//   slug: add-auth-to-the-settings-3f2a9c
//   scope: project
//   source: capture           # capture | manual | enhanced | imported
//   session: 612acf0e-...
//   project: /Users/me/repo
//   tags: []
//   created_at: 2026-07-10T19:20:00Z
//   updated_at: 2026-07-10T19:20:00Z
//   uses: 0
//   ---
//
//   <the prompt text>
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use serde::Serialize;
use sha2::{Digest, Sha256};

pub struct Vault {
    root: PathBuf, // <base>/.devcli
    base: PathBuf, // <base> (repo dir, or home for global)
    scope: String, // "project" | "global"
    conn: Connection,
}

#[derive(Serialize)]
pub struct Note {
    pub id: i64,
    pub kind: String,
    pub title: String,
    pub text: String,
    pub url: String,
    pub done: bool,
    pub pinned: bool,
    pub collapsed: bool,
    pub created_at: i64,
}

#[derive(Serialize)]
pub struct ItemMeta {
    pub item_id: String,
    pub group: String,
    pub hidden: bool,
}

#[derive(Serialize)]
pub struct PromptHit {
    pub slug: String,
    pub pid: String,
    pub title: String,
    pub text: String,
    pub session: String,
    pub source: String,
    pub scope: String,
    pub created_at: i64,
    pub uses: i64,
    pub tags: Vec<String>,
}

const README: &str = "# DevCLI prompts

Each `*.md` file is one saved prompt with YAML frontmatter, git-tracked.
`devcli.db` is a rebuildable SQLite index over these files — the files win.

Frontmatter fields: `id`, `title`, `slug`, `scope`, `source`, `session`,
`project`, `tags`, `created_at`, `updated_at`, `uses`.

`source`: capture (auto from a Claude Code session) · manual (saved by you) ·
enhanced (rephrased) · imported (from a shared prompt-pack).
";

fn now_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn sha256_hex(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

fn truncate(s: &str, n: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= n { s.to_string() } else { s.chars().take(n).collect() }
}

/// A human title: first non-empty line, cleaned and clipped.
fn title_of(text: &str) -> String {
    let line = text.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    let t = truncate(line, 70);
    if t.is_empty() { "untitled prompt".into() } else { t }
}

/// Replace a `key: value` line inside the leading `---` frontmatter block
/// (inserts it just after the opening `---` if the key is absent).
fn set_frontmatter_field(raw: &str, key: &str, value: &str) -> String {
    let lines: Vec<&str> = raw.lines().collect();
    if lines.first() != Some(&"---") {
        return raw.to_string();
    }
    let end = match lines.iter().enumerate().skip(1).find(|(_, l)| **l == "---") {
        Some((i, _)) => i,
        None => return raw.to_string(),
    };
    let prefix = format!("{key}:");
    let mut out: Vec<String> = Vec::with_capacity(lines.len() + 1);
    let mut replaced = false;
    for (i, l) in lines.iter().enumerate() {
        if i > 0 && i < end && l.trim_start().starts_with(&prefix) {
            out.push(format!("{key}: {value}"));
            replaced = true;
        } else {
            out.push((*l).to_string());
        }
    }
    if !replaced {
        out.insert(1, format!("{key}: {value}"));
    }
    let mut s = out.join("\n");
    if raw.ends_with('\n') {
        s.push('\n');
    }
    s
}

fn slugify(title: &str, hash: &str) -> String {
    let mut slug: String = title
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .take(6)
        .collect::<Vec<_>>()
        .join("-");
    if slug.is_empty() {
        slug = "prompt".into();
    }
    format!("{slug}-{}", &hash[..6])
}

/// Unix seconds -> ISO-8601 UTC (no chrono; Hinnant's civil-from-days).
fn iso8601(secs: i64) -> String {
    let days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400);
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

fn strip_frontmatter(s: &str) -> &str {
    if let Some(rest) = s.strip_prefix("---\n") {
        if let Some(end) = rest.find("\n---\n") {
            return rest[end + 5..].trim_start();
        }
    }
    s
}

fn frontmatter_field(raw: &str, key: &str) -> Option<String> {
    let rest = raw.strip_prefix("---\n")?;
    let end = rest.find("\n---")?;
    for line in rest[..end].lines() {
        if let Some(v) = line.trim().strip_prefix(&format!("{key}:")) {
            let val = v.trim().trim_matches('"').trim_matches('\'').to_string();
            if !val.is_empty() {
                return Some(val);
            }
        }
    }
    None
}

impl Vault {
    pub fn open(base: &Path, scope: &str) -> Result<Self, String> {
        let root = base.join(".devcli");
        let prompts = root.join("prompts");
        std::fs::create_dir_all(&prompts).map_err(|e| e.to_string())?;
        let readme = prompts.join("README.md");
        if !readme.exists() {
            let _ = std::fs::write(&readme, README);
        }
        if !root.join(".git").exists() {
            run_git(&root, &["init", "-q"])?;
        }
        let conn = Connection::open(root.join("devcli.db")).map_err(|e| e.to_string())?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS prompts(
                id INTEGER PRIMARY KEY,
                pid TEXT,
                slug TEXT UNIQUE,
                title TEXT,
                text TEXT NOT NULL,
                scope TEXT,
                source TEXT,
                session TEXT,
                project TEXT,
                hash TEXT UNIQUE,
                created_at INTEGER,
                updated_at INTEGER,
                uses INTEGER DEFAULT 0
             );
             CREATE TABLE IF NOT EXISTS tags(prompt_id INTEGER, tag TEXT);
             CREATE TABLE IF NOT EXISTS notes(
                id INTEGER PRIMARY KEY,
                kind TEXT,
                text TEXT,
                url TEXT,
                done INTEGER DEFAULT 0,
                pinned INTEGER DEFAULT 0,
                collapsed INTEGER DEFAULT 0,
                sort INTEGER DEFAULT 0,
                created_at INTEGER
             );
             CREATE TABLE IF NOT EXISTS groups(
                id INTEGER PRIMARY KEY,
                kind TEXT,
                name TEXT,
                UNIQUE(kind,name)
             );
             CREATE TABLE IF NOT EXISTS item_meta(
                kind TEXT,
                item_id TEXT,
                group_name TEXT DEFAULT '',
                hidden INTEGER DEFAULT 0,
                PRIMARY KEY(kind,item_id)
             );",
        )
        .map_err(|e| e.to_string())?;
        // tolerate an older schema (columns added over time)
        for col in [
            "pid TEXT", "title TEXT", "scope TEXT", "source TEXT",
            "project TEXT", "updated_at INTEGER", "uses INTEGER DEFAULT 0",
        ] {
            let _ = conn.execute(&format!("ALTER TABLE prompts ADD COLUMN {col}"), []);
        }
        for col in ["pinned INTEGER DEFAULT 0", "collapsed INTEGER DEFAULT 0", "sort INTEGER DEFAULT 0", "title TEXT"] {
            let _ = conn.execute(&format!("ALTER TABLE notes ADD COLUMN {col}"), []);
        }
        Ok(Vault { root, base: base.to_path_buf(), scope: scope.to_string(), conn })
    }

    /// Save a prompt (idempotent by content hash). Writes the .md, indexes it,
    /// and commits. `source` = capture | manual | enhanced | imported.
    pub fn capture(&mut self, text: &str, session: &str, source: &str) -> Result<(), String> {
        let text = text.trim();
        if text.len() < 3 {
            return Ok(());
        }
        let hash = sha256_hex(text);
        if self.conn.query_row("SELECT 1 FROM prompts WHERE hash=?1", [&hash], |_| Ok(())).is_ok() {
            return Ok(());
        }
        let now = now_secs();
        let pid = hash[..6].to_string();
        let title = title_of(text);
        let slug = slugify(&title, &hash);
        let project = self.base.to_string_lossy().to_string();

        let file = self.root.join("prompts").join(format!("{slug}.md"));
        let body = format!(
            "---\nid: {pid}\ntitle: {title}\nslug: {slug}\nscope: {}\nsource: {source}\n\
             session: {session}\nproject: {project}\ntags: []\ncreated_at: {}\nupdated_at: {}\nuses: 0\n---\n\n{text}\n",
            self.scope,
            iso8601(now),
            iso8601(now),
        );
        std::fs::write(&file, &body).map_err(|e| e.to_string())?;

        self.conn
            .execute(
                "INSERT OR IGNORE INTO prompts
                 (pid,slug,title,text,scope,source,session,project,hash,created_at,updated_at,uses)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10,0)",
                rusqlite::params![pid, slug, title, text, self.scope, source, session, project, hash, now],
            )
            .map_err(|e| e.to_string())?;

        let rel = format!("prompts/{slug}.md");
        let _ = run_git(&self.root, &["add", &rel]);
        let _ = run_git(
            &self.root,
            &["-c", "user.name=DevCLI", "-c", "user.email=devcli@local",
              "commit", "-q", "-m", &format!("{source}: {}", truncate(&title, 50))],
        );
        Ok(())
    }

    pub fn search(&self, query: &str) -> Result<Vec<PromptHit>, String> {
        let like = format!("%{}%", query.trim());
        let mut stmt = self
            .conn
            .prepare(
                "SELECT slug,COALESCE(pid,''),COALESCE(title,''),text,COALESCE(session,''),
                        COALESCE(source,'manual'),created_at,COALESCE(uses,0)
                 FROM prompts WHERE text LIKE ?1 ORDER BY created_at DESC LIMIT 100",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([&like], |r| {
                Ok(PromptHit {
                    slug: r.get(0)?,
                    pid: r.get(1)?,
                    title: r.get(2)?,
                    text: r.get(3)?,
                    session: r.get(4)?,
                    source: r.get(5)?,
                    created_at: r.get(6)?,
                    uses: r.get(7)?,
                    scope: self.scope.clone(),
                    tags: Vec::new(),
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
        Ok(out)
    }

    /// Fetch full text and bump the use counter (called when inserting to a terminal).
    pub fn get(&self, slug: &str) -> Result<String, String> {
        let text: String = self
            .conn
            .query_row("SELECT text FROM prompts WHERE slug=?1", [slug], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        let _ = self.conn.execute(
            "UPDATE prompts SET uses=COALESCE(uses,0)+1, updated_at=?2 WHERE slug=?1",
            rusqlite::params![slug, now_secs()],
        );
        Ok(text)
    }

    /// Delete a prompt: remove its file and index row, commit the removal.
    pub fn delete(&mut self, slug: &str) -> Result<(), String> {
        self.conn
            .execute("DELETE FROM prompts WHERE slug=?1", [slug])
            .map_err(|e| e.to_string())?;
        self.conn
            .execute("DELETE FROM tags WHERE prompt_id NOT IN (SELECT id FROM prompts)", [])
            .ok();
        let file = self.root.join("prompts").join(format!("{slug}.md"));
        let _ = std::fs::remove_file(&file);
        let _ = run_git(&self.root, &["add", "-A"]);
        let _ = run_git(
            &self.root,
            &["-c", "user.name=DevCLI", "-c", "user.email=devcli@local", "commit", "-q", "-m", "remove prompt"],
        );
        Ok(())
    }

    /// Rename a prompt's title: update the DB and rewrite the .md frontmatter
    /// (keeps the slug / file path so links and git history stay intact).
    pub fn set_title(&self, slug: &str, title: &str) -> Result<(), String> {
        let title = title.trim();
        if title.is_empty() {
            return Err("empty title".into());
        }
        self.conn
            .execute(
                "UPDATE prompts SET title=?2, updated_at=?3 WHERE slug=?1",
                rusqlite::params![slug, title, now_secs()],
            )
            .map_err(|e| e.to_string())?;
        let file = self.root.join("prompts").join(format!("{slug}.md"));
        if let Ok(raw) = std::fs::read_to_string(&file) {
            let updated = set_frontmatter_field(&raw, "title", title);
            if std::fs::write(&file, updated).is_ok() {
                let rel = format!("prompts/{slug}.md");
                let _ = run_git(&self.root, &["add", &rel]);
                let _ = run_git(
                    &self.root,
                    &["-c", "user.name=DevCLI", "-c", "user.email=devcli@local",
                      "commit", "-q", "-m", &format!("rename: {}", truncate(title, 50))],
                );
            }
        }
        Ok(())
    }

    pub fn tag(&self, slug: &str, tag: &str) -> Result<(), String> {
        let id: i64 = self
            .conn
            .query_row("SELECT id FROM prompts WHERE slug=?1", [slug], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        self.conn
            .execute("INSERT INTO tags(prompt_id,tag) VALUES(?1,?2)", rusqlite::params![id, tag])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Index a prompt .md that already exists on disk (written by you, Claude, or a
    /// pack) without rewriting or committing it. Returns true if newly added.
    pub fn ingest_file(&mut self, path: &Path) -> Result<bool, String> {
        if path.file_name().and_then(|n| n.to_str()) == Some("README.md") {
            return Ok(false);
        }
        let raw = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
        let body = strip_frontmatter(&raw).trim();
        if body.len() < 3 {
            return Ok(false);
        }
        let hash = sha256_hex(body);
        if self.conn.query_row("SELECT 1 FROM prompts WHERE hash=?1", [&hash], |_| Ok(())).is_ok() {
            return Ok(false);
        }
        let title = frontmatter_field(&raw, "title").unwrap_or_else(|| title_of(body));
        let source = frontmatter_field(&raw, "source").unwrap_or_else(|| "external".into());
        let session = frontmatter_field(&raw, "session").unwrap_or_default();
        let slug = path.file_stem().and_then(|s| s.to_str()).unwrap_or("prompt").to_string();
        let now = now_secs();
        let project = self.base.to_string_lossy().to_string();
        self.conn
            .execute(
                "INSERT OR IGNORE INTO prompts
                 (pid,slug,title,text,scope,source,session,project,hash,created_at,updated_at,uses)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10,0)",
                rusqlite::params![&hash[..6], slug, title, body, self.scope, source, session, project, hash, now],
            )
            .map_err(|e| e.to_string())?;
        Ok(true)
    }

    /// Index every prompt file in the folder (and any subfolders) that isn't
    /// already known. Returns count added.
    pub fn ingest_dir(&mut self) -> usize {
        let dir = self.root.join("prompts");
        let mut n = 0;
        for entry in walkdir::WalkDir::new(&dir).into_iter().filter_map(|e| e.ok()) {
            if !entry.file_type().is_file() {
                continue;
            }
            let p = entry.path();
            if p.extension().and_then(|x| x.to_str()) == Some("md")
                && self.ingest_file(p).unwrap_or(false)
            {
                n += 1;
            }
        }
        n
    }

    /// Export prompts (all, or those carrying `tag`) as a shareable pack folder.
    pub fn export_pack(&self, tag: &str, dest: &Path) -> Result<usize, String> {
        std::fs::create_dir_all(dest.join("prompts")).map_err(|e| e.to_string())?;
        let slugs: Vec<String> = if tag.trim().is_empty() {
            let mut stmt = self.conn.prepare("SELECT slug FROM prompts").map_err(|e| e.to_string())?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
            rows.filter_map(|r| r.ok()).collect()
        } else {
            let mut stmt = self
                .conn
                .prepare("SELECT p.slug FROM prompts p JOIN tags t ON t.prompt_id=p.id WHERE t.tag=?1")
                .map_err(|e| e.to_string())?;
            let rows = stmt.query_map([tag], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
            rows.filter_map(|r| r.ok()).collect()
        };
        let mut count = 0;
        for slug in &slugs {
            let src = self.root.join("prompts").join(format!("{slug}.md"));
            if src.exists() {
                std::fs::copy(&src, dest.join("prompts").join(format!("{slug}.md")))
                    .map_err(|e| e.to_string())?;
                count += 1;
            }
        }
        let name = if tag.trim().is_empty() { "vault" } else { tag };
        std::fs::write(
            dest.join("pack.toml"),
            format!("name = \"{name}\"\ndescription = \"DevCLI prompt-pack\"\nversion = \"1\"\ncount = {count}\n"),
        )
        .map_err(|e| e.to_string())?;
        Ok(count)
    }

    /// Import a pack folder's prompts (dedup by content hash).
    pub fn import_pack(&mut self, src: &Path) -> Result<usize, String> {
        let entries = std::fs::read_dir(src.join("prompts")).map_err(|e| e.to_string())?;
        let mut count = 0;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            if let Ok(raw) = std::fs::read_to_string(&path) {
                let body = strip_frontmatter(&raw).trim();
                if !body.is_empty() {
                    let before = self.count();
                    self.capture(body, "", "imported")?;
                    if self.count() > before {
                        count += 1;
                    }
                }
            }
        }
        Ok(count)
    }

    fn count(&self) -> i64 {
        self.conn.query_row("SELECT COUNT(*) FROM prompts", [], |r| r.get(0)).unwrap_or(0)
    }

    // ---- notes / tasks / links ----

    pub fn note_add(&self, kind: &str, text: &str, url: &str) -> Result<(), String> {
        if text.trim().is_empty() && url.trim().is_empty() {
            return Err("empty".into());
        }
        let top: i64 = self.conn.query_row("SELECT COALESCE(MIN(sort),0)-1 FROM notes", [], |r| r.get(0)).unwrap_or(-1);
        self.conn
            .execute(
                "INSERT INTO notes(kind,text,url,done,pinned,collapsed,sort,created_at) VALUES(?1,?2,?3,0,0,0,?4,?5)",
                rusqlite::params![kind, text.trim(), url.trim(), top, now_secs()],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn note_list(&self) -> Result<Vec<Note>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id,COALESCE(kind,'note'),COALESCE(title,''),COALESCE(text,''),COALESCE(url,''),
                        COALESCE(done,0),COALESCE(pinned,0),COALESCE(collapsed,0),COALESCE(created_at,0)
                 FROM notes ORDER BY pinned DESC, done ASC, sort ASC, created_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(Note {
                    id: r.get(0)?,
                    kind: r.get(1)?,
                    title: r.get(2)?,
                    text: r.get(3)?,
                    url: r.get(4)?,
                    done: r.get::<_, i64>(5)? != 0,
                    pinned: r.get::<_, i64>(6)? != 0,
                    collapsed: r.get::<_, i64>(7)? != 0,
                    created_at: r.get(8)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
        Ok(out)
    }

    pub fn note_toggle(&self, id: i64) -> Result<(), String> {
        self.conn
            .execute("UPDATE notes SET done = 1 - COALESCE(done,0) WHERE id=?1", [id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn note_pin(&self, id: i64) -> Result<(), String> {
        self.conn.execute("UPDATE notes SET pinned = 1 - COALESCE(pinned,0) WHERE id=?1", [id]).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn note_collapse(&self, id: i64) -> Result<(), String> {
        self.conn.execute("UPDATE notes SET collapsed = 1 - COALESCE(collapsed,0) WHERE id=?1", [id]).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn note_reorder(&self, ids: Vec<i64>) -> Result<(), String> {
        for (i, id) in ids.iter().enumerate() {
            self.conn.execute("UPDATE notes SET sort=?1 WHERE id=?2", rusqlite::params![i as i64, id]).ok();
        }
        Ok(())
    }

    pub fn note_delete(&self, id: i64) -> Result<(), String> {
        self.conn.execute("DELETE FROM notes WHERE id=?1", [id]).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn note_set_title(&self, id: i64, title: &str) -> Result<(), String> {
        self.conn
            .execute("UPDATE notes SET title=?2 WHERE id=?1", rusqlite::params![id, title.trim()])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    // ---- groups + per-item hide (for prompts / agents / skills) ----

    pub fn group_add(&self, kind: &str, name: &str) -> Result<(), String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("empty group name".into());
        }
        self.conn
            .execute("INSERT OR IGNORE INTO groups(kind,name) VALUES(?1,?2)", rusqlite::params![kind, name])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn group_list(&self, kind: &str) -> Result<Vec<String>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT name FROM groups WHERE kind=?1 ORDER BY name")
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map([kind], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn group_delete(&self, kind: &str, name: &str) -> Result<(), String> {
        self.conn
            .execute("DELETE FROM groups WHERE kind=?1 AND name=?2", rusqlite::params![kind, name])
            .map_err(|e| e.to_string())?;
        self.conn
            .execute("UPDATE item_meta SET group_name='' WHERE kind=?1 AND group_name=?2", rusqlite::params![kind, name])
            .ok();
        Ok(())
    }

    pub fn item_set_group(&self, kind: &str, item_id: &str, group: &str) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO item_meta(kind,item_id,group_name,hidden) VALUES(?1,?2,?3,0)
                 ON CONFLICT(kind,item_id) DO UPDATE SET group_name=excluded.group_name",
                rusqlite::params![kind, item_id, group],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn item_hide(&self, kind: &str, item_id: &str, hidden: bool) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO item_meta(kind,item_id,group_name,hidden) VALUES(?1,?2,'',?3)
                 ON CONFLICT(kind,item_id) DO UPDATE SET hidden=excluded.hidden",
                rusqlite::params![kind, item_id, hidden as i64],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn item_meta_list(&self, kind: &str) -> Result<Vec<ItemMeta>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT item_id,COALESCE(group_name,''),COALESCE(hidden,0) FROM item_meta WHERE kind=?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([kind], |r| {
                Ok(ItemMeta { item_id: r.get(0)?, group: r.get(1)?, hidden: r.get::<_, i64>(2)? != 0 })
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
        Ok(out)
    }
}

fn run_git(cwd: &Path, args: &[&str]) -> Result<(), String> {
    let out = Command::new("git").current_dir(cwd).args(args).output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}
