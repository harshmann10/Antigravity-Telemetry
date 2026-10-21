# AGENTS.md - Antigravity Telemetry Extension

This file contains the **core architectural invariants, security rules, and development guidelines** for AI agents working on this codebase.

> 📚 **Deep Technical Reference:** Binary protobuf layouts, SQLite schemas, subagent decoding tags, and storage locations have been moved to [`REFERENCE.md`](./REFERENCE.md) to keep this rulebook lean and high-signal. Consult [`REFERENCE.md`](./REFERENCE.md) whenever modifying the data engine or parser.

---

## 1. Prime Directives & Constraints

1. **Zero npm dependencies**: Use Node.js built-ins and the VS Code Extension API only.
2. **Zero network, ever**: Every metric is read locally from disk. A wrong number is a parser bug, not a connectivity problem.
3. **Read-only by default**: Antigravity's databases and files must never be written to or mutated, except via the explicit user-triggered `deleteConversation` path.
4. **Native PowerShell environment**: On Windows, invoke cmdlets and executables directly (`git`, `node`, `Get-ChildItem`). Never wrap in `powershell -Command "..."`.

---

## 2. Strict Agent Invariants (Must NEVER Be Violated)

### A. Strict Git & Release Restraint
> [!IMPORTANT]
> **NEVER run `git commit`, `git tag`, `git push`, or trigger a GitHub release autonomously.**
> - An agent may **only** execute git or release commands when the user **explicitly commands it** in the conversation.
> - Every commit must include a clear, descriptive message (`git commit -m "..."`). Never commit without a message.
> - Pre-flight test checks (`npm run self-check`) are intentionally omitted from `.github/workflows/release.yml` to keep releases fast; do NOT add them back to the CI workflow.

### B. Remote SSH & Distributed IPC Bandwidth
> [!CAUTION]
> **NEVER stream multi-megabyte caches or bulk inactive arrays over Webview IPC or VS Code RPC.**
> In VS Code Remote - SSH, WSL, or Dev Containers, the extension host runs on a remote server while the UI runs on the user's local machine over an encrypted SSH tunnel:
> 1. **Zero RPC sync for persistent cache**: Never use `context.globalState.update()` for large caches or heartbeat data (this triggers multi-megabyte RPC streaming over the SSH pipe on every tick). Store persistent caches in `context.globalStorageUri` using native Node.js `fs` file operations (0 network bytes).
> 2. **Selective IPC payload decimation (`prepareConversationsForWebview`)**: Inactive sessions must have bulky arrays (`contextTimeline`, `activity.filesRead`, `activity.filesModified`) stripped to empty `[]` before `webview.postMessage()`. Inactive items retain counts (`filesReadCount`, `calls`), while full arrays load on-demand when selected.
> 3. **Preserve on-demand data across background ticks (`oldTimelines` & `oldActivities`)**: When routine background polling (`telemetryUpdate`) delivers fresh stripped arrays, `dashboardHtml.js` **must** preserve previously loaded timelines and activity file lists in memory. Never let a routine 10-second tick wipe an inspected file drawer back to empty!
> 4. **Webview visibility guards**: Mute webview updates when hidden (`!currentPanel.visible`). Skip idle polls if the SQLite signature hasn't changed.

### C. Webview Security & Nonce CSP
> [!CAUTION]
> **NEVER add inline event handlers (`onclick="…"`, `onchange="…"`, `oninput="…"`) to dashboard markup.**
> The webview sets a strict nonce-based CSP (`script-src 'nonce-…'`). Inline event handlers fail silently with console violations:
> - **Always bind in `bindEvents()`** via element ID: `document.getElementById('myBtn').onclick = () => ...`.
> - **Never build markup with quote-concatenation** in template literals: `onclick=\"f('" + id + "')\"` evaluates to `SyntaxError` at load time. Use `div.querySelector('.btn').onclick = (e) => ...`.

### D. Webview State vs. Background Polling
> [!CAUTION]
> **NEVER overwrite interactive webview UI state from background polling messages.**
> Routine background updates (`telemetryUpdate` every 10 s or file watcher debounces) must only deliver updated data arrays (`CONVERSATIONS`), and must **never** clobber the user's interactive view filters:
> - `currentWorkspaceFilter` is controlled by the user via the dropdown; routine ticks must never overwrite it with VS Code settings.
> - `selectedId` must never be reset back to `currentActiveId` or `filtered[0]` just because a filter chip is clicked. It only falls back if the conversation was literally deleted from disk.

### E. Layout & Viewport Allocation
> [!IMPORTANT]
> **Zero dual scrollbars — always use flex viewport allocation.**
> - `body`: `h-screen overflow-hidden flex flex-col` — the outer window must never scroll.
> - Headers & controls: `shrink-0` pinned at top.
> - Detail and List views: `flex-1 min-h-0 overflow-y-auto`.

### F. Dual-Layer Chart Integrity
> [!CAUTION]
> **Clamp the visual cached series to the context series.**
> After Antigravity prunes tool output, the API prompt cache can exceed the trajectory context line. Always clamp visual geometry:
> `const visualCached = Math.min(pt.cached || 0, pt.input || 0);` (keep unclamped numbers in the tooltip).

### G. Deletion Safety & Zero-Residue
> - **Recycle Bin by default**: Batch-send all 7 asset layers via `recyclePaths()` using PowerShell `RecycleOption.SendToRecycleBin`.
> - **Verify before reporting**: The authoritative check is `fs.existsSync()` *after* deletion. Never claim bytes that were not freed.
> - **Catalog row purged last**: Delete the row in `conversation_summaries` only after files are confirmed gone.

---

## 3. The Master Invariant Table

Every row here has caused a real bug in production — keep these rules in mind:

| Trap | What Happens | Rule / Solution |
| :--- | :--- | :--- |
| **Inline `onclick` in webview** | Silently fails under nonce CSP (console error only) | Bind dynamically in `bindEvents()` |
| **`context.globalState` for cache** | Floods Remote SSH tunnels with multi-MB RPC packets | Use `context.globalStorageUri` + Node `fs` |
| **Wiping files on 10s tick** | Loaded file list vanishes back to "No files read" | Preserve `oldActivities` in `dashboardHtml.js` |
| **Treating `null` catalog as `{}`** | Healthy chats falsely flagged as "Dead Ghost Chats" | Check `catalogAvailable` explicitly |
| **Omitting `step_type = 132`** | Misses actual tool execution payloads and commands | Query `WHERE (step_type = 15 OR step_type = 132)` |
| **`Number(bigint)` on varints** | Sentinel `2^64-1` leaks into UI as `1.8e19` | Use `safeVarintNumber()` / `numField()` |
| **Deleting catalog row first** | Locked DB leaves orphaned files with no catalog entry | Verify `existsSync` first, delete row last |
| **Matching workspaces by folder name**| Renamed folder shows 0 chats; short name matches all | Match by normalized path prefix |
| **Backticks in dashboard template** | Node.js `SyntaxError` halts entire extension | Use plain text or string escapes |

---

## 4. Component Structure & Roles

```text
├── package.json          # Manifest: activationEvents, commands, settings (antigravity.dataSource, enableCache, etc.)
├── extension.js          # Lifecycle: status bar, QuickPick, webview panel, file watchers, message router
├── telemetryReader.js    # Data engine: SQLite queries, protobuf decoder, multi-root discovery, deletion engine
├── dashboardHtml.js      # Webview UI: Tailwind markup, dual-layer SVG chart, modal, client script
├── media/                # Styling: tailwind-input.css (source) → dashboard.css (generated, committed)
├── scripts/
│   ├── self-check.js        # 250+ dependency-free unit & integration tests (ALWAYS run after edits)
│   └── extract-changelog.js # Extracts release notes from CHANGELOG.md for GitHub Releases
├── REFERENCE.md          # Technical specifications: protobuf wire schemas, SQLite tables, step types
├── CLI.md                # Antigravity CLI integration architecture and status
├── UI UX.md              # UI/UX design specifications, collapse states, and visual badges
├── CHANGELOG.md          # User-facing release notes
└── DEV_CHANGELOG.md      # Engineering log by review phase
```

---

## 5. When to Consult Reference Files (Progressive Disclosure)

Before editing specific components, consult their dedicated documentation:
- **Modifying Protobuf Decoding, SQLite Queries, or Step Types**: Read [`REFERENCE.md`](./REFERENCE.md) (§3, §4, §5).
- **Modifying Multi-Root Scanning or Deletion Engine**: Read [`REFERENCE.md`](./REFERENCE.md) (§1, §2).
- **Working on CLI Support or Auto-Detection**: Read [`CLI.md`](./CLI.md).
- **Working on Dashboard Layout, Badges, or Collapse Controls**: Read [`UI UX.md`](./UI UX.md).
- **Reviewing Architectural History**: Read [`DEV_CHANGELOG.md`](./DEV_CHANGELOG.md).

---

## 6. Verification Workflow

Always verify changes with the self-check suite before concluding any task:

```powershell
node scripts/self-check.js   # Verifies protobuf math, parity, cache, IPC decimation, and CLI roots
npm run build:css            # ONLY needed if adding new Tailwind classes to dashboardHtml.js
npm run package              # Verifies standalone .vsix packaging via @vscode/vsce
```

---

## 7. Maintenance Protocol (`AGENTS.md` vs `REFERENCE.md`)

To prevent documentation rot and maintain fast, high-signal AI agent performance, follow this strict division:

| Document | Purpose & Content | What to Update & When | Target Size |
| :--- | :--- | :--- | :--- |
| **[`AGENTS.md`](./AGENTS.md)** | **Behavioral Invariants & Safety Rules**<br>• Git/Release restraint<br>• Remote SSH bandwidth decimation<br>• Nonce CSP & Webview state rules<br>• Master Invariant Trap Table | Update **only** when discovering a new architectural trap, security rule, or workflow constraint. **Never dump raw schemas, protobuf tags, or SQL tables here.** | **Lean (< 200 lines)** to prevent prompt bloat and attention dilution. |
| **[`REFERENCE.md`](./REFERENCE.md)** | **Technical Specifications & Schemas**<br>• Protobuf tag maps (`Tag 1 -> Tag 4`, `Tag 1 -> Tag 9`)<br>• SQLite table columns & indexes<br>• Step types (`14`, `15`, `132`) & tool payloads<br>• Multi-root storage paths & deletion layers | Update **immediately** whenever modifying the data engine, discovering new protobuf fields, adding step types, or altering database queries. | **Comprehensive / Living Encyclopedia** |

### Documentation Invariants:
1. **Zero Schema Duplication**: Never copy binary schemas or SQL table layouts back into `AGENTS.md`. Always keep them centralized in `REFERENCE.md` and reference them via Markdown links.
2. **Synchronized Code Updates**: If code in `telemetryReader.js` or `extension.js` alters how a protobuf tag, SQLite column, or tool argument is parsed, `REFERENCE.md` **must** be updated in the same change so technical documentation never drifts from reality.
