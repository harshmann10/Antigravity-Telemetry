# AGENTS.md - Antigravity Telemetry Extension

This file provides architectural, technical, and development instructions for any AI assistant working on this codebase.

> 📋 **History:** `DEV_CHANGELOG.md` summarises internal engineering changes by review phase; `CHANGELOG.md` contains user-facing release notes for GitHub releases. **Backlog & open questions:** §9 below. Everything else you need is in this file — read §5 (frontend rules), §6 (invariants) and §9 (known gaps) before making changes.

---

## 1. Project Overview

A zero-token, zero-dependency VS Code extension that reads Antigravity's local SQLite databases and
protobuf telemetry. **User-facing features live in `README.md`** — what matters when editing:

- **Zero npm dependencies.** Node built-ins and the VS Code API only. `media/dashboard.css` is generated at build time and committed.
- **No network, ever.** Every number comes from local files, so a wrong value is a parsing bug, not a connectivity problem.
- **Antigravity's files are read-only** except through the explicit `deleteConversation` path.

---

## 2. Directory & Component Structure

```text
G:\web dev\antigravity-telemetry\
├── .github/workflows/
│   └── release.yml       # GitHub Actions automated release & packaging pipeline
├── .vscodeignore         # Packaging ignore patterns for vsce / .vsix builds
├── package.json          # VS Code extension manifest (activation, commands, settings, build scripts)
├── extension.js          # Main entry point: Status bar, QuickPick, Webview lifecycle, watchers, message router
├── telemetryReader.js    # Data engine: SQLite reader, protobuf decoder, analysis cache, storage calculator, delete engine
├── dashboardHtml.js      # Webview template: Tailwind UI, dual-layer SVG chart, modal, client script
├── media/                # Dashboard styling: tailwind-input.css (source) + dashboard.css (generated, committed)
├── scripts/
│   ├── self-check.js        # Dependency-free verification suite (run after changing telemetryReader.js)
│   └── extract-changelog.js # Extracts changelog release notes for GitHub releases
├── link-extensions.js    # Script to symlink extension into VS Code & VS Code Insiders
├── unlink-extensions.js  # Script to remove symlinks
├── AGENTS.md             # AI development instructions, invariants & telemetry specs (this file)
├── DEV_CHANGELOG.md      # Detailed developer & engineering changelog by review phase
├── CHANGELOG.md          # User-facing release notes (parsed by GitHub Action release workflow)
└── README.md             # User guide and features
```

### Component Roles:

| File                    | Responsibility                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| `extension.js`          | Status bar, two-level QuickPick, webview lifecycle, watchers, message router, deletion outcome reporting |
| `telemetryReader.js`    | Protobuf decoder, SQLite queries, incremental analysis cache, storage calculator, delete engine          |
| `dashboardHtml.js`      | Self-contained webview HTML + client script (nonce CSP, `bindEvents()`, dual-layer SVG chart)            |
| `media/`                | `tailwind-input.css` (source) → `dashboard.css` (generated, **committed**)                               |
| `scripts/self-check.js`       | Dependency-free verification suite — run it after touching `telemetryReader.js`                          |
| `scripts/extract-changelog.js`| Automated release notes extractor targeting `CHANGELOG.md` sections for GitHub Releases                  |
| `.github/workflows/release.yml`| Automated GitHub Actions workflow to build `.vsix` packages and publish GitHub Releases with assets       |

**Operational facts:**

- **Refresh loop**: 10 s heartbeat that **skips while the window is unfocused** and refreshes on focus regain; guarded by `isRefreshing` so watcher + timer + manual refresh cannot stack.
- **Watchers**: `conversations/` filtered to the `.db` family (incl. `-wal`/`-shm`/`-journal`), debounced 400 ms; plus the antigravity root filtered to `conversation_summaries.db`, debounced 600 ms.
- **Logging**: `log()` writes to the `Antigravity Telemetry` OutputChannel (`antigravity.showLogs`), never `console`.
- **Settings** (`getConfig()`): `deleteToRecycleBin`, `workspaceFilter`, `sqlitePath`.
- **Exports for tooling and tests**: `readAllTelemetry`, `deleteConversation`, `analyzeConversation`, `validateConversationId`, `clearAnalysisCache`, `recyclePaths`, `parseWorkspaceInfo`, `conversationMatchesWorkspace`, `selectActiveConversation`, `getSqliteBinary`, `setCustomSqlitePath`.
- **Delete outcomes** are reported through `reportDeleteResult()`, which distinguishes full success, partial failure (locked files) and "nothing to delete" — never claim bytes that were not freed.

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
> **Antigravity's own delete only removes the catalog row.** Deleting a chat in the IDE leaves
> `conversations/<id>.db`, the entire `brain/<id>/` folder (megabytes of transcripts and media) and
> `annotations/<id>.pbtxt` on disk. Disk space is never freed, and anything reading `conversations/`
> keeps seeing the dead chat. That is the problem this extension exists to solve.

### Zero-Residue Deletion Engine (`deleteConversation`):

`telemetryReader.js` removes all 7 layers — `conversations/<id>.db` (+`-wal`/`-shm`), `brain/<id>/`,
`annotations/<id>.pbtxt`, `browser_recordings/<id>/`, `implicit/<id>.pb`, the `conversation_summaries`
row — and returns the exact number of freed bytes.

**Rules this engine must keep obeying:**

- **Recycle Bin by default.** `recyclePaths()` moves every target in a single batched PowerShell call
  (`Microsoft.VisualBasic.FileIO.FileSystem` + `RecycleOption.SendToRecycleBin`), driven by the
  `AG_RECYCLE_ITEMS` JSON env var. `antigravity.deleteToRecycleBin: false` switches to permanent deletion.
- **Verify, never assume.** The authoritative check is `fs.existsSync()` _after_ the attempt. A path that still
  exists goes into `failures[]` and its bytes are **not** counted as freed.
- **The catalog row is deleted last, and only if every file is gone.** Otherwise a locked DB would leave an
  orphaned catalog entry — the exact ghost-chat problem this extension exists to fix. `SELECT changes()` confirms
  the row was actually removed.
- **Strict UUID validation** before any filesystem or SQL write (`validateConversationId`).
- `purgeOrphanedData()` deletes each id **at most once** (a `handled` set), refuses to run when the catalog is
  unreadable, and reports `catalogRowsRemoved` separately from file deletions.

---

## 4. Protobuf Wire Schema (`conversations/<id>.db`)

### SQLite Schema:

- Table: `gen_metadata (idx INTEGER, data BLOB, size INTEGER)`
- Ordered by `idx ASC` for turn progression; latest row is the current turn.

### Protobuf Binary Layout in `gen_metadata.data`:

> [!IMPORTANT]
> **There are TWO different Tag 9 / Tag 10 pairs, in different namespaces.** Usage tokens live under
> `Tag 1 → Tag 4`; the context counters live under `Tag 1 → Tag 9`. Mixing them up is the easiest mistake to
> make in this file — check the parent, not just the tag number.

```text
Root Message
 ├── Tag 1 (Message)
 │    ├── Tag 19 (String): Model Name (e.g. "gemini-3.8-flash")
 │    ├── Tag 4 (Message): USAGE METADATA
 │    │    ├── Tag 2  (Varint): Non-cached Input Tokens (fresh prompt / Cache Write)
 │    │    ├── Tag 5  (Varint): Cached Input Tokens (served from cache / Cache Read)
 │    │    ├── Tag 3  (Varint): Candidates / Output Tokens (total generation)
 │    │    ├── Tag 9  (Varint): Thinking Tokens (internal reasoning)
 │    │    └── Tag 10 (Varint): Response Content Tokens (tool calls + text)
 │    ├── Tag 9 (Message): CONTEXT METADATA          <-- different Tag 9
 │    │    ├── Tag 1  (Varint): last step index
 │    │    └── Tag 10 (Message)
 │    │         ├── Tag 1 (Varint): CURRENT CONTEXT TOKENS  <-- authoritative, see below
 │    │         └── Tag 4 (Varint): CONTEXT CEILING = 256000
 │    └── Tag 20 (Message, repeated): key/value pairs (model_enum, last_execution_id, ...)
 ├── Tag 4 (String): conversation / trajectory UUID
 └── Tag 8 (Message): unexplored
```

### The authoritative context field (verified in every row of every chat)

`Tag 1 → Tag 9 → Tag 10 → { Tag 1 = context tokens, Tag 4 = 256000 }` is present in **all** rows (41/41 sampled
across 21 chats, first and last row of each). It is Antigravity's own live context counter and is what actually
triggers compaction:

| Observation                             | Value                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------ |
| Fresh-chat start (`Tag 1` at row 0)     | 22,451 / 24,050 / 24,551 / 24,551 → fixed system-prompt + tool-schema overhead |
| Peak before compaction                  | 255,600 - 255,913 → compaction fires at ~99.9 % of 256 k                       |
| Post-compaction reset                   | back to ~24,183 - 25,662                                                       |
| vs the extension's `fresh + cached` sum | ratio 0.98 - 1.41, avg 1.06 - 1.12 (i.e. that sum under-reports)               |

Use this field (falling back to `fresh + cached` and 255 k for older chats) for context fill %, the chart
ceiling, and compaction detection. A drop between consecutive values **is** a compaction, with an exact drop size.

> [!NOTE]
> `Tag 9 → Tag 10 → Tag 1` (trajectory context) and `Tag 4 → Tag 5` (API prompt cache) measure
> **different things** — see §5 for why the chart must clamp one to the other.

> ⚠️ `readVarint` returns a `BigInt` and real rows contain a `2^64-1` sentinel. Use `safeVarintNumber()` /
> `numField()` — never `Number(val)` directly.

### Formulas:

| Quantity                  | Source                                              |
| ------------------------- | --------------------------------------------------- |
| Cache Read                | `Tag 4 → Tag 5`                                     |
| Cache Write (fresh input) | `Tag 4 → Tag 2`                                     |
| Total Input               | `Tag 2 + Tag 5`                                     |
| Model Output              | `Tag 3` = thinking (`Tag 9`) + response (`Tag 10`)  |
| Grand Total               | Total Input + Model Output                          |
| Current Context           | `Tag 9 → Tag 10 → Tag 1` (fallback `Tag 2 + Tag 5`) |
| Context Ceiling           | `Tag 9 → Tag 10 → Tag 4` (fallback 255,000)         |

Context fill % = `min(100, round(Current Context / Ceiling × 100))`.

---

## 5. Critical Frontend / Webview Development Rules

### The nonce CSP forbids inline event handlers:

> [!CAUTION]
> **NEVER add `onclick="…"`, `onchange="…"` or `oninput="…"` to the dashboard markup.**
>
> The webview sets a nonce-based CSP (`script-src 'nonce-…'`). A nonce authorises `<script nonce=…>`
> **elements only** — it does _not_ authorise inline event-handler attributes, which the CSP spec requires
> `'unsafe-inline'` for. An inline handler therefore fails silently: no error in the UI, just a console
> violation and a dead control.
>
> **Safe pattern** — give it an `id` and bind it in `bindEvents()`:
>
> ```javascript
> // markup: <button id="purgeOrphansBtn">🧹 Purge Ghost Chats</button>
> const el = document.getElementById("purgeOrphansBtn");
> if (el) el.onclick = () => purgeOrphans();
> ```
>
> Same rule for `style="…"`: `style-src` includes `'unsafe-inline'` so inline style attributes work, but do
> not add `'unsafe-inline'` to `script-src` — that would defeat the nonce.

### Building markup in Node template literals:

> [!CAUTION]
> **Never build markup by concatenating escaped quotes, and never emit an `onclick` attribute.**
>
> Inside a Node template literal, `\''` unescapes to `''` before the browser sees it, so
> `"...onclick=\"f('" + id + "')\""` ships as `onclick="f('' + id + '')"` — a page-load `SyntaxError`
> that halts all dashboard JavaScript. Even when it parses, an `onclick` attribute is blocked by the
> CSP above. **The only correct pattern is `innerHTML` plus a real listener:**
>
> ```javascript
> div.innerHTML = '<button class="del-btn">🗑️</button>';
> div.querySelector(".del-btn").onclick = (e) => {
>   e.stopPropagation();
>   openDeleteModal(c.id);
> };
> ```

### Webview State vs. Background Polling Invariant:

> [!CAUTION]
> **NEVER overwrite interactive webview UI state from background polling messages.**
>
> Background polling (`telemetryUpdate` triggered by the 10s heartbeat or file watcher debounces) must **only** deliver updated data arrays (`CONVERSATIONS`), and must **never** clobber the user's interactive view filters or selections:
>
> - **Workspace Filter (`currentWorkspaceFilter`)**: Controlled by the user via the `workspaceSelect` dropdown in the webview. Routine background updates must **not** include or overwrite `currentWorkspaceFilter` with the VS Code setting (`antigravity.workspaceFilter`). Only explicit VS Code settings changes (`workspaceFilterConfigUpdate`) should update it.
> - **Active Selection (`selectedId`)**: Must **never** be reset back to `currentActiveId` or `filtered[0]` just because a filter, chip, or workspace scope is active. `selectedId` must **only** fall back if the conversation was literally deleted from disk (`!CONVERSATIONS.some(c => c.id === selectedId)`).
> - **Dropdown Inclusion (`chatSelect`)**: If `selectedId` is outside the current filtered view (e.g., user selected a subagent from a drawer or card while the view chip is on "Chats"), `populateDropdown()` must prepend `selectedId` to `displayList` so the dropdown accurately displays and retains the selected session rather than getting desynced.

### Layout & Single-Scroll Invariant:

> [!IMPORTANT]
> **Zero dual scrollbars — always use flex viewport allocation.**
>
> In `dashboardHtml.js`, never let the outer document window and inner lists create nested scrollbars:
> - `body`: `h-screen overflow-hidden flex flex-col` — the outer window must **never** scroll.
> - Controls & navigation header: `shrink-0` pinned at top.
> - Views (`#detailView` and `#listView`): `flex-1 min-h-0 overflow-y-auto`.
> - `#convList`: `flex-1 min-h-0 overflow-y-auto` (never use hardcoded `max-h-[600px]`).
> - **Subagent UI formatting**: Truncate task titles at 36 characters with full title in `title="..."` hover tooltip. Avoid noisy `(from "...")` suffixes. Badges must use `min-w-0 flex-1` to prevent badge clipping.

### Dual-Layer Chart Visual Integrity:

> [!CAUTION]
> **Clamp the cached series to the context series.**
>
> `pt.input` (trajectory context) and `pt.cached` (API prompt cache) measure different things. After
> Antigravity prunes tool output, the API cache can still hold the pruned prefix — measured **110,066
> cached vs 89,058 context** in `c4585504` — so an unclamped emerald series spills above the blue line
> and reports an impossible >100 % cache rate.
>
> ```javascript
> const visualCached = Math.min(pt.cached || 0, pt.input || 0); // geometry only
> const cachePct =
>   pt.input > 0
>     ? Math.min(100, Math.round(((pt.cached || 0) / pt.input) * 100))
>     : 0;
> ```
>
> Keep the raw, unclamped token counts in the tooltip. Covered by self-check section 10.

---

## 6. Development, Symlinks & Verification

### Live Directory Junctions:

VS Code and VS Code Insiders both link to this folder via Windows directory junctions
(`%USERPROFILE%\.vscode\extensions\antigravity-telemetry` and `G:\vs code insider\data\extensions\antigravity-telemetry`).
Run `node link-extensions.js` to create or repair them.

### Reloading After Edits:

In VS Code / VS Code Insiders: Press `Ctrl + Shift + P` $\rightarrow$ **`Developer: Reload Window`**.

### Testing Client Script Without Launching VS Code:

Use `vm.runInContext` on the generated HTML's `<script>` block to catch any syntax or runtime errors before reloading VS Code. Two gotchas:

- Top-level `let`/`const` in the script live in the context's **lexical** scope, so read them back with a second `vm.runInContext('CONVERSATIONS.length', sandbox)` call — they do not appear as properties of the sandbox object.
- Extract the script body as `html.slice(html.indexOf('>', html.indexOf('<script nonce=')) + 1, html.lastIndexOf('</script>'))`. Do not search for the next `>` inside the body (an `=>` or `>` in the code truncates it).

### Verifying a Change:

```bash
node scripts/self-check.js   # protobuf math, incremental-vs-full parity, id validation, Recycle Bin round trip
npm run build:css            # ONLY after changing class names in dashboardHtml.js (output is committed)
npm run package              # Packages the extension as a standalone .vsix via @vscode/vsce
```

`media/dashboard.css` is generated but **must be committed** — there is no CDN fallback any more, and the dashboard would render unstyled without it.

### Packaging & Distribution (.vsix):

The extension is packaged as a standalone installer using `@vscode/vsce`:
- Configuration: `.vscodeignore` excludes development scripts (`scripts/`, `link-extensions.js`, etc.) and dev inputs (`tailwind-input.css`).
- Build command: `npm run package` generates `antigravity-telemetry-1.0.0.vsix` (~58 KB, 10 runtime files).
- Zero runtime dependencies: all telemetry parsing runs on pure Node built-ins and precompiled CSS.

### Invariants — every row here has already caused a real bug:

| Trap                                                      | What happens                                                                                                                           | Rule                                                                                 |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Inline `onclick` under the nonce CSP                      | Control silently does nothing (console violation only)                                                                                 | Bind in `bindEvents()` (§5)                                                          |
| Treating a `null` catalog as `{}`                         | Every chat looks like a ghost; purge offered for healthy chats                                                                         | Check `catalogAvailable`                                                             |
| A new per-conversation field not added to the cache state | Correct on first refresh, silently stale afterwards                                                                                    | Derive from cached state, or add it to the `(mtimeMs, size, walSignature)` signature |
| `Number(bigint)` on a varint                              | The `2^64-1` sentinel leaks as `1.8e19` into the UI                                                                                    | Use `safeVarintNumber()` / `numField()`                                              |
| Deleting the catalog row before verifying files           | Creates new ghost chats                                                                                                                | Verify with `existsSync` first, then delete the row                                  |
| Delimiter-splitting `sqlite3.exe` output                  | Windows rewrites chars < 32 to caret notation (`char(31)` → `^_`), so `split()` silently fails and **every** chat is flagged an orphan | Query with `-json` and `JSON.parse()`                                                |
| Reading `title` without a `preview` fallback              | 17 of 30 reference rows have an empty `title`                                                                                          | Fall back from `title` to `preview`, then to `'Untitled Conversation'`               |
| Backticks inside the `dashboardHtml.js` template literal  | Node `SyntaxError` on load                                                                                                             | Plain text in comments                                                               |
| Background polling overwriting webview state              | The user's scope/selection silently reverts every 10 s                                                                                 | See the webview state invariant in §5                                                |
| Matching workspaces by folder **name**                    | A renamed folder shows 0 chats; a short name matches everything                                                                        | Match by path prefix (`conversationMatchesWorkspace`)                                |
| Choosing the active chat before filtering                 | A hidden subagent drives the footer                                                                                                    | Prefer a human chat, from the visible set                                            |

---

## 7. Live-Data Reference (measured 2026-09-22)

A snapshot of the reference installation — useful for sizing decisions and for judging whether a new UI
feature will behave sensibly. Re-measure before relying on it.

- **Catalog vs. UI**: 30 catalog rows, **21** conversation `.db` files (21 visible), 9 rows with no `.db` (aborted subagent task records — real previews, zero bytes), 22 brain folders. No row lacks both title and preview (the `preview` fallback rescues 17 empty-title rows).
- **Workspaces**: `g:/web dev` 21 rows (**12 visible**), `g:/job` 9 rows (**9 visible**).
- **Subagents**: 16 catalog rows carry `parent_conversation_id` / `agent_name`, but only **7 have a `.db`** (`firefox_browser` ×8, `browser` ×6, `DeepInvestigator` ×1, `DeepInvestigatorWorkerL0` ×1; `nesting_depth` 0 ×14, 1 ×15, 2 ×1). **5 of the 7 resolve to a named parent**; **2 are unattached** — `2e436dd9` (2.14M tok, parent `1797e61d` is catalog-only) and `ee1db8dd` (34k tok, parent `f1e2afae` has no catalog row). Those two are why the Unattached group exists.
- **Token share**: human chats **480.56M (99.1%)** vs subagents **4.50M (0.9%)** — subagents are a _session-list noise_ problem, not a token-accounting problem.
- **Per-model ceiling**: the ceiling belongs to the **model**, not the conversation, and can change mid-session — `e570da32` ran `gemini-3.1-pro-low` at **128,000** for rows 0-29, then switched to `gemini-3.7-flash` / `gemini-3.8-flash` at **256,000** from row 30. The reader takes the newest value (correct for current headroom); the chart guideline is drawn at that latest ceiling across the whole history, so it sits above the real limit for the earlier rows (cosmetic, not fixed).

---

## 8. Design Decisions

**Subagents are nested, never hidden — there is deliberately no `antigravity.hideSubagents`.**

- A boolean hide is the wrong primitive: it is a _view preference_ being stored as _behaviour_, it destroys the parent→child relationship (the only genuinely useful thing in the data), and it has no visible state — after a week you cannot tell whether subagents are hidden or simply absent.
- Instead: nested collapsible drawers (§ Task 3 in `CHANGELOG.md`), a transient per-session view chip (`All` / `Chats` / `Subagents`), and an "Unattached" group so nothing can vanish.
- **Do not add a `hideSubagents` setting.** If a persistent option is ever genuinely needed, make it a view chip state rather than configuration.

**Bulk automated ghost purging is intentionally removed.**
- A telemetry tool must prioritize safety and non-destructive observability. SQLite catalog locks, background Antigravity sync, or schema updates can temporarily make healthy active conversations appear unindexed. A bulk "purge" button risked deleting real user transcripts and databases.
- Safe, individual conversation deletion (`🗑️` trash icon with detailed confirmation modal) provides full cleanup control with zero collateral damage risk.

**Deletion defaults to the Recycle Bin, not permanent removal.** Six storage layers are wiped in
one action, so recoverability matters more than the few seconds saved.

---

## 9. Known Gaps & Backlog

**Open**

1. **Non-JSON catalog fallback is incomplete (low).** `getConversationSummaries()` falls back to delimiter splitting when `sqlite3` lacks `-json`. That path does not fetch `parent_conversation_id` / `agent_name` / `nesting_depth` / `killed`, so if it ever ran, every conversation would be treated as a human chat — no drawers, no Unattached group, and `selectActiveConversation()` would degrade to mtime order. It is _graceful_ (nothing is hidden or lost; all rows still render as flat chats) and dormant on `sqlite3` 3.50.6. Fixing it would also make the subagent features resilient to an ancient `sqlite3`.
2. **Cold start is ~2 s** after a window reload. Single-process `sqlite3` batching was deliberately cut for leanness; the warm path is ~30 ms. Revisit only if the cold delay becomes annoying.
3. **~100 KB of stats JSON** is posted to the webview on every refresh. Fine at the current size; if the dashboard ever feels heavy, send only the selected conversation's timeline.

**Resolved**

- **Bulk automated ghost purging removed**: Replaced with safe per-conversation deletion to eliminate data loss risk from temporary catalog lockouts.
- **Dual-scroll layout resolved**: Pinned header and flex-1 scroll container eliminate nested scroll jail across viewport sizes.
- **Packaging workflow established**: Added `.vscodeignore` and `npm run package` producing a self-contained 58 KB `.vsix` installer.

---

## 10. Git & Workflow Rules

> [!IMPORTANT]
> **NO COMMITS WITHOUT EXPLICIT APPROVAL**:
> AI agents working on this codebase must **NEVER** run `git commit` or create git commits autonomously. Always verify changes with the user and wait for explicit user instruction or approval before committing any files.
