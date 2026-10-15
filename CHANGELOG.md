# Changelog

All notable changes to the **Antigravity Telemetry** extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.1.1] - 2026-10-15

### ⚡ Remote SSH Bandwidth Optimization & Local Storage Architecture

> **Critical patch release** resolving excessive network bandwidth consumption over VS Code Remote - SSH, WSL, and Dev Containers.

#### 🌐 Remote SSH Bandwidth & Traffic Fix
- **Isolated Local Disk Cache**: Migrated the persistent telemetry cache from `context.globalState` (which transmitted multi-megabyte payloads across the Remote SSH RPC tunnel) to isolated extension local file storage (`context.globalStorageUri`). Cache persistence now generates **0 bytes** of network traffic across remote connections.
- **Automatic Legacy Cache Migration**: Existing installations automatically migrate and purge the bloated key from `globalState`, immediately freeing remote RPC bandwidth and cleaning internal state databases.
- **Selective Webview Timeline Delivery**: The Webview payload now strips heavy `contextTimeline` turn arrays from inactive conversations, delivering 1:1 turn details strictly for the currently selected session. Reduces Webview IPC data size from ~1.2 MB down to ~150 KB (**~88–95% payload reduction**).
- **On-Demand Timeline Loading & Webview Caching**: Switching conversations in the dashboard fetches the selected session's timeline on-demand and caches it in webview memory, avoiding redundant network roundtrips.
- **Configurable Persistent Cache**: Added `antigravity.enableCache` setting and QuickMenu toggle (`Persistent Startup Cache: Enabled / Disabled`) allowing users to disable disk caching completely with instant cleanup of cache files.
- **Webview Visibility Guard**: Telemetry updates are suppressed when the dashboard panel is hidden or minimized behind other editor tabs, resuming immediately when the tab is brought back into view.
- **State Signature Dirty-Checking**: Suppresses redundant status bar updates, webview broadcasts, and disk writes during the 10-second polling cycle when conversations have not changed on disk.

---

## [1.1.0] - 2026-10-12

### 🛸 Standalone Antigravity IDE & Multi-Root Support

> **Major milestone release** adding seamless native support for the standalone **Antigravity IDE**, sub-50ms instant startup caching, intelligent compaction qualification, and zero-flicker vector UI badges.

#### 🛸 Antigravity IDE & Multi-Root Discovery
- **Host-Aware Auto Routing**: Automatically detects whether you are in VS Code (`~/.gemini/antigravity`) or standalone Antigravity IDE (`~/.gemini/antigravity-ide`) with zero configuration.
- **Data Source Preference**: Choose `auto`, `ide`, `extension`, or merged `both` mode via settings or the status bar menu.
- **State Store Catalog Integration**: Decodes session summaries directly from Antigravity IDE's `state.vscdb` store with full title, step, and workspace parity.
- **Live Session Self-Description**: In-flight sessions are automatically identified directly from conversation databases, preventing false ghost-chat warnings.

#### 🚀 Instant Startup & Performance Architecture
- **Persistent Cache Across Reloads**: Window reloads drop from ~3,500 ms to **~30–50 ms** (~98% speedup) via serialized `globalState` caching.
- **Atomic In-DB Queries**: Halved process spawn overhead on Windows by consolidating metadata checks into atomic queries.
- **Zero-Flicker Vector UI**: Replaced raw OS emojis with crisp SVG badges, and memoized chart rendering so tooltips never jump during polling.

#### 📈 Smarter Timeline & Compaction Tracking
- **Transient Planner V-Dip Filtering**: Intermediate agent tool-pruning notches are filtered out, ensuring only genuine context-ceiling compactions trigger alerts.
- **Forced Un-Cached Manual Refresh**: Clicking the header Refresh button now passes `force: true` to bypass all caches and re-query SQLite immediately.

#### 🗑️ Multi-Root Storage Hygiene
- **Root-Aware Cleanup**: Enhanced safe deletion to wipe all 7 storage layers across either installation with Windows Recycle Bin protection by default.
- **Open VSX Availability**: Published officially on the [Open VSX Registry](https://open-vsx.org/extension/HarshMann/antigravity-telemetry) for Antigravity IDE, VSCodium, and Coder users.


---

## [1.0.2] - 2026-10-08

### 🔄 Manual Refresh & Subagent Intelligence

#### ⚡ On-Demand Manual Refresh
- **Manual Refresh Button in Visual Dashboard**: Added a dedicated `Refresh` button in the top header with tactile press feedback (`active:scale-95`).
- **Live Sync & Animation State**: Triggers immediate telemetry re-read with animated SVG rotation, disabled spam-prevention state, and temporary emerald `Updated` confirmation before resetting.
- **Responsive Layout**: Automatically collapses to a compact icon-only button on narrow split-editor views to preserve header readability.

#### 🤖 Subagent Role Decoding & Hierarchy
- **Resolved "Untitled Conversation"**: Decoded task records from background worker telemetry across both catalog paths to extract genuine subagent roles (e.g., `Icon Designer`, `Research Assistant`), eliminating generic "Untitled Conversation" labels.
- **Collapsible Subagents Section**: Added an interactive toggle (`▼ Collapse` / `▶ Expand`) to the subagent breakdown card in the Chat Telemetry detail view with clean animations and scrollable overflow container.
- **Non-JSON Catalog Parity**: Extended delimiter parsing fallback to support full subagent hierarchy extraction.

#### 🎨 Branding & Visual Polish
- **Official Extension Icon in Webview Panel**: Integrated high-resolution `media/icon.png` into the Webview panel tab icon and dashboard header brand badge.

---

## [1.0.1] - 2026-10-04

### 🚀 Visual Studio Code Marketplace Release & Timeline Enhancements

#### 🎨 Extension Branding & Marketplace Assets
- **Official Extension Icon**: Added high-resolution custom icon (`media/icon.png`) and banner dashboard preview.
- **MIT License**: Formally included MIT license declaration and file for open distribution.
- **Direct Marketplace Installation**: Published officially under `HarshMann.antigravity-telemetry` on the Visual Studio Code Marketplace.

#### 📈 Proportional Chart Scaling & 1:1 Resolution
- **Proportional X-Axis Timeline**: Scaled the SVG context timeline strictly by actual turn progress (`pt.turn`), eliminating artificial horizontal width distortion where early compactions appeared 3× wider than subsequent compactions.
- **1:1 Turn Fidelity**: Removed artificial decimation stride so every turn is preserved 1:1 (~70 KB per chat), improving tooltip hover precision.

#### 🧹 Maintenance & Cleanup
- Removed legacy local directory junction scripts in favor of direct Marketplace and VSIX installation.
- Updated documentation with official Marketplace badges and CLI commands.

---

## [1.0.0] - 2026-09-27

### 🎉 Initial Public Release

Antigravity Telemetry brings real-time context window intelligence, prompt cache analytics, and subagent observability to Google Antigravity.

#### 📊 Live Status Bar & Token Intelligence
- **Context Window Usage**: Real-time context fill rate and token count in the VS Code status bar.
- **Prompt Cache Efficiency**: Instant breakdown of cached read tokens vs fresh write tokens with cache hit percentage.
- **Model-Aware Context Ceilings**: Automatically detects true model context ceilings (e.g., 256k) and tracks exact compaction events when context drops.
- **Two-Level QuickPick Menu**: Click the status bar item to view quick turn details, jump to the dashboard, browse past sessions, or configure settings.

#### 📈 Interactive Visual Dashboard
- **Dual-Layer SVG Timeline**: Interactive chart plotting context window fill against cached tokens across every conversation turn.
- **Compaction Event Markers**: Visual indicators on the chart highlighting exactly where Antigravity compacted context.
- **Session Intelligence Cards**: Instant turn metrics showing last turn context, per-turn averages, cache hit reliability, and session peaks.
- **Single-Scroll Responsive Layout**: Pinned header and search bar with fluid vertical scrolling designed for split editors and compact screens.

#### 🗂️ Workspace Scoping & Session Browsing
- **Project-Aware Filtering**: Scopes conversations and status bar telemetry to your currently open workspace so multiple projects never cross paths.
- **Workspace Switcher**: Easily switch between your current project or view all sessions across all workspaces in one click.
- **Instant Search**: Filter conversation history by title or conversation UUID in real-time.

#### 🤖 Subagent Hierarchy & Visibility
- **Nested Subagent Drawers**: Background subagents are neatly grouped under their parent human chat with token and storage rollups.
- **Subagent View Chips**: One-click toggles (`All`, `Chats`, `Subagents`) to quickly isolate human discussions from autonomous agent tasks.
- **Detailed Subagent Telemetry**: Breadcrumb navigation linking subagents back to their parent sessions with truncated task descriptions.

#### 🗑️ Safe Storage Management
- **Disk Usage Transparency**: Inspect exact disk space used by conversation databases, brain transcripts, media, and artifacts.
- **Safe Conversation Deletion**: Delete unwanted sessions with a detailed confirmation modal.
- **Recycle Bin Protection**: Deleted files are moved to the Windows Recycle Bin by default, ensuring deletions are completely recoverable.

#### ⚡ Performance & Privacy
- **Zero Runtime Dependencies**: Built entirely with native Node.js and VS Code APIs for maximum speed and security.
- **100% Offline & Private**: All telemetry is read directly from your local Antigravity installation. No data ever leaves your computer.
- **Ultra-Fast In-Memory Cache**: Incremental reads and smart caching deliver instant UI updates (<30ms warm refresh).
