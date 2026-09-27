# Changelog

All notable changes to the **Antigravity Telemetry** extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
