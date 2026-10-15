# Developer & Internal Engineering Changelog

Technical and architectural notes for Antigravity Telemetry, grouped by development and review phases.
For the user-facing release notes, see [`CHANGELOG.md`](./CHANGELOG.md).

## 2026-10-15 — Phase 5: Remote SSH Bandwidth Optimization & Local Storage Architecture

**Task 1 — Root Cause Diagnosis: Remote SSH Traffic Explosion**
- Investigated user issue report: `"Bug: The new version abnormally transfers a large amount of traffic."` over Remote SSH.
- Diagnosed that in VS Code's client-server architecture (Remote SSH, WSL, Dev Containers), the extension host runs remotely while the UI runs locally.
- Identified that `context.globalState.update('telemetryAnalysisCache', dump)` was executing on every 10s heartbeat and every file watcher debounce, serializing a multi-megabyte JSON cache across the SSH tunnel RPC socket.
- Identified that `state.vscdb` in `globalStorage` was watched by `fs.watch`, creating a feedback loop where `globalState.update` triggered the watcher, which called `updateTelemetry()`, which updated `globalState`.
- Identified that `currentPanel.webview.postMessage` broadcast full un-decimated `contextTimeline` turn arrays for dozens of inactive historical conversations on every update even when the dashboard tab was hidden.

**Task 2 — Isolated Local Disk Cache Persistence (`globalStorageUri`)**
- Migrated cache persistence from `context.globalState` to isolated local file storage on disk using `extensionContext.globalStorageUri` (`telemetry-cache.json`).
- In Remote SSH, `globalStorageUri.fsPath` resides entirely on the remote host filesystem. Network traffic over the SSH tunnel: **0 bytes**.
- Added automatic migration: on startup, detects legacy `telemetryAnalysisCache` in `globalState`, imports it, and purges the key via `globalState.update(..., undefined)`.
- Added atomic disk writes (`.tmp` file write + atomic `fs.renameSync`) with debounced 3-second save throttling and flush on `deactivate()`.
- Added `isCacheDirty()` tracking in `telemetryReader.js` so unchanged cycles generate zero disk writes.

**Task 3 — Selective Webview Timeline Delivery & On-Demand Loading**
- Built `prepareConversationsForWebview(conversations, selectedId)`: strips heavy `contextTimeline` arrays from all inactive conversations, delivering full 1:1 turn details strictly for the currently selected session.
- Reduced Webview IPC payload size by ~88–95% (e.g. from 1,217 KB to 169 KB).
- Added on-demand timeline loading: when a user selects a session in the dashboard whose timeline was stripped, the webview sends `{ command: 'getTimeline', conversationId }`, and the extension replies with `{ type: 'timelineData', ... }`.
- Webview caches loaded timelines locally in memory; subsequent `telemetryUpdate` messages preserve cached timelines rather than clearing them.

**Task 4 — Webview Visibility Guard & State Signature Dirty-Checking**
- Added visibility guard: `currentPanel && currentPanel.visible`. Telemetry update messages are suppressed while the dashboard panel is hidden or minimized behind other editor tabs.
- Hooked `currentPanel.onDidChangeViewState` to immediately send a fresh update when the panel is brought back into view.
- Added `computeTelemetrySignature(state)` dirty-checking: if conversation counts, active IDs, modification times, and turn totals have not changed, `updateTelemetry` exits early, suppressing redundant status bar DOM mutations, webview messages, and disk writes.

**Task 5 — Configurable Persistent Cache Setting (`antigravity.enableCache`)**
- Added `antigravity.enableCache` boolean setting (default `true`) to `package.json` with configuration change listener in `extension.js`.
- Added interactive QuickMenu toggle: `$(archive) Persistent Startup Cache: Enabled / Disabled`.
- When disabled, immediately cleans up any existing `telemetry-cache.json` on disk and bypasses disk writes, ensuring fresh on-demand SQLite parsing.

---

## 2026-10-11 — Phase 4: Antigravity IDE & Multi-Root Telemetry Support (Issue #1)

**Task 1 — Host-Aware Installation Discovery & User Configuration**
- Added `getInstallationRoots(preference, hostEditor)` resolving `%USERPROFILE%\.gemini\antigravity-ide` (`ide`) alongside `%USERPROFILE%\.gemini\antigravity` (`extension`), with auto-detection of the active editor to eliminate cross-environment clutter.
- Added `antigravity.dataSource` configuration (`auto`, `ide`, `extension`, `both`) to `package.json` with an interactive switch picker in the QuickPick status menu.
- Unified multi-root directory discovery with deduplication by conversation modification timestamp.

**Task 2 — Antigravity IDE State Store Catalog Extraction (`state.vscdb`)**
- Located IDE session summaries in `%APPDATA%\Antigravity IDE\User\globalStorage\state.vscdb` under key `antigravityUnifiedStateSync.trajectorySummaries`.
- Built Base64 + Protobuf decoder (`parseVscdbTrajectorySummaries`, `getVscdbSummaries`) extracting conversation UUIDs, titles, step counts, timestamps, and workspace mappings.
- Added file modification and size caching (`vscdbCache`) to prevent redundant `sqlite3` queries on heartbeats.

**Task 3 — In-DB Self-Description Fallback for Live Sessions**
- Resolved live/in-flight session visibility before disk catalog commits.
- Decoded `<id>.db`'s `trajectory_metadata_blob` (`id = 'main'`, Tag 1 $\rightarrow$ Tag 7) for workspace URIs.
- Decoded `<id>.db`'s `steps` table (`idx = 0`, Tag 19 $\rightarrow$ Tag 2) for initial prompt/title fallback.
- Prevented active conversations from being flagged as ghost chats or filtered out by workspace scoping.

**Task 4 — Multi-Root File Watchers & Zero-Residue Deletion**
- Updated `extension.js` to watch conversation directories across all detected roots and `state.vscdb` in `globalStorage`.
- Enhanced `deleteConversation()` with root discovery (`findRootForConversation`) ensuring all 7 storage layers are cleaned up across the correct installation directory.

**Task 5 — Transient Planner V-Dip Filtering & Compaction Qualification**
- Diagnosed single-turn transient context notches in Antigravity IDE caused by intermediate planner execution boundaries where tool outputs are temporarily pruned.
- Added reconciliation in `telemetryReader.js` (`contextTimeline`) to distinguish transient dips that rebound within 2 turns from sustained session compactions that reset working memory near ceiling.
- Added Section 1c to `scripts/self-check.js` validating transient notch filtering vs. true compaction detection (177 tests total).

**Task 6 — Forced Un-Cached Manual Refresh & UI Fluctuation Stability**
- Added `{ force = false }` option to `readAllTelemetry()`, bypassing `entry && !changed` to force a complete re-read from SQLite and recalculate stats from scratch.
- Connected dashboard `refresh` command and `antigravity.refresh` command to trigger `updateTelemetry({ force: true })`.
- Factored live `-wal` modification time in conversation sorting (`Math.max(stat.mtimeMs, walStat.mtimeMs)`) to prevent in-flight sessions from fluctuating in list order.
- Guarded status bar tooltip/color updates and dashboard SVG chart re-renders against identical payloads, eliminating hover flickering.

**Task 7 — Open VSX Registry Distribution**
- Registered namespace `HarshMann` on [Open VSX](https://open-vsx.org/extension/HarshMann/antigravity-telemetry) and published `.vsix`.
- Added Open VSX installation instructions and status badges to `README.md` and release workflow commands to `AGENTS.md`.

---

## 2026-10-11 — Phase 3: UX Polish, Subagent Decoding & Startup Acceleration

**Task 1 — On-Demand Manual Refresh in Visual Dashboard**
- Added header `#refreshBtn` with interactive states (`idle`, `syncing`, `updated`) and tactile active feedback (`active:scale-95`).
- Communicates via `vscode.postMessage({ command: 'refresh' })` to trigger immediate telemetry reload.
- Synchronous animation handling with spinning SVG icon, disabled spam prevention, and 3-second fallback safety timer.
- Responsive layout collapses gracefully to icon-only on narrow split views.

**Task 2 — Subagent Role Decoding & Hierarchy Presentation**
- Decoded protobuf `raw_summary` records (`Tag 17 → Tag 8 → Tag 2`) across both JSON and delimiter catalog fallback paths to extract genuine subagent task roles (e.g. `Icon Designer`, `Research Assistant`), eliminating generic "Untitled Conversation" labels.
- Added interactive collapsible toggle (`▼ Collapse` / `▶ Expand`) to the subagent breakdown card in the detail view with smooth overflow containment.
- Extended delimiter fallback parser with full subagent field extraction parity (`parent_conversation_id`, `nesting_depth`, `agent_name`, `killed`, `HEX(raw_summary)`).

**Task 3 — Branding & Asset Polish**
- Embedded official high-resolution `media/icon.png` into the webview tab title and header brand badge.
- Added transparent squircle masking preventing "box-in-a-box" double-border artifacts against dark and light themes.

**Task 4 — Instant Startup & Persistent Cache**
- Implemented `dumpAnalysisCache()` and `loadAnalysisCache()` to serialize in-memory conversation analysis and catalog summaries into VS Code's `context.globalState`.
- On extension activation, restored cached stats instantly bypass cold sqlite spawns, dropping window reload and startup scan time from **~3,500 ms to ~30–50 ms** (~98% speedup).
- Added `summariesCache` to validate `conversation_summaries.db` by `(mtimeMs, size, walSignature)`.
- Streamlined storage walks by eliminating redundant `existsSync` probes before `statSync`/`readdirSync` and sorting conversation inspection by `mtimeMs` descending (most active first).

---

## 2026-09-22 — Phase 2: Data Accuracy, Scoping, Configuration

**Task 1 — Authoritative Context, True Ceiling, No Dollar Figures**

- Decoded `root → tag1 → tag9 → tag10` (`tag1` = live context tokens, `tag4` = per-model ceiling), with a per-row fallback to `fresh + cached` / 255k for legacy chats.
- Context fill %, headroom, peak % and the chart guideline now read the decoded ceiling instead of a hardcoded 255,000.
- Compaction detection became ground truth — a drop between consecutive context values, with an exact drop size, replacing the `totalInput < prevContext - 10000` heuristic.
- Removed all estimated-cost math and UI (`estimatedCost`, `costSaved`, the cost pill, "Saved: $…"); surfaced `thinkingRate` on the Model Output KPI.
- _Review finding:_ `peakContext` / `minContext` only tracked decimated (sampled) turns, under-reporting the peak on 4 of 21 real chats (worst 1,168 tokens). Now tracked on every turn.

**Task 2 — Workspace Scoping**

- New `antigravity.workspaceFilter` (`current` | `all`, default `current`); `parseWorkspaceInfo()` decodes `workspace_uris` into native paths plus a display name.
- Active chat, history picker and delete picker all scope to the visible workspace, so another project's chat cannot hijack the status bar. The dashboard gained a scope dropdown, per-row badges and scope-aware headers/KPIs.
- _Review finding:_ the dashboard filtered by workspace **folder name** with a substring test — a renamed folder showed 0 chats, and a workspace named `b` matched all 21. Both surfaces now share one path-prefix predicate (`conversationMatchesWorkspace`).

**Task 3 — Subagent Organization**

- Subagents are **nested, never hidden**: a parent gets a collapsed drawer (`▾ 🤖 3 subagents · 165.0k tok · 0.6 MB`) that expands to the child rows, plus an "Unattached Subagents" group for children whose parent has no local data.
- A transient header view chip (`All · Chats · Subagents`) replaces a persistent setting, so the view cannot be left filtered by accident.
- Tab 1 gained a rolled-up card (`Parent + Subagents = Total`) and a 3-tier breadcrumb (link / text+note / unavailable).
- `selectActiveConversation()` prefers a human chat, so a background worker finishing later cannot drive the footer.

**Task 4 — Configuration & Failure Visibility**

- New `antigravity.sqlitePath`, with a "Set Path" prompt reachable from the status bar, the error toast and the QuickPick menu.
- `getSqliteBinary()` returns `null` instead of a bare `'sqlite3'` string, so a missing CLI is now visible: `$(error) Antigravity: sqlite3 missing` with an error-coloured status bar. The warning fires once and re-arms after recovery.
- Removed bulk ghost purge to prevent accidental deletion during SQLite lock or catalog sync; individual per-chat deletion with full confirmation remains available.

**Follow-ups**

- Dual-layer chart: the cached series is clamped to the context series so the emerald area can never render above the blue line; tooltip percentage capped at 100% (raw token counts stay exact).
- Webview view-state stability: background polling no longer clobbers the user's workspace scope or selected chat, and `chatSelect` retains a selection outside the current filter.
- Subagent UI polish: descriptions truncated cleanly to 36 chars with hover tooltips, badges adjusted to prevent layout clipping, and table rows de-cluttered.
- Responsive single-scroll layout: pinned header (`shrink-0`) and responsive list fill (`flex-1 min-h-0`), removing dual-scrollbars on Tab 2.
- 1:1 timeline fidelity & proportional chart scaling: removed artificial decimation stride so every turn is preserved 1:1 (~70 KB per chat); scaled SVG chart X-axis strictly by turn progress (`pt.turn`), eliminating visual horizontal distortion between early and late compaction cycles.

---

## 2026-09-21 — Phase 1: Speed, Honest Deletion, Offline Styling

**Performance**

- Per-conversation analysis cache keyed by `(mtimeMs, size, walSignature)`; unchanged chats cost zero `sqlite3` spawns. Incremental reads (`idx > lastIdx`) are guarded by `count(*)` / `max(idx)` so deleted rows or a rewritten table force a clean re-read.
- On-disk storage sizes TTL-cached (the `brain/` walk alone was 305 ms per refresh across 2,434 files).
- **Measured on a real install (21 chats, 138 MB databases, 104 MB brain): 2,953 ms → 2,028 ms cold → 30 ms warm.**
- Watchers cover the `.db` family plus `conversation_summaries.db`; polling pauses while the window is unfocused.

**Deletion Safety**

- Deletion is honest: every path is verified gone _after_ the attempt, failures are reported with reasons, and the catalog row is removed only when all files are gone — so a locked file can no longer create a new ghost chat.
- Files go to the Windows Recycle Bin by default (`antigravity.deleteToRecycleBin`); permanent deletion is opt-in. Strict UUID validation runs before any filesystem or SQL write.

**Security & Offline**

- Injected webview state is escaped (`<`, U+2028, U+2029) so a chat title cannot break out of the script block; `MarkdownString.isTrusted` is restricted to an allowlist of extension commands.
- Dashboard styling moved from a `gstatic.com` CDN script to a committed local stylesheet with a nonce-based CSP — zero network requests.

**Correctness**

- Model name now actually decodes (length-delimited fields are classified as printable strings).
- Varint overflow guard rejects the `2^64-1` sentinel instead of leaking `1.8e19` into the UI; `parseProto` stops on illegal field number 0 or out-of-bounds lengths instead of inventing tags.
- Catalog reads use SQLite `-json` mode, since `sqlite3.exe` rewrites control-character delimiters to caret notation on Windows. Chat titles fall back to `preview` when `title` is empty.
