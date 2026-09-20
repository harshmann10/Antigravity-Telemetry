# AGENTS.md - Antigravity Telemetry Extension

This file provides architectural, technical, and development instructions for any AI assistant working on this codebase.

---

## 1. Project Overview

**Antigravity Telemetry** is a lightweight, zero-token, zero-dependency local VS Code extension that monitors, visualizes, and manages LLM telemetry and conversation storage for Google Antigravity.

It reads local SQLite databases and directories managed by Antigravity directly from the filesystem to:

- Display active Context Window usage calibrated against Antigravity's **255k token compaction ceiling**.
- Track Cache Read (Prompt Cache hits & volume), Cache Write (fresh input tokens), and Model Output (thinking vs. response tokens).
- Visualize a dual-layer interactive context timeline with hover crosshairs, compaction flags, and turn-by-turn inspection.
- Track accurate on-disk storage consumption per conversation.
- Provide a **zero-residue conversation deletion engine** that purges orphaned "ghost" chats and frees disk space completely.

---

## 2. Directory & Component Structure

```text
G:\web dev\antigravity-telemetry\
├── package.json          # VS Code extension manifest (activation, commands)
├── extension.js          # Main entry point: Status bar, QuickPick, Webview lifecycle, message router
├── telemetryReader.js    # Data engine: SQLite reader, protobuf decoder, storage calculator, delete engine
├── dashboardHtml.js      # Webview template: Tailwind UI, dual-layer SVG chart, modal, client script
├── link-extensions.js    # Script to symlink extension into VS Code & VS Code Insiders
├── unlink-extensions.js  # Script to remove symlinks
├── AGENTS.md             # AI development instructions & telemetry specs (this file)
└── README.md             # User guide and features
```

### Component Roles:

1. **`extension.js`**:
   - **Status Bar Item**: Displays `${shortTitle} | ${shortContext} (${contextPct}%) · ${hitRate}% cache` with native VS Code styling. Detects auto-compaction events (`Compacted (-Xk)`).
   - **Two-Level QuickPick (`antigravity.showMenu`)**:
     - Level 1: Active Chat Summary, Open Visual Dashboard, Browse Past Conversations, Delete a Conversation, Purge Ghost Chats, Refresh.
     - Level 2: Searchable history list over all past sessions with token counts and disk usage.
   - **Webview Message Router**: Listens via `panel.webview.onDidReceiveMessage` for `deleteConversation` and `purgeOrphaned` commands, executes them via `telemetryReader.js`, pushes `telemetryUpdate` messages, and displays VS Code toast notifications.
   - **File Watcher**: Watches `~/.gemini/antigravity/conversations/` for `.db` changes (debounced at 400ms) with a 10s fallback heartbeat.

2. **`telemetryReader.js`**:
   - Pure JavaScript Protobuf wire parser (`readVarint`, wire types 0, 1, 2, 5). **Zero npm dependencies**.
   - Discovers SQLite CLI via candidate paths (`adb-fastboot/platform-tools/sqlite3.exe`, `sqlite3`, `sqlite3.exe`).
   - Calculates on-disk storage per conversation across all SQLite DBs, brain directories, and metadata files.
   - Identifies orphaned/ghost chats (conversations whose `.db` file exists in `conversations/` but whose row was removed from `conversation_summaries.db`).
   - Exports `deleteConversation(id)` and `purgeOrphanedData()`.

3. **`dashboardHtml.js`**:
   - Generates a self-contained HTML page using Tailwind CSS (`https://www.gstatic.com/antigravity/web/dev/tailwindcss.min.js`).
   - Uses VS Code CSS theme variables (`--vscode-editor-background`, `--vscode-sideBar-background`, `--vscode-sideBar-border`, etc.).
   - Header with compact `Est. Cost: ~$X.XX` badge and active chat indicator.
   - 4 Top KPI Cards: Context Window (fill % & headroom to 255k), Cache Read, Cache Write, Model Output.
   - Token Composition progress bar & legend (Cache Read vs Cache Write vs Model Output).
   - Dual-Layer SVG Context Timeline: Total Context curve + Cached Volume curve, 255k red dashed guideline, hover tracking crosshair, and floating turn inspection tooltip.
   - Session Intelligence & Turn Metrics 4-card grid (Last Turn Activity, Turn Averages, Cache Performance, Session Peaks).
   - All Sessions Tab with search, per-session disk usage badges, ghost chat detection banner, and individual trash buttons.
   - In-Dashboard Confirmation Modal for safe deletion with disk space reclamation estimates.

---

## 3. Antigravity Storage Architecture & The "Ghost Chat" Problem

### Antigravity Storage Locations:

| Path                                                          | Purpose                                                                                                                              | Size / Impact                                     |
| :------------------------------------------------------------ | :----------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------ |
| `%USERPROFILE%\.gemini\antigravity\conversations\<id>.db`     | SQLite database with `gen_metadata` table storing protobuf turn telemetry. Also `<id>.db-wal` and `<id>.db-shm`.                     | 1 MB – 15 MB per chat                             |
| `%USERPROFILE%\.gemini\antigravity\conversation_summaries.db` | Catalog table `conversation_summaries` listing conversation ID, title, last modified timestamp, step count.                          | Global database                                   |
| `%USERPROFILE%\.gemini\antigravity\brain\<id>\`               | Transcripts (`transcript.jsonl`, `transcript_full.jsonl`), `.system_generated/` logs, `.user_uploaded/` media, and `scratch/` files. | **10 MB – 80 MB+ per chat** (major disk consumer) |
| `%USERPROFILE%\.gemini\antigravity\annotations\<id>.pbtxt`    | Protobuf text format annotation metadata.                                                                                            | Few KB                                            |
| `%USERPROFILE%\.gemini\antigravity\browser_recordings\<id>\`  | Screen and web session recordings (if browser MCP used).                                                                             | Variable                                          |
| `%USERPROFILE%\.gemini\antigravity\implicit\<id>.pb`          | Implicit conversation state protobuf.                                                                                                | Few KB                                            |

### The "Ghost Chat" Incomplete Deletion Finding:

> [!WARNING]
> **Why Antigravity's Built-In Delete Leaves Leftover Data**:
> When a user deletes a chat inside the Antigravity IDE UI, Antigravity **only removes the row from `conversation_summaries.db`**.
> It leaves:
>
> 1. `conversations/<id>.db` sitting in the conversations folder.
> 2. The entire `brain/<id>/` folder sitting on disk with megabytes of logs, artifacts, and media.
> 3. Annotation files in `annotations/<id>.pbtxt`.
>
> **Consequences**:
>
> - Disk space is never freed. Over dozens of sessions, dead chats consume hundreds of megabytes to gigabytes.
> - Any extension or script reading `conversations/` still discovers these orphaned `.db` files and displays them as dead/ghost chats.

### Zero-Residue Deletion Engine (`deleteConversation`):

To delete a conversation 100% cleanly without leaving any residue, `telemetryReader.js` purges all 6 layers:

1. `conversations/<id>.db`, `<id>.db-wal`, `<id>.db-shm`
2. `brain/<id>/` folder recursively (`fs.rmSync(p, { recursive: true, force: true })`)
3. `annotations/<id>.pbtxt`
4. `browser_recordings/<id>/` folder recursively
5. `implicit/<id>.pb`
6. SQLite query: `DELETE FROM conversation_summaries WHERE conversation_id = '<id>';`
7. Computes and returns the exact number of freed bytes.

---

## 4. Protobuf Wire Schema (`conversations/<id>.db`)

### SQLite Schema:

- Table: `gen_metadata (idx INTEGER, data BLOB, size INTEGER)`
- Ordered by `idx ASC` for turn progression; latest row is the current turn.

### Protobuf Binary Layout in `gen_metadata.data`:

```text
Root Message
 └── Tag 1 (Message)
      ├── Tag 19 (String): Model Name (e.g. "gemini-3.8-flash")
      └── Tag 4 (Message): Usage Metadata
           ├── Tag 2  (Varint): Non-cached Input Tokens (fresh prompt / Cache Write)
           ├── Tag 5  (Varint): Cached Input Tokens (served from cache / Cache Read)
           ├── Tag 3  (Varint): Candidates / Output Tokens (total generation)
           ├── Tag 9  (Varint): Thinking Tokens (internal reasoning)
           └── Tag 10 (Varint): Response Content Tokens (tool calls + text)
```

### Formulas:

$$\text{Cache Read (Cached Input)} = \text{Tag 5}$$
$$\text{Cache Write (Fresh Input)} = \text{Tag 2}$$
$$\text{Total Input Tokens} = \text{Tag 2} + \text{Tag 5}$$
$$\text{Model Output} = \text{Tag 3} = \text{Tag 9 (Thinking)} + \text{Tag 10 (Response)}$$
$$\text{Grand Total} = \text{Total Input} + \text{Total Output}$$
$$\text{Working Context Ceiling} = \mathbf{255,000 \text{ tokens}}$$
$$\text{Context Fill \%} = \min\left(100, \text{round}\left(\frac{\text{Current Context}}{255,000} \times 100\right)\right)$$

---

## 5. Critical Frontend / Webview Development Rules

### Template String Escaping Pitfall in Node.js:

> [!CAUTION]
> **NEVER generate inline JavaScript event handlers with escaped string concatenation inside Node template literals.**
>
> **Bad Example**:
>
> ```javascript
> // Inside a Node template literal (`...`):
> div.innerHTML =
>   "<button onclick=\"openDeleteModal('" + c.id + "')\">Delete</button>";
> ```
>
> In Node.js, `\''` unescapes to `''` before reaching the browser. The browser receives:
> `<button onclick="openDeleteModal('' + c.id + '')">`
> This causes a fatal `SyntaxError: Unexpected string` on page load, which halts all JavaScript execution, breaking the dashboard completely.
>
> **Safe Solutions**:
>
> 1. **Attach Native Event Listeners in JS** (Preferred):
>    ```javascript
>    div.innerHTML = '<button class="del-btn">🗑️</button>';
>    div.querySelector(".del-btn").onclick = (e) => {
>      e.stopPropagation();
>      openDeleteModal(c.id);
>    };
>    ```
> 2. **Use Data Attributes**:
>    ```javascript
>    div.innerHTML =
>      '<button data-id="' +
>      c.id +
>      '" onclick="openDeleteModal(this.dataset.id)">🗑️</button>';
>    ```

---

## 6. Development, Symlinks & Verification

### Live Directory Junctions:

The extension is linked to both VS Code and VS Code Insiders via Windows Directory Junctions:

- `C:\Users\Harsh\.vscode\extensions\antigravity-telemetry` $\leftrightarrow$ `G:\web dev\antigravity-telemetry`
- `G:\vs code insider\data\extensions\antigravity-telemetry` $\leftrightarrow$ `G:\web dev\antigravity-telemetry`

Run `node link-extensions.js` to create or verify the junctions.

### Reloading After Edits:

In VS Code / VS Code Insiders: Press `Ctrl + Shift + P` $\rightarrow$ **`Developer: Reload Window`**.

### Testing Client Script Without Launching VS Code:

Use `vm.runInContext` on the generated HTML's `<script>` block to catch any syntax or runtime errors before reloading VS Code.

---

## 7. Git & Workflow Rules

> [!IMPORTANT]
> **NO COMMITS WITHOUT EXPLICIT APPROVAL**:
> AI agents working on this codebase must **NEVER** run `git commit` or create git commits autonomously. Always verify changes with the user and wait for explicit user instruction or approval before committing any files.
