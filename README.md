# Antigravity Telemetry (VS Code Extension)

A lightweight, zero-token, real-time LLM telemetry monitor, visual observability dashboard, and storage management extension for Google Antigravity inside VS Code.

---

## Features

### 1. ⚡ Footer Status Bar Item

- **Live Active Chat Monitoring**: Displays active chat title, context window fill %, and prompt cache hit rate in clean native styling:
  `[Chat Title] | 182k (71%) · 98.4% cache`
- **Compaction Ceiling Calibration**: Calibrated against Antigravity's **255,000 token working ceiling** (so 182k shows 71% full, giving you an honest indicator of session weight before compaction triggers).
- **Auto-Compaction Alerts**: Automatically detects when Antigravity compacts context and displays a compaction notice:
  `[Chat Title] | Compacted (-71k) · 98.4%`
- **Markdown Hover Card**: Hovering over the footer displays a full breakdown with a 12-segment ASCII window meter, cache volume, and thinking tokens.

---

### 2. 📋 Two-Level QuickPick Menu

Clicking the status bar item opens a quick command menu:

- **Active Chat Summary**: Shows context, cache read/write, and output tokens.
- **📈 Open Full Visual Dashboard**: Opens the rich editor tab dashboard.
- **🗂️ Browse Past Conversations**: Searchable sub-picker displaying all previous sessions with token counts and on-disk storage sizes.
- **🗑️ Delete a Conversation (Free Disk Space)**: Pick any conversation to permanently wipe from disk.
- **🧹 Purge Dead Ghost Chats**: 1-click cleanup when orphaned chats are detected.
- **🔄 Refresh Telemetry**: Immediate re-scan of local databases.

---

### 3. 📈 Live Visual Observability Dashboard (Editor Tab)

Opens side-by-side with your code (`Ctrl + W` to close anytime) and updates live via `postMessage`:

- **Split-Window Optimized**: Active KPIs and context timeline sit directly at the top with zero scrolling required in narrow split editor views.
- **Compact Cost Indicator**: Displays estimated API cost (`Est. Cost: ~$0.XX`) at standard rates without wasting vertical screen space.
- **4 Top KPIs**: Context Window (fill % & headroom), Cache Read (cached tokens & hit %), Cache Write (fresh prompt tokens), and Model Output.
- **Dual-Layer Interactive Timeline (SVG)**:
  - **Blue curve**: Total Context progression across all turns.
  - **Emerald curve**: Cached Prompt Volume per turn, visually exposing the thin sliver of fresh tokens added per turn.
  - **Red dashed guideline**: Calibrated at the **255k Compaction Limit** with marker dots on compaction turns.
  - **Mouse Tracking Crosshairs & Hover Tooltip**: Moving your cursor over the chart displays turn details, context %, cached volume, fresh additions, and generation output.
- **Session Intelligence Grid**:
  - **⚡ Last Turn Activity**: Delta fresh tokens added, output, and compaction state.
  - **📊 Per-Turn Averages**: Average context, output, thinking tokens, and cache volume.
  - **🛡️ Cache Performance**: Total hits vs. calls, cold start misses, and compaction count.
  - **🏔️ Session Peaks**: Peak context reached (% of 255k), peak generation, and peak reasoning tokens.

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
- **In-Dashboard Deletion**:
  - Click **`🗑️ Delete Chat`** directly from the Active Chat card or the trash icon next to any chat in the **All Sessions** list.
  - An in-dashboard confirmation modal shows the exact files to be erased and the disk space reclaimed.
- **Ghost Chat Detection Banner**:
  - Automatically identifies dead conversations left behind on disk and provides a **`🧹 Purge Ghost Chats`** button for instant batch cleanup.

---

### 5. 🔒 Zero Tokens & Pure Local Parsing

- Queries local SQLite databases directly from `%USERPROFILE%\.gemini\antigravity\`.
- Pure JavaScript Protobuf wire decoder (`readVarint`).
- **Zero npm dependencies, zero network requests, zero API tokens consumed**.

---

## Development & Installation

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

### Packaging to `.vsix`

```bash
npx @vscode/vsce package
```

Creates `antigravity-telemetry-1.0.0.vsix` for 1-click installation on any machine.
