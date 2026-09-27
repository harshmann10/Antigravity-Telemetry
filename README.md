# Antigravity Telemetry (VS Code Extension)

A lightweight, zero-token, real-time LLM telemetry monitor, visual observability dashboard, and storage management extension for Google Antigravity inside VS Code.

---

## Features

### 1. ⚡ Footer Status Bar Item

- **Live Active Chat Monitoring**: Displays active chat title, context window fill %, and prompt cache hit rate in clean native styling:
  `[Chat Title] | 182k (71%) · 98.4% cache`
- **Compaction Ceiling Calibration**: Calibrated against Antigravity's **256,000 token working ceiling** (so 182k shows 71% full, giving you an honest indicator of session weight before compaction triggers; falls back to 255k for legacy chats).
- **Auto-Compaction Alerts**: Automatically detects when Antigravity compacts context and displays a compaction notice:
  `[Chat Title] | Compacted (-71k) · 98.4%`
- **Markdown Hover Card**: Hovering over the footer displays a full breakdown with a 12-segment ASCII window meter, cache volume, and thinking tokens.

---

### 2. 📋 Two-Level QuickPick Menu

Clicking the status bar item opens a quick command menu:

- **Active Chat Summary**: Shows context, cache read/write, and output tokens.
- **📈 Open Full Visual Dashboard**: Opens the rich editor tab dashboard.
- **🗂️ Browse Past Conversations**: Searchable sub-picker displaying all previous sessions with token counts and on-disk storage sizes.
- **🗑️ Delete a Conversation (Free Disk Space)**: Pick any conversation to remove it (Recycle Bin by default).
- **🔄 Refresh Telemetry**: Immediate re-scan of local databases.
- **⚙️ Set sqlite3 Path**: Only shown when the `sqlite3` CLI could not be found — see **§7 Failure Visibility** below.

The menu is **scoped to your current workspace** by default, so chats from other projects do not
drown out the one you are working in (see **§5 Workspace Scoping**).

---

### 3. 📈 Live Visual Observability Dashboard (Editor Tab)

Opens side-by-side with your code (`Ctrl + W` to close anytime) and updates live via `postMessage`:

- **Split-Window Optimized**: Active KPIs and context timeline sit directly at the top with zero scrolling required in narrow split editor views.
- **4 Top KPIs**: Context Window (fill % & headroom against the real ceiling), Cache Read (cached tokens & hit %), Cache Write (fresh prompt tokens), and Model Output (generated tokens & thinking ratio).
- **Scope Controls**: A workspace dropdown switches between your current project, all workspaces, or any individual workspace, and a view chip switches between `All · Chats · Subagents`. Both are transient, so the view always tells you what you are looking at.
- **Dual-Layer Interactive Timeline (SVG)**:
  - **Blue curve**: Total Context progression across all turns, read from Antigravity's own trajectory context counter.
  - **Emerald curve**: Cached Prompt Volume per turn, visually exposing the thin sliver of fresh tokens added per turn. It is clamped to the context curve so it can never render above it, even when the API-side prompt cache holds a prefix Antigravity has already pruned.
  - **Red dashed guideline**: Drawn at the conversation's real compaction ceiling, with marker dots on compaction turns.
  - **Mouse Tracking Crosshairs & Hover Tooltip**: Moving your cursor over the chart displays turn details, context %, cached volume, fresh additions, and generation output.
- **Session Intelligence Grid**:
  - **⚡ Last Turn Activity**: Delta fresh tokens added, output, and compaction state.
  - **📊 Per-Turn Averages**: Average context, output, thinking tokens, and cache volume.
  - **🛡️ Cache Performance**: Total hits vs. calls, cold start misses, and compaction count.
  - **🏔️ Session Peaks**: Peak context reached (% of the ceiling), peak generation, and peak reasoning tokens.

---

### 4. 🗑️ Complete Zero-Residue Conversation Deletion

Antigravity's built-in chat deletion often only deletes the catalog record while leaving massive SQLite databases and `brain/` folders (transcripts, images, artifacts) lingering on disk, accumulating hundreds of megabytes of dead "ghost" data.

**Antigravity Telemetry completely solves this**:

- **Wipes All Storage Layers**:
  - `conversations/<id>.db`, `.db-wal`, `.db-shm`
  - `brain/<id>/` folder (transcripts, media, scratch files)
  - `annotations/<id>.pbtxt`
  - `browser_recordings/<id>/`
  - `implicit/<id>.pb`
  - Row in `conversation_summaries.db`
- **Recycle Bin by default**: files are moved to the Windows Recycle Bin instead of being shredded, so an accidental delete is recoverable. Set `antigravity.deleteToRecycleBin` to `false` for permanent deletion.
- **Honest reporting**: every path is verified gone _after_ the delete. If Windows refuses (file locked by Antigravity), the extension says so, logs the exact paths (`Antigravity: Show Logs`) and **keeps the catalog row** — so a failed delete never turns a healthy chat into a new ghost.
- **In-Dashboard Deletion**:
  - Click **`🗑️ Delete Chat`** directly from the Active Chat card or the trash icon next to any chat in the **All Sessions** list.
  - An in-dashboard confirmation modal lists what will be removed and how much space is involved.

---

### 5. 🗂️ Workspace Scoping

Antigravity stores every chat in one flat catalog, so `g:\job` work and `g:\web dev` work look
identical in a session list. This extension resolves each conversation's `workspace_uris` to a real
path and scopes the UI to the project you actually have open:

- The **footer, history picker and delete picker** show only the current project by default.
- The **active chat** is chosen from that visible set, so a chat from another project cannot hijack the status bar.
- Set `antigravity.workspaceFilter` to `"all"` to see everything, or switch scope from the dashboard dropdown without changing the setting.
- Matching is by **path prefix**, case-insensitively, so opening a subfolder of a project still finds its chats — and a project named `web` does not accidentally match `web dev`.

---

### 6. 🤖 Subagent & Background-Worker Organization

Antigravity spawns background workers (`browser`, `firefox_browser`, `DeepInvestigator…`) that
write their own conversation records. They are **nested, never hidden** — one click always reveals them:

- **Collapsed drawers**: a chat that spawned workers shows `▾ 🤖 3 subagents · 165.0k tok · 0.6 MB`; expanding reveals each child with its agent badge, tokens, storage and delete button.
- **Rolled-up accounting**: selecting a parent shows a _Subagents & Background Workers_ card listing each child plus `Parent + Subagents = Total`, so a session's true cost is never understated.
- **Breadcrumb**: selecting a subagent links back to its parent — and degrades gracefully (name only, or "no longer available") when the parent has no local data.
- **Unattached group**: children whose parent is not on disk appear in their own collapsed group rather than disappearing.
- **Human chats drive the footer**: a background worker finishing later cannot take over the status bar.

---

### 7. ⚠️ Failure Visibility

If something the extension depends on is missing, it says so instead of silently showing nothing:

- **`sqlite3` not found** → the footer shows `$(error) Antigravity: sqlite3 missing` with an error background, and clicking it (or the toast's **Set Path** action) lets you point at the executable via `antigravity.sqlitePath`. The warning fires once and re-arms itself if the CLI disappears again later.
- **Catalog unreadable** → chat titles are unavailable and fallback titles are used, rather than failing or misidentifying conversations.
- **A file locked by Antigravity during deletion** → the failure is reported with the exact paths (`Antigravity: Show Logs`) and the catalog entry is kept, so a failed delete never leaves a half-deleted chat.

---

### 8. 🔒 Zero Tokens, Zero Network, Pure Local Parsing

- Queries local SQLite databases directly from `%USERPROFILE%\.gemini\antigravity\`. Catalog queries use SQLite's native `-json` mode to guarantee reliable title resolution without delimiter collisions or Windows CLI caret translation bugs.
- Pure JavaScript Protobuf wire decoder (`readVarint`), with guards against malformed/over-large varints.
- **Zero npm dependencies, zero network requests, zero API tokens consumed** — including the dashboard styling, which is a committed local stylesheet (`media/dashboard.css`) rather than a CDN script.

---

### 9. ⚡ Incremental Telemetry Cache

A full scan used to re-query every conversation's `gen_metadata` table and re-walk the whole `brain/` tree on every refresh (~2-3 s, every 10 s). Now:

- Each conversation is cached by `(mtimeMs, size)` (+ the WAL signature when Antigravity holds a DB open), so unchanged chats cost **zero** `sqlite3` spawns.
- Changed chats are read incrementally (`WHERE idx > lastIdx`), with a structural guard (`count(*)` / `max(idx)`) that forces a clean re-read if rows were deleted or the table was rewritten.
- On-disk storage sizes are cached with a TTL, since walking 2,400+ `brain/` files is the most expensive part of a scan.
- Measured on a real 21-conversation install: **~2,000 ms cold → ~30 ms warm**.
- The file watcher covers `.db`/`-wal`/`-shm` plus the `conversation_summaries.db` catalog, and polling pauses while the window is unfocused.

---

## Settings

| Setting                          | Default     | Description                                                                              |
| :------------------------------- | :---------- | :--------------------------------------------------------------------------------------- |
| `antigravity.deleteToRecycleBin` | `true`      | Move conversation files to the Windows Recycle Bin instead of deleting them permanently. |
| `antigravity.workspaceFilter`    | `"current"` | Filter telemetry to the active workspace project (`"current"`) or show all (`"all"`).    |
| `antigravity.sqlitePath`         | `""`        | Custom path to `sqlite3` CLI executable. When empty, searches standard paths and PATH.   |

---

## Development & Installation

### Verifying a change

A self-contained check suite runs without launching VS Code (no test framework, no dependencies):

```bash
node scripts/self-check.js
```

**119 assertions across 13 sections**, covering the protobuf decode and usage math against a synthetic
fixture with known values, per-row context fallback, incremental-vs-full parity (including the deleted-row
guard and non-sampled turns), real-installation parity, conversation-id validation, a Recycle Bin round
trip on temporary files, workspace parsing and scoping, subagent organization and active-chat selection,
dashboard stability across telemetry updates, `sqlite3` resolution, and chart layer integrity. It also
times a cold vs cached scan of your real installation.

### Rebuilding the dashboard stylesheet

`media/dashboard.css` is generated and **committed** so the extension keeps zero runtime dependencies. If you
change any class name in `dashboardHtml.js`, regenerate it:

```bash
npm run build:css
```

(`npx tailwindcss@3` is only used at build time; nothing is installed into the extension.)

> ⚠️ The dashboard webview uses a nonce-based CSP, which does **not** authorise inline event-handler
> attributes. Add listeners in `bindEvents()` inside `dashboardHtml.js` instead of writing `onclick="…"` —
> otherwise the control silently does nothing.

### Live Directory Junctions (Local Setup)

The extension is linked to VS Code and VS Code Insiders via Windows Directory Junctions:

```cmd
cmd /c mklink /J "%USERPROFILE%\.vscode\extensions\antigravity-telemetry" "G:\web dev\antigravity-telemetry"
cmd /c mklink /J "G:\vs code insider\data\extensions\antigravity-telemetry" "G:\web dev\antigravity-telemetry"
```

Or run the included setup helper:

```bash
node link-extensions.js
```

### Applying Changes

Press `Ctrl + Shift + P` $\rightarrow$ **`Developer: Reload Window`** in VS Code to immediately test edits.

### 📦 Packaging & Sharing (.vsix)

To package the extension into a standalone `.vsix` installer for sharing with other users or testing:

```bash
npm run package
```

This generates a lightweight, self-contained **`antigravity-telemetry-1.0.0.vsix`** (under 60 KB).

#### How other users install the .vsix:
1. Open VS Code and go to the **Extensions** view (`Ctrl+Shift+X` / `Cmd+Shift+X`).
2. Click the **`...`** (Views and More Actions) menu at the top-right of the Extensions sidebar.
3. Select **`Install from VSIX...`** and choose `antigravity-telemetry-1.0.0.vsix`.
4. *Or via Terminal:*
   ```bash
   code --install-extension antigravity-telemetry-1.0.0.vsix
   ```

> **Prerequisites for other users:**
> - Must have Google Antigravity installed (reads sessions from `~/.gemini/antigravity`).
> - Must have the `sqlite3` CLI available (built-in on macOS/Linux; auto-detected on Windows or configurable via `antigravity.sqlitePath`).

