# Antigravity CLI Integration Plan

This document outlines the architecture, technical requirements, and execution plan for integrating **Antigravity CLI (`agy`)** telemetry into the `antigravity-telemetry` VS Code extension.

---

## 1. Goal Description

Support Antigravity CLI (`agy`) sessions residing in `%USERPROFILE%\.gemini\antigravity-cli` within the VS Code extension alongside Antigravity IDE and VS Code Extension chats.

### Key Objectives:
1. **Multi-Root Catalog Support**: Integrate `antigravity-cli\conversation_summaries.db` and `antigravity-cli\conversations\*.db` into the telemetry engine.
2. **Prevent Cache Thrashing**: Refactor `summariesCache` to support multiple simultaneous `conversation_summaries.db` files (extension and CLI) without invalidating each other on every tick.
3. **Smart Workspace-Aware Auto-Detection**: In `auto` mode, automatically surface CLI sessions that match the current workspace or are actively running, without overriding host editor chats when idle.
4. **Zero-Residue Deletion Isolation**: Ensure deletion strictly targets the origin root (`.gemini/antigravity-cli`), preventing healthy CLI chats from ever being purged as IDE orphans.
5. **Visual Distinction**: Provide distinct `[CLI]` badges and terminal icons (`$(terminal)`) in the QuickPick, Webview session list, and Detail card.

---

## 2. Configuration & Active Priority Decisions

### Data Source Configuration (`antigravity.dataSource`)
- `'auto'` **(Default)**: Automatically detects host editor (`ide` or `extension`) **AND** includes CLI sessions that match the active workspace or are currently running.
- `'all'`: Merges all three environments (IDE standalone, VS Code extension, and CLI).
- `'cli'`: Shows only Antigravity CLI terminal sessions.
- `'ide'`: Shows only standalone Antigravity IDE sessions.
- `'extension'`: Shows only VS Code Extension sessions.
*(Backwards compatibility: `'both'` will continue to work as an alias for `'all'` or `'ide+extension'`).*

### Active Chat Status Bar Priority
When both an editor chat and a CLI chat exist for the active workspace:
- If the CLI agent is actively running (`CASCADE_RUN_STATUS_RUNNING` or fresh WAL writes), it gets highlighted.
- When both are idle, the **host editor's chat retains precedence** in the status bar so working in VS Code doesn't randomly flip to a background terminal session.

---

## 3. Architecture & Data Flow

```
┌─────────────────────────────────────────────────────────────┐
│                      PACKAGE.JSON                           │
│  • Expand antigravity.dataSource enum: auto, ide,           │
│    extension, cli, all                                      │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│                   TELEMETRYREADER.JS                        │
│  • Add cliRoot (~/.gemini/antigravity-cli)                  │
│  • Key summariesCache by DB path (prevents cache thrashing) │
│  • Multi-root discovery in findRootForConversation()        │
│  • Detect CASCADE_RUN_STATUS_RUNNING & live lockfiles       │
│  • Workspace-aware auto root provider                       │
└──────────────────────────────┬──────────────────────────────┘
                               │
               ┌───────────────┴───────────────┐
               ▼                               ▼
┌─────────────────────────────┐ ┌─────────────────────────────┐
│        EXTENSION.JS         │ │      DASHBOARDHTML.JS       │
│  • Watchers for CLI dirs    │ │  • [CLI] terminal badge     │
│  • Switch Source QuickPick  │ │  • Multi-source badge check │
│  • $(terminal) icon for CLI │ │  • CLI source metadata card │
│  • Status bar source label  │ │                             │
└─────────────────────────────┘ └─────────────────────────────┘
```

---

## 4. Proposed Changes by Component

### Component 1: Engine & Catalog Multi-Root (`telemetryReader.js`)

1. **Add CLI Root Definition to `getInstallationRoots()`**:
   ```javascript
   const cliDir = path.join(userHome, '.gemini', 'antigravity-cli');
   const cliRoot = {
     id: 'cli',
     name: 'Antigravity CLI',
     antigravityDir: cliDir,
     convDir: path.join(cliDir, 'conversations'),
     summariesDb: path.join(cliDir, 'conversation_summaries.db'),
     stateVscdb: null
   };
   ```

2. **Per-Catalog `summariesCache`**:
   Replace single `let summariesCache = { ... }` with a map keyed by `summariesDb`:
   ```javascript
   // summariesDbPath -> { mtimeMs, size, walSignature, map }
   const summariesCaches = new Map();
   ```
   Ensures both `antigravity/conversation_summaries.db` and `antigravity-cli/conversation_summaries.db` stay warm in memory simultaneously without cache collisions.

3. **Multi-Root Resolution in `findRootForConversation()`**:
   ```javascript
   function findRootForConversation(id) {
     const roots = getInstallationRoots('all');
     for (const r of roots) {
       if (fs.existsSync(path.join(r.convDir, `${id}.db`))) {
         return r;
       }
     }
     return roots[0];
   }
   ```

4. **Support `CASCADE_RUN_STATUS_RUNNING` and `not_fully_idle`**:
   Extract `status` and `not_fully_idle` from `conversation_summaries.db` and tag conversations with `isRunning: status === 'CASCADE_RUN_STATUS_RUNNING' || not_fully_idle === 1`.

---

### Component 2: VS Code Extension Host (`extension.js` & `package.json`)

1. **Update `package.json`**:
   - Update `antigravity.dataSource` configuration: add `"cli"` and `"all"`.
   - Update description to explain how `'auto'` intelligently includes matching CLI sessions.

2. **Update `extension.js`**:
   - **File Watchers**: Update `setupWatchers()` so any active root in `getInstallationRoots()` (including CLI's `conversations/` and `conversation_summaries.db`) is watched with debouncing.
   - **QuickPick Source Switcher**: Add `Antigravity CLI` (`cli`) and `All Sources (IDE, Extension, CLI)` (`all`) to `promptSwitchDataSource()`.
   - **History Picker Icons**: Display `$(terminal)` for `c.source === 'cli'`, with a `[CLI]` prefix if multiple sources are active.
   - **Status Bar Tooltip**: Indicate `Source: Antigravity CLI` when inspecting a CLI conversation.

---

### Component 3: Visual Dashboard (`dashboardHtml.js`)

1. **Source Badges in List & Header**:
   Support `conv.source === 'cli'` with an emerald terminal badge:
   ```html
   <span class="inline-flex items-center gap-1 text-[9px] font-medium px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 shrink-0" title="Source: Antigravity CLI">
     <svg class="w-2.5 h-2.5 text-emerald-300 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
       <path stroke-linecap="round" stroke-linejoin="round" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/>
     </svg>
     CLI
   </span>
   ```
2. **Session Dropdown (`chatSelect`)**: Prepend `[CLI]` prefix when multiple sources are loaded.
3. **Multi-Source Detection**: Update `hasMultipleSources` to check `new Set(CONVERSATIONS.map(x => x.source).filter(Boolean)).size > 1`.

---

### Component 4: Test Suite & Verification (`scripts/self-check.js`)

Add **Section 13: Antigravity CLI Support & Multi-Root Parity**:
- Verify `cliRoot` resolution in `getInstallationRoots('cli')` and `getInstallationRoots('all')`.
- Verify synthetic CLI catalog parsing from `conversation_summaries.db`.
- Verify that `summariesCaches` preserves cache entries for both Extension and CLI catalogs across consecutive reads without cache eviction.
- Verify that deleting a CLI conversation correctly resolves target paths in `.gemini/antigravity-cli` and deletes the row from CLI's `conversation_summaries.db`.
- Verify that CLI conversations with matching workspace paths are included in `auto` mode while orphan checks remain strictly isolated.

---

## 5. Verification Plan

### Automated Tests
Run the comprehensive self-check suite:
```bash
node scripts/self-check.js
```
*Criteria:* All existing 177 tests plus new Section 13 tests must pass with 0 failures.

### Manual Verification
1. **Source Switching**:
   - In VS Code, run `Antigravity: Show Telemetry Menu` -> `Switch Data Source` -> Select `Antigravity CLI`.
   - Verify that CLI conversations (e.g. from `C:\Users\Harsh\.gemini\antigravity-cli\conversations\`) populate the status bar and QuickPick.
2. **Dashboard Rendering**:
   - Open Visual Dashboard (`Antigravity: Open Visual Dashboard`).
   - Verify that CLI sessions display the emerald `[CLI]` badge and terminal icon.
   - Verify token burn timeline, context meter, and storage metrics render cleanly.
3. **Multi-Source Merging**:
   - Switch data source to `All Sources`.
   - Verify that conversations from IDE, Extension, and CLI coexist without ID collisions.
4. **Live Terminal Reflection**:
   - Run a prompt or turn in the `agy` CLI in a terminal.
   - Verify that the status bar / dashboard detects the update within 400ms without errors or infinite loops.
5. **Zero-Residue Deletion Test**:
   - Verify deletion of a test conversation cleans up files strictly in `antigravity-cli/` and removes its row from `antigravity-cli/conversation_summaries.db`.