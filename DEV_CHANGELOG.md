# Developer & Internal Engineering Changelog

Technical and architectural notes for Antigravity Telemetry, grouped by development and review phases.
For the user-facing release notes, see [`CHANGELOG.md`](./CHANGELOG.md).

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
