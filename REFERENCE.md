# Antigravity Telemetry - Technical Reference & Specifications

This document serves as the authoritative technical reference for the internal database schemas, binary protobuf layouts, multi-root storage architecture, and telemetry data models used across **Antigravity Extension**, **Antigravity IDE**, and **Antigravity CLI**.

> 💡 **For AI Agents & Developers:** Core development rules, git restraint, and runtime invariants live in [`AGENTS.md`](./AGENTS.md). Consult this document for in-depth wire schemas, database queries, and reverse-engineered telemetry specs.
>
> 🔄 **Maintenance Protocol:** When code in `telemetryReader.js`, `extension.js`, or `dashboardHtml.js` introduces or alters protobuf tags, SQLite schemas, tool arguments, or storage paths, update this file immediately to keep the technical specifications authoritative. Never copy raw schemas or SQL tables into `AGENTS.md`.

---

## 1. Multi-Root Storage Architecture

The extension unifies telemetry across three distinct Antigravity environments:
1. **Antigravity Extension in VS Code**: Root at `%USERPROFILE%\.gemini\antigravity`, catalog at `conversation_summaries.db`.
2. **Antigravity IDE (VS Code Fork)**: Root at `%USERPROFILE%\.gemini\antigravity-ide`, catalog in VS Code state store `%APPDATA%\Antigravity IDE\User\globalStorage\state.vscdb`.
3. **Antigravity CLI (`agy`)**: Root at `%USERPROFILE%\.gemini\antigravity-cli`, catalog at `conversation_summaries.db`.

### Storage Locations & Assets per Conversation:

| Path / Asset                                                              | Purpose                                                                                                                              | Size / Impact                                     |
| :------------------------------------------------------------------------ | :----------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------ |
| `%USERPROFILE%\.gemini\<root>\conversations\<id>.db`                      | SQLite database with `gen_metadata` (turns) and `steps` (actions) tables. Also `<id>.db-wal` and `<id>.db-shm`.                      | 1 MB – 30 MB per chat                             |
| `%USERPROFILE%\.gemini\<root>\conversation_summaries.db`                  | Extension & CLI catalog table `conversation_summaries` listing conversation ID, title, timestamp, step count.                       | Global database                                   |
| `%APPDATA%\Antigravity IDE\User\globalStorage\state.vscdb`                | IDE catalog table `ItemTable` storing Base64+protobuf trajectory summaries under key `antigravityUnifiedStateSync.trajectorySummaries`.| Global SQLite DB                                  |
| `<id>.db` tables `trajectory_metadata_blob` & `steps`                     | In-DB self-description fallback: workspace directory URIs (`trajectory_metadata_blob`) & initial user prompt (`steps`, idx=0).      | Live session fallback                             |
| `%USERPROFILE%\.gemini\<root>\brain\<id>\`                                | Transcripts (`transcript.jsonl`, `transcript_full.jsonl`), `.system_generated/` logs, `.user_uploaded/` media, and `scratch/` files. | **10 MB – 100 MB+ per chat** (major disk consumer)|
| `%USERPROFILE%\.gemini\<root>\annotations\<id>.pbtxt`                     | Protobuf text format annotation metadata.                                                                                            | Few KB                                            |
| `%USERPROFILE%\.gemini\<root>\browser_recordings\<id>\`                   | Screen recordings and devtools snapshots (if browser MCP used).                                                                      | Variable (MBs)                                    |
| `%USERPROFILE%\.gemini\<root>\implicit\<id>.pb`                           | Implicit conversation state protobuf.                                                                                                | Few KB                                            |

---

## 2. Zero-Residue Deletion & The "Ghost Chat" Problem

### The "Ghost Chat" Incomplete Deletion Finding
Antigravity's built-in "Delete Chat" action **only deletes the row in `conversation_summaries`**. It leaves behind:
1. `conversations/<id>.db` (+`-wal`/`-shm`)
2. The entire `brain/<id>/` directory (often 10 MB to 100 MB of transcripts, logs, and user-uploaded media)
3. `annotations/<id>.pbtxt`
4. `browser_recordings/<id>/`
5. `implicit/<id>.pb`

Because the files remain on disk, any disk scanner or raw file watcher continues to see dead chats.

### Zero-Residue Deletion Sequence (`deleteConversation`)
When deleting a conversation, `telemetryReader.js` systematically removes all 7 asset layers:
1. **Target Identification**: Locate the origin root (`extension`, `ide`, or `cli`) via `findRootForConversation(id)`.
2. **Strict UUID Validation**: Run `validateConversationId(id)` to prevent path traversal or SQL injection before touching disk or database.
3. **File Removal (Recycle Bin by default)**:
   - Uses `recyclePaths()` to batch-send the target files and directories to the OS Recycle Bin (`Microsoft.VisualBasic.FileIO.FileSystem.DeleteFile` / `DeleteDirectory` with `RecycleOption.SendToRecycleBin`).
   - If `antigravity.deleteToRecycleBin: false` is configured, falls back to permanent deletion (`fs.rmSync`).
4. **Post-Deletion Verification**:
   - Every path is verified with `fs.existsSync()` *after* deletion. A file that still exists (e.g. locked by another process) is recorded in `failures[]` and its bytes are **never** counted as freed.
5. **Catalog Row Purge (Executed Last)**:
   - The catalog row in `conversation_summaries` is removed **only after** filesystem deletion succeeds. If a locked database could not be deleted, the catalog entry is preserved so it does not turn into an untracked ghost chat.
   - Confirmed using `SELECT changes()` in SQLite.

---

## 3. Protobuf Wire Schemas (`conversations/<id>.db`)

### SQLite Table: `gen_metadata`
Stores the turn-by-turn context growth and token telemetry.
- Columns: `idx INTEGER`, `data BLOB`, `size INTEGER`
- Ordered by `idx ASC` for turn progression; the latest row represents the current conversation state.

### Protobuf Binary Layout in `gen_metadata.data`:

> [!IMPORTANT]
> **There are TWO distinct Tag 9 / Tag 10 pairs in different namespaces:**
> - Usage tokens live under `Tag 1 → Tag 4`.
> - Context window counters live under `Tag 1 → Tag 9`.
> Mixing them up will corrupt context ceiling and token calculations.

```text
Root Message
 ├── Tag 1 (Message)
 │    ├── Tag 19 (String): Model Name (e.g. "gemini-3.8-flash")
 │    ├── Tag 4 (Message): USAGE METADATA
 │    │    ├── Tag 2  (Varint): Non-cached Input Tokens (fresh prompt tokens)
 │    │    ├── Tag 5  (Varint): Cached Input Tokens (served from API cache)
 │    │    ├── Tag 3  (Varint): Candidates / Output Tokens (generation tokens)
 │    │    ├── Tag 9  (Varint): Thinking Tokens (internal model reasoning)
 │    │    └── Tag 10 (Varint): Response Content Tokens (tool calls + text output)
 │    ├── Tag 9 (Message): CONTEXT METADATA          <-- different Tag 9
 │    │    ├── Tag 1  (Varint): last step index
 │    │    └── Tag 10 (Message)
 │    │         ├── Tag 1 (Varint): CURRENT CONTEXT TOKENS (authoritative input context)
 │    │         └── Tag 4 (Varint): CONTEXT CEILING (default 256000)
 │    └── Tag 20 (Message, repeated): Key/value runtime execution pairs
 ├── Tag 4 (String): Conversation UUID
 └── Tag 8 (Message): Internal routing metadata
```

### Context Ceiling & Mid-Session Model Switches:
- Context ceiling belongs to the **model**, not the conversation.
- If a user switches from `gemini-3.1-pro-low` (128,000 ceiling) to `gemini-3.8-flash` (256,000 ceiling) mid-session, the latest row's ceiling is authoritative for headroom calculations.
- Clamping rule: in `dashboardHtml.js`, always clamp the visual cached series:
  ```javascript
  const visualCached = Math.min(pt.cached || 0, pt.input || 0);
  ```
  *(Prevents API cache prefixes from exceeding trajectory context lines after tool pruning).*

### Subagent Role Extraction (`raw_summary`):
In `conversation_summaries.db`, subagents store a binary protobuf blob in `raw_summary`.
To extract the human-readable role (e.g. `image-generator`, `firefox_browser`, `DeepInvestigatorWorkerL0`):
- Path: `Tag 17 (Message) → Tag 8 (Message) → Tag 2 (String)`
- Function: `extractSubagentRole(hexRaw)` in `telemetryReader.js`.

---

## 4. SQLite Catalogs & State Stores

### 1. Extension & CLI Catalog: `conversation_summaries.db`
- **Table**: `conversation_summaries`
- **Columns**:
  - `conversation_id TEXT PRIMARY KEY`
  - `title TEXT`
  - `preview TEXT` (fallback prompt snippet when title is empty or `<original_task>`)
  - `step_count INTEGER`
  - `last_modified_time TEXT` (ISO 8601 string)
  - `workspace_uris TEXT` (JSON string array of `file:///` URIs)
  - `parent_conversation_id TEXT` (links subagents to parent chats)
  - `nesting_depth INTEGER`
  - `agent_name TEXT`
  - `killed INTEGER` (1 if aborted/killed)
  - `status TEXT` (e.g. `CASCADE_RUN_STATUS_RUNNING` for active CLI sessions)
  - `not_fully_idle INTEGER`
  - `raw_summary BLOB` (contains subagent role in protobuf)

### 2. Antigravity IDE State Store: `state.vscdb`
- **Table**: `ItemTable (key TEXT PRIMARY KEY, value TEXT)`
- **Key**: `antigravityUnifiedStateSync.trajectorySummaries`
- **Payload**: Base64 string containing serialized protobuf list of summaries:
  - `Tag 1` (Repeated Message: Trajectory Summary item):
    - `Tag 1` (String): Conversation UUID
    - `Tag 2` (Varint): Step count / turns
    - `Tag 3` (String): Conversation Title
    - `Tag 5` (Varint): Creation timestamp
    - `Tag 7` (Varint): Last modified timestamp (seconds)
    - `Tag 9` (Message): Workspace metadata containing `Tag 1` or `Tag 2` (directory URI)
    - `Tag 17` / `Tag 21` (Message): Repeated workspace file URI references
    - `Tag 23` (Message): Parent conversation UUID linkage

### 3. In-DB Self-Description Fallback (`<id>.db`)
For live active sessions before the catalog commit, `<id>.db` contains:
1. **Workspace Paths**:
   - Table: `trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB)` where `id = 'main'`.
   - Path: `Tag 1 → Tag 7 → repeated Tag 2 (String)` contains workspace directory paths.
2. **Initial User Prompt / Title Fallback**:
   - Table: `steps (idx INTEGER PRIMARY KEY, ...)`
   - Step at `idx = 0`: Protobuf message with `Tag 19 → Tag 2 (String)` containing the initial user prompt.

---

## 5. Step Types & Session Activity Schema (Issue #3)

Antigravity logs every atomic action in the `steps` table of `<id>.db`:
```sql
CREATE TABLE `steps` (
  `idx` INTEGER PRIMARY KEY,
  `step_type` INTEGER NOT NULL DEFAULT 0,
  `status` INTEGER NOT NULL DEFAULT 0,
  `has_subtrajectory` NUMERIC NOT NULL DEFAULT false,
  `metadata` BLOB,
  `error_details` BLOB,
  `permissions` BLOB,
  `task_details` BLOB,
  `render_info` BLOB,
  `step_payload` BLOB,
  `step_format` INTEGER NOT NULL DEFAULT 0
);
```

### Recognized `step_type` Constants:
- `step_type = 14`: **`USER_INPUT`** (User prompt text).
- `step_type = 15`: **`PLANNER_RESPONSE`** (Model thoughts, reasoning, and planned actions).
- `step_type = 132`: **`TOOL_CALL`** (Actual tool execution payload and parameters).
- `step_type = 17`: System control & status events.
- `step_type = 23`: Context compaction / truncation boundaries.
- `step_type = 101`: Internal asynchronous notification messages.

### Activity Extraction (`extractSessionActivity`):
Extracts operational metrics displayed in the **Session Operations & Activity** card:
1. **Responses**: `count(step_type = 15)` (Assistant replies) vs `count(step_type = 14)` (User prompts).
2. **Total Tool Invocations**: `count(step_type = 132)`.
3. **Executed Commands**: Tool invocations matching `'run_command'`.
4. **Subagents Invoked**: Tool invocations matching `'invoke_subagent'`.
5. **Web Requests**: Tool invocations matching `'read_url_content'` or `'search_web'`.
6. **Analyzed Images**: Occurrences of `'image/'` or `'browser_screenshot'`, plus user uploads in `.gemini/<root>/brain/<id>/.user_uploaded/`.
7. **Files Read & Modified**:
   - Query: `WHERE (step_type = 15 OR step_type = 132) AND (view_file | read_file | replace_file_content | write_to_file)`
   - Regex: `/"(?:AbsolutePath|TargetFile|filePath|file_path|target_file)":\s*"([^"]+)"/g`
   - Normalized with `path.normalize()` and deduplicated into `filesRead` and `filesModified` arrays.

---

## 6. Live Installation Reference Benchmarks

Data characteristics from real production installations (useful for testing and performance budgets):

- **Typical Turn Counts**:
  - Small / Conceptual Q&A: 1 to 5 turns.
  - Medium Task: 20 to 80 turns.
  - Large Multi-Step Agent: 200 to 850+ turns (`0d45b64f`, `72a3ced6`, `b05dc0d7`).
- **Token Share Distribution**:
  - Human chats account for **>98%** of total token consumption.
  - Subagents account for **<2%** of tokens (subagents are a *session-list noise* problem, not a token accounting problem).
- **Latency Targets**:
  - Cold start (fresh scan of 35+ SQLite databases): ~2,500 ms – 3,500 ms.
  - Warm restart (via local persistent cache `telemetry-cache.json`): **< 50 ms**.
  - Background incremental tick (no changes on disk): **< 5 ms** (zero sqlite spawns).
- **Network Traffic over Remote SSH**:
  - Idle background polling: **0 bytes**.
  - Inactive conversation payload: **~175 KB** (reduced by 86%–95% from un-decimated 1.2+ MB).

---

## 7. Historical Design Rationale

1. **Subagents are nested, never hidden**:
   - There is intentionally no boolean `antigravity.hideSubagents` setting.
   - Hiding destroys the parent $\rightarrow$ child relationship and leaves users wondering where their sessions went.
   - Instead, the UI uses collapsible parent drawers, an "Unattached" fallback container, and interactive view chips (`All` / `Chats` / `Subagents`).
2. **No automated bulk ghost purging**:
   - Deletion must always remain an intentional, non-destructive user action.
   - Background SQLite locks or schema sync can make healthy sessions look temporarily missing from the catalog; bulk purging risked accidental data loss.
3. **Icon branding (The "Box-in-a-Box" Trap)**:
   - `media/icon.png` is **256×256 PNG**; `logo.png` is **1024×1024 PNG**.
   - Must touch image borders edge-to-edge with 100% transparent PNG alpha outside the squircle radius. Never use an opaque dark rectangular outer margin (causes unsightly double-border tiles across varying VS Code theme backgrounds).
