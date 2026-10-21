# Antigravity CLI Integration Plan

> 🚧 **Status: In Progress** — Branch `feat/cli-support` rebased on `v1.1.1`.
> Multi-root catalog discovery, per-catalog cache isolation, CLI root file watchers, running execution state detection, visual `[CLI]` badges, and nested subagent collapse controls are implemented with 223 passing verification tests. Final edge-case testing and UI refinement remain in progress.

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


---

## 6. Detailed Session Metrics & Context Health Plan (CLI `/context` Issue #3)

### 6.1 Problem & Vision (Elevating Beyond Static Terminal Replication)

> [!IMPORTANT]
> **Design Philosophy: Inspiration, Not Carbon Copy.**
> The CLI /context screenshot provides the **mental model** (capacity health, headroom awareness, and component attribution). We must **not** merely copy a flat, static terminal table into the webview.
>
> Instead, the VS Code dashboard will deliver a **substantially richer, more interactive experience**:
> - Smooth animated capacity meter with dynamic color states (Emerald -> Amber -> Rose).
> - Direct interactivity (clicking the Files row toggles the in-memory file drawer with search & filter).
> - Proportional context share mini-meters for instant visual scanning.
> - Flexible Dual-Mode Switcher: **Diagnostic Matrix** for full tabs vs. **Visual Metric Tiles** for split sidebars.
> - 100% native VS Code theme adaptability.
The user issue requested exposing detailed session counts normally visible via the CLI `/context` command:
- **Assistant Responses**: Model reply volume and conversational density.
- **Files loaded into memory**: Codebase files currently in context.
- **Executed commands**: Terminal commands run by the agent.
- **Analyzed images**: Images inspected for visual reasoning.

While the initial Phase 6 implementation extracted these 4 metrics into a 4-card grid, it was a **bare minimum implementation**:
1. It presented numbers in isolated KPI tiles without relating them to the overall context window.
2. It stacked 4 activity cards directly above 4 turn intelligence cards, creating **"Card Fatigue"** (8 small boxes competing for attention).
3. It missed the core value proposition of the CLI `/context` output (shown in user diagnostics):
   > **"Health Diagnostic: X% in use of 100%"** — answering *where* memory is going and *how much headroom remains* before compaction.

---

### 6.2 Target UI/UX Architecture: Unified Context Health & Intelligence Hub

Replace the two disjointed 4-card sections with a unified two-part observability console:

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ 1. CONTEXT HEALTH & CODEBASE IMPACT (CLI /context Experience)                          │
│    • Health Diagnostic Meter: "Health Diagnostic: 18.2% in use of 256k"                │
│    • Dynamic Capacity Bar: [████████░░░░░░░░░░░░░░░░░] (46.5k used · 209.5k free)    │
│    • View Switcher Pill: [ 📋 Diagnostic Table (CLI Style) | 🗂️ Metric Cards ]         │
│    • Collapsible In-Memory Files Drawer: Search & filter paths read / modified         │
└────────────────────────────────────────────────────────────────────────────────────────┘
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ 2. STREAMLINED TURN & CACHE INTELLIGENCE                                                │
│    • Recent Turn Delta (Fresh input vs Output vs Compaction badge)                     │
│    • Trajectory Bounds & Net Growth (First → Peak → Current · Net Expansion)           │
│    • Prompt Cache Acceleration (Cache hits %, serving volume, latency multiplier)      │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

### 6.3 Detailed Component Specifications

#### A. Health Diagnostic Hero Bar
- **Header**: `Health Diagnostic: {usedPct}% in use of {ceilingTokens}`
- **Headroom Subtitle**: `{usedTokens} used · {freeTokens} free space remaining`
- **Color-Coded Status Pill**:
  - 🟢 `Healthy (< 60%)`: Emerald gradient progress bar (`from-emerald-500 to-teal-400`).
  - 🟡 `Moderate (60% – 85%)`: Amber gradient progress bar (`from-amber-500 to-yellow-400`).
  - 🔴 `Near Compaction (> 85%)`: Rose gradient progress bar (`from-rose-500 to-red-400`) with alert badge.

#### B. Dual-View Mode Switcher
Provide an interactive toggle (`#contextViewModeBtn`):
1. **`[ 📋 Diagnostic Table ]` Mode (Default for full-width views)**:
   - 4 Columns: `Component / Metric`, `Detail / Quantity`, `Context Tokens`, `Share of Limit`.
   - Rows:
     - 🤖 **Active Model**: `s.model` | Ceiling limit | `100% max`
     - 💬 **User Messages**: `act.userPrompts` messages | Fresh input token estimation | `% of context`
     - 🧠 **Assistant Responses**: `act.assistantResponses` replies | Output token estimation | `% of context`
     - 📂 **Files Loaded in Memory**: `act.filesReadCount` files | Context footprint | `[View Files ▾]`
     - ⚡ **Executed Commands**: `act.executedCommands` commands | Tool call footprint | `% of context`
     - 🖼️ **Analyzed Images**: `act.analyzedImages` captures | Multimedia footprint | `% of context`
     - 📊 **Total Context (Used)**: `s.calls` turns | `s.contextTokens` | `s.usedPct%`
     - 🟢 **Remaining Headroom (Free)**: Safe capacity | `s.freeTokens` | `s.freePct%`
   - Clicking `[View Files ▾]` expands the Codebase Files drawer directly below the table.

2. **`[ 🗂️ Metric Cards ]` Mode (Optimized for narrow sidebars)**:
   - 4 modern responsive cards with icons, colored stat badges, and percentage pills:
     - Card 1: Responses & Autonomy ratio
     - Card 2: Files in Memory & Modified count
     - Card 3: Commands & Total tool actions
     - Card 4: Analyzed Images & Web calls

#### C. Codebase Files Drawer
- Reused for both modes: displays `Files Read in Memory` (cyan) and `Files Modified / Created` (emerald).
- Preserved in memory across 10s background `telemetryUpdate` polls via `oldActivities`.

#### D. Refactored Turn Intelligence Section
Streamline Section 4 from 4 repetitive cards into 3 dense, actionable cards:
1. **Turn Execution & Compaction**:
   - Turn number, fresh uncached tokens, output tokens, and explicit compaction badge (`⚡ -42k Compacted` or `Normal`).
2. **Trajectory Dynamics**:
   - Min context $\rightarrow$ Current context $\rightarrow$ Peak context.
   - Net expansion pill: `+{netGrowth} tok net growth`.
3. **Prompt Cache Acceleration**:
   - Cache hit rate %, volume served from cache, and estimated speedup multiplier (`~5.2x faster`).

---

### 6.4 Implementation Checklist

1. [ ] **`dashboardHtml.js` Markup**:
   - Replace basic `#activityCard` with unified `#contextHealthCard`.
   - Add Health Diagnostic progress bar and percentage pill.
   - Add Diagnostic Table markup with view mode toggle.
   - Streamline `#intelligenceCard` into 3 focused operational cards.
2. [ ] **`dashboardHtml.js` Client Script**:
   - Calculate headroom tokens (`ceiling - currentContext`) and usage percentage.
   - Bind view switcher in `bindEvents()` without inline handlers (Nonce CSP compliance).
   - Populate Diagnostic Table cells and progress bar width dynamically in `renderDetail()`.
3. [ ] **Build & Styling**:
   - Run `npm run build:css` to bundle any new utility classes into `media/dashboard.css`.
4. [ ] **Verification**:
   - Run `node scripts/self-check.js` to ensure all 254+ test assertions pass with 0 failures.
