// HTML Webview generator with split-window / narrow-screen optimization, live message passing,
// dual-layer interactive context graph with hover crosshair/tooltip, and session intelligence metrics.

function getDashboardHtml(conversations, activeId, options = {}) {
  const {
    cssUri = '',
    iconUri = '',
    nonce = '',
    cspSource = '',
    deleteToRecycleBin = true
  } = options;

  // Wording follows the actual delete behaviour so the modal never claims something irreversible
  // when files are going to the Recycle Bin.
  const delButtonLabel = deleteToRecycleBin ? 'Move to Recycle Bin' : 'Delete Permanently';
  const delHeading = deleteToRecycleBin ? 'Remove Conversation' : 'Permanently Delete Conversation';
  const delQuestion = deleteToRecycleBin
    ? 'The database, transcripts and artifacts are moved to the Recycle Bin, so you can restore them if needed.'
    : 'This permanently erases the database, transcripts and artifacts. It cannot be undone.';
  const delFilesNote = deleteToRecycleBin
    ? 'Storage to be moved to the Recycle Bin:'
    : 'Storage to be permanently wiped:';
  const delTooltip = deleteToRecycleBin
    ? 'Remove this conversation (files go to the Recycle Bin)'
    : 'Permanently delete this conversation and all stored files';
  const delSizeNote = deleteToRecycleBin ? 'Storage to be moved:' : 'Storage to be reclaimed:';

  // Serialise state for the webview without letting user-controlled text (chat titles) break out
  // of the <script> block via "</script>", U+2028 or U+2029.
  const safeJson = value => JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

  let globalInput = 0, globalCached = 0, globalOutput = 0;
  for (const c of conversations) {
    if (!c.stats) continue;
    globalInput += c.stats.totalInput || 0;
    globalCached += c.stats.totalCached || 0;
    globalOutput += c.stats.totalOutput || 0;
  }
  const globalTokens = globalInput + globalOutput;
  const globalHitRate = globalInput > 0 ? ((globalCached / globalInput) * 100).toFixed(1) : '0.0';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Antigravity Telemetry</title>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${cspSource} data:;">
  <link rel="stylesheet" href="${cssUri}">
  ${cssUri ? '' : `<!-- media/dashboard.css is missing: keep the page readable rather than unstyled. -->
  <style>
    body { background-color: var(--vscode-editor-background, #18181b); color: var(--vscode-editor-foreground, #f4f4f5); font-family: var(--vscode-font-family, sans-serif); padding: 12px; }
    .card-bg { background-color: var(--vscode-sideBar-background, #202023); }
    .inner-bg { background-color: var(--vscode-editor-background, #18181b); }
    .border-color { border-color: var(--vscode-sideBar-border, #3f3f46); }
    .muted-color { color: var(--vscode-descriptionForeground, #a1a1aa); }
    .hidden { display: none; }
  </style>`}
</head>
<body class="h-screen overflow-hidden p-3 custom-scrollbar text-sm antialiased flex flex-col">
  <div class="max-w-5xl w-full mx-auto flex flex-col flex-1 min-h-0 space-y-3">
    
    <!-- Top Header & Controls -->
    <div class="p-3 card-bg border border-color rounded-xl shadow-sm space-y-3 shrink-0">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2.5">
          ${iconUri ? `
          <img src="${iconUri}" class="w-8 h-8 rounded-lg object-contain shadow-sm shrink-0" alt="Antigravity Telemetry Logo" />
          ` : `
          <div class="w-8 h-8 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold text-base border border-emerald-500/30 shrink-0">
            <svg class="w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
          </div>
          `}
          <div>
            <div class="flex items-center gap-2">
              <h1 class="text-sm font-semibold tracking-tight text-[var(--vscode-editor-foreground,#f4f4f5)]">Antigravity Telemetry</h1>
              <span class="inline-flex items-center px-1.5 py-0.2 rounded text-[10px] font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 mr-1 animate-pulse"></span> Live
              </span>
            </div>
            <p class="text-[11px] muted-color">Total: <span id="headerTotalTokens" class="text-emerald-400 font-semibold">${(globalTokens / 1_000_000).toFixed(1)}M tok</span><span id="headerExcludedTokens" class="text-zinc-400 font-medium"></span> · Cache: <span id="headerHitRate" class="text-blue-400 font-semibold">${globalHitRate}%</span></p>
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <!-- View Chip (Transient per-session filter, hidden when 0 subagents) -->
          <div id="subagentChipGroup" class="${conversations.some(c => c.isSubagent) ? 'flex' : 'hidden'} items-center gap-1 p-0.5 inner-bg border border-color rounded-lg text-xs">
            <button id="chipAllBtn" class="px-2 py-1 rounded font-medium transition-colors bg-blue-500/20 text-blue-400 border border-blue-500/30 shadow-sm text-[11px]">
              All (<span id="countAll">${conversations.length}</span>)
            </button>
            <button id="chipChatsBtn" class="px-2 py-1 rounded font-medium transition-colors muted-color hover:text-[var(--vscode-editor-foreground,#f4f4f5)] text-[11px]">
              Chats (<span id="countChats">${conversations.filter(c => !c.isSubagent).length}</span>)
            </button>
            <button id="chipSubagentsBtn" class="px-2 py-1 rounded font-medium transition-colors muted-color hover:text-[var(--vscode-editor-foreground,#f4f4f5)] text-[11px]">
              Subagents (<span id="countSubagents">${conversations.filter(c => c.isSubagent).length}</span>)
            </button>
          </div>

          <!-- Navigation Tabs -->
          <div class="flex items-center gap-1 p-1 inner-bg border border-color rounded-lg text-xs">
            <button id="tabDetailBtn"
              class="flex items-center gap-1.5 px-2.5 py-1 rounded font-medium transition-colors bg-blue-500/20 text-blue-400 border border-blue-500/30 shadow-sm">
              <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/></svg>
              <span>Telemetry</span>
            </button>
            <button id="tabListBtn"
              class="flex items-center gap-1.5 px-2.5 py-1 rounded font-medium transition-colors muted-color hover:text-[var(--vscode-editor-foreground,#f4f4f5)]">
              <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 10h16M4 14h16M4 18h16"/></svg>
              <span>Sessions (<span id="tabListCount">${conversations.length}</span>)</span>
            </button>
          </div>

          <!-- Manual Refresh Button -->
          <button id="refreshBtn"
            title="Refresh Telemetry Data"
            class="flex items-center gap-1.5 px-2.5 py-1.5 inner-bg hover:bg-zinc-700/40 active:scale-95 border border-color rounded-lg text-xs font-medium text-[var(--vscode-editor-foreground,#f4f4f5)] transition-all cursor-pointer shadow-sm">
            <svg id="refreshIcon" class="w-3.5 h-3.5 text-zinc-400 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            <span id="refreshLabel" class="hidden sm:inline">Refresh</span>
          </button>
        </div>
      </div>

      <!-- Quick Conversation Selector Dropdown & Workspace Filter -->
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-1 border-t border-color">
        <div class="flex items-center gap-2 flex-1 min-w-0">
          <span class="text-xs muted-color font-medium shrink-0">Viewing:</span>
          <select id="chatSelect"
            class="w-full max-w-xl min-w-0 truncate px-2.5 py-1.5 text-xs inner-bg border border-color rounded-lg font-medium text-[var(--vscode-editor-foreground,#f4f4f5)] focus:outline-none focus:border-blue-500 transition-colors">
            <!-- Populated by JS -->
          </select>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          <span class="text-xs muted-color font-medium shrink-0">Workspace:</span>
          <select id="workspaceSelect"
            class="max-w-xs truncate px-2.5 py-1.5 text-xs inner-bg border border-color rounded-lg font-medium text-[var(--vscode-editor-foreground,#f4f4f5)] focus:outline-none focus:border-blue-500 transition-colors">
            <!-- Populated by JS -->
          </select>
        </div>
      </div>
    </div>

    <!-- TAB 1: Chat Telemetry Details (DIRECTLY AT TOP - ZERO SCROLLING) -->
    <div id="detailView" class="flex-1 min-h-0 overflow-y-auto space-y-3 pr-1 custom-scrollbar">
      
      <!-- Selected Chat Overview Card -->
      <div class="p-3 card-bg border border-color rounded-xl shadow-sm">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-color pb-2.5 mb-2.5">
          <div>
            <div class="flex flex-wrap items-center gap-2 mb-1">
              <span id="chatBadge" class="px-2 py-0.5 rounded text-[10px] font-semibold bg-blue-500/20 text-blue-400 border border-blue-500/30">gemini-3.8-flash</span>
              <span id="sourceBadgeDetail" class="hidden inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 shrink-0">IDE</span>
              <span id="subagentBadge" class="hidden inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-purple-500/20 text-purple-300 border border-purple-500/30 shrink-0"><svg class="w-2.5 h-2.5 text-purple-300 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg><span id="chatAgentVal">subagent</span></span>
              <span id="workspaceBadge" class="hidden inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 shrink-0"><svg class="w-2.5 h-2.5 text-indigo-300 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/></svg><span id="chatWorkspaceVal">--</span></span>
              <span id="activePill" class="hidden px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">ACTIVE</span>
              <span id="diskBadge" class="px-2 py-0.5 rounded text-[10px] font-medium inner-bg border border-color muted-color" title="Disk space used by this conversation (SQLite DB + Brain transcripts/artifacts + Annotations)">
                Disk: <span id="chatDiskVal" class="text-zinc-300 font-semibold">0 MB</span>
              </span>
            </div>
            <div id="subagentBreadcrumb" class="hidden text-xs muted-color mb-1.5 flex items-center gap-1.5 flex-wrap"></div>
            <div class="flex items-center gap-2.5">
              <h2 id="chatTitle" class="text-sm font-bold text-[var(--vscode-editor-foreground,#f4f4f5)]">Loading...</h2>
              <button id="deleteChatBtn" class="px-2 py-0.5 rounded text-[10px] font-semibold bg-red-500/15 hover:bg-red-500/25 text-red-400 hover:text-red-300 border border-red-500/30 transition-colors flex items-center gap-1 shadow-sm shrink-0" title="${delTooltip}">
                <svg class="w-3 h-3 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                <span>Delete Chat</span>
              </button>
            </div>
            <p id="chatMeta" class="text-[11px] muted-color">ID: -- | Last Active: --</p>
          </div>
          <div class="sm:text-right">
            <span class="text-[10px] muted-color">Total Tokens Processed</span>
            <div id="grandTotalText" class="text-lg font-black text-emerald-400">0</div>
          </div>
        </div>

        <!-- 4 KPI Cards -->
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div class="p-2.5 inner-bg border border-color rounded-lg">
            <div class="text-[10px] muted-color">Context Window</div>
            <div id="kpiContext" class="text-base font-bold text-amber-400">0 / 256k</div>
            <div id="kpiContextSub" class="text-[10px] muted-color">0% Fill (256k left)</div>
          </div>

          <div class="p-2.5 inner-bg border border-color rounded-lg">
            <div class="text-[10px] muted-color">Cache Read</div>
            <div id="kpiCacheRead" class="text-base font-bold text-blue-400">0</div>
            <div id="kpiCacheReadSub" class="text-[10px] muted-color">0% vol · 0 hits</div>
          </div>

          <div class="p-2.5 inner-bg border border-color rounded-lg">
            <div class="text-[10px] muted-color">Uncached Input</div>
            <div id="kpiCacheWrite" class="text-base font-bold text-cyan-400">0</div>
            <div id="kpiCacheWriteSub" class="text-[10px] muted-color">0% vol · +0 avg / turn</div>
          </div>

          <div class="p-2.5 inner-bg border border-color rounded-lg">
            <div class="text-[10px] muted-color">Model Output</div>
            <div id="kpiOutput" class="text-base font-bold text-emerald-400">0</div>
            <div id="kpiOutputSub" class="text-[10px] muted-color">Avg 0 tok / call</div>
          </div>
        </div>
      </div>

      <!-- Subagents & Background Workers Card (Shown when selected chat has spawned children) -->
      <div id="subagentsCard" class="hidden p-3 card-bg border border-color rounded-xl space-y-2.5">
        <div id="subagentsToggleBtn" class="flex flex-wrap items-center justify-between gap-2 cursor-pointer select-none group" title="Click to minimize or expand subagents">
          <div class="flex items-center gap-2">
            <span id="subagentsChevron" class="text-[10px] text-zinc-400 group-hover:text-zinc-200 transition-transform duration-150">▼</span>
            <div class="flex items-center gap-1.5">
              <svg class="w-3.5 h-3.5 text-purple-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
              <h3 class="text-xs font-bold uppercase tracking-wider text-[var(--vscode-editor-foreground,#f4f4f5)] group-hover:text-blue-300 transition-colors">Subagents & Background Workers</h3>
            </div>
            <span id="subagentsCountBadge" class="text-[10px] px-2 py-0.5 rounded inner-bg border border-color text-purple-300 font-semibold">0 subagents</span>
          </div>
          <div class="flex items-center gap-3">
            <div id="subagentsRolledUpTotal" class="text-xs font-semibold text-emerald-400">
              <!-- Populated by JS: Parent (X) + Subagents (Y) = Z total -->
            </div>
            <span id="subagentsToggleLabel" class="text-[10px] text-zinc-400 group-hover:text-zinc-200 border border-transparent group-hover:border-color px-1.5 py-0.5 rounded transition-all">Collapse</span>
          </div>
        </div>

        <div id="subagentsList" class="space-y-1.5 max-h-72 overflow-y-auto custom-scrollbar pr-0.5">
          <!-- Populated by JS -->
        </div>
      </div>

      <!-- Token Breakdown Progress Bar & Legend -->
      <div class="p-3 card-bg border border-color rounded-xl space-y-2.5">
        <div class="flex items-center justify-between">
          <h3 class="text-xs font-bold uppercase tracking-wider text-[var(--vscode-editor-foreground,#f4f4f5)]">Token Composition</h3>
          <span class="text-[10px] muted-color">Cache Read vs Uncached Input vs Model Output</span>
        </div>

        <div class="h-3.5 w-full inner-bg rounded-full overflow-hidden flex border border-color">
          <div id="barCacheRead" class="bg-blue-500 h-full transition-all duration-300" style="width: 0%" title="Cache Read (Cached Prompt)"></div>
          <div id="barCacheWrite" class="bg-cyan-400 h-full transition-all duration-300" style="width: 0%" title="Uncached Input (Fresh Prompt)"></div>
          <div id="barOutput" class="bg-emerald-400 h-full transition-all duration-300" style="width: 0%" title="Model Output (Generation)"></div>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
          <div class="flex items-center gap-1.5">
            <span class="w-2.5 h-2.5 rounded-full bg-blue-500 shrink-0"></span>
            <div>
              <div class="font-medium text-[var(--vscode-editor-foreground,#f4f4f5)]" id="legCacheRead">0</div>
              <div class="text-[10px] muted-color">Cache Read (<span id="legCacheReadPct">0%</span>)</div>
            </div>
          </div>

          <div class="flex items-center gap-1.5">
            <span class="w-2.5 h-2.5 rounded-full bg-cyan-400 shrink-0"></span>
            <div>
              <div class="font-medium text-[var(--vscode-editor-foreground,#f4f4f5)]" id="legCacheWrite">0</div>
              <div class="text-[10px] muted-color">Uncached Input (<span id="legCacheWritePct">0%</span>)</div>
            </div>
          </div>

          <div class="flex items-center gap-1.5">
            <span class="w-2.5 h-2.5 rounded-full bg-emerald-400 shrink-0"></span>
            <div>
              <div class="font-medium text-[var(--vscode-editor-foreground,#f4f4f5)]" id="legOutput">0</div>
              <div class="text-[10px] muted-color">Model Output (<span id="legOutputPct">0%</span>)</div>
            </div>
          </div>
        </div>
      </div>

      <!-- EXPANDED INTERACTIVE CONTEXT WINDOW TIMELINE CHART -->
      <div class="p-3 card-bg border border-color rounded-xl space-y-2 relative">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div class="flex items-center gap-2">
              <h3 class="text-xs font-bold uppercase tracking-wider text-[var(--vscode-editor-foreground,#f4f4f5)]">Context Window Timeline</h3>
              <span id="chartPointsCount" class="text-[10px] px-2 py-0.5 rounded inner-bg border border-color muted-color">0 points</span>
            </div>
            <p class="text-[10px] muted-color">Dual-layer progression: Total Context (Blue) vs Cached Volume (Emerald)</p>
          </div>
          
          <!-- Chart Legend -->
          <div class="flex items-center gap-3 text-[10px]">
            <div class="flex items-center gap-1">
              <span class="w-2 h-2 rounded-full bg-blue-500 inline-block"></span>
              <span class="text-[var(--vscode-editor-foreground,#f4f4f5)]">Total Context</span>
            </div>
            <div class="flex items-center gap-1">
              <span class="w-2 h-2 rounded-full bg-emerald-400 inline-block"></span>
              <span class="text-emerald-400">Cache Read</span>
            </div>
            <div class="flex items-center gap-1">
              <span class="w-3 border-t border-dashed border-red-400 inline-block"></span>
              <span id="chartCeilingLegend" class="text-red-400 font-medium">256k Limit</span>
            </div>
          </div>
        </div>

        <!-- SVG Chart Container with Interactive Crosshair & Floating Tooltip -->
        <div id="chartContainer" class="h-44 w-full inner-bg border border-color rounded-lg relative overflow-hidden flex items-center justify-center select-none">
          <svg id="timelineSvg" class="w-full h-full" style="display: block;"></svg>

          <!-- Chart Loading Overlay -->
          <div id="chartLoadingOverlay" class="absolute inset-0 bg-black/50 backdrop-blur-[2px] flex flex-col items-center justify-center gap-2 z-20 hidden select-none pointer-events-none transition-opacity duration-150">
            <div class="flex items-center gap-2 px-3 py-1.5 rounded-lg inner-bg border border-color shadow-xl">
              <svg class="w-4 h-4 text-blue-400 animate-spin shrink-0" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              <span id="chartLoadingText" class="text-xs font-semibold text-[var(--vscode-editor-foreground,#f4f4f5)]">Loading turn timeline...</span>
            </div>
          </div>

          <!-- Chart Empty State -->
          <div id="chartEmptyState" class="absolute inset-0 hidden flex items-center justify-center text-xs muted-color italic pointer-events-none select-none">
            No turns recorded yet
          </div>

          <!-- Floating Inspection Tooltip -->
          <div id="chartTooltip" class="absolute hidden pointer-events-none p-2.5 inner-bg border border-color rounded-lg shadow-xl text-xs z-30 transition-all duration-75">
            <div class="flex items-center justify-between gap-3 border-b border-color pb-1 mb-1.5">
              <span id="ttTurn" class="font-bold text-blue-400">Turn #--</span>
              <span id="ttCompacted" class="hidden text-[9px] font-bold px-1.5 py-0.2 rounded bg-red-500/20 text-red-400 border border-red-500/30">COMPACTED</span>
            </div>
            <div class="space-y-1 text-[11px]">
              <div class="flex justify-between gap-4">
                <span class="muted-color">Context Size:</span>
                <span id="ttContext" class="font-mono font-semibold text-[var(--vscode-editor-foreground,#f4f4f5)]">--</span>
              </div>
              <div class="flex justify-between gap-4">
                <span class="muted-color">Cache Read:</span>
                <span id="ttCached" class="font-mono font-semibold text-emerald-400">--</span>
              </div>
              <div class="flex justify-between gap-4">
                <span class="muted-color">Uncached Input:</span>
                <span id="ttFresh" class="font-mono font-semibold text-cyan-400">--</span>
              </div>
              <div class="flex justify-between gap-4">
                <span class="muted-color">Model Output:</span>
                <span id="ttOutput" class="font-mono font-semibold text-purple-400">--</span>
              </div>
            </div>
          </div>
        </div>

        <div class="flex items-center justify-between text-[10px] muted-color px-1">
          <span>Start (Turn 1)</span>
          <span class="text-[9px] muted-color">Hover over graph to inspect turn details</span>
          <span>Latest Turn</span>
        </div>
      </div>

      <!-- CONTEXT HEALTH & CODEBASE IMPACT (CLI /context Experience & Activity) -->
      <div id="activityCard" class="p-3 card-bg border border-color rounded-xl space-y-3">
        <!-- Top Bar: Title & Controls -->
        <div class="flex flex-wrap items-center justify-between gap-2 border-b border-color pb-2.5">
          <div class="flex items-center gap-2">
            <svg class="w-4 h-4 text-emerald-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/></svg>
            <div>
              <div class="flex items-center gap-2">
                <h3 class="text-xs font-bold uppercase tracking-wider text-[var(--vscode-editor-foreground,#f4f4f5)]">Context Health & Codebase Impact</h3>
                <span id="contextHealthStatusBadge" class="px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wide uppercase bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">Healthy</span>
              </div>
              <p class="text-[10px] muted-color">Live context allocation, token headroom & codebase operations</p>
            </div>
          </div>

          <div class="flex items-center gap-2">
            <!-- Files Drawer Toggle -->
            <button id="actToggleFilesBtn" class="flex items-center gap-1.5 px-2 py-1 rounded text-[10px] font-semibold inner-bg border border-color hover:border-blue-500/40 text-[var(--vscode-editor-foreground,#f4f4f5)] hover:text-blue-300 transition-colors shadow-sm select-none" title="Toggle list of files read in memory and modified">
              <svg class="w-3.5 h-3.5 text-blue-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/></svg>
              <span>Files Touched (<span id="actFilesBadgeCount">0</span>)</span>
              <span id="actFilesChevron" class="text-[9px] text-zinc-400 transition-transform">▼</span>
            </button>
          </div>
        </div>

        <!-- Hero Context Health Diagnostic Bar -->
        <div class="p-2.5 inner-bg rounded-lg border border-color space-y-2">
          <div class="flex flex-wrap items-center justify-between gap-2 text-xs">
            <div class="flex items-center gap-1.5 flex-wrap">
              <span class="text-xs font-semibold text-[var(--vscode-editor-foreground,#f4f4f5)]">Health Diagnostic:</span>
              <span id="contextHealthPct" class="font-mono font-bold text-emerald-400">0.0%</span>
              <span class="muted-color">in use of</span>
              <span id="contextHealthCeiling" class="font-mono font-semibold text-[var(--vscode-editor-foreground,#f4f4f5)]">256k</span>
            </div>
            <div class="text-[11px] font-mono muted-color flex items-center gap-2">
              <span><strong id="contextHealthUsed" class="text-[var(--vscode-editor-foreground,#f4f4f5)]">0</strong> tok used</span>
              <span>·</span>
              <span><strong id="contextHealthFree" class="text-emerald-400">256,000</strong> tok headroom remaining</span>
            </div>
          </div>

          <!-- Unified Segmented Context Allocation Bar -->
          <div id="contextHealthMeter" class="h-3 w-full bg-zinc-900 rounded-full overflow-hidden flex border border-color/80 relative transition-all duration-300" title="Context Allocation">
            <div id="segPrompts" class="h-full bg-blue-500 transition-all duration-300" style="width: 0%" title="User Prompts"></div>
            <div id="segReplies" class="h-full bg-purple-500 transition-all duration-300" style="width: 0%" title="Assistant Output"></div>
            <div id="segFiles" class="h-full bg-cyan-400 transition-all duration-300" style="width: 0%" title="Codebase Files"></div>
            <div id="segCommands" class="h-full bg-emerald-400 transition-all duration-300" style="width: 0%" title="Tool & Command Outputs"></div>
            <div id="segImages" class="h-full bg-amber-400 transition-all duration-300" style="width: 0%" title="Analyzed Images"></div>
            <div id="segFree" class="h-full bg-zinc-800/60 transition-all duration-300" style="width: 100%" title="Free Headroom"></div>
          </div>

          <!-- Allocation Bar Micro-Legend (3-column responsive grid) -->
          <div class="grid grid-cols-3 sm:grid-cols-6 gap-x-2 gap-y-1 text-[10px] muted-color pt-0.5">
            <div class="flex items-center gap-1 min-w-0 truncate">
              <span class="w-2 h-2 rounded-full bg-blue-500 shrink-0"></span>
              <span class="truncate">Prompts: <strong id="segPromptsVal" class="text-[var(--vscode-editor-foreground,#f4f4f5)] font-mono">0%</strong></span>
            </div>
            <div class="flex items-center gap-1 min-w-0 truncate">
              <span class="w-2 h-2 rounded-full bg-purple-500 shrink-0"></span>
              <span class="truncate">Replies: <strong id="segRepliesVal" class="text-[var(--vscode-editor-foreground,#f4f4f5)] font-mono">0%</strong></span>
            </div>
            <div class="flex items-center gap-1 min-w-0 truncate">
              <span class="w-2 h-2 rounded-full bg-cyan-400 shrink-0"></span>
              <span class="truncate">Files: <strong id="segFilesVal" class="text-[var(--vscode-editor-foreground,#f4f4f5)] font-mono">0%</strong></span>
            </div>
            <div class="flex items-center gap-1 min-w-0 truncate">
              <span class="w-2 h-2 rounded-full bg-emerald-400 shrink-0"></span>
              <span class="truncate">Cmds: <strong id="segCommandsVal" class="text-[var(--vscode-editor-foreground,#f4f4f5)] font-mono">0%</strong></span>
            </div>
            <div class="flex items-center gap-1 min-w-0 truncate">
              <span class="w-2 h-2 rounded-full bg-amber-400 shrink-0"></span>
              <span class="truncate">Images: <strong id="segImagesVal" class="text-[var(--vscode-editor-foreground,#f4f4f5)] font-mono">0%</strong></span>
            </div>
            <div class="flex items-center gap-1 min-w-0 truncate">
              <span class="w-2 h-2 rounded-full bg-zinc-600 shrink-0"></span>
              <span class="truncate">Headroom: <strong id="segFreeVal" class="text-emerald-400 font-mono">100%</strong></span>
            </div>
          </div>
        </div>

        <!-- 4 Unified Activity & Footprint Metrics Cards -->
        <div id="contextCardsGrid" class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
          <!-- Metric 1: Assistant Responses -->
          <div class="p-2.5 inner-bg rounded-lg border border-color space-y-1">
            <div class="flex items-center justify-between text-[10px] muted-color">
              <span class="flex items-center gap-1 font-semibold uppercase tracking-wider">
                <svg class="w-3 h-3 text-blue-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"/></svg>
                Responses
              </span>
              <span id="actRepliesFootprint" class="text-[9px] px-1 py-0.2 rounded font-mono inner-bg border border-color text-blue-300">~0 tok</span>
            </div>
            <div id="actAssistantReplies" class="text-base font-bold text-blue-400">0</div>
            <div id="actUserPromptsSub" class="text-[10px] muted-color truncate" title="User prompts and autonomy ratio">0 prompts · 0.0 turns/prompt</div>
          </div>

          <!-- Metric 2: Codebase Files -->
          <div class="p-2.5 inner-bg rounded-lg border border-color space-y-1">
            <div class="flex items-center justify-between text-[10px] muted-color">
              <span class="flex items-center gap-1 font-semibold uppercase tracking-wider">
                <svg class="w-3 h-3 text-cyan-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
                Files In Memory
              </span>
              <span id="actFilesFootprint" class="text-[9px] px-1 py-0.2 rounded font-mono inner-bg border border-color text-cyan-300">~0 tok</span>
            </div>
            <div id="actFilesRead" class="text-base font-bold text-cyan-400">0</div>
            <div id="actFilesModifiedSub" class="text-[10px] muted-color truncate" title="Files modified or created">0 modified / created</div>
          </div>

          <!-- Metric 3: Executed Commands -->
          <div class="p-2.5 inner-bg rounded-lg border border-color space-y-1">
            <div class="flex items-center justify-between text-[10px] muted-color">
              <span class="flex items-center gap-1 font-semibold uppercase tracking-wider">
                <svg class="w-3 h-3 text-emerald-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2z"/></svg>
                Commands
              </span>
              <span id="actCommandsFootprint" class="text-[9px] px-1 py-0.2 rounded font-mono inner-bg border border-color text-emerald-300">~0 tok</span>
            </div>
            <div id="actCommands" class="text-base font-bold text-emerald-400">0</div>
            <div id="actTotalToolsSub" class="text-[10px] muted-color truncate" title="Total tool actions completed">0 total tool actions</div>
          </div>

          <!-- Metric 4: Visual & Web Operations -->
          <div class="p-2.5 inner-bg rounded-lg border border-color space-y-1">
            <div class="flex items-center justify-between text-[10px] muted-color">
              <span class="flex items-center gap-1 font-semibold uppercase tracking-wider">
                <svg class="w-3 h-3 text-amber-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
                Images
              </span>
              <span id="actImagesFootprint" class="text-[9px] px-1 py-0.2 rounded font-mono inner-bg border border-color text-amber-300">~0 tok</span>
            </div>
            <div id="actImages" class="text-base font-bold text-amber-400">0</div>
            <div id="actSubagentsWebSub" class="text-[10px] muted-color truncate" title="Multimodal visual captures processed">0 captures processed</div>
          </div>
        </div>

        <!-- Collapsible Files Inspector Drawer -->
        <div id="actFilesDrawer" class="hidden inner-bg border border-color rounded-lg p-3 space-y-2.5">
          <div class="flex items-center justify-between gap-2 border-b border-color pb-2">
            <div class="flex items-center gap-1.5 text-xs font-semibold text-[var(--vscode-editor-foreground,#f4f4f5)]">
              <svg class="w-3.5 h-3.5 text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/></svg>
              <span>In-Memory & Modified Codebase Files</span>
            </div>
            <input id="actFileFilterInput" type="text" placeholder="Filter paths..." 
              class="px-2 py-0.5 text-[10px] inner-bg border border-color rounded text-[var(--vscode-editor-foreground,#f4f4f5)] placeholder-[var(--vscode-input-placeholderForeground,#71717a)] focus:outline-none focus:border-blue-500 w-44" />
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
            <!-- Files Read in Memory -->
            <div class="space-y-1.5">
              <div class="flex items-center justify-between text-[11px] font-semibold border-b border-color pb-1 text-cyan-300">
                <span class="flex items-center gap-1">
                  <svg class="w-3 h-3 text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
                  Files Read in Memory
                </span>
                <span id="actDrawerReadCount" class="px-1.5 py-0.2 rounded text-[10px] inner-bg border border-color text-zinc-300 font-mono">0</span>
              </div>
              <div id="actDrawerReadList" class="max-h-56 overflow-y-auto custom-scrollbar space-y-1 pr-1 text-[11px] font-mono text-zinc-300">
                <div class="muted-color italic text-[11px]">No files read</div>
              </div>
            </div>

            <!-- Files Modified or Created -->
            <div class="space-y-1.5">
              <div class="flex items-center justify-between text-[11px] font-semibold border-b border-color pb-1 text-emerald-300">
                <span class="flex items-center gap-1">
                  <svg class="w-3 h-3 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
                  Files Modified / Created
                </span>
                <span id="actDrawerModCount" class="px-1.5 py-0.2 rounded text-[10px] inner-bg border border-color text-zinc-300 font-mono">0</span>
              </div>
              <div id="actDrawerModList" class="max-h-56 overflow-y-auto custom-scrollbar space-y-1 pr-1 text-[11px] font-mono text-zinc-300">
                <div class="muted-color italic text-[11px]">No files modified</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- STREAMLINED TURN & CACHE INTELLIGENCE -->
      <div id="intelligenceCard" class="p-3 card-bg border border-color rounded-xl space-y-2.5">
        <div class="flex items-center justify-between">
          <h3 class="text-xs font-bold uppercase tracking-wider text-[var(--vscode-editor-foreground,#f4f4f5)]">Turn & Cache Intelligence</h3>
          <span class="text-[10px] muted-color">Operational telemetry & execution dynamics</span>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-3 gap-2 text-xs">
          
          <!-- Card 1: Last Turn Execution & Compaction -->
          <div class="p-2.5 inner-bg rounded-lg border border-color space-y-1.5">
            <div class="flex items-center justify-between text-[10px] muted-color">
              <span class="flex items-center gap-1 font-semibold uppercase tracking-wider">
                <svg class="w-3 h-3 text-blue-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
                Last Turn Execution
              </span>
              <span id="metaLastTurnNum" class="font-semibold text-blue-400">Turn #--</span>
            </div>
            <div class="flex items-baseline justify-between gap-2">
              <div id="metaLastContext" class="text-base font-bold text-[var(--vscode-editor-foreground,#f4f4f5)]">0 tok</div>
              <div id="metaLastCompaction" class="text-[10px] font-semibold text-emerald-400">Normal</div>
            </div>
            <div class="text-[10px] space-y-0.5 border-t border-color/60 pt-1">
              <div class="flex justify-between">
                <span class="muted-color">Fresh Uncached Input:</span>
                <span id="metaLastFresh" class="font-medium text-cyan-400">+0 fresh</span>
              </div>
              <div class="flex justify-between">
                <span class="muted-color">Model Output:</span>
                <span id="metaLastOutput" class="font-medium text-purple-400">0 tok</span>
              </div>
            </div>
          </div>

          <!-- Card 2: Trajectory Dynamics & Net Growth -->
          <div class="p-2.5 inner-bg rounded-lg border border-color space-y-1.5">
            <div class="flex items-center justify-between text-[10px] muted-color">
              <span class="flex items-center gap-1 font-semibold uppercase tracking-wider">
                <svg class="w-3 h-3 text-amber-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"/></svg>
                Trajectory Dynamics
              </span>
              <span id="metaTrajectoryNetPill" class="text-[9px] px-1.5 py-0.2 rounded font-mono font-medium bg-blue-500/15 text-blue-300 border border-blue-500/30">+0 tok net</span>
            </div>
            <div class="flex items-baseline justify-between gap-2">
              <div id="metaPeakContext" class="text-base font-bold text-amber-400">0 tok peak</div>
              <div class="text-[10px] muted-color font-mono">Min: <span id="metaMinContext" class="text-blue-300">0</span></div>
            </div>
            <div class="text-[10px] space-y-0.5 border-t border-color/60 pt-1">
              <div class="flex justify-between">
                <span class="muted-color">Average per Turn:</span>
                <span id="metaAvgContext" class="font-medium text-[var(--vscode-editor-foreground,#f4f4f5)]">0 tok</span>
              </div>
              <div class="flex justify-between">
                <span class="muted-color">Compaction Events:</span>
                <span id="metaCompactions" class="font-medium text-zinc-300">0 events</span>
              </div>
            </div>
          </div>

          <!-- Card 3: Prompt Cache Acceleration -->
          <div class="p-2.5 inner-bg rounded-lg border border-color space-y-1.5">
            <div class="flex items-center justify-between text-[10px] muted-color">
              <span class="flex items-center gap-1 font-semibold uppercase tracking-wider">
                <svg class="w-3 h-3 text-emerald-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/></svg>
                Cache Acceleration
              </span>
              <span id="metaCacheSpeedupPill" class="text-[9px] px-1.5 py-0.2 rounded font-mono font-medium bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">~1.0x</span>
            </div>
            <div class="flex items-baseline justify-between gap-2">
              <div id="metaCacheCalls" class="text-base font-bold text-emerald-400">0 / 0 Hits</div>
              <div id="metaCeilingLimit" class="text-[10px] font-mono text-red-400">256k limit</div>
            </div>
            <div class="text-[10px] space-y-0.5 border-t border-color/60 pt-1">
              <div class="flex justify-between">
                <span class="muted-color">Cold Starts:</span>
                <span id="metaCacheMisses" class="font-medium text-amber-400">0 misses</span>
              </div>
              <div class="flex justify-between">
                <span class="muted-color">Volume Served:</span>
                <span id="metaAvgCached" class="font-medium text-emerald-400">0 tok avg</span>
              </div>
            </div>
          </div>

        </div>
      </div>

    </div>

    <!-- TAB 2: All Sessions List (Shown only when user clicks tab) -->
    <div id="listView" class="hidden flex-1 min-h-0 p-3 card-bg border border-color rounded-xl flex flex-col space-y-3">
      <div class="flex items-center justify-between shrink-0">
        <h3 id="listHeading" class="text-xs font-bold uppercase tracking-wider text-[var(--vscode-editor-foreground,#f4f4f5)]">Conversation History (${conversations.length} sessions)</h3>
        <span id="listSubHeading" class="text-[10px] muted-color">Click any session to view its telemetry</span>
      </div>

      <div class="shrink-0">
        <input id="searchInput" type="text" placeholder="Search sessions by title or ID..." 
          class="w-full px-3 py-2 text-xs inner-bg border border-color rounded-lg text-[var(--vscode-editor-foreground,#f4f4f5)] placeholder-[var(--vscode-input-placeholderForeground,#71717a)] focus:outline-none focus:border-blue-500" />
      </div>

      <div id="convList" class="flex-1 min-h-0 overflow-y-auto space-y-1.5 pr-1 custom-scrollbar">
        <!-- Populated by JS -->
      </div>
    </div>

  </div>

  <!-- Modal for Deleting Conversation -->
  <div id="deleteModal" class="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4 hidden">
    <div class="card-bg border border-red-500/40 rounded-xl p-4 max-w-md w-full space-y-3 shadow-2xl">
      <div class="flex items-center gap-2 text-red-400 font-bold text-sm">
        <svg class="w-4 h-4 text-red-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
        <span>${delHeading}</span>
      </div>
      <p class="text-xs text-[var(--vscode-editor-foreground,#f4f4f5)]">
        <strong id="delModalTitle" class="text-white"></strong>
      </p>
      <p class="text-[11px] muted-color">${delQuestion}</p>
      <div id="delModalActiveWarning" class="hidden p-2 rounded bg-amber-500/15 border border-amber-500/30 text-[11px] text-amber-300 flex items-center gap-1.5">
        <svg class="w-3.5 h-3.5 shrink-0 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>
        <span>This is the currently active chat in Antigravity. Deleting it will terminate this session.</span>
      </div>
      <div class="text-[11px] muted-color space-y-1 p-2.5 inner-bg rounded-lg border border-color">
        <div class="text-[10px] uppercase font-bold text-red-400/90 mb-1">${delFilesNote}</div>
        <div>• SQLite conversation database (<code class="text-zinc-300 font-mono">conversations/*.db</code>)</div>
        <div>• Transcripts, artifacts & media (<code class="text-zinc-300 font-mono">brain/*</code> folder)</div>
        <div>• Summary records & annotations (<code class="text-zinc-300 font-mono">*.pbtxt</code>)</div>
        <div class="text-emerald-400 font-medium pt-1.5 border-t border-color flex justify-between">
          <span>${delSizeNote}</span>
          <span id="delModalSize" class="font-bold">-- MB</span>
        </div>
      </div>
      <div class="flex justify-end gap-2 pt-1">
        <button id="delModalCancelBtn" class="px-3 py-1.5 rounded text-xs inner-bg border border-color muted-color hover:text-white transition-colors">
          Cancel
        </button>
        <button id="delModalConfirmBtn" class="px-3 py-1.5 rounded text-xs bg-red-600 hover:bg-red-500 text-white font-semibold transition-colors flex items-center gap-1.5 shadow-sm">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
          <span>${delButtonLabel}</span>
        </button>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let CONVERSATIONS = ${safeJson(conversations)};
    let selectedId = ${safeJson(activeId || (conversations[0] ? conversations[0].id : ''))};
    let currentActiveId = ${safeJson(activeId || '')};
    let currentWorkspaceFilter = ${safeJson(options.workspaceFilter || 'current')};
    let currentWorkspaceName = ${safeJson(options.currentWorkspaceName || '')};
    let currentWorkspacePaths = ${safeJson(options.currentWorkspacePaths || [])};
    let currentSubagentFilter = 'all';
    let currentTab = 'detail';
    let currentTimeline = [];
    let pendingDeleteId = null;
    let expandedDrawers = new Set();
    let collapsedSubagents = new Set();
    let unattachedExpanded = false;
    let subagentsCardCollapsed = false;
    let activityFilesOpen = false;
    let isLoadingTimeline = false;
    let isRefreshing = false;
    let refreshTimeout = null;
    let fileFilterQuery = '';

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg && msg.type === 'workspaceFilterConfigUpdate') {
        if (msg.workspaceFilter) {
          currentWorkspaceFilter = msg.workspaceFilter;
          const filtered = getFilteredConversations();
          if (filtered.length > 0 && !filtered.some(c => c.id === selectedId)) {
            selectedId = filtered[0].id;
          }
          populateWorkspaceDropdown();
          populateDropdown();
          filterList();
          renderDetail();
          updateGlobalHeaders();
        }
      } else if (msg && msg.type === 'timelineData') {
        const target = CONVERSATIONS.find(c => c.id === msg.conversationId);
        if (target && target.stats) {
          target.stats.contextTimeline = msg.timeline || [];
          if (msg.activity) {
            target.stats.activity = msg.activity;
          }
        }
        if (selectedId === msg.conversationId) {
          isLoadingTimeline = false;
          currentTimeline = msg.timeline || [];
          renderChart(currentTimeline);
          renderDetail();
        }
      } else if (msg && msg.type === 'telemetryUpdate') {
        const oldTimelines = new Map();
        const oldActivities = new Map();
        for (const c of CONVERSATIONS) {
          if (c.stats && c.stats.contextTimeline && c.stats.contextTimeline.length > 0) {
            oldTimelines.set(c.id, c.stats.contextTimeline);
          }
          if (c.stats && c.stats.activity && (
            (c.stats.activity.filesRead && c.stats.activity.filesRead.length > 0) ||
            (c.stats.activity.filesModified && c.stats.activity.filesModified.length > 0)
          )) {
            oldActivities.set(c.id, c.stats.activity);
          }
        }
        CONVERSATIONS = msg.data;
        for (const c of CONVERSATIONS) {
          if ((!c.stats || !c.stats.contextTimeline || c.stats.contextTimeline.length === 0) && oldTimelines.has(c.id)) {
            if (!c.stats) c.stats = {};
            c.stats.contextTimeline = oldTimelines.get(c.id);
          }
          if (oldActivities.has(c.id)) {
            const oldAct = oldActivities.get(c.id);
            if (c.stats && c.stats.activity) {
              if ((!c.stats.activity.filesRead || c.stats.activity.filesRead.length === 0) && oldAct.filesRead && oldAct.filesRead.length > 0) {
                c.stats.activity.filesRead = oldAct.filesRead;
              }
              if ((!c.stats.activity.filesModified || c.stats.activity.filesModified.length === 0) && oldAct.filesModified && oldAct.filesModified.length > 0) {
                c.stats.activity.filesModified = oldAct.filesModified;
              }
            }
          }
        }
        if (msg.activeId) {
          currentActiveId = msg.activeId;
        }
        if (msg.currentWorkspaceName !== undefined) {
          currentWorkspaceName = msg.currentWorkspaceName;
        }
        if (msg.currentWorkspacePaths !== undefined) {
          currentWorkspacePaths = Array.isArray(msg.currentWorkspacePaths) ? msg.currentWorkspacePaths : [];
        }
        if (!CONVERSATIONS.some(c => c.id === selectedId)) {
          const filtered = getFilteredConversations();
          selectedId = currentActiveId && filtered.some(c => c.id === currentActiveId)
            ? currentActiveId
            : (filtered[0] ? filtered[0].id : (CONVERSATIONS[0] ? CONVERSATIONS[0].id : ''));
        }
        populateWorkspaceDropdown();
        populateDropdown();
        filterList();
        renderDetail();
        updateGlobalHeaders();
        if (isRefreshing) {
          resetRefreshButton(true);
        }
      }
    });

    function handleManualRefresh() {
      if (isRefreshing) return;
      isRefreshing = true;

      const btn = document.getElementById('refreshBtn');
      const icon = document.getElementById('refreshIcon');
      const label = document.getElementById('refreshLabel');

      if (btn) {
        btn.disabled = true;
        btn.title = 'Syncing telemetry...';
        btn.classList.add('opacity-75', 'cursor-not-allowed');
      }
      if (icon) {
        icon.classList.add('animate-spin', 'text-blue-400');
        icon.classList.remove('text-zinc-400', 'text-emerald-400');
      }
      if (label) {
        label.textContent = 'Syncing...';
      }

      vscode.postMessage({ command: 'refresh' });

      if (refreshTimeout) clearTimeout(refreshTimeout);
      refreshTimeout = setTimeout(() => {
        resetRefreshButton(false);
      }, 3000);
    }

    function resetRefreshButton(success) {
      if (refreshTimeout) {
        clearTimeout(refreshTimeout);
        refreshTimeout = null;
      }
      const btn = document.getElementById('refreshBtn');
      const icon = document.getElementById('refreshIcon');
      const label = document.getElementById('refreshLabel');

      if (icon) {
        icon.classList.remove('animate-spin', 'text-blue-400');
      }

      if (success) {
        if (btn) btn.title = 'Telemetry updated';
        if (icon) icon.classList.add('text-emerald-400');
        if (label) {
          label.textContent = 'Updated';
          label.classList.add('text-emerald-400');
        }
        setTimeout(() => {
          if (icon) {
            icon.classList.remove('text-emerald-400');
            icon.classList.add('text-zinc-400');
          }
          if (label) {
            label.textContent = 'Refresh';
            label.classList.remove('text-emerald-400');
          }
          if (btn) {
            btn.title = 'Refresh Telemetry Data';
            btn.disabled = false;
            btn.classList.remove('opacity-75', 'cursor-not-allowed');
          }
          isRefreshing = false;
        }, 800);
      } else {
        if (btn) {
          btn.title = 'Refresh Telemetry Data';
          btn.disabled = false;
          btn.classList.remove('opacity-75', 'cursor-not-allowed');
        }
        if (icon) {
          icon.classList.remove('text-emerald-400');
          icon.classList.add('text-zinc-400');
        }
        if (label) {
          label.textContent = 'Refresh';
          label.classList.remove('text-emerald-400');
        }
        isRefreshing = false;
      }
    }

    function normWorkspacePath(p) {
      if (!p || typeof p !== 'string') return '';
      const backslash = String.fromCharCode(92);
      let s = p.split(backslash).join('/').toLowerCase();
      while (s.indexOf('//') !== -1) {
        s = s.split('//').join('/');
      }
      while (s.endsWith('/') && s.length > 1) {
        s = s.slice(0, -1);
      }
      return s;
    }

    function setSubagentFilter(filter) {
      currentSubagentFilter = filter;
      const chipAll = document.getElementById('chipAllBtn');
      const chipChats = document.getElementById('chipChatsBtn');
      const chipSubs = document.getElementById('chipSubagentsBtn');
      const activeCls = 'px-2 py-1 rounded font-medium transition-colors bg-blue-500/20 text-blue-400 border border-blue-500/30 shadow-sm text-[11px]';
      const inactiveCls = 'px-2 py-1 rounded font-medium transition-colors muted-color hover:text-[var(--vscode-editor-foreground,#f4f4f5)] text-[11px]';

      if (chipAll) chipAll.className = filter === 'all' ? activeCls : inactiveCls;
      if (chipChats) chipChats.className = filter === 'chats' ? activeCls : inactiveCls;
      if (chipSubs) chipSubs.className = filter === 'subagents' ? activeCls : inactiveCls;

      populateDropdown();
      filterList();
      updateGlobalHeaders();
    }

    function getWorkspaceFilteredConversations() {
      if (currentWorkspaceFilter === 'all') {
        return CONVERSATIONS;
      }
      if (currentWorkspaceFilter.startsWith('ws:')) {
        const targetWs = currentWorkspaceFilter.slice(3).toLowerCase();
        return CONVERSATIONS.filter(c => (c.workspaceName || '').toLowerCase() === targetWs);
      }
      // 'current' workspace filter: match by path-prefix predicate
      if (!currentWorkspacePaths || currentWorkspacePaths.length === 0) {
        return CONVERSATIONS;
      }
      const sep = '/';
      const curNormPaths = currentWorkspacePaths.map(normWorkspacePath).filter(Boolean);
      if (curNormPaths.length === 0) {
        return CONVERSATIONS;
      }

      return CONVERSATIONS.filter(c => {
        const paths = c.workspacePaths;
        if (!Array.isArray(paths) || paths.length === 0) return false;
        for (const rawP of paths) {
          const normP = normWorkspacePath(rawP);
          if (!normP) continue;
          for (const cur of curNormPaths) {
            if (normP === cur || cur.startsWith(normP + sep) || normP.startsWith(cur + sep)) {
              return true;
            }
          }
        }
        return false;
      });
    }

    function getFilteredConversations() {
      const list = getWorkspaceFilteredConversations();
      if (currentSubagentFilter === 'chats') {
        return list.filter(c => !c.isSubagent);
      }
      if (currentSubagentFilter === 'subagents') {
        return list.filter(c => c.isSubagent);
      }
      return list;
    }

    function populateWorkspaceDropdown() {
      const select = document.getElementById('workspaceSelect');
      if (!select) return;
      select.innerHTML = '';

      const wsMap = new Map();
      for (const c of CONVERSATIONS) {
        const name = c.workspaceName;
        if (name) {
          wsMap.set(name, (wsMap.get(name) || 0) + 1);
        }
      }

      const optCurrent = document.createElement('option');
      optCurrent.value = 'current';
      optCurrent.textContent = currentWorkspaceName 
        ? 'Current (' + currentWorkspaceName + ')' 
        : 'Current Workspace';
      select.appendChild(optCurrent);

      const optAll = document.createElement('option');
      optAll.value = 'all';
      optAll.textContent = 'All Workspaces (' + CONVERSATIONS.length + ')';
      select.appendChild(optAll);

      for (const [wsName, count] of wsMap.entries()) {
        const optWs = document.createElement('option');
        optWs.value = 'ws:' + wsName;
        optWs.textContent = wsName + ' (' + count + ')';
        select.appendChild(optWs);
      }

      let hasMatch = false;
      for (let i = 0; i < select.options.length; i++) {
        if (select.options[i].value === currentWorkspaceFilter) {
          select.selectedIndex = i;
          hasMatch = true;
          break;
        }
      }
      if (!hasMatch) {
        select.value = 'current';
      }
    }

    function updateGlobalHeaders() {
      const wsList = getWorkspaceFilteredConversations();
      const allCount = wsList.length;
      const chatsCount = wsList.filter(c => !c.isSubagent).length;
      const subsCount = wsList.filter(c => c.isSubagent).length;

      const elAll = document.getElementById('countAll');
      const elChats = document.getElementById('countChats');
      const elSubs = document.getElementById('countSubagents');
      const elTabCount = document.getElementById('tabListCount');
      if (elAll) elAll.textContent = allCount;
      if (elChats) elChats.textContent = chatsCount;
      if (elSubs) elSubs.textContent = subsCount;
      if (elTabCount) elTabCount.textContent = allCount;

      const chipGroup = document.getElementById('subagentChipGroup');
      if (chipGroup) {
        if (subsCount > 0) {
          chipGroup.classList.remove('hidden');
          chipGroup.classList.add('flex');
        } else {
          chipGroup.classList.remove('flex');
          chipGroup.classList.add('hidden');
          if (currentSubagentFilter !== 'all') {
            currentSubagentFilter = 'all';
          }
        }
      }

      let gInput = 0, gCached = 0, gOutput = 0;
      let excludedInput = 0, excludedOutput = 0;

      for (const c of wsList) {
        if (!c.stats) continue;
        const inp = c.stats.totalInput || 0;
        const out = c.stats.totalOutput || 0;
        const cac = c.stats.totalCached || 0;

        let included = true;
        if (currentSubagentFilter === 'chats' && c.isSubagent) included = false;
        if (currentSubagentFilter === 'subagents' && !c.isSubagent) included = false;

        if (included) {
          gInput += inp;
          gCached += cac;
          gOutput += out;
        } else {
          excludedInput += inp;
          excludedOutput += out;
        }
      }

      const gTot = gInput + gOutput;
      const excludedTot = excludedInput + excludedOutput;
      const gHit = gInput > 0 ? ((gCached / gInput) * 100).toFixed(1) : '0.0';

      const elTot = document.getElementById('headerTotalTokens');
      const elHit = document.getElementById('headerHitRate');
      const elExcluded = document.getElementById('headerExcludedTokens');

      if (elTot) elTot.textContent = (gTot / 1_000_000).toFixed(1) + 'M tok';
      if (elHit) elHit.textContent = gHit + '%';
      if (elExcluded) {
        if (currentSubagentFilter === 'chats' && excludedTot > 0) {
          elExcluded.textContent = ' · +' + (excludedTot / 1_000_000).toFixed(1) + 'M in subagents';
        } else if (currentSubagentFilter === 'subagents' && excludedTot > 0) {
          elExcluded.textContent = ' · +' + (excludedTot / 1_000_000).toFixed(1) + 'M in chats';
        } else {
          elExcluded.textContent = '';
        }
      }
    }

    function switchTab(tab) {
      currentTab = tab;
      const detailView = document.getElementById('detailView');
      const listView = document.getElementById('listView');
      const detailBtn = document.getElementById('tabDetailBtn');
      const listBtn = document.getElementById('tabListBtn');

      if (tab === 'detail') {
        detailView.classList.remove('hidden');
        listView.classList.add('hidden');
        detailBtn.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded font-medium transition-colors bg-blue-500/20 text-blue-400 border border-blue-500/30 shadow-sm';
        listBtn.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded font-medium transition-colors muted-color hover:text-[var(--vscode-editor-foreground,#f4f4f5)]';
        const conv = CONVERSATIONS.find(c => c.id === selectedId);
        if (conv && conv.stats) renderChart(conv.stats.contextTimeline);
      } else {
        detailView.classList.add('hidden');
        listView.classList.remove('hidden');
        listBtn.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded font-medium transition-colors bg-blue-500/20 text-blue-400 border border-blue-500/30 shadow-sm';
        detailBtn.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded font-medium transition-colors muted-color hover:text-[var(--vscode-editor-foreground,#f4f4f5)]';
        filterList();
      }
    }

    function populateDropdown() {
      const select = document.getElementById('chatSelect');
      if (!select) return;
      select.innerHTML = '';
      const list = getFilteredConversations();
      if (list.length === 0 && !selectedId) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'No sessions in current view';
        select.appendChild(opt);
        return;
      }
      const displayList = list.slice();
      if (selectedId && !displayList.some(c => c.id === selectedId)) {
        const selConv = CONVERSATIONS.find(c => c.id === selectedId);
        if (selConv) {
          displayList.unshift(selConv);
        }
      }
      displayList.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.id;
        const isAct = c.id === currentActiveId ? ' (ACTIVE)' : '';
        const wsPrefix = (currentWorkspaceFilter === 'all' && c.workspaceName) ? '[' + c.workspaceName + '] ' : '';
        const tokM = c.stats ? (c.stats.grandTotal / 1_000_000).toFixed(1) + 'M' : '0M';
        const hit = c.stats ? Math.round(parseFloat(c.stats.cacheHitRate) || 0) + '%' : '0%';

        let titleText = '';
        let fullTitle = '';
        if (c.isSubagent) {
          const agent = c.agentName || 'subagent';
          const hasTitle = c.title && c.title !== '<original_task>' && c.title !== 'Untitled Conversation' && c.title !== 'Untitled' && c.title.trim() !== agent;
          const display = hasTitle ? c.title.trim() : (c.agentRole ? c.agentRole.trim() : '');
          if (display) {
            let tClean = display;
            if (tClean.length > 28) tClean = tClean.slice(0, 26).trim() + '…';
            titleText = '[' + agent + '] ' + tClean;
            fullTitle = '[' + agent + '] ' + display;
          } else {
            titleText = '[' + agent + ']';
            fullTitle = '[' + agent + ']';
          }
        } else {
          fullTitle = c.title || 'Untitled';
          let t = fullTitle.trim();
          if (t.length > 36) {
            t = t.slice(0, 34).trim() + '…';
          }
          titleText = t;
        }

        const hasMultipleSources = new Set(CONVERSATIONS.map(x => x.source).filter(Boolean)).size > 1;
        const srcPrefix = hasMultipleSources && c.source ? (c.source === 'cli' ? '[CLI] ' : (c.source === 'ide' ? '[IDE] ' : '[Ext] ')) : '';
        opt.textContent = srcPrefix + wsPrefix + titleText + isAct + ' · ' + tokM + ' (' + hit + ' cache)';
        opt.title = srcPrefix + (wsPrefix ? wsPrefix : '') + fullTitle + isAct + ' — ' + (c.storageMB ? c.storageMB + 'MB · ' : '') + tokM + ' tok (' + (c.stats ? c.stats.cacheHitRate : 0) + '% cache)';
        if (c.id === selectedId) opt.selected = true;
        select.appendChild(opt);
      });
      if (selectedId) {
        select.value = selectedId;
        const cur = CONVERSATIONS.find(c => c.id === selectedId);
        if (cur) {
          const agent = cur.agentName || 'subagent';
          const hasTask = cur.title && cur.title !== '<original_task>' && cur.title !== 'Untitled Conversation' && cur.title !== 'Untitled' && cur.title.trim() !== agent;
          const task = hasTask ? cur.title.trim() : (cur.agentRole ? cur.agentRole.trim() : '');
          select.title = cur.isSubagent ? ('[' + agent + ']' + (task ? ' ' + task : '')) : (cur.title || 'Untitled');
        }
      }
    }

    function selectConv(id) {
      selectedId = id;
      const conv = CONVERSATIONS.find(c => c.id === id);
      const needsTimeline = Boolean(conv && conv.stats && (!conv.stats.contextTimeline || conv.stats.contextTimeline.length === 0) && conv.stats.calls > 0);
      isLoadingTimeline = needsTimeline;
      try {
        vscode.postMessage({ command: 'selectConversation', conversationId: id });
        if (needsTimeline) {
          vscode.postMessage({ command: 'getTimeline', conversationId: id });
        }
      } catch {}
      populateDropdown();
      renderDetail();
      if (currentTab === 'list') {
        switchTab('detail');
      }
    }

    function escapeHtml(str) {
      if (!str) return '';
      return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function renderList(wsList, q) {
      const container = document.getElementById('convList');
      if (!container) return;
      container.innerHTML = '';

      if (!wsList || wsList.length === 0) {
        container.innerHTML = '<div class="text-xs muted-color p-4 text-center">No sessions found</div>';
        return;
      }

      function createConvRow(c, collapseOpts = null) {
        const isSel = c.id === selectedId;
        const isAct = c.id === currentActiveId;
        const div = document.createElement('div');
        div.className = 'p-2.5 rounded-lg cursor-pointer transition-all border ' + (
          isSel 
            ? 'bg-blue-500/15 border-blue-500/40 text-[var(--vscode-editor-foreground,#f4f4f5)] shadow-sm' 
            : 'inner-bg border-transparent hover:border-color muted-color hover:text-[var(--vscode-editor-foreground,#f4f4f5)]'
        );
        div.onclick = () => selectConv(c.id);

        const totalM = c.stats ? (c.stats.grandTotal / 1_000_000).toFixed(1) : '0';
        const hitRate = c.stats ? c.stats.cacheHitRate : '0';
        const storageMB = c.storageMB ? c.storageMB + ' MB' : '-- MB';
        const wsName = c.workspaceName || '';
        const wsBadge = wsName && currentWorkspaceFilter === 'all'
          ? '<span class="inline-flex items-center gap-1 text-[9px] font-medium px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300 border border-indigo-500/30 shrink-0" title="Workspace: ' + escapeHtml(wsName) + '"><svg class="w-2.5 h-2.5 text-indigo-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/></svg>' + escapeHtml(wsName) + '</span>'
          : '';
        const hasMultipleSources = new Set(CONVERSATIONS.map(x => x.source).filter(Boolean)).size > 1;
        let sourceBadge = '';
        if (hasMultipleSources && c.source) {
          if (c.source === 'cli') {
            sourceBadge = '<span class="inline-flex items-center gap-1 text-[9px] font-medium px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 shrink-0" title="Source: Antigravity CLI"><svg class="w-2.5 h-2.5 text-emerald-300 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>CLI</span>';
          } else if (c.source === 'ide') {
            sourceBadge = '<span class="inline-flex items-center gap-1 text-[9px] font-medium px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 shrink-0" title="Source: Antigravity IDE"><svg class="w-2.5 h-2.5 text-cyan-300 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2H4V5zm0 4h16v10a1 1 0 01-1 1H5a1 1 0 01-1-1V9z"/></svg>IDE</span>';
          } else {
            sourceBadge = '<span class="inline-flex items-center gap-1 text-[9px] font-medium px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30 shrink-0" title="Source: Antigravity Extension"><svg class="w-2.5 h-2.5 text-amber-300 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M11 4a2 2 0 114 0v1a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-1a2 2 0 100 4h1a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-1a2 2 0 10-4 0v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-3a1 1 0 00-1-1H4a2 2 0 110-4h1a1 1 0 001-1V7a1 1 0 011-1h3a1 1 0 001-1V4z"/></svg>Ext</span>';
          }
        }

        let leftChevronHtml = '';
        let collapsePillHtml = '';
        if (collapseOpts && collapseOpts.hasChildren) {
          const arrow = collapseOpts.isCollapsed ? '▸' : '▾';
          leftChevronHtml = '<span class="sub-toggle-arrow-left text-[11px] text-purple-300 font-bold select-none cursor-pointer hover:text-purple-200 shrink-0 mr-0.5" title="' + (collapseOpts.isCollapsed ? 'Show child subagents' : 'Hide child subagents') + '">' + arrow + '</span>';
          const cnt = collapseOpts.count || 0;
          collapsePillHtml = 
            '<button class="sub-toggle-pill flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono font-medium border bg-purple-500/15 text-purple-300 border-purple-500/30 hover:bg-purple-500/25 cursor-pointer shrink-0" title="' + (collapseOpts.isCollapsed ? 'Show child subagents' : 'Hide child subagents') + '">' +
              '<span class="sub-toggle-arrow text-[10px]">' + arrow + '</span>' +
              '<span>' + cnt + ' subagent' + (cnt > 1 ? 's' : '') + '</span>' +
            '</button>';
        }

        let titleHtml = '';
        if (c.isSubagent) {
          const agentLabel = escapeHtml(c.agentName || 'subagent');
          const hasTitle = c.title && c.title !== '<original_task>' && c.title !== 'Untitled Conversation' && c.title !== 'Untitled' && c.title.trim() !== c.agentName;
          const cleanTitle = (hasTitle ? c.title.trim() : (c.agentRole ? c.agentRole.trim() : '')).trim();
          let displayTitle = cleanTitle;
          if (displayTitle.length > 38) {
            displayTitle = displayTitle.slice(0, 36).trim() + '…';
          }
          const parentConv = c.parentConversationId ? CONVERSATIONS.find(x => x.id === c.parentConversationId) : null;
          const parentTooltip = parentConv && parentConv.isSubagent ? ' (Subagent of ' + (parentConv.agentName || parentConv.title || 'subagent') + ')' : '';
          const fullTooltip = cleanTitle ? (cleanTitle + parentTooltip) : '';
          const taskSpan = displayTitle
            ? '<span class="font-medium text-xs truncate min-w-0 ' + (isSel ? 'text-blue-300 font-semibold' : 'text-[var(--vscode-editor-foreground,#f4f4f5)]') + '" title="' + escapeHtml(fullTooltip) + '">' + escapeHtml(displayTitle) + '</span>'
            : '';
          titleHtml = 
            leftChevronHtml +
            '<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold bg-purple-500/20 text-purple-300 border border-purple-500/30 shrink-0"><svg class="w-2.5 h-2.5 text-purple-300 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>' + agentLabel + '</span>' +
            taskSpan;
        } else {
          titleHtml = '<span class="font-medium text-xs truncate min-w-0 ' + (isSel ? 'text-blue-300 font-semibold' : 'text-[var(--vscode-editor-foreground,#f4f4f5)]') + '" title="' + escapeHtml(c.title || 'Untitled') + '">' + escapeHtml(c.title || 'Untitled') + '</span>';
        }

        div.innerHTML = 
          '<div class="flex items-center justify-between gap-2 mb-1">' +
            '<div class="flex items-center gap-1.5 min-w-0 flex-1">' +
              titleHtml +
              wsBadge +
              sourceBadge +
            '</div>' +
            '<div class="flex items-center gap-1.5 shrink-0">' +
              (isAct ? '<span class="text-[9px] font-bold px-1 rounded bg-emerald-500/20 text-emerald-400">ACTIVE</span>' : '') +
              collapsePillHtml +
              '<span class="text-[10px] font-bold px-1.5 py-0.5 rounded ' + (hitRate > 90 ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400') + '">' + hitRate + '%</span>' +
              '<button class="del-btn p-1 rounded hover:bg-red-500/20 text-zinc-400 hover:text-red-400 transition-colors" title="${delTooltip}"><svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg></button>' +
            '</div>' +
          '</div>' +
          '<div class="flex items-center justify-between text-[10px] muted-color">' +
            '<span>' + (c.stats ? c.stats.calls : 0) + ' calls · ' + c.stepCount + ' steps' + (c.stats && c.stats.activity && c.stats.activity.totalToolCalls > 0 ? ' · ' + c.stats.activity.totalToolCalls + ' tools' : '') + '</span>' +
            '<div class="flex items-center gap-2 font-mono font-medium">' +
              '<span class="text-zinc-400">' + storageMB + '</span>' +
              '<span>' + totalM + 'M tok</span>' +
            '</div>' +
          '</div>';

        const delBtn = div.querySelector('.del-btn');
        if (delBtn) {
          delBtn.onclick = (e) => {
            e.stopPropagation();
            openDeleteModal(c.id);
          };
        }

        if (collapseOpts && collapseOpts.hasChildren && collapseOpts.onToggle) {
          const pill = div.querySelector('.sub-toggle-pill');
          if (pill) {
            pill.onclick = (e) => {
              e.stopPropagation();
              collapseOpts.onToggle();
            };
          }
          const leftArr = div.querySelector('.sub-toggle-arrow-left');
          if (leftArr) {
            leftArr.onclick = (e) => {
              e.stopPropagation();
              collapseOpts.onToggle();
            };
          }
        }
        return div;
      }

      if (currentSubagentFilter === 'chats') {
        const chats = wsList.filter(c => !c.isSubagent);
        const filtered = q
          ? chats.filter(c => (c.title || '').toLowerCase().includes(q) || (c.id || '').toLowerCase().includes(q))
          : chats;
        if (filtered.length === 0) {
          container.innerHTML = '<div class="text-xs muted-color p-4 text-center">No chats match filter</div>';
          return;
        }
        filtered.forEach(c => container.appendChild(createConvRow(c, false)));
        return;
      }

      if (currentSubagentFilter === 'subagents') {
        const subs = wsList.filter(c => c.isSubagent);
        const filtered = q
          ? subs.filter(c => (c.agentName || '').toLowerCase().includes(q) || (c.agentRole || '').toLowerCase().includes(q) || (c.title || '').toLowerCase().includes(q) || (c.id || '').toLowerCase().includes(q))
          : subs;
        if (filtered.length === 0) {
          container.innerHTML = '<div class="text-xs muted-color p-4 text-center">No subagents match filter</div>';
          return;
        }
        filtered.forEach(c => {
          container.appendChild(createConvRow(c, true));
        });
        return;
      }

      // Default: 'all' mode with NESTED DRAWERS and UNATTACHED GROUP
      const humanChats = wsList.filter(c => !c.isSubagent);
      const allSubagents = wsList.filter(c => c.isSubagent);

      const convById = new Map(CONVERSATIONS.map(c => [c.id, c]));

      // Map direct children for every conversation
      const childrenMap = new Map();
      allSubagents.forEach(s => {
        const pId = s.parentConversationId;
        if (pId) {
          if (!childrenMap.has(pId)) childrenMap.set(pId, []);
          childrenMap.get(pId).push(s);
        }
      });

      // Find root ancestor for any conversation
      function getRootConversation(conv) {
        let curr = conv;
        const visited = new Set();
        while (curr && curr.parentConversationId && !visited.has(curr.id)) {
          visited.add(curr.id);
          const parent = convById.get(curr.parentConversationId);
          if (!parent) break;
          curr = parent;
          if (!curr.isSubagent) {
            return curr;
          }
        }
        return curr;
      }

      // Collect all descendant subagents recursively
      function getAllDescendants(parentId) {
        const descendants = [];
        const direct = childrenMap.get(parentId) || [];
        for (const child of direct) {
          descendants.push(child);
          descendants.push(...getAllDescendants(child.id));
        }
        return descendants;
      }

      // Unattached subagents: subagents whose root ancestor is NOT in humanChats
      const unattached = allSubagents.filter(s => {
        const root = getRootConversation(s);
        return !root || root.isSubagent || !humanChats.some(h => h.id === root.id);
      });

      // Handle search filtering
      let visibleHumans = humanChats;
      let visibleUnattached = unattached;

      if (q) {
        visibleHumans = humanChats.filter(h => {
          const hMatch = (h.title || '').toLowerCase().includes(q) || (h.id || '').toLowerCase().includes(q);
          const allDesc = getAllDescendants(h.id);
          const cMatch = allDesc.some(c => (c.agentName || '').toLowerCase().includes(q) || (c.agentRole || '').toLowerCase().includes(q) || (c.title || '').toLowerCase().includes(q) || (c.id || '').toLowerCase().includes(q));
          if (cMatch) expandedDrawers.add(h.id);
          return hMatch || cMatch;
        });

        visibleUnattached = unattached.filter(u => {
          const uMatch = (u.agentName || '').toLowerCase().includes(q) || (u.agentRole || '').toLowerCase().includes(q) || (u.title || '').toLowerCase().includes(q) || (u.id || '').toLowerCase().includes(q);
          const uDesc = getAllDescendants(u.id);
          const udMatch = uDesc.some(c => (c.agentName || '').toLowerCase().includes(q) || (c.agentRole || '').toLowerCase().includes(q) || (c.title || '').toLowerCase().includes(q) || (c.id || '').toLowerCase().includes(q));
          if (uMatch || udMatch) unattachedExpanded = true;
          return uMatch || udMatch;
        });
      }

      if (visibleHumans.length === 0 && visibleUnattached.length === 0) {
        container.innerHTML = '<div class="text-xs muted-color p-4 text-center">No sessions match search</div>';
        return;
      }

      function renderSubagentTree(subList, treeContainer) {
        subList.forEach(ch => {
          const allNested = getAllDescendants(ch.id);
          const hasChildren = allNested.length > 0;
          let collapseOpts = null;
          let nestedDiv = null;

          if (hasChildren) {
            if (q) {
              const anyChildMatches = allNested.some(c => 
                (c.agentName || '').toLowerCase().includes(q) || 
                (c.agentRole || '').toLowerCase().includes(q) || 
                (c.title || '').toLowerCase().includes(q) || 
                (c.id || '').toLowerCase().includes(q)
              );
              if (anyChildMatches) {
                collapsedSubagents.delete(ch.id);
              }
            }
            const isCollapsed = collapsedSubagents.has(ch.id);
            collapseOpts = {
              hasChildren: true,
              count: allNested.length,
              isCollapsed: isCollapsed,
              onToggle: () => {
                if (collapsedSubagents.has(ch.id)) {
                  collapsedSubagents.delete(ch.id);
                } else {
                  collapsedSubagents.add(ch.id);
                }
                const nowCollapsed = collapsedSubagents.has(ch.id);
                if (nestedDiv) nestedDiv.classList.toggle('hidden', nowCollapsed);
                const leftArrow = childRow.querySelector('.sub-toggle-arrow-left');
                if (leftArrow) {
                  leftArrow.textContent = nowCollapsed ? '▸' : '▾';
                  leftArrow.title = nowCollapsed ? 'Show child subagents' : 'Hide child subagents';
                }
                const pillArrow = childRow.querySelector('.sub-toggle-arrow');
                if (pillArrow) pillArrow.textContent = nowCollapsed ? '▸' : '▾';
                const pill = childRow.querySelector('.sub-toggle-pill');
                if (pill) pill.title = nowCollapsed ? 'Show child subagents' : 'Hide child subagents';
              }
            };
          }

          const childRow = createConvRow(ch, collapseOpts);
          treeContainer.appendChild(childRow);

          const nested = childrenMap.get(ch.id) || [];
          if (nested.length > 0) {
            const isCollapsed = collapsedSubagents.has(ch.id);
            nestedDiv = document.createElement('div');
            nestedDiv.className = 'space-y-1.5 ml-4 my-1 border-l-2 border-purple-500/25 pl-2.5' + (isCollapsed ? ' hidden' : '');
            renderSubagentTree(nested, nestedDiv);
            treeContainer.appendChild(nestedDiv);
          }
        });
      }

      visibleHumans.forEach(h => {
        const row = createConvRow(h, false);
        container.appendChild(row);

        const directChildren = childrenMap.get(h.id) || [];
        const allDescendants = getAllDescendants(h.id);
        if (allDescendants.length > 0) {
          const cTok = allDescendants.reduce((sum, ch) => sum + (ch.stats ? ch.stats.grandTotal : 0), 0);
          const cStorage = allDescendants.reduce((sum, ch) => sum + (parseFloat(ch.storageMB) || 0), 0).toFixed(1);
          const isExp = expandedDrawers.has(h.id);

          const drawerWrap = document.createElement('div');
          drawerWrap.className = 'mb-2';

          const toggle = document.createElement('div');
          toggle.className = 'drawer-toggle flex items-center justify-between px-3 py-1.5 ml-3 rounded-lg border border-color inner-bg/80 cursor-pointer hover:border-purple-500/40 text-xs transition-colors';
          toggle.innerHTML = 
            '<div class="flex items-center gap-1.5 text-purple-300 font-medium">' +
              '<span class="drawer-arrow text-[11px]">' + (isExp ? '▾' : '▸') + '</span>' +
              '<span class="inline-flex items-center gap-1 text-[9px] font-mono px-1.5 py-0.5 rounded bg-purple-500/25 text-purple-300 border border-purple-500/30"><svg class="w-2.5 h-2.5 text-purple-300 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>subagents</span>' +
              '<span>' + allDescendants.length + ' subagent' + (allDescendants.length > 1 ? 's' : '') + '</span>' +
              '<span class="muted-color font-mono">· ' + formatTok(cTok) + ' tok · ' + cStorage + ' MB</span>' +
            '</div>' +
            '<span class="text-[10px] muted-color">' + (isExp ? 'Hide' : 'Show') + '</span>';

          const childListDiv = document.createElement('div');
          childListDiv.className = 'space-y-1.5 ml-5 mt-1 border-l-2 border-purple-500/30 pl-2.5 ' + (isExp ? '' : 'hidden');

          renderSubagentTree(directChildren, childListDiv);

          toggle.onclick = (e) => {
            e.stopPropagation();
            if (expandedDrawers.has(h.id)) {
              expandedDrawers.delete(h.id);
            } else {
              expandedDrawers.add(h.id);
            }
            const nowExp = expandedDrawers.has(h.id);
            childListDiv.classList.toggle('hidden', !nowExp);
            const arrow = toggle.querySelector('.drawer-arrow');
            if (arrow) arrow.textContent = nowExp ? '▾' : '▸';
            const hint = toggle.querySelector('span:last-child');
            if (hint) hint.textContent = nowExp ? 'Hide' : 'Show';
          };

          drawerWrap.appendChild(toggle);
          drawerWrap.appendChild(childListDiv);
          container.appendChild(drawerWrap);
        }
      });

      if (visibleUnattached.length > 0) {
        const uTok = visibleUnattached.reduce((sum, ch) => sum + (ch.stats ? ch.stats.grandTotal : 0), 0);
        const uStorage = visibleUnattached.reduce((sum, ch) => sum + (parseFloat(ch.storageMB) || 0), 0).toFixed(1);

        const unWrap = document.createElement('div');
        unWrap.className = 'mt-3 mb-2';

        const unToggle = document.createElement('div');
        unToggle.className = 'unattached-toggle flex items-center justify-between px-3 py-2 rounded-lg border border-amber-500/30 bg-amber-500/10 cursor-pointer hover:bg-amber-500/15 text-xs transition-colors';
        unToggle.innerHTML = 
          '<div class="flex items-center gap-1.5 text-amber-300 font-medium">' +
            '<span class="unattached-arrow text-[11px]">' + (unattachedExpanded ? '▾' : '▸') + '</span>' +
            '<span class="inline-flex items-center gap-1 text-[9px] font-mono px-1.5 py-0.5 rounded bg-amber-500/25 text-amber-300 border border-amber-500/30"><svg class="w-2.5 h-2.5 text-amber-300 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>orphan</span>' +
            '<span>Unattached Subagents (' + visibleUnattached.length + ')</span>' +
            '<span class="muted-color font-mono">· ' + formatTok(uTok) + ' tok · ' + uStorage + ' MB</span>' +
          '</div>' +
          '<span class="text-[10px] muted-color">' + (unattachedExpanded ? 'Hide' : 'Show') + '</span>';

        const unListDiv = document.createElement('div');
        unListDiv.className = 'space-y-1.5 ml-3 mt-1 border-l-2 border-amber-500/30 pl-2.5 ' + (unattachedExpanded ? '' : 'hidden');

        const unattachedTopLevel = visibleUnattached.filter(u => !u.parentConversationId || !visibleUnattached.some(other => other.id === u.parentConversationId));
        renderSubagentTree(unattachedTopLevel, unListDiv);

        unToggle.onclick = (e) => {
          e.stopPropagation();
          unattachedExpanded = !unattachedExpanded;
          unListDiv.classList.toggle('hidden', !unattachedExpanded);
          const arrow = unToggle.querySelector('.unattached-arrow');
          if (arrow) arrow.textContent = unattachedExpanded ? '▾' : '▸';
          const hint = unToggle.querySelector('span:last-child');
          if (hint) hint.textContent = unattachedExpanded ? 'Hide' : 'Show';
        };

        unWrap.appendChild(unToggle);
        unWrap.appendChild(unListDiv);
        container.appendChild(unWrap);
      }
    }

    function filterList() {
      const wsList = getWorkspaceFilteredConversations();
      const heading = document.getElementById('listHeading');
      const subHeading = document.getElementById('listSubHeading');

      const humanCount = wsList.filter(c => !c.isSubagent).length;
      const subCount = wsList.filter(c => c.isSubagent).length;

      if (heading) {
        if (currentSubagentFilter === 'chats') {
          heading.textContent = 'Conversation History (' + humanCount + ' chats)';
        } else if (currentSubagentFilter === 'subagents') {
          heading.textContent = 'Subagent Sessions (' + subCount + ' subagents)';
        } else {
          heading.textContent = 'Conversation History (' + wsList.length + ' sessions)';
        }
      }
      if (subHeading) {
        const wsLabel = currentWorkspaceFilter === 'all'
          ? 'All Workspaces'
          : (currentWorkspaceFilter.startsWith('ws:') ? currentWorkspaceFilter.slice(3) : (currentWorkspaceName || 'Current Workspace'));
        subHeading.textContent = 'Showing: ' + wsLabel + ' · Click any session to view its telemetry';
      }

      const q = (document.getElementById('searchInput').value || '').toLowerCase().trim();
      renderList(wsList, q);
    }

    function formatTok(n) {
      if (!n || isNaN(n)) return '0';
      if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
      if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
      return String(n);
    }

    function promptDeleteCurrent() {
      if (selectedId) openDeleteModal(selectedId);
    }

    function openDeleteModal(id) {
      const conv = CONVERSATIONS.find(c => c.id === id);
      if (!conv) return;
      pendingDeleteId = id;

      document.getElementById('delModalTitle').textContent = conv.title || 'Untitled';
      document.getElementById('delModalSize').textContent = (conv.storageMB || '0.0') + ' MB';

      const actWarn = document.getElementById('delModalActiveWarning');
      if (conv.id === currentActiveId) {
        actWarn.classList.remove('hidden');
      } else {
        actWarn.classList.add('hidden');
      }

      document.getElementById('deleteModal').classList.remove('hidden');
    }

    function closeDeleteModal() {
      pendingDeleteId = null;
      document.getElementById('deleteModal').classList.add('hidden');
    }

    function confirmDeleteExec() {
      if (!pendingDeleteId) return;
      const conv = CONVERSATIONS.find(c => c.id === pendingDeleteId);
      const title = conv ? conv.title : pendingDeleteId;
      const idToDelete = pendingDeleteId;
      closeDeleteModal();

      vscode.postMessage({
        command: 'deleteConversation',
        conversationId: idToDelete,
        title: title
      });

      if (selectedId === idToDelete) {
        const next = CONVERSATIONS.find(c => c.id !== idToDelete);
        if (next) {
          selectedId = next.id;
        }
      }
      expandedDrawers.delete(idToDelete);
      collapsedSubagents.delete(idToDelete);
    }

    function getFileExtension(path) {
      if (!path) return '';
      const base = path.split(/[\\/]/).pop() || '';
      const parts = base.split('.');
      if (parts.length > 1) {
        return parts.pop().toLowerCase();
      }
      return '';
    }

    function getFileBadgeClass(ext) {
      switch (ext) {
        case 'js':
        case 'mjs':
        case 'cjs':
          return 'bg-yellow-500/15 text-yellow-300 border-yellow-500/30';
        case 'ts':
        case 'tsx':
        case 'jsx':
          return 'bg-blue-500/15 text-blue-300 border-blue-500/30';
        case 'py':
          return 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30';
        case 'json':
          return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
        case 'md':
        case 'txt':
          return 'bg-zinc-500/15 text-zinc-300 border-zinc-500/30';
        case 'html':
        case 'css':
        case 'scss':
          return 'bg-pink-500/15 text-pink-300 border-pink-500/30';
        case 'sql':
        case 'db':
          return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30';
        default:
          return 'bg-purple-500/15 text-purple-300 border-purple-500/30';
      }
    }

    function createFileItemHtml(filePath, isModified = false) {
      const base = escapeHtml(filePath.split(/[\\/]/).pop() || filePath);
      const ext = getFileExtension(filePath);
      const badgeCls = getFileBadgeClass(ext);
      const extBadge = ext ? ('<span class="text-[9px] px-1 py-0.2 rounded font-mono font-semibold uppercase border shrink-0 ' + badgeCls + '">' + escapeHtml(ext) + '</span>') : '';
      const nameCls = isModified ? 'text-emerald-300 font-semibold' : 'text-zinc-200';
      const borderHover = isModified ? 'hover:border-emerald-500/40' : 'hover:border-cyan-500/40';

      return '<div class="truncate p-1.5 inner-bg rounded-md border border-color ' + borderHover + ' flex items-center justify-between gap-1.5 transition-colors" title="' + escapeHtml(filePath) + '">' +
        '<div class="flex items-center gap-1.5 min-w-0 flex-1 truncate">' +
          extBadge +
          '<span class="truncate ' + nameCls + '">' + base + '</span>' +
        '</div>' +
        '<span class="text-[9px] muted-color font-sans shrink-0 truncate max-w-[45%] text-right">' + escapeHtml(filePath) + '</span>' +
      '</div>';
    }

    function renderDrawerFiles(query = '') {
      const conv = CONVERSATIONS.find(c => c.id === selectedId) || CONVERSATIONS[0];
      const act = (conv && conv.stats && conv.stats.activity) || {};
      const q = (query || '').toLowerCase().trim();

      const readListEl = document.getElementById('actDrawerReadList');
      const readCountEl = document.getElementById('actDrawerReadCount');
      const allRead = Array.isArray(act.filesRead) ? act.filesRead : [];
      const filteredRead = q ? allRead.filter(f => f.toLowerCase().includes(q)) : allRead;

      if (readCountEl) {
        readCountEl.textContent = q ? (filteredRead.length + ' / ' + (act.filesReadCount || allRead.length)) : (act.filesReadCount || allRead.length);
      }
      if (readListEl) {
        if (filteredRead.length > 0) {
          readListEl.innerHTML = filteredRead.map(f => createFileItemHtml(f, false)).join('');
        } else if (allRead.length > 0 && q) {
          readListEl.innerHTML = '<div class="muted-color italic text-[11px] p-2 text-center">No matching files for "' + escapeHtml(q) + '"</div>';
        } else if (act.filesReadCount > 0) {
          readListEl.innerHTML = '<div class="text-cyan-400 text-[11px] p-2 flex items-center gap-1.5 font-sans"><svg class="w-3.5 h-3.5 text-cyan-400 animate-spin shrink-0" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg><span>Loading ' + act.filesReadCount + ' files in memory...</span></div>';
        } else {
          readListEl.innerHTML = '<div class="muted-color italic text-[11px] p-2 text-center">No files read in memory</div>';
        }
      }

      const modListEl = document.getElementById('actDrawerModList');
      const modCountEl = document.getElementById('actDrawerModCount');
      const allMod = Array.isArray(act.filesModified) ? act.filesModified : [];
      const filteredMod = q ? allMod.filter(f => f.toLowerCase().includes(q)) : allMod;

      if (modCountEl) {
        modCountEl.textContent = q ? (filteredMod.length + ' / ' + (act.filesModifiedCount || allMod.length)) : (act.filesModifiedCount || allMod.length);
      }
      if (modListEl) {
        if (filteredMod.length > 0) {
          modListEl.innerHTML = filteredMod.map(f => createFileItemHtml(f, true)).join('');
        } else if (allMod.length > 0 && q) {
          modListEl.innerHTML = '<div class="muted-color italic text-[11px] p-2 text-center">No matching files for "' + escapeHtml(q) + '"</div>';
        } else if (act.filesModifiedCount > 0) {
          modListEl.innerHTML = '<div class="text-emerald-400 text-[11px] p-2 flex items-center gap-1.5 font-sans"><svg class="w-3.5 h-3.5 text-emerald-400 animate-spin shrink-0" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg><span>Loading ' + act.filesModifiedCount + ' modified files...</span></div>';
        } else {
          modListEl.innerHTML = '<div class="muted-color italic text-[11px] p-2 text-center">No files modified or created</div>';
        }
      }
    }

    function renderDetail() {
      const conv = CONVERSATIONS.find(c => c.id === selectedId) || CONVERSATIONS[0];
      if (!conv || !conv.stats) return;

      const s = conv.stats;
      const isSub = Boolean(conv.isSubagent);
      const subBadge = document.getElementById('subagentBadge');
      const agentVal = document.getElementById('chatAgentVal');
      const breadcrumb = document.getElementById('subagentBreadcrumb');

      if (isSub) {
        if (subBadge) {
          subBadge.classList.remove('hidden');
          if (agentVal) agentVal.textContent = conv.agentName || 'subagent';
        }
        const hasTitle = conv.title && conv.title !== '<original_task>' && conv.title !== 'Untitled Conversation' && conv.title !== 'Untitled' && conv.title.trim() !== conv.agentName;
        let headTitle = hasTitle ? conv.title.trim() : (conv.agentRole ? conv.agentRole.trim() : (conv.agentName || 'Subagent'));
        if (headTitle.length > 60) {
          headTitle = headTitle.slice(0, 58).trim() + '…';
        }
        document.getElementById('chatTitle').textContent = headTitle;
        document.getElementById('chatTitle').title = (hasTitle ? conv.title : (conv.agentRole || conv.agentName || '')) || '';

        if (breadcrumb) {
          breadcrumb.classList.remove('hidden');
          breadcrumb.innerHTML = '';

          // Build ancestor chain
          const ancestors = [];
          let curr = conv;
          const visited = new Set();
          while (curr && curr.parentConversationId && !visited.has(curr.id)) {
            visited.add(curr.id);
            const p = CONVERSATIONS.find(c => c.id === curr.parentConversationId);
            if (!p) {
              if (curr.parentTitle) {
                ancestors.unshift({ id: null, title: curr.parentTitle, missing: true });
              }
              break;
            }
            ancestors.unshift(p);
            curr = p;
          }

          if (ancestors.length > 0) {
            ancestors.forEach((anc, idx) => {
              if (idx > 0) {
                const sep = document.createElement('span');
                sep.className = 'muted-color text-[11px]';
                sep.textContent = ' → ';
                breadcrumb.appendChild(sep);
              }
              if (anc.missing) {
                const nameSpan = document.createElement('span');
                nameSpan.className = 'text-zinc-300 font-medium';
                nameSpan.textContent = anc.title;
                breadcrumb.appendChild(nameSpan);

                const note = document.createElement('span');
                note.className = 'text-[10px] muted-color';
                note.textContent = ' (session data no longer on disk)';
                breadcrumb.appendChild(note);
              } else {
                const link = document.createElement('a');
                link.className = 'text-blue-400 hover:underline cursor-pointer font-medium';
                const label = anc.isSubagent 
                  ? (anc.agentName ? '[' + anc.agentName + '] ' : '') + (anc.title || anc.agentRole || 'Subagent')
                  : (anc.title || 'Parent Chat');
                link.textContent = label;
                link.onclick = () => selectConv(anc.id);
                breadcrumb.appendChild(link);
              }
            });
          } else {
            const missing = document.createElement('span');
            missing.className = 'muted-color italic';
            missing.textContent = 'parent chat no longer available';
            breadcrumb.appendChild(missing);
          }
        }
      } else {
        if (subBadge) subBadge.classList.add('hidden');
        if (breadcrumb) breadcrumb.classList.add('hidden');
        document.getElementById('chatTitle').textContent = conv.title || 'Untitled Conversation';
        document.getElementById('chatTitle').title = '';
      }

      // Subagents & Background Workers Card
      function getDescendantsForConv(parentId) {
        const desc = [];
        const direct = CONVERSATIONS.filter(c => c.parentConversationId === parentId);
        for (const ch of direct) {
          desc.push(ch);
          desc.push(...getDescendantsForConv(ch.id));
        }
        return desc;
      }
      const directChildren = CONVERSATIONS.filter(c => c.parentConversationId === conv.id);
      const allDescendants = getDescendantsForConv(conv.id);
      const subCard = document.getElementById('subagentsCard');
      const subList = document.getElementById('subagentsList');
      const subCountBadge = document.getElementById('subagentsCountBadge');
      const subRolledUp = document.getElementById('subagentsRolledUpTotal');

      if (allDescendants.length > 0) {
        if (subCard) subCard.classList.remove('hidden');
        if (subCountBadge) subCountBadge.textContent = allDescendants.length + (allDescendants.length === 1 ? ' subagent' : ' subagents');

        let childTok = 0;
        if (subList) {
          subList.innerHTML = '';

          function renderDetailSubagentTree(subListItems, treeContainer) {
            subListItems.forEach(ch => {
              const cTok = ch.stats ? ch.stats.grandTotal : 0;
              childTok += cTok;

              const directSubs = CONVERSATIONS.filter(c => c.parentConversationId === ch.id);
              const allChildSubs = getDescendantsForConv(ch.id);
              const hasChildren = allChildSubs.length > 0;
              const isCollapsed = collapsedSubagents.has(ch.id);
              let nestedDiv = null;

              const row = document.createElement('div');
              row.className = 'p-2 inner-bg border border-color rounded-lg flex items-center justify-between gap-2 hover:border-blue-500/40 cursor-pointer transition-colors';
              row.onclick = () => selectConv(ch.id);

              let leftChevronHtml = '';
              let pillHtml = '';
              if (hasChildren) {
                const arrow = isCollapsed ? '▸' : '▾';
                leftChevronHtml = '<span class="detail-sub-toggle-arrow text-[11px] text-purple-300 font-bold select-none cursor-pointer hover:text-purple-200 shrink-0 mr-0.5" title="' + (isCollapsed ? 'Show child subagents' : 'Hide child subagents') + '">' + arrow + '</span>';
                pillHtml = 
                  '<button class="detail-sub-toggle-pill flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono font-medium border bg-purple-500/15 text-purple-300 border-purple-500/30 hover:bg-purple-500/25 cursor-pointer shrink-0" title="' + (isCollapsed ? 'Show child subagents' : 'Hide child subagents') + '">' +
                    '<span class="detail-sub-arrow text-[10px]">' + arrow + '</span>' +
                    '<span>' + allChildSubs.length + ' subagent' + (allChildSubs.length > 1 ? 's' : '') + '</span>' +
                  '</button>';
              }

              const left = document.createElement('div');
              left.className = 'flex items-center gap-2 min-w-0';
              const hasTask = ch.title && ch.title !== '<original_task>' && ch.title !== 'Untitled Conversation' && ch.title !== 'Untitled' && ch.title.trim() !== ch.agentName;
              let displayTask = hasTask ? ch.title.trim() : (ch.agentRole ? ch.agentRole.trim() : (ch.agentName || ch.id.slice(0, 8)));
              if (displayTask.length > 36) displayTask = displayTask.slice(0, 34).trim() + '…';
              left.innerHTML = 
                leftChevronHtml +
                '<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold bg-purple-500/20 text-purple-300 border border-purple-500/30 shrink-0"><svg class="w-2.5 h-2.5 text-purple-300 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>' + escapeHtml(ch.agentName || 'subagent') + '</span>' +
                '<span class="text-xs text-[var(--vscode-editor-foreground,#f4f4f5)] font-medium truncate" title="' + escapeHtml(ch.title || '') + '">' + escapeHtml(displayTask) + '</span>' +
                '<span class="text-[10px] muted-color font-mono shrink-0">(' + escapeHtml(ch.id.slice(0, 8)) + ')</span>';

              const right = document.createElement('div');
              right.className = 'flex items-center gap-2.5 shrink-0 text-xs font-mono';
              right.innerHTML = 
                pillHtml +
                '<span class="text-zinc-400 text-[11px]">' + (ch.storageMB || '0.0') + ' MB</span>' +
                '<span class="text-emerald-400 font-semibold">' + formatTok(cTok) + ' tok</span>' +
                '<span class="text-[10px] muted-color">(' + (ch.stats ? ch.stats.calls : 0) + ' calls)</span>' +
                '<span class="text-blue-400 text-[11px]">Inspect →</span>';

              if (hasChildren) {
                const toggleChild = () => {
                  if (collapsedSubagents.has(ch.id)) {
                    collapsedSubagents.delete(ch.id);
                  } else {
                    collapsedSubagents.add(ch.id);
                  }
                  const nowCol = collapsedSubagents.has(ch.id);
                  if (nestedDiv) nestedDiv.classList.toggle('hidden', nowCol);
                  const arr = left.querySelector('.detail-sub-toggle-arrow');
                  if (arr) {
                    arr.textContent = nowCol ? '▸' : '▾';
                    arr.title = nowCol ? 'Show child subagents' : 'Hide child subagents';
                  }
                  const pillArr = right.querySelector('.detail-sub-arrow');
                  if (pillArr) pillArr.textContent = nowCol ? '▸' : '▾';
                  const pillBtn = right.querySelector('.detail-sub-toggle-pill');
                  if (pillBtn) pillBtn.title = nowCol ? 'Show child subagents' : 'Hide child subagents';
                };
                const pillBtn = right.querySelector('.detail-sub-toggle-pill');
                if (pillBtn) {
                  pillBtn.onclick = (e) => {
                    e.stopPropagation();
                    toggleChild();
                  };
                }
                const arrowEl = left.querySelector('.detail-sub-toggle-arrow');
                if (arrowEl) {
                  arrowEl.onclick = (e) => {
                    e.stopPropagation();
                    toggleChild();
                  };
                }
              }

              row.appendChild(left);
              row.appendChild(right);
              treeContainer.appendChild(row);

              if (directSubs.length > 0) {
                nestedDiv = document.createElement('div');
                nestedDiv.className = 'space-y-1.5 ml-4 my-1 border-l-2 border-purple-500/25 pl-2.5' + (isCollapsed ? ' hidden' : '');
                renderDetailSubagentTree(directSubs, nestedDiv);
                treeContainer.appendChild(nestedDiv);
              }
            });
          }

          renderDetailSubagentTree(directChildren, subList);
        }

        const parentTok = s.grandTotal || 0;
        const rolledTok = parentTok + childTok;
        if (subRolledUp) {
          subRolledUp.innerHTML = 
            '<span class="muted-color">Parent (' + formatTok(parentTok) + ') + Subagents (' + formatTok(childTok) + ') = </span>' +
            '<span class="text-emerald-400 font-bold">' + formatTok(rolledTok) + ' total</span>';
        }
        updateSubagentsCollapseState();
      } else {
        if (subCard) subCard.classList.add('hidden');
      }

      document.getElementById('chatBadge').textContent = s.modelName || 'gemini-3.8-flash';
      document.getElementById('chatMeta').textContent = 'ID: ' + conv.id + ' · Active: ' + (conv.lastModified ? new Date(conv.lastModified).toLocaleDateString() : 'Recent');
      document.getElementById('grandTotalText').textContent = s.grandTotal.toLocaleString();

      if (conv.id === currentActiveId) {
        document.getElementById('activePill').classList.remove('hidden');
      } else {
        document.getElementById('activePill').classList.add('hidden');
      }

      const srcBadge = document.getElementById('sourceBadgeDetail');
      const hasMultipleSources = new Set(CONVERSATIONS.map(x => x.source).filter(Boolean)).size > 1;
      if (srcBadge) {
        if (hasMultipleSources && conv.source) {
          srcBadge.classList.remove('hidden');
          if (conv.source === 'cli') {
            srcBadge.innerHTML = '<svg class="w-2.5 h-2.5 text-emerald-300 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg><span>CLI</span>';
            srcBadge.className = 'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold shrink-0 bg-emerald-500/20 text-emerald-300 border border-emerald-500/30';
            srcBadge.title = 'Source: Antigravity CLI';
          } else if (conv.source === 'ide') {
            srcBadge.innerHTML = '<svg class="w-2.5 h-2.5 text-cyan-300 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2H4V5zm0 4h16v10a1 1 0 01-1 1H5a1 1 0 01-1-1V9z"/></svg><span>IDE</span>';
            srcBadge.className = 'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold shrink-0 bg-cyan-500/20 text-cyan-300 border border-cyan-500/30';
            srcBadge.title = 'Source: Antigravity IDE';
          } else {
            srcBadge.innerHTML = '<svg class="w-2.5 h-2.5 text-amber-300 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M11 4a2 2 0 114 0v1a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-1a2 2 0 100 4h1a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-1a2 2 0 10-4 0v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-3a1 1 0 00-1-1H4a2 2 0 110-4h1a1 1 0 001-1V7a1 1 0 011-1h3a1 1 0 001-1V4z"/></svg><span>Ext</span>';
            srcBadge.className = 'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold shrink-0 bg-amber-500/20 text-amber-300 border border-amber-500/30';
            srcBadge.title = 'Source: Antigravity Extension';
          }
        } else {
          srcBadge.classList.add('hidden');
        }
      }

      const wsBadge = document.getElementById('workspaceBadge');
      const wsVal = document.getElementById('chatWorkspaceVal');
      if (wsBadge && wsVal) {
        if (conv.workspaceName) {
          wsBadge.classList.remove('hidden');
          wsVal.textContent = conv.workspaceName;
        } else {
          wsBadge.classList.add('hidden');
        }
      }
      const diskEl = document.getElementById('chatDiskVal');
      if (diskEl) diskEl.textContent = (conv.storageMB || '0.0') + ' MB';

      // 4 Top KPI Cards
      const tot = s.grandTotal || 1;
      const contextLimit = s.contextLimit || 256000;
      const lastContext = (s.contextTokens != null ? s.contextTokens : s.currentContext) || (s.contextTimeline && s.contextTimeline.length > 0 ? s.contextTimeline[s.contextTimeline.length - 1].input : s.peakContext);
      const contextPct = Math.min(100, Math.round((lastContext / contextLimit) * 100));
      const headroom = Math.max(0, contextLimit - lastContext);

      // Card 1: Context Window
      document.getElementById('kpiContext').textContent = formatTok(lastContext) + ' / ' + formatTok(contextLimit);
      document.getElementById('kpiContextSub').textContent = contextPct + '% Fill (' + formatTok(headroom) + ' left)';

      // Card 2: Cache Read
      document.getElementById('kpiCacheRead').textContent = formatTok(s.totalCached);
      document.getElementById('kpiCacheReadSub').textContent = s.cacheVolumeRate + '% vol · ' + s.cacheHits + ' hits (' + s.cacheHitRate + '%)';

      // Card 3: Cache Write
      const avgWrite = s.calls > 0 ? Math.round(s.totalNonCached / s.calls) : 0;
      const writeRate = tot > 0 ? ((s.totalNonCached / (s.totalInput || 1)) * 100).toFixed(1) : '0.0';
      document.getElementById('kpiCacheWrite').textContent = formatTok(s.totalNonCached);
      document.getElementById('kpiCacheWriteSub').textContent = writeRate + '% vol · +' + formatTok(avgWrite) + ' avg / turn';

      // Card 4: Model Output
      document.getElementById('kpiOutput').textContent = formatTok(s.totalOutput);
      document.getElementById('kpiOutputSub').textContent = 'Avg ' + (s.avgOutput || 0).toLocaleString() + ' tok / call · ' + (s.thinkingRate || '0.0') + '% think';

      // Token Composition 3-part Progress Bar & Legend
      const pctRead = (((s.totalCached || 0) / tot) * 100).toFixed(1);
      const pctWrite = (((s.totalNonCached || 0) / tot) * 100).toFixed(1);
      const pctOut = (((s.totalOutput || 0) / tot) * 100).toFixed(1);

      document.getElementById('barCacheRead').style.width = pctRead + '%';
      document.getElementById('barCacheWrite').style.width = pctWrite + '%';
      document.getElementById('barOutput').style.width = pctOut + '%';

      document.getElementById('legCacheRead').textContent = (s.totalCached || 0).toLocaleString() + ' tok';
      document.getElementById('legCacheReadPct').textContent = pctRead + '%';

      document.getElementById('legCacheWrite').textContent = (s.totalNonCached || 0).toLocaleString() + ' tok';
      document.getElementById('legCacheWritePct').textContent = pctWrite + '%';

      document.getElementById('legOutput').textContent = (s.totalOutput || 0).toLocaleString() + ' tok';
      document.getElementById('legOutputPct').textContent = pctOut + '%';

      // Session Operations & Context Health (Issue #3 /context metrics)
      const act = s.activity || {
        userPrompts: 0,
        assistantResponses: s.calls || 0,
        executedCommands: 0,
        filesReadCount: 0,
        filesRead: [],
        filesModifiedCount: 0,
        filesModified: [],
        subagentsInvoked: 0,
        webRequests: 0,
        analyzedImages: 0,
        totalToolCalls: 0
      };

      const replies = act.assistantResponses || s.calls || 0;
      const prompts = act.userPrompts || 0;
      const autonomy = prompts > 0 ? (replies / prompts).toFixed(1) : (replies > 0 ? replies.toFixed(1) : '1.0');

      const repliesEl = document.getElementById('actAssistantReplies');
      if (repliesEl) repliesEl.textContent = replies.toLocaleString();
      const promptsSubEl = document.getElementById('actUserPromptsSub');
      if (promptsSubEl) {
        promptsSubEl.textContent = prompts + ' prompt' + (prompts === 1 ? '' : 's') + ' · ' + autonomy + ' turns/prompt';
        promptsSubEl.title = prompts + ' user prompts · ' + autonomy + ' agent turns per prompt (autonomy ratio)';
      }

      const filesReadEl = document.getElementById('actFilesRead');
      if (filesReadEl) filesReadEl.textContent = (act.filesReadCount || 0).toLocaleString();
      const filesModSubEl = document.getElementById('actFilesModifiedSub');
      if (filesModSubEl) filesModSubEl.textContent = (act.filesModifiedCount || 0) + ' modified / created';

      const commandsEl = document.getElementById('actCommands');
      if (commandsEl) commandsEl.textContent = (act.executedCommands || 0).toLocaleString();
      const toolsSubEl = document.getElementById('actTotalToolsSub');
      if (toolsSubEl) toolsSubEl.textContent = (act.totalToolCalls || 0).toLocaleString() + ' total tool actions';

      const imagesCount = act.analyzedImages || 0;
      const imagesEl = document.getElementById('actImages');
      if (imagesEl) imagesEl.textContent = imagesCount.toLocaleString();
      const subsWebSubEl = document.getElementById('actSubagentsWebSub');
      if (subsWebSubEl) {
        subsWebSubEl.textContent = imagesCount === 1 ? '1 capture processed' : imagesCount + ' captures processed';
        subsWebSubEl.title = imagesCount + ' multimodal image captures processed' + (act.subagentsInvoked > 0 || act.webRequests > 0 ? ' (' + act.subagentsInvoked + ' subagents, ' + act.webRequests + ' web calls)' : '');
      }

      const badgeCountEl = document.getElementById('actFilesBadgeCount');
      if (badgeCountEl) badgeCountEl.textContent = (act.filesReadCount || 0) + ' read · ' + (act.filesModifiedCount || 0) + ' mod';

      // Context Health & Allocation Calculations
      const usedTokens = lastContext || 0;
      const ceilingTokens = contextLimit || 256000;
      const freeTokens = Math.max(0, ceilingTokens - usedTokens);
      const usedPct = ceilingTokens > 0 ? ((usedTokens / ceilingTokens) * 100).toFixed(1) : '0.0';
      const freePct = ceilingTokens > 0 ? ((freeTokens / ceilingTokens) * 100).toFixed(1) : '100.0';

      const healthPctEl = document.getElementById('contextHealthPct');
      if (healthPctEl) healthPctEl.textContent = usedPct + '%';

      const healthCeilEl = document.getElementById('contextHealthCeiling');
      if (healthCeilEl) healthCeilEl.textContent = formatTok(ceilingTokens) + ' limit';

      const healthUsedEl = document.getElementById('contextHealthUsed');
      if (healthUsedEl) healthUsedEl.textContent = usedTokens.toLocaleString();

      const healthFreeEl = document.getElementById('contextHealthFree');
      if (healthFreeEl) healthFreeEl.textContent = freeTokens.toLocaleString();

      const healthMeterEl = document.getElementById('contextHealthMeter');
      const healthBadgeEl = document.getElementById('contextHealthStatusBadge');

      const usedNum = parseFloat(usedPct) || 0;
      if (usedNum >= 85) {
        if (healthBadgeEl) {
          healthBadgeEl.textContent = 'Compaction Alert';
          healthBadgeEl.className = 'px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wide uppercase bg-rose-500/20 text-rose-300 border border-rose-500/30';
        }
        if (healthPctEl) healthPctEl.className = 'font-mono font-bold text-rose-400';
        if (healthMeterEl) {
          healthMeterEl.className = 'h-3 w-full bg-zinc-900 rounded-full overflow-hidden flex border border-rose-500/70 shadow-[0_0_8px_rgba(244,63,94,0.3)] relative transition-all duration-300';
          healthMeterEl.title = 'Context Allocation: ' + usedPct + '% used (Compaction Alert)';
        }
      } else if (usedNum >= 60) {
        if (healthBadgeEl) {
          healthBadgeEl.textContent = 'Moderate Load';
          healthBadgeEl.className = 'px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wide uppercase bg-amber-500/20 text-amber-300 border border-amber-500/30';
        }
        if (healthPctEl) healthPctEl.className = 'font-mono font-bold text-amber-400';
        if (healthMeterEl) {
          healthMeterEl.className = 'h-3 w-full bg-zinc-900 rounded-full overflow-hidden flex border border-amber-500/60 relative transition-all duration-300';
          healthMeterEl.title = 'Context Allocation: ' + usedPct + '% used (Moderate Load)';
        }
      } else {
        if (healthBadgeEl) {
          healthBadgeEl.textContent = 'Optimal';
          healthBadgeEl.className = 'px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wide uppercase bg-emerald-500/20 text-emerald-300 border border-emerald-500/30';
        }
        if (healthPctEl) healthPctEl.className = 'font-mono font-bold text-emerald-400';
        if (healthMeterEl) {
          healthMeterEl.className = 'h-3 w-full bg-zinc-900 rounded-full overflow-hidden flex border border-color/80 relative transition-all duration-300';
          healthMeterEl.title = 'Context Allocation: ' + usedPct + '% used (Optimal)';
        }
      }

      // Proportional Token Component Footprints
      let imgTok = (act.analyzedImages || 0) * 1600;
      let cmdTok = (act.executedCommands || 0) * 250;
      let repliesTok = (s.lastTurn ? s.lastTurn.output : s.avgOutput) || (act.assistantResponses * 300) || 0;
      let promptsTok = (act.userPrompts || 0) * 200;
      let filesTok = 0;

      if (usedTokens > 0) {
        if (act.filesReadCount > 0) {
          const rawNonFiles = imgTok + cmdTok + repliesTok + promptsTok;
          if (rawNonFiles < usedTokens) {
            filesTok = usedTokens - rawNonFiles;
          } else {
            filesTok = Math.round(usedTokens * 0.45);
            const remaining = usedTokens - filesTok;
            const factor = rawNonFiles > 0 ? (remaining / rawNonFiles) : 0;
            imgTok = Math.round(imgTok * factor);
            cmdTok = Math.round(cmdTok * factor);
            repliesTok = Math.round(repliesTok * factor);
            promptsTok = Math.max(0, usedTokens - filesTok - imgTok - cmdTok - repliesTok);
          }
        } else {
          filesTok = 0;
          const rawNonFiles = imgTok + cmdTok + repliesTok + promptsTok;
          if (rawNonFiles > 0 && rawNonFiles !== usedTokens) {
            const factor = usedTokens / rawNonFiles;
            imgTok = Math.round(imgTok * factor);
            cmdTok = Math.round(cmdTok * factor);
            repliesTok = Math.round(repliesTok * factor);
            promptsTok = Math.max(0, usedTokens - imgTok - cmdTok - repliesTok);
          }
        }
      } else {
        imgTok = 0;
        cmdTok = 0;
        repliesTok = 0;
        promptsTok = 0;
        filesTok = 0;
      }

      const promptsCeilPct = ceilingTokens > 0 ? ((promptsTok / ceilingTokens) * 100).toFixed(1) : '0.0';
      const repliesCeilPct = ceilingTokens > 0 ? ((repliesTok / ceilingTokens) * 100).toFixed(1) : '0.0';
      const filesCeilPct = ceilingTokens > 0 ? ((filesTok / ceilingTokens) * 100).toFixed(1) : '0.0';
      const cmdCeilPct = ceilingTokens > 0 ? ((cmdTok / ceilingTokens) * 100).toFixed(1) : '0.0';
      const imgCeilPct = ceilingTokens > 0 ? ((imgTok / ceilingTokens) * 100).toFixed(1) : '0.0';

      const promptsCtxPct = usedTokens > 0 ? ((promptsTok / usedTokens) * 100).toFixed(1) : '0.0';
      const repliesCtxPct = usedTokens > 0 ? ((repliesTok / usedTokens) * 100).toFixed(1) : '0.0';
      const filesCtxPct = usedTokens > 0 ? ((filesTok / usedTokens) * 100).toFixed(1) : '0.0';
      const cmdCtxPct = usedTokens > 0 ? ((cmdTok / usedTokens) * 100).toFixed(1) : '0.0';
      const imgCtxPct = usedTokens > 0 ? ((imgTok / usedTokens) * 100).toFixed(1) : '0.0';

      // Segmented Allocation Bar
      const segPrompts = document.getElementById('segPrompts');
      if (segPrompts) {
        segPrompts.style.width = promptsCeilPct + '%';
        segPrompts.title = 'User Prompts: ~' + promptsTok.toLocaleString() + ' tok (' + promptsCeilPct + '% of ceiling)';
      }
      const segReplies = document.getElementById('segReplies');
      if (segReplies) {
        segReplies.style.width = repliesCeilPct + '%';
        segReplies.title = 'Assistant Responses: ~' + repliesTok.toLocaleString() + ' tok (' + repliesCeilPct + '% of ceiling)';
      }
      const segFiles = document.getElementById('segFiles');
      if (segFiles) {
        segFiles.style.width = filesCeilPct + '%';
        segFiles.title = 'Codebase Files: ~' + filesTok.toLocaleString() + ' tok (' + filesCeilPct + '% of ceiling)';
      }
      const segCommands = document.getElementById('segCommands');
      if (segCommands) {
        segCommands.style.width = cmdCeilPct + '%';
        segCommands.title = 'Executed Commands: ~' + cmdTok.toLocaleString() + ' tok (' + cmdCeilPct + '% of ceiling)';
      }
      const segImages = document.getElementById('segImages');
      if (segImages) {
        segImages.style.width = imgCeilPct + '%';
        segImages.title = 'Analyzed Images: ~' + imgTok.toLocaleString() + ' tok (' + imgCeilPct + '% of ceiling)';
      }
      const segFree = document.getElementById('segFree');
      if (segFree) {
        segFree.style.width = freePct + '%';
        segFree.title = 'Available Headroom: ' + freeTokens.toLocaleString() + ' tok (' + freePct + '% free)';
      }

      // Micro-Legend Labels
      const segPromptsVal = document.getElementById('segPromptsVal');
      if (segPromptsVal) segPromptsVal.textContent = promptsCtxPct + '%';
      const segRepliesVal = document.getElementById('segRepliesVal');
      if (segRepliesVal) segRepliesVal.textContent = repliesCtxPct + '%';
      const segFilesVal = document.getElementById('segFilesVal');
      if (segFilesVal) segFilesVal.textContent = filesCtxPct + '%';
      const segCommandsVal = document.getElementById('segCommandsVal');
      if (segCommandsVal) segCommandsVal.textContent = cmdCtxPct + '%';
      const segImagesVal = document.getElementById('segImagesVal');
      if (segImagesVal) segImagesVal.textContent = imgCtxPct + '%';
      const segFreeVal = document.getElementById('segFreeVal');
      if (segFreeVal) segFreeVal.textContent = freePct + '%';

      // Card Footprint Pills
      const actRepliesFootprint = document.getElementById('actRepliesFootprint');
      if (actRepliesFootprint) actRepliesFootprint.textContent = '~' + formatTok(repliesTok) + ' tok (' + repliesCtxPct + '%)';
      const actFilesFootprint = document.getElementById('actFilesFootprint');
      if (actFilesFootprint) actFilesFootprint.textContent = '~' + formatTok(filesTok) + ' tok (' + filesCtxPct + '%)';
      const actCommandsFootprint = document.getElementById('actCommandsFootprint');
      if (actCommandsFootprint) actCommandsFootprint.textContent = '~' + formatTok(cmdTok) + ' tok (' + cmdCtxPct + '%)';
      const actImagesFootprint = document.getElementById('actImagesFootprint');
      if (actImagesFootprint) actImagesFootprint.textContent = '~' + formatTok(imgTok) + ' tok (' + imgCtxPct + '%)';

      // Populate file lists in drawer with search filter & badges
      renderDrawerFiles(fileFilterQuery);
      updateActivityFilesState();

      // Streamlined Turn & Cache Intelligence
      // Card 1: Last Turn Activity
      const lt = s.lastTurn;
      if (lt) {
        const ltNumEl = document.getElementById('metaLastTurnNum');
        if (ltNumEl) ltNumEl.textContent = 'Turn #' + lt.turn;
        const ltCtxEl = document.getElementById('metaLastContext');
        if (ltCtxEl) ltCtxEl.textContent = formatTok(lt.context != null ? lt.context : lt.totalInput) + ' tok';
        const ltFreshEl = document.getElementById('metaLastFresh');
        if (ltFreshEl) ltFreshEl.textContent = '+' + formatTok(lt.fresh) + ' fresh';
        const ltOutEl = document.getElementById('metaLastOutput');
        if (ltOutEl) ltOutEl.textContent = lt.output.toLocaleString() + ' tok (' + lt.thinking.toLocaleString() + ' thk)';
        const ltCompEl = document.getElementById('metaLastCompaction');
        if (ltCompEl) {
          if (lt.isCompacted) {
            ltCompEl.innerHTML = '<span class="text-red-400 font-bold">Compacted (-' + formatTok(lt.compactedAmount) + ')</span>';
          } else {
            ltCompEl.innerHTML = '<span class="text-emerald-400 font-medium">Normal</span>';
          }
        }
      } else {
        const ltNumEl = document.getElementById('metaLastTurnNum');
        if (ltNumEl) ltNumEl.textContent = 'Turn #--';
        const ltCtxEl = document.getElementById('metaLastContext');
        if (ltCtxEl) ltCtxEl.textContent = '0 tok';
        const ltFreshEl = document.getElementById('metaLastFresh');
        if (ltFreshEl) ltFreshEl.textContent = '+0 fresh';
        const ltOutEl = document.getElementById('metaLastOutput');
        if (ltOutEl) ltOutEl.textContent = '0 tok';
        const ltCompEl = document.getElementById('metaLastCompaction');
        if (ltCompEl) ltCompEl.textContent = 'Normal';
      }

      // Card 2: Trajectory Dynamics & Net Growth
      const netGrowth = usedTokens - (s.minContext || 0);
      const netPill = document.getElementById('metaTrajectoryNetPill');
      if (netPill) {
        const sign = netGrowth >= 0 ? '+' : '';
        netPill.textContent = sign + formatTok(netGrowth) + ' tok net';
        netPill.className = netGrowth >= 0
          ? 'text-[9px] px-1.5 py-0.2 rounded font-mono font-medium bg-blue-500/15 text-blue-300 border border-blue-500/30'
          : 'text-[9px] px-1.5 py-0.2 rounded font-mono font-medium bg-emerald-500/15 text-emerald-300 border border-emerald-500/30';
      }
      const peakPct = Math.min(100, Math.round(((s.peakContext || 0) / ceilingTokens) * 100));
      const peakCtxEl = document.getElementById('metaPeakContext');
      if (peakCtxEl) peakCtxEl.textContent = formatTok(s.peakContext) + ' (' + peakPct + '%)';
      const minCtxEl = document.getElementById('metaMinContext');
      if (minCtxEl) minCtxEl.textContent = formatTok(s.minContext) + ' tok';
      const avgCtxEl = document.getElementById('metaAvgContext');
      if (avgCtxEl) avgCtxEl.textContent = formatTok(s.avgContext) + ' tok';
      const compEventsEl = document.getElementById('metaCompactions');
      if (compEventsEl) compEventsEl.textContent = (s.compactionsCount || 0) + ' events';

      // Card 3: Cache Acceleration
      const hitRateNum = parseFloat(s.cacheHitRate) || 0;
      const speedup = hitRateNum > 0 ? (1 / Math.max(0.05, (1 - (hitRateNum / 100) * 0.85))).toFixed(1) : '1.0';
      const speedupPill = document.getElementById('metaCacheSpeedupPill');
      if (speedupPill) speedupPill.textContent = '~' + speedup + 'x faster';

      const cacheCallsEl = document.getElementById('metaCacheCalls');
      if (cacheCallsEl) cacheCallsEl.textContent = s.cacheHits + ' / ' + s.calls + ' Hits (' + s.cacheHitRate + '%)';
      const cacheMissesEl = document.getElementById('metaCacheMisses');
      if (cacheMissesEl) cacheMissesEl.textContent = s.cacheMisses + ' misses';
      const avgCachedEl = document.getElementById('metaAvgCached');
      if (avgCachedEl) avgCachedEl.textContent = formatTok(s.avgCached) + ' tok avg';

      const limitLabel = formatTok(ceilingTokens);
      const ceilEl = document.getElementById('metaCeilingLimit');
      if (ceilEl) ceilEl.textContent = limitLabel + ' limit';
      const chartCeilLeg = document.getElementById('chartCeilingLegend');
      if (chartCeilLeg) chartCeilLeg.textContent = limitLabel + ' Limit';

      currentTimeline = s.contextTimeline || [];
      renderChart(currentTimeline);
    }

    function toggleSubagentsCollapse() {
      subagentsCardCollapsed = !subagentsCardCollapsed;
      updateSubagentsCollapseState();
    }

    function updateSubagentsCollapseState() {
      const list = document.getElementById('subagentsList');
      const chevron = document.getElementById('subagentsChevron');
      const label = document.getElementById('subagentsToggleLabel');
      if (!list) return;
      if (subagentsCardCollapsed) {
        list.classList.add('hidden');
        if (chevron) chevron.textContent = '▶';
        if (label) label.textContent = 'Expand';
      } else {
        list.classList.remove('hidden');
        if (chevron) chevron.textContent = '▼';
        if (label) label.textContent = 'Collapse';
      }
    }

    function toggleActivityFiles() {
      activityFilesOpen = !activityFilesOpen;
      updateActivityFilesState();
    }

    function updateActivityFilesState() {
      const drawer = document.getElementById('actFilesDrawer');
      const chevron = document.getElementById('actFilesChevron');
      if (!drawer) return;
      if (activityFilesOpen) {
        drawer.classList.remove('hidden');
        if (chevron) chevron.textContent = '▲';
      } else {
        drawer.classList.add('hidden');
        if (chevron) chevron.textContent = '▼';
      }
    }

    let lastRenderedChartId = null;
    let lastRenderedTimelineLen = 0;
    let lastRenderedLastInput = null;

    function renderChart(timeline, forceRedraw = false) {
      const svg = document.getElementById('timelineSvg');
      const tooltip = document.getElementById('chartTooltip');
      const loadingOverlay = document.getElementById('chartLoadingOverlay');
      const emptyState = document.getElementById('chartEmptyState');
      const countEl = document.getElementById('chartPointsCount');
      const conv = CONVERSATIONS.find(c => c.id === selectedId);
      const calls = (conv && conv.stats && conv.stats.calls) || 0;

      if (!timeline || timeline.length === 0) {
        if (svg) svg.innerHTML = '';
        if (tooltip) tooltip.classList.add('hidden');
        lastRenderedChartId = null;
        lastRenderedTimelineLen = 0;
        lastRenderedLastInput = null;

        if (isLoadingTimeline || calls > 0) {
          if (loadingOverlay) {
            loadingOverlay.classList.remove('hidden');
            const txt = document.getElementById('chartLoadingText');
            if (txt) txt.textContent = 'Loading trajectory timeline (' + calls + ' turn' + (calls === 1 ? '' : 's') + ')...';
          }
          if (emptyState) emptyState.classList.add('hidden');
          if (countEl) {
            countEl.textContent = 'Loading turns...';
            countEl.className = 'text-[10px] px-2 py-0.5 rounded inner-bg border border-blue-500/30 text-blue-400 font-semibold animate-pulse';
          }
        } else {
          if (loadingOverlay) loadingOverlay.classList.add('hidden');
          if (emptyState) emptyState.classList.remove('hidden');
          if (countEl) {
            countEl.textContent = '0 points';
            countEl.className = 'text-[10px] px-2 py-0.5 rounded inner-bg border border-color muted-color';
          }
        }
        return;
      }

      if (loadingOverlay) loadingOverlay.classList.add('hidden');
      if (emptyState) emptyState.classList.add('hidden');
      if (countEl) {
        countEl.textContent = timeline.length + (timeline.length === 1 ? ' point' : ' points');
        countEl.className = 'text-[10px] px-2 py-0.5 rounded inner-bg border border-color muted-color';
      }

      const lastPoint = timeline[timeline.length - 1];
      const lastInput = lastPoint ? lastPoint.input : null;
      if (!forceRedraw && lastRenderedChartId === selectedId && lastRenderedTimelineLen === timeline.length && lastRenderedLastInput === lastInput) {
        // Timeline has not changed; skip clearing SVG to prevent tooltip and tracker fluctuation
        return;
      }
      lastRenderedChartId = selectedId;
      lastRenderedTimelineLen = timeline.length;
      lastRenderedLastInput = lastInput;

      if (svg) svg.innerHTML = '';
      if (tooltip) tooltip.classList.add('hidden');

      const w = svg.clientWidth || 500;
      const h = svg.clientHeight || 170;
      const padTop = 22;
      const padBottom = 16;
      const padLeft = 14;
      const padRight = 14;
      const chartW = w - padLeft - padRight;
      const chartH = h - padTop - padBottom;

      // Compaction ceiling calibrated to 256,000 tokens (or conversation limit)
      const ceilingTokens = (conv && conv.stats && conv.stats.contextLimit) || 256000;
      const maxDataTokens = Math.max(...timeline.map(t => Math.max(t.input || 0, t.cached || 0))) || 1;
      const maxVal = Math.max(ceilingTokens, maxDataTokens * 1.05);

      // SVG Defs for Gradients
      const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
      defs.innerHTML = 
        '<linearGradient id="blueGrad" x1="0%" y1="0%" x2="0%" y2="100%">' +
          '<stop offset="0%" stop-color="#3b82f6" stop-opacity="0.32" />' +
          '<stop offset="100%" stop-color="#3b82f6" stop-opacity="0.02" />' +
        '</linearGradient>' +
        '<linearGradient id="emeraldGrad" x1="0%" y1="0%" x2="0%" y2="100%">' +
          '<stop offset="0%" stop-color="#10b981" stop-opacity="0.28" />' +
          '<stop offset="100%" stop-color="#10b981" stop-opacity="0.02" />' +
        '</linearGradient>';
      svg.appendChild(defs);

      // Compaction Limit Dashed Guideline
      const ceilingY = padTop + chartH - (ceilingTokens / maxVal) * chartH;
      if (ceilingY >= padTop && ceilingY <= padTop + chartH) {
        const ceilingLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        ceilingLine.setAttribute('x1', padLeft);
        ceilingLine.setAttribute('x2', w - padRight);
        ceilingLine.setAttribute('y1', ceilingY);
        ceilingLine.setAttribute('y2', ceilingY);
        ceilingLine.setAttribute('stroke', '#ef4444');
        ceilingLine.setAttribute('stroke-opacity', '0.55');
        ceilingLine.setAttribute('stroke-dasharray', '5 4');
        ceilingLine.setAttribute('stroke-width', '1.2');
        svg.appendChild(ceilingLine);

        const ceilingLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        ceilingLabel.setAttribute('x', w - padRight);
        ceilingLabel.setAttribute('y', ceilingY - 4);
        ceilingLabel.setAttribute('fill', '#f87171');
        ceilingLabel.setAttribute('font-size', '9');
        ceilingLabel.setAttribute('font-weight', '600');
        ceilingLabel.setAttribute('text-anchor', 'end');
        ceilingLabel.textContent = formatTok(ceilingTokens) + ' Compaction Limit';
        svg.appendChild(ceilingLabel);
      }

      // Compute Point Coordinates
      const minTurn = (timeline[0] && typeof timeline[0].turn === 'number') ? timeline[0].turn : 1;
      const maxTurn = (timeline[timeline.length - 1] && typeof timeline[timeline.length - 1].turn === 'number')
        ? timeline[timeline.length - 1].turn
        : minTurn;
      const turnSpan = Math.max(1, maxTurn - minTurn);

      const points = timeline.map((pt, i) => {
        const turnVal = typeof pt.turn === 'number' ? pt.turn : (i + 1);
        const x = (timeline.length === 1 || turnSpan === 0)
          ? padLeft + chartW / 2
          : padLeft + ((turnVal - minTurn) / turnSpan) * chartW;
        const visualCached = Math.min(pt.cached || 0, pt.input || 0);
        const yContext = padTop + chartH - ((pt.input || 0) / maxVal) * chartH;
        const yCached = padTop + chartH - (visualCached / maxVal) * chartH;
        return { x, yContext, yCached, visualCached, pt };
      });

      if (points.length > 1) {
        // 1. Context Area & Line (Blue)
        let contextAreaD = 'M ' + points[0].x + ' ' + (padTop + chartH);
        points.forEach(p => { contextAreaD += ' L ' + p.x + ' ' + p.yContext; });
        contextAreaD += ' L ' + points[points.length - 1].x + ' ' + (padTop + chartH) + ' Z';

        const contextArea = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        contextArea.setAttribute('d', contextAreaD);
        contextArea.setAttribute('fill', 'url(#blueGrad)');
        svg.appendChild(contextArea);

        // 2. Cached Area & Line (Emerald)
        let cachedAreaD = 'M ' + points[0].x + ' ' + (padTop + chartH);
        points.forEach(p => { cachedAreaD += ' L ' + p.x + ' ' + p.yCached; });
        cachedAreaD += ' L ' + points[points.length - 1].x + ' ' + (padTop + chartH) + ' Z';

        const cachedArea = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        cachedArea.setAttribute('d', cachedAreaD);
        cachedArea.setAttribute('fill', 'url(#emeraldGrad)');
        svg.appendChild(cachedArea);

        // Cached Stroke Line (Emerald)
        let cachedLineD = 'M ' + points[0].x + ' ' + points[0].yCached;
        points.forEach(p => { cachedLineD += ' L ' + p.x + ' ' + p.yCached; });
        const cachedLine = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        cachedLine.setAttribute('d', cachedLineD);
        cachedLine.setAttribute('fill', 'none');
        cachedLine.setAttribute('stroke', '#10b981');
        cachedLine.setAttribute('stroke-width', '1.5');
        cachedLine.setAttribute('stroke-opacity', '0.85');
        svg.appendChild(cachedLine);

        // Total Context Stroke Line (Blue)
        let contextLineD = 'M ' + points[0].x + ' ' + points[0].yContext;
        points.forEach(p => { contextLineD += ' L ' + p.x + ' ' + p.yContext; });
        const contextLine = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        contextLine.setAttribute('d', contextLineD);
        contextLine.setAttribute('fill', 'none');
        contextLine.setAttribute('stroke', '#3b82f6');
        contextLine.setAttribute('stroke-width', '2');
        svg.appendChild(contextLine);

        // Compaction Event Markers
        points.forEach(p => {
          if (p.pt.isCompacted) {
            const compDot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            compDot.setAttribute('cx', p.x);
            compDot.setAttribute('cy', p.yContext);
            compDot.setAttribute('r', '4');
            compDot.setAttribute('fill', '#ef4444');
            compDot.setAttribute('stroke', '#ffffff');
            compDot.setAttribute('stroke-width', '1.5');
            svg.appendChild(compDot);
          }
        });
      }

      // Interactive Elements: Vertical Crosshair Guideline & Tooltip Trackers
      const trackerGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      trackerGroup.setAttribute('id', 'trackerGroup');
      trackerGroup.style.display = 'none';

      const trackerLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      trackerLine.setAttribute('id', 'trackerLine');
      trackerLine.setAttribute('y1', padTop);
      trackerLine.setAttribute('y2', padTop + chartH);
      trackerLine.setAttribute('stroke', 'var(--vscode-editor-foreground, #f4f4f5)');
      trackerLine.setAttribute('stroke-opacity', '0.4');
      trackerLine.setAttribute('stroke-dasharray', '3 3');
      trackerGroup.appendChild(trackerLine);

      const dotContext = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dotContext.setAttribute('id', 'dotContext');
      dotContext.setAttribute('r', '4.5');
      dotContext.setAttribute('fill', '#3b82f6');
      dotContext.setAttribute('stroke', '#ffffff');
      dotContext.setAttribute('stroke-width', '1.5');
      trackerGroup.appendChild(dotContext);

      const dotCached = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dotCached.setAttribute('id', 'dotCached');
      dotCached.setAttribute('r', '3.5');
      dotCached.setAttribute('fill', '#10b981');
      dotCached.setAttribute('stroke', '#ffffff');
      dotCached.setAttribute('stroke-width', '1.5');
      trackerGroup.appendChild(dotCached);

      svg.appendChild(trackerGroup);

      // Full Transparent Overlay for Mouse Tracking
      const overlay = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      overlay.setAttribute('x', '0');
      overlay.setAttribute('y', '0');
      overlay.setAttribute('width', w);
      overlay.setAttribute('height', h);
      overlay.setAttribute('fill', 'transparent');
      overlay.style.cursor = 'crosshair';

      overlay.addEventListener('mousemove', (e) => {
        const rect = svg.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;

        // Find nearest point
        let nearest = points[0];
        let minDist = Infinity;
        for (const p of points) {
          const dist = Math.abs(p.x - mouseX);
          if (dist < minDist) {
            minDist = dist;
            nearest = p;
          }
        }

        if (!nearest) return;

        // Position trackers
        trackerGroup.style.display = 'block';
        trackerLine.setAttribute('x1', nearest.x);
        trackerLine.setAttribute('x2', nearest.x);
        dotContext.setAttribute('cx', nearest.x);
        dotContext.setAttribute('cy', nearest.yContext);
        dotCached.setAttribute('cx', nearest.x);
        dotCached.setAttribute('cy', nearest.yCached);

        // Update Tooltip Content
        const pt = nearest.pt;
        document.getElementById('ttTurn').textContent = 'Turn #' + pt.turn;
        const compBadge = document.getElementById('ttCompacted');
        if (pt.isCompacted) {
          compBadge.classList.remove('hidden');
          compBadge.textContent = 'COMPACTED (-' + formatTok(pt.compactedAmount) + ')';
        } else {
          compBadge.classList.add('hidden');
        }

        const pctCeil = Math.round((pt.input / ceilingTokens) * 100);
        document.getElementById('ttContext').textContent = pt.input.toLocaleString() + ' tok (' + pctCeil + '% of ' + formatTok(ceilingTokens) + ')';
        const cachePct = pt.input > 0 ? Math.min(100, Math.round(((pt.cached || 0) / pt.input) * 100)) : 0;
        document.getElementById('ttCached').textContent = (pt.cached || 0).toLocaleString() + ' tok (' + cachePct + '%)';
        document.getElementById('ttFresh').textContent = '+' + (pt.fresh || 0).toLocaleString() + ' tok';
        document.getElementById('ttOutput').textContent = (pt.output || 0).toLocaleString() + ' tok (' + (pt.thinking || 0).toLocaleString() + ' thk)';

        // Position Floating Tooltip
        const container = document.getElementById('chartContainer');
        const cRect = container.getBoundingClientRect();
        const tooltipW = 210;
        let tipX = nearest.x + 12;
        if (tipX + tooltipW > cRect.width) {
          tipX = nearest.x - tooltipW - 12;
        }
        let tipY = Math.min(nearest.yContext - 10, cRect.height - 110);
        if (tipY < 8) tipY = 8;

        tooltip.style.left = Math.max(8, tipX) + 'px';
        tooltip.style.top = tipY + 'px';
        tooltip.classList.remove('hidden');
      });

      overlay.addEventListener('mouseleave', () => {
        trackerGroup.style.display = 'none';
        tooltip.classList.add('hidden');
      });

      svg.appendChild(overlay);
    }

    // The webview CSP is nonce-based, and a nonce does NOT authorise inline event-handler
    // attributes (an onclick attribute would be blocked). Every handler is attached here.
    function bindEvents() {
      const handlers = [
        ['tabDetailBtn', () => switchTab('detail')],
        ['tabListBtn', () => switchTab('list')],
        ['chipAllBtn', () => setSubagentFilter('all')],
        ['chipChatsBtn', () => setSubagentFilter('chats')],
        ['chipSubagentsBtn', () => setSubagentFilter('subagents')],
        ['refreshBtn', () => handleManualRefresh()],
        ['chatSelect', null],
        ['searchInput', null],
        ['deleteChatBtn', () => promptDeleteCurrent()],
        ['delModalCancelBtn', () => closeDeleteModal()],
        ['delModalConfirmBtn', () => confirmDeleteExec()],
        ['subagentsToggleBtn', () => toggleSubagentsCollapse()],
        ['actToggleFilesBtn', () => toggleActivityFiles()]
      ];
      for (const [id, handler] of handlers) {
        if (!handler) continue;
        const el = document.getElementById(id);
        if (el) el.onclick = handler;
      }
      const select = document.getElementById('chatSelect');
      if (select) select.onchange = e => selectConv(e.target.value);
      const wsSelect = document.getElementById('workspaceSelect');
      if (wsSelect) {
        wsSelect.onchange = e => {
          currentWorkspaceFilter = e.target.value;
          const list = getFilteredConversations();
          if (list.length > 0 && !list.some(c => c.id === selectedId)) {
            selectedId = list[0].id;
          }
          populateDropdown();
          filterList();
          updateGlobalHeaders();
          renderDetail();
        };
      }
      const fileFilterInput = document.getElementById('actFileFilterInput');
      if (fileFilterInput) {
        fileFilterInput.oninput = (e) => {
          fileFilterQuery = (e.target.value || '').toLowerCase().trim();
          renderDrawerFiles(fileFilterQuery);
        };
      }
      const search = document.getElementById('searchInput');
      if (search) {
        search.oninput = () => filterList();
        search.onkeydown = e => {
          if (e.key === 'Escape') {
            search.value = '';
            filterList();
          }
        };
      }
    }

    bindEvents();
    populateWorkspaceDropdown();
    populateDropdown();
    filterList();
    updateGlobalHeaders();
    renderDetail();
    window.onresize = () => {
      const conv = CONVERSATIONS.find(c => c.id === selectedId);
      if (conv && conv.stats) renderChart(conv.stats.contextTimeline, true);
    };
  </script>
</body>
</html>`;
}

module.exports = { getDashboardHtml };
