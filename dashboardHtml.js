// HTML Webview generator with split-window / narrow-screen optimization, live message passing,
// dual-layer interactive context graph with hover crosshair/tooltip, and session intelligence metrics.

function getDashboardHtml(conversations, activeId, options = {}) {
  const {
    cssUri = '',
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
          <div class="w-8 h-8 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold text-base border border-emerald-500/30">
            ⚡
          </div>
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
          <!-- View Chip (Transient per-session filter) -->
          <div class="flex items-center gap-1 p-0.5 inner-bg border border-color rounded-lg text-xs">
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
              class="px-2.5 py-1 rounded font-medium transition-colors bg-blue-500/20 text-blue-400 border border-blue-500/30 shadow-sm">
              📊 Chat Telemetry
            </button>
            <button id="tabListBtn"
              class="px-2.5 py-1 rounded font-medium transition-colors muted-color hover:text-[var(--vscode-editor-foreground,#f4f4f5)]">
              🗂️ All Sessions (<span id="tabListCount">${conversations.length}</span>)
            </button>
          </div>
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
              <span id="subagentBadge" class="hidden px-2 py-0.5 rounded text-[10px] font-semibold bg-purple-500/20 text-purple-300 border border-purple-500/30">🤖 <span id="chatAgentVal">subagent</span></span>
              <span id="workspaceBadge" class="hidden px-2 py-0.5 rounded text-[10px] font-semibold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">📁 <span id="chatWorkspaceVal">--</span></span>
              <span id="activePill" class="hidden px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">ACTIVE CHAT</span>
              <span id="diskBadge" class="px-2 py-0.5 rounded text-[10px] font-medium inner-bg border border-color muted-color" title="Disk space used by this conversation (SQLite DB + Brain transcripts/artifacts + Annotations)">
                Disk: <span id="chatDiskVal" class="text-zinc-300 font-semibold">0 MB</span>
              </span>
            </div>
            <div id="subagentBreadcrumb" class="hidden text-xs muted-color mb-1.5 flex items-center gap-1.5 flex-wrap"></div>
            <div class="flex items-center gap-2.5">
              <h2 id="chatTitle" class="text-sm font-bold text-[var(--vscode-editor-foreground,#f4f4f5)]">Loading...</h2>
              <button id="deleteChatBtn" class="px-2 py-0.5 rounded text-[10px] font-semibold bg-red-500/15 hover:bg-red-500/25 text-red-400 hover:text-red-300 border border-red-500/30 transition-colors flex items-center gap-1 shadow-sm shrink-0" title="${delTooltip}">
                🗑️ Delete Chat
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
            <div class="text-[10px] muted-color">Cache Write</div>
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

      <!-- 🤖 Subagents & Background Workers Card (Shown when selected chat has spawned children) -->
      <div id="subagentsCard" class="hidden p-3 card-bg border border-color rounded-xl space-y-2.5">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex items-center gap-2">
            <h3 class="text-xs font-bold uppercase tracking-wider text-[var(--vscode-editor-foreground,#f4f4f5)]">🤖 Subagents & Background Workers</h3>
            <span id="subagentsCountBadge" class="text-[10px] px-2 py-0.5 rounded inner-bg border border-color text-purple-300 font-semibold">0 subagents</span>
          </div>
          <div id="subagentsRolledUpTotal" class="text-xs font-semibold text-emerald-400">
            <!-- Populated by JS: Parent (X) + Subagents (Y) = Z total -->
          </div>
        </div>

        <div id="subagentsList" class="space-y-1.5">
          <!-- Populated by JS -->
        </div>
      </div>

      <!-- Token Breakdown Progress Bar & Legend -->
      <div class="p-3 card-bg border border-color rounded-xl space-y-2.5">
        <div class="flex items-center justify-between">
          <h3 class="text-xs font-bold uppercase tracking-wider text-[var(--vscode-editor-foreground,#f4f4f5)]">Token Composition</h3>
          <span class="text-[10px] muted-color">Cache Read vs Cache Write vs Model Output</span>
        </div>

        <div class="h-3.5 w-full inner-bg rounded-full overflow-hidden flex border border-color">
          <div id="barCacheRead" class="bg-blue-500 h-full transition-all duration-300" style="width: 0%" title="Cache Read (Cached Prompt)"></div>
          <div id="barCacheWrite" class="bg-cyan-400 h-full transition-all duration-300" style="width: 0%" title="Cache Write (Fresh Prompt)"></div>
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
              <div class="text-[10px] muted-color">Cache Write (<span id="legCacheWritePct">0%</span>)</div>
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
                <span class="muted-color">Cache Write:</span>
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
          <span class="italic text-[9px]">💡 Hover over graph to inspect turn details</span>
          <span>Latest Turn</span>
        </div>
      </div>

      <!-- SESSION INTELLIGENCE & METRICS GRID (REPLACING OLD COST SECTION) -->
      <div class="p-3 card-bg border border-color rounded-xl space-y-2.5">
        <div class="flex items-center justify-between">
          <h3 class="text-xs font-bold uppercase tracking-wider text-[var(--vscode-editor-foreground,#f4f4f5)]">Session Intelligence & Turn Metrics</h3>
          <span class="text-[10px] muted-color">Live execution telemetry</span>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 text-xs">
          
          <!-- Card 1: Last Turn Activity -->
          <div class="p-2.5 inner-bg rounded-lg border border-color space-y-1">
            <div class="flex items-center justify-between text-[10px] muted-color">
              <span>⚡ Last Turn Activity</span>
              <span id="metaLastTurnNum" class="font-semibold text-blue-400">Turn #--</span>
            </div>
            <div id="metaLastContext" class="text-sm font-bold text-[var(--vscode-editor-foreground,#f4f4f5)]">0 tok</div>
            <div class="text-[10px] space-y-0.5">
              <div class="flex justify-between">
                <span class="muted-color">Cache Write:</span>
                <span id="metaLastFresh" class="font-medium text-cyan-400">+0 fresh</span>
              </div>
              <div class="flex justify-between">
                <span class="muted-color">Model Output:</span>
                <span id="metaLastOutput" class="font-medium text-purple-400">0 tok</span>
              </div>
              <div class="flex justify-between">
                <span class="muted-color">Compaction:</span>
                <span id="metaLastCompaction" class="font-medium text-emerald-400">Normal</span>
              </div>
            </div>
          </div>

          <!-- Card 2: Per-Turn Averages -->
          <div class="p-2.5 inner-bg rounded-lg border border-color space-y-1">
            <div class="text-[10px] muted-color">📊 Per-Turn Averages</div>
            <div id="metaAvgContext" class="text-sm font-bold text-amber-400">0 tok</div>
            <div class="text-[10px] space-y-0.5">
              <div class="flex justify-between">
                <span class="muted-color">Avg Output:</span>
                <span id="metaAvgOutput" class="font-medium text-[var(--vscode-editor-foreground,#f4f4f5)]">0 tok</span>
              </div>
              <div class="flex justify-between">
                <span class="muted-color">Avg Thinking:</span>
                <span id="metaAvgThinking" class="font-medium text-purple-400">0 tok</span>
              </div>
              <div class="flex justify-between">
                <span class="muted-color">Avg Cached:</span>
                <span id="metaAvgCached" class="font-medium text-emerald-400">0 tok</span>
              </div>
            </div>
          </div>

          <!-- Card 3: Cache Reliability & Ceiling -->
          <div class="p-2.5 inner-bg rounded-lg border border-color space-y-1">
            <div class="text-[10px] muted-color">🛡️ Cache Performance</div>
            <div id="metaCacheCalls" class="text-sm font-bold text-blue-400">0 Hits</div>
            <div class="text-[10px] space-y-0.5">
              <div class="flex justify-between">
                <span class="muted-color">Cold Starts:</span>
                <span id="metaCacheMisses" class="font-medium text-amber-400">0 misses</span>
              </div>
              <div class="flex justify-between">
                <span class="muted-color">Compactions:</span>
                <span id="metaCompactions" class="font-medium text-[var(--vscode-editor-foreground,#f4f4f5)]">0 events</span>
              </div>
              <div class="flex justify-between">
                <span class="muted-color">Ceiling Limit:</span>
                <span id="metaCeilingLimit" class="font-medium text-red-400 font-mono">256k limit</span>
              </div>
            </div>
          </div>

          <!-- Card 4: Session Peaks -->
          <div class="p-2.5 inner-bg rounded-lg border border-color space-y-1">
            <div class="text-[10px] muted-color">🏔️ Session Peaks</div>
            <div id="metaPeakContext" class="text-sm font-bold text-emerald-400">0 tok</div>
            <div class="text-[10px] space-y-0.5">
              <div class="flex justify-between">
                <span class="muted-color">Peak Output:</span>
                <span id="metaPeakOutput" class="font-medium text-[var(--vscode-editor-foreground,#f4f4f5)]">0 tok</span>
              </div>
              <div class="flex justify-between">
                <span class="muted-color">Peak Thinking:</span>
                <span id="metaPeakThinking" class="font-medium text-purple-400">0 tok</span>
              </div>
              <div class="flex justify-between">
                <span class="muted-color">Min Context:</span>
                <span id="metaMinContext" class="font-medium text-blue-300">0 tok</span>
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
        <span class="text-base">🗑️</span>
        <span>${delHeading}</span>
      </div>
      <p class="text-xs text-[var(--vscode-editor-foreground,#f4f4f5)]">
        <strong id="delModalTitle" class="text-white"></strong>
      </p>
      <p class="text-[11px] muted-color">${delQuestion}</p>
      <div id="delModalActiveWarning" class="hidden p-2 rounded bg-amber-500/15 border border-amber-500/30 text-[11px] text-amber-300">
        ⚠️ This is the currently active chat in Antigravity. Deleting it will terminate this session.
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
          🗑️ ${delButtonLabel}
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
    let unattachedExpanded = false;

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
      } else if (msg && msg.type === 'telemetryUpdate') {
        CONVERSATIONS = msg.data;
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
      }
    });

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
        detailBtn.className = 'px-2.5 py-1 rounded font-medium transition-colors bg-blue-500/20 text-blue-400 border border-blue-500/30 shadow-sm';
        listBtn.className = 'px-2.5 py-1 rounded font-medium transition-colors muted-color hover:text-[var(--vscode-editor-foreground,#f4f4f5)]';
        const conv = CONVERSATIONS.find(c => c.id === selectedId);
        if (conv && conv.stats) renderChart(conv.stats.contextTimeline);
      } else {
        detailView.classList.add('hidden');
        listView.classList.remove('hidden');
        listBtn.className = 'px-2.5 py-1 rounded font-medium transition-colors bg-blue-500/20 text-blue-400 border border-blue-500/30 shadow-sm';
        detailBtn.className = 'px-2.5 py-1 rounded font-medium transition-colors muted-color hover:text-[var(--vscode-editor-foreground,#f4f4f5)]';
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
          const hasTitle = c.title && c.title !== '<original_task>' && c.title.trim() !== agent;
          if (hasTitle) {
            let tClean = c.title.trim();
            if (tClean.length > 28) tClean = tClean.slice(0, 26).trim() + '…';
            titleText = '🤖 [' + agent + '] ' + tClean;
            fullTitle = '🤖 [' + agent + '] ' + c.title.trim();
          } else {
            titleText = '🤖 [' + agent + ']';
            fullTitle = '🤖 [' + agent + ']';
          }
        } else {
          fullTitle = c.title || 'Untitled';
          let t = fullTitle.trim();
          if (t.length > 36) {
            t = t.slice(0, 34).trim() + '…';
          }
          titleText = t;
        }

        opt.textContent = wsPrefix + titleText + isAct + ' · ' + tokM + ' (' + hit + ' cache)';
        opt.title = (wsPrefix ? wsPrefix : '') + fullTitle + isAct + ' — ' + (c.storageMB ? c.storageMB + 'MB · ' : '') + tokM + ' tok (' + (c.stats ? c.stats.cacheHitRate : 0) + '% cache)';
        if (c.id === selectedId) opt.selected = true;
        select.appendChild(opt);
      });
      if (selectedId) {
        select.value = selectedId;
        const cur = CONVERSATIONS.find(c => c.id === selectedId);
        if (cur) {
          select.title = (cur.isSubagent ? '🤖 [' + (cur.agentName || 'subagent') + '] ' : '') + (cur.title || 'Untitled');
        }
      }
    }

    function selectConv(id) {
      selectedId = id;
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

      function createConvRow(c, isChild) {
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
          ? '<span class="text-[9px] font-medium px-1.5 py-0.2 rounded bg-indigo-500/15 text-indigo-300 border border-indigo-500/30 shrink-0" title="Workspace: ' + escapeHtml(wsName) + '">📁 ' + escapeHtml(wsName) + '</span>'
          : '';

        let titleHtml = '';
        if (c.isSubagent) {
          const agentLabel = escapeHtml(c.agentName || 'subagent');
          const hasTitle = c.title && c.title !== '<original_task>' && c.title.trim() !== c.agentName;
          const cleanTitle = hasTitle ? c.title.trim() : '';
          let displayTitle = cleanTitle;
          if (displayTitle.length > 38) {
            displayTitle = displayTitle.slice(0, 36).trim() + '…';
          }
          const taskSpan = displayTitle
            ? '<span class="font-medium text-xs truncate min-w-0 ' + (isSel ? 'text-blue-300 font-semibold' : 'text-[var(--vscode-editor-foreground,#f4f4f5)]') + '" title="' + escapeHtml(cleanTitle) + '">' + escapeHtml(displayTitle) + '</span>'
            : '';
          titleHtml = 
            '<span class="px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold bg-purple-500/20 text-purple-300 border border-purple-500/30 shrink-0">🤖 ' + agentLabel + '</span>' +
            taskSpan;
        } else {
          titleHtml = '<span class="font-medium text-xs truncate min-w-0 ' + (isSel ? 'text-blue-300 font-semibold' : 'text-[var(--vscode-editor-foreground,#f4f4f5)]') + '" title="' + escapeHtml(c.title || 'Untitled') + '">' + escapeHtml(c.title || 'Untitled') + '</span>';
        }

        div.innerHTML = 
          '<div class="flex items-center justify-between gap-2 mb-1">' +
            '<div class="flex items-center gap-1.5 min-w-0 flex-1">' +
              titleHtml +
              wsBadge +
            '</div>' +
            '<div class="flex items-center gap-1.5 shrink-0">' +
              (isAct ? '<span class="text-[9px] font-bold px-1 rounded bg-emerald-500/20 text-emerald-400">ACTIVE</span>' : '') +
              '<span class="text-[10px] font-bold px-1.5 py-0.5 rounded ' + (hitRate > 90 ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400') + '">' + hitRate + '%</span>' +
              '<button class="del-btn p-1 rounded hover:bg-red-500/20 text-zinc-400 hover:text-red-400 transition-colors text-xs" title="${delTooltip}">🗑️</button>' +
            '</div>' +
          '</div>' +
          '<div class="flex items-center justify-between text-[10px] muted-color">' +
            '<span>' + (c.stats ? c.stats.calls : 0) + ' calls · ' + c.stepCount + ' steps</span>' +
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
          ? subs.filter(c => (c.agentName || '').toLowerCase().includes(q) || (c.title || '').toLowerCase().includes(q) || (c.id || '').toLowerCase().includes(q))
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

      const parentToChildren = new Map();
      const unattached = [];

      allSubagents.forEach(s => {
        const pId = s.parentConversationId;
        if (pId && humanChats.some(h => h.id === pId)) {
          if (!parentToChildren.has(pId)) parentToChildren.set(pId, []);
          parentToChildren.get(pId).push(s);
        } else {
          unattached.push(s);
        }
      });

      // Handle search filtering
      let visibleHumans = humanChats;
      let visibleUnattached = unattached;

      if (q) {
        visibleHumans = humanChats.filter(h => {
          const hMatch = (h.title || '').toLowerCase().includes(q) || (h.id || '').toLowerCase().includes(q);
          const children = parentToChildren.get(h.id) || [];
          const cMatch = children.some(c => (c.agentName || '').toLowerCase().includes(q) || (c.title || '').toLowerCase().includes(q) || (c.id || '').toLowerCase().includes(q));
          if (cMatch) expandedDrawers.add(h.id);
          return hMatch || cMatch;
        });

        visibleUnattached = unattached.filter(u => {
          const uMatch = (u.agentName || '').toLowerCase().includes(q) || (u.title || '').toLowerCase().includes(q) || (u.id || '').toLowerCase().includes(q);
          if (uMatch) unattachedExpanded = true;
          return uMatch;
        });
      }

      if (visibleHumans.length === 0 && visibleUnattached.length === 0) {
        container.innerHTML = '<div class="text-xs muted-color p-4 text-center">No sessions match search</div>';
        return;
      }

      visibleHumans.forEach(h => {
        const row = createConvRow(h, false);
        container.appendChild(row);

        const children = parentToChildren.get(h.id) || [];
        if (children.length > 0) {
          const cTok = children.reduce((sum, ch) => sum + (ch.stats ? ch.stats.grandTotal : 0), 0);
          const cStorage = children.reduce((sum, ch) => sum + (parseFloat(ch.storageMB) || 0), 0).toFixed(1);
          const isExp = expandedDrawers.has(h.id);

          const drawerWrap = document.createElement('div');
          drawerWrap.className = 'mb-2';

          const toggle = document.createElement('div');
          toggle.className = 'drawer-toggle flex items-center justify-between px-3 py-1.5 ml-3 rounded-lg border border-color inner-bg/80 cursor-pointer hover:border-purple-500/40 text-xs transition-colors';
          toggle.innerHTML = 
            '<div class="flex items-center gap-1.5 text-purple-300 font-medium">' +
              '<span class="drawer-arrow text-[11px]">' + (isExp ? '▾' : '▸') + '</span>' +
              '<span>🤖</span>' +
              '<span>' + children.length + ' subagent' + (children.length > 1 ? 's' : '') + '</span>' +
              '<span class="muted-color font-mono">· ' + formatTok(cTok) + ' tok · ' + cStorage + ' MB</span>' +
            '</div>' +
            '<span class="text-[10px] muted-color">' + (isExp ? 'Hide' : 'Show') + '</span>';

          const childListDiv = document.createElement('div');
          childListDiv.className = 'space-y-1.5 ml-5 mt-1 border-l-2 border-purple-500/30 pl-2.5 ' + (isExp ? '' : 'hidden');

          children.forEach(ch => {
            const childRow = createConvRow(ch, true, null);
            childListDiv.appendChild(childRow);
          });

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
            '<span>🤖</span>' +
            '<span>Unattached Subagents (' + visibleUnattached.length + ')</span>' +
            '<span class="muted-color font-mono">· ' + formatTok(uTok) + ' tok · ' + uStorage + ' MB</span>' +
          '</div>' +
          '<span class="text-[10px] muted-color">' + (unattachedExpanded ? 'Hide' : 'Show') + '</span>';

        const unListDiv = document.createElement('div');
        unListDiv.className = 'space-y-1.5 ml-3 mt-1 border-l-2 border-amber-500/30 pl-2.5 ' + (unattachedExpanded ? '' : 'hidden');

        visibleUnattached.forEach(ch => {
          const uRow = createConvRow(ch, true);
          unListDiv.appendChild(uRow);
        });

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
        const hasTitle = conv.title && conv.title !== '<original_task>' && conv.title.trim() !== conv.agentName;
        let headTitle = hasTitle ? conv.title.trim() : (conv.agentName || 'Subagent');
        if (headTitle.length > 60) {
          headTitle = headTitle.slice(0, 58).trim() + '…';
        }
        document.getElementById('chatTitle').textContent = headTitle;
        document.getElementById('chatTitle').title = conv.title || '';

        if (breadcrumb) {
          breadcrumb.classList.remove('hidden');
          breadcrumb.innerHTML = '';

          const parentId = conv.parentConversationId;
          const parentConv = parentId ? CONVERSATIONS.find(c => c.id === parentId) : null;

          const prefix = document.createElement('span');
          prefix.className = 'muted-color';
          prefix.textContent = 'Subagent of: ';
          breadcrumb.appendChild(prefix);

          if (parentConv) {
            const link = document.createElement('a');
            link.className = 'text-blue-400 hover:underline cursor-pointer font-medium';
            link.textContent = parentConv.title || 'Parent Chat';
            link.onclick = () => selectConv(parentConv.id);
            breadcrumb.appendChild(link);
          } else if (conv.parentTitle) {
            const nameSpan = document.createElement('span');
            nameSpan.className = 'text-zinc-300 font-medium';
            nameSpan.textContent = conv.parentTitle;
            breadcrumb.appendChild(nameSpan);

            const note = document.createElement('span');
            note.className = 'text-[10px] muted-color';
            note.textContent = ' (session data no longer on disk)';
            breadcrumb.appendChild(note);
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

      // 🤖 Subagents & Background Workers Card
      const children = CONVERSATIONS.filter(c => c.parentConversationId === conv.id);
      const subCard = document.getElementById('subagentsCard');
      const subList = document.getElementById('subagentsList');
      const subCountBadge = document.getElementById('subagentsCountBadge');
      const subRolledUp = document.getElementById('subagentsRolledUpTotal');

      if (children.length > 0) {
        if (subCard) subCard.classList.remove('hidden');
        if (subCountBadge) subCountBadge.textContent = children.length + (children.length === 1 ? ' subagent' : ' subagents');

        let childTok = 0;
        let childStorage = 0;
        if (subList) {
          subList.innerHTML = '';
          children.forEach(ch => {
            const cTok = ch.stats ? ch.stats.grandTotal : 0;
            const cStorage = parseFloat(ch.storageMB) || 0;
            childTok += cTok;
            childStorage += cStorage;

            const row = document.createElement('div');
            row.className = 'p-2 inner-bg border border-color rounded-lg flex items-center justify-between gap-2 hover:border-blue-500/40 cursor-pointer transition-colors';
            row.onclick = () => selectConv(ch.id);

            const left = document.createElement('div');
            left.className = 'flex items-center gap-2 min-w-0';
            const hasTask = ch.title && ch.title !== '<original_task>' && ch.title.trim() !== ch.agentName;
            let displayTask = hasTask ? ch.title.trim() : (ch.agentName || ch.id.slice(0, 8));
            if (displayTask.length > 36) displayTask = displayTask.slice(0, 34).trim() + '…';
            left.innerHTML = 
              '<span class="px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold bg-purple-500/20 text-purple-300 border border-purple-500/30 shrink-0">🤖 ' + escapeHtml(ch.agentName || 'subagent') + '</span>' +
              '<span class="text-xs text-[var(--vscode-editor-foreground,#f4f4f5)] font-medium truncate" title="' + escapeHtml(ch.title || '') + '">' + escapeHtml(displayTask) + '</span>' +
              '<span class="text-[10px] muted-color font-mono shrink-0">(' + escapeHtml(ch.id.slice(0, 8)) + ')</span>';

            const right = document.createElement('div');
            right.className = 'flex items-center gap-2.5 shrink-0 text-xs font-mono';
            right.innerHTML = 
              '<span class="text-zinc-400 text-[11px]">' + (ch.storageMB || '0.0') + ' MB</span>' +
              '<span class="text-emerald-400 font-semibold">' + formatTok(cTok) + ' tok</span>' +
              '<span class="text-[10px] muted-color">(' + (ch.stats ? ch.stats.calls : 0) + ' calls)</span>' +
              '<span class="text-blue-400 text-[11px]">Inspect →</span>';

            row.appendChild(left);
            row.appendChild(right);
            subList.appendChild(row);
          });
        }

        const parentTok = s.grandTotal || 0;
        const rolledTok = parentTok + childTok;
        if (subRolledUp) {
          subRolledUp.innerHTML = 
            '<span class="muted-color">Parent (' + formatTok(parentTok) + ') + Subagents (' + formatTok(childTok) + ') = </span>' +
            '<span class="text-emerald-400 font-bold">' + formatTok(rolledTok) + ' total</span>';
        }
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
      const pctRead = ((s.totalCached / tot) * 100).toFixed(1);
      const pctWrite = ((s.totalNonCached / tot) * 100).toFixed(1);
      const pctOut = ((s.totalOutput / tot) * 100).toFixed(1);

      document.getElementById('barCacheRead').style.width = pctRead + '%';
      document.getElementById('barCacheWrite').style.width = pctWrite + '%';
      document.getElementById('barOutput').style.width = pctOut + '%';

      document.getElementById('legCacheRead').textContent = s.totalCached.toLocaleString() + ' tok';
      document.getElementById('legCacheReadPct').textContent = pctRead + '%';

      document.getElementById('legCacheWrite').textContent = s.totalNonCached.toLocaleString() + ' tok';
      document.getElementById('legCacheWritePct').textContent = pctWrite + '%';

      document.getElementById('legOutput').textContent = s.totalOutput.toLocaleString() + ' tok';
      document.getElementById('legOutputPct').textContent = pctOut + '%';

      // Session Intelligence & Turn Metrics
      // Card 1: Last Turn Activity
      const lt = s.lastTurn;
      if (lt) {
        document.getElementById('metaLastTurnNum').textContent = 'Turn #' + lt.turn;
        document.getElementById('metaLastContext').textContent = formatTok(lt.context != null ? lt.context : lt.totalInput) + ' tok';
        document.getElementById('metaLastFresh').textContent = '+' + formatTok(lt.fresh) + ' fresh';
        document.getElementById('metaLastOutput').textContent = lt.output.toLocaleString() + ' tok (' + lt.thinking.toLocaleString() + ' thk)';
        if (lt.isCompacted) {
          document.getElementById('metaLastCompaction').innerHTML = '<span class="text-red-400 font-bold">Compacted (-' + formatTok(lt.compactedAmount) + ')</span>';
        } else {
          document.getElementById('metaLastCompaction').innerHTML = '<span class="text-emerald-400 font-medium">Normal</span>';
        }
      } else {
        document.getElementById('metaLastTurnNum').textContent = 'Turn #--';
        document.getElementById('metaLastContext').textContent = '0 tok';
        document.getElementById('metaLastFresh').textContent = '+0 fresh';
        document.getElementById('metaLastOutput').textContent = '0 tok';
        document.getElementById('metaLastCompaction').textContent = 'Normal';
      }

      // Card 2: Per-Turn Averages
      document.getElementById('metaAvgContext').textContent = formatTok(s.avgContext) + ' tok';
      document.getElementById('metaAvgOutput').textContent = (s.avgOutput || 0).toLocaleString() + ' tok / call';
      const thinkRatio = s.avgOutput > 0 ? Math.round(((s.avgThinking || 0) / s.avgOutput) * 100) : 0;
      document.getElementById('metaAvgThinking').textContent = (s.avgThinking || 0).toLocaleString() + ' tok (' + thinkRatio + '%)';
      document.getElementById('metaAvgCached').textContent = formatTok(s.avgCached) + ' tok';

      // Card 3: Cache Reliability & Compactions
      document.getElementById('metaCacheCalls').textContent = s.cacheHits + ' / ' + s.calls + ' Hits';
      document.getElementById('metaCacheMisses').textContent = s.cacheMisses + ' misses';
      document.getElementById('metaCompactions').textContent = (s.compactionsCount || 0) + ' events';
      const limitLabel = formatTok(contextLimit);
      const ceilEl = document.getElementById('metaCeilingLimit');
      if (ceilEl) ceilEl.textContent = limitLabel + ' limit';
      const chartCeilLeg = document.getElementById('chartCeilingLegend');
      if (chartCeilLeg) chartCeilLeg.textContent = limitLabel + ' Limit';

      // Card 4: Session Peaks
      const peakPct = Math.min(100, Math.round(((s.peakContext || 0) / contextLimit) * 100));
      document.getElementById('metaPeakContext').textContent = formatTok(s.peakContext) + ' (' + peakPct + '%)';
      document.getElementById('metaPeakOutput').textContent = (s.peakOutput || 0).toLocaleString() + ' tok';
      document.getElementById('metaPeakThinking').textContent = (s.peakThinking || 0).toLocaleString() + ' tok';
      document.getElementById('metaMinContext').textContent = formatTok(s.minContext) + ' tok';

      currentTimeline = s.contextTimeline || [];
      renderChart(currentTimeline);
    }

    function renderChart(timeline) {
      const svg = document.getElementById('timelineSvg');
      svg.innerHTML = '';
      const tooltip = document.getElementById('chartTooltip');
      if (tooltip) tooltip.classList.add('hidden');

      if (!timeline || timeline.length === 0) {
        document.getElementById('chartPointsCount').textContent = '0 points';
        return;
      }
      document.getElementById('chartPointsCount').textContent = timeline.length + ' data points';

      const w = svg.clientWidth || 500;
      const h = svg.clientHeight || 170;
      const padTop = 22;
      const padBottom = 16;
      const padLeft = 14;
      const padRight = 14;
      const chartW = w - padLeft - padRight;
      const chartH = h - padTop - padBottom;

      // Compaction ceiling calibrated to 256,000 tokens (or conversation limit)
      const conv = CONVERSATIONS.find(c => c.id === selectedId);
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
      const points = timeline.map((pt, i) => {
        const x = timeline.length === 1 
          ? padLeft + chartW / 2 
          : padLeft + (i / (timeline.length - 1)) * chartW;
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
        ['chatSelect', null],
        ['searchInput', null],
        ['deleteChatBtn', () => promptDeleteCurrent()],
        ['delModalCancelBtn', () => closeDeleteModal()],
        ['delModalConfirmBtn', () => confirmDeleteExec()]
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
      const search = document.getElementById('searchInput');
      if (search) search.oninput = () => filterList();
    }

    bindEvents();
    populateWorkspaceDropdown();
    populateDropdown();
    filterList();
    updateGlobalHeaders();
    renderDetail();
    window.onresize = () => {
      const conv = CONVERSATIONS.find(c => c.id === selectedId);
      if (conv && conv.stats) renderChart(conv.stats.contextTimeline);
    };
  </script>
</body>
</html>`;
}

module.exports = { getDashboardHtml };
