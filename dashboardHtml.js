// HTML Webview generator with split-window / narrow-screen optimization, live message passing,
// dual-layer interactive context graph with hover crosshair/tooltip, compact cost pill, and session intelligence metrics.

function getDashboardHtml(conversations, activeId) {
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
  <script src="https://www.gstatic.com/antigravity/web/dev/tailwindcss.min.js"></script>
  <style>
    body {
      background-color: var(--vscode-editor-background, #18181b);
      color: var(--vscode-editor-foreground, #f4f4f5);
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif);
      user-select: none;
    }
    .card-bg { background-color: var(--vscode-sideBar-background, #202023); }
    .inner-bg { background-color: var(--vscode-editor-background, #18181b); }
    .border-color { border-color: var(--vscode-sideBar-border, #3f3f46); }
    .muted-color { color: var(--vscode-descriptionForeground, #a1a1aa); }
    .custom-scrollbar::-webkit-scrollbar { width: 6px; height: 6px; }
    .custom-scrollbar::-webkit-scrollbar-thumb { background-color: var(--vscode-scrollbarSlider-background, #3f3f46); border-radius: 9999px; }
  </style>
</head>
<body class="p-3 custom-scrollbar text-sm antialiased">
  <div class="max-w-5xl mx-auto space-y-3">
    
    <!-- Top Header & Controls -->
    <div class="p-3 card-bg border border-color rounded-xl shadow-sm space-y-3">
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
            <p class="text-[11px] muted-color">Total: <span id="headerTotalTokens" class="text-emerald-400 font-semibold">${(globalTokens / 1_000_000).toFixed(1)}M tok</span> · Cache: <span id="headerHitRate" class="text-blue-400 font-semibold">${globalHitRate}%</span></p>
          </div>
        </div>

        <!-- Navigation Tabs -->
        <div class="flex items-center gap-1 p-1 inner-bg border border-color rounded-lg text-xs">
          <button id="tabDetailBtn" onclick="switchTab('detail')" 
            class="px-2.5 py-1 rounded font-medium transition-colors bg-blue-500/20 text-blue-400 border border-blue-500/30 shadow-sm">
            📊 Chat Telemetry
          </button>
          <button id="tabListBtn" onclick="switchTab('list')" 
            class="px-2.5 py-1 rounded font-medium transition-colors muted-color hover:text-[var(--vscode-editor-foreground,#f4f4f5)]">
            🗂️ All Sessions (${conversations.length})
          </button>
        </div>
      </div>

      <!-- Quick Conversation Selector Dropdown -->
      <div class="flex items-center gap-2 pt-1 border-t border-color">
        <span class="text-xs muted-color font-medium shrink-0">Viewing:</span>
        <select id="chatSelect" onchange="selectConv(this.value)" 
          class="w-full px-2.5 py-1.5 text-xs inner-bg border border-color rounded-lg font-medium text-[var(--vscode-editor-foreground,#f4f4f5)] focus:outline-none focus:border-blue-500 transition-colors">
          <!-- Populated by JS -->
        </select>
      </div>
    </div>

    <!-- TAB 1: Chat Telemetry Details (DIRECTLY AT TOP - ZERO SCROLLING) -->
    <div id="detailView" class="space-y-3">
      
      <!-- Selected Chat Overview Card -->
      <div class="p-3 card-bg border border-color rounded-xl shadow-sm">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-color pb-2.5 mb-2.5">
          <div>
            <div class="flex flex-wrap items-center gap-2 mb-1">
              <span id="chatBadge" class="px-2 py-0.5 rounded text-[10px] font-semibold bg-blue-500/20 text-blue-400 border border-blue-500/30">gemini-3.8-flash</span>
              <span id="activePill" class="hidden px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">ACTIVE CHAT</span>
              <span id="ghostPill" class="hidden px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30">GHOST (DELETED IN ANTIGRAVITY)</span>
              <span id="costBadge" class="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30" title="Estimated API cost at official rates">
                Est. Cost: <span id="costVal" class="font-bold">$0.00</span>
              </span>
              <span id="diskBadge" class="px-2 py-0.5 rounded text-[10px] font-medium inner-bg border border-color muted-color" title="Disk space used by this conversation (SQLite DB + Brain transcripts/artifacts + Annotations)">
                Disk: <span id="chatDiskVal" class="text-zinc-300 font-semibold">0 MB</span>
              </span>
            </div>
            <div class="flex items-center gap-2.5">
              <h2 id="chatTitle" class="text-sm font-bold text-[var(--vscode-editor-foreground,#f4f4f5)]">Loading...</h2>
              <button onclick="promptDeleteCurrent()" class="px-2 py-0.5 rounded text-[10px] font-semibold bg-red-500/15 hover:bg-red-500/25 text-red-400 hover:text-red-300 border border-red-500/30 transition-colors flex items-center gap-1 shadow-sm shrink-0" title="Permanently delete this conversation and all stored files (free disk space)">
                🗑️ Delete Chat
              </button>
            </div>
            <p id="chatMeta" class="text-[11px] muted-color">ID: -- | Last Active: --</p>
          </div>
          <div class="sm:text-right">
            <span class="text-[10px] muted-color">Total Tokens Processed</span>
            <div id="grandTotalText" class="text-lg font-black text-emerald-400">0</div>
            <div class="text-[10px] muted-color">Saved: <span id="costSavedVal" class="text-emerald-400 font-semibold">$0.00</span> with cache</div>
          </div>
        </div>

        <!-- 4 KPI Cards -->
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div class="p-2.5 inner-bg border border-color rounded-lg">
            <div class="text-[10px] muted-color">Context Window</div>
            <div id="kpiContext" class="text-base font-bold text-amber-400">0 / 255k</div>
            <div id="kpiContextSub" class="text-[10px] muted-color">0% Fill (255k left)</div>
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
              <span class="text-red-400 font-medium">255k Limit</span>
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
                <span class="font-medium text-red-400 font-mono">255k limit</span>
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
    <div id="listView" class="hidden p-3 card-bg border border-color rounded-xl space-y-3">
      <div class="flex items-center justify-between">
        <h3 class="text-xs font-bold uppercase tracking-wider text-[var(--vscode-editor-foreground,#f4f4f5)]">Conversation History (${conversations.length} sessions)</h3>
        <span class="text-[10px] muted-color">Click any session to view its telemetry</span>
      </div>

      <!-- Orphan / Ghost Chats Warning Banner -->
      <div id="orphanBanner" class="hidden p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 flex items-center justify-between gap-2 text-xs text-amber-300">
        <div class="flex items-center gap-1.5">
          <span>⚠️</span>
          <span>Found <strong id="orphanCount">0</strong> dead ghost chat(s) taking <strong id="orphanDisk">0 MB</strong>.</span>
        </div>
        <button onclick="purgeOrphans()" class="px-2.5 py-1 rounded bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 border border-amber-500/40 text-[11px] font-semibold transition-colors flex items-center gap-1">
          🧹 Purge Ghost Chats
        </button>
      </div>

      <input id="searchInput" type="text" placeholder="Search sessions by title or ID..." 
        class="w-full px-3 py-2 text-xs inner-bg border border-color rounded-lg text-[var(--vscode-editor-foreground,#f4f4f5)] placeholder-[var(--vscode-input-placeholderForeground,#71717a)] focus:outline-none focus:border-blue-500"
        oninput="filterList()" />

      <div id="convList" class="space-y-1.5 max-h-[600px] overflow-y-auto pr-1 custom-scrollbar">
        <!-- Populated by JS -->
      </div>
    </div>

  </div>

  <!-- Modal for Deleting Conversation -->
  <div id="deleteModal" class="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4 hidden">
    <div class="card-bg border border-red-500/40 rounded-xl p-4 max-w-md w-full space-y-3 shadow-2xl">
      <div class="flex items-center gap-2 text-red-400 font-bold text-sm">
        <span class="text-base">🗑️</span>
        <span>Permanently Delete Conversation</span>
      </div>
      <p class="text-xs text-[var(--vscode-editor-foreground,#f4f4f5)]">
        Are you sure you want to permanently erase <strong id="delModalTitle" class="text-white"></strong>?
      </p>
      <div id="delModalActiveWarning" class="hidden p-2 rounded bg-amber-500/15 border border-amber-500/30 text-[11px] text-amber-300">
        ⚠️ This is the currently active chat in Antigravity. Deleting it will terminate this session.
      </div>
      <div class="text-[11px] muted-color space-y-1 p-2.5 inner-bg rounded-lg border border-color">
        <div class="text-[10px] uppercase font-bold text-red-400/90 mb-1">Storage to be permanently wiped:</div>
        <div>• SQLite conversation database (<code class="text-zinc-300 font-mono">conversations/*.db</code>)</div>
        <div>• Transcripts, artifacts & media (<code class="text-zinc-300 font-mono">brain/*</code> folder)</div>
        <div>• Summary records & annotations (<code class="text-zinc-300 font-mono">*.pbtxt</code>)</div>
        <div class="text-emerald-400 font-medium pt-1.5 border-t border-color flex justify-between">
          <span>Storage to be reclaimed:</span>
          <span id="delModalSize" class="font-bold">-- MB</span>
        </div>
      </div>
      <div class="flex justify-end gap-2 pt-1">
        <button onclick="closeDeleteModal()" class="px-3 py-1.5 rounded text-xs inner-bg border border-color muted-color hover:text-white transition-colors">
          Cancel
        </button>
        <button id="delModalConfirmBtn" onclick="confirmDeleteExec()" class="px-3 py-1.5 rounded text-xs bg-red-600 hover:bg-red-500 text-white font-semibold transition-colors flex items-center gap-1.5 shadow-sm">
          🗑️ Delete Permanently
        </button>
      </div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let CONVERSATIONS = ${JSON.stringify(conversations)};
    let selectedId = "${activeId || (conversations[0] ? conversations[0].id : '')}";
    let currentActiveId = "${activeId || ''}";
    let currentTab = 'detail';
    let currentTimeline = [];
    let pendingDeleteId = null;

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg && msg.type === 'telemetryUpdate') {
        CONVERSATIONS = msg.data;
        if (msg.activeId) {
          currentActiveId = msg.activeId;
        }
        if (!CONVERSATIONS.some(c => c.id === selectedId)) {
          selectedId = currentActiveId || (CONVERSATIONS[0] ? CONVERSATIONS[0].id : '');
        }
        updateGlobalHeaders();
        populateDropdown();
        filterList();
        renderDetail();
      }
    });

    function updateGlobalHeaders() {
      let gInput = 0, gCached = 0, gOutput = 0;
      for (const c of CONVERSATIONS) {
        if (!c.stats) continue;
        gInput += c.stats.totalInput || 0;
        gCached += c.stats.totalCached || 0;
        gOutput += c.stats.totalOutput || 0;
      }
      const gTot = gInput + gOutput;
      const gHit = gInput > 0 ? ((gCached / gInput) * 100).toFixed(1) : '0.0';
      const elTot = document.getElementById('headerTotalTokens');
      const elHit = document.getElementById('headerHitRate');
      if (elTot) elTot.textContent = (gTot / 1_000_000).toFixed(1) + 'M tok';
      if (elHit) elHit.textContent = gHit + '%';
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
      select.innerHTML = '';
      CONVERSATIONS.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.id;
        const isAct = c.id === currentActiveId ? ' (ACTIVE)' : '';
        const orphanMark = c.isOrphan ? ' [GHOST]' : '';
        const tokM = c.stats ? (c.stats.grandTotal / 1_000_000).toFixed(1) + 'M' : '0';
        const hit = c.stats ? c.stats.cacheHitRate + '%' : '0%';
        const sz = c.storageMB ? c.storageMB + 'MB · ' : '';
        opt.textContent = (c.title || 'Untitled') + isAct + orphanMark + ' — ' + sz + tokM + ' tok (' + hit + ' cache)';
        if (c.id === selectedId) opt.selected = true;
        select.appendChild(opt);
      });
    }

    function selectConv(id) {
      selectedId = id;
      const select = document.getElementById('chatSelect');
      if (select) select.value = id;
      renderDetail();
      if (currentTab === 'list') {
        switchTab('detail');
      }
    }

    function renderList(items) {
      const container = document.getElementById('convList');
      container.innerHTML = '';
      if (!items || items.length === 0) {
        container.innerHTML = '<div class="text-xs muted-color p-4 text-center">No sessions found</div>';
        return;
      }
      items.forEach(c => {
        const isSel = c.id === selectedId;
        const isAct = c.id === currentActiveId;
        const div = document.createElement('div');
        div.className = 'p-2.5 rounded-lg cursor-pointer transition-all border ' + (
          isSel 
            ? 'bg-blue-500/15 border-blue-500/40 text-[var(--vscode-editor-foreground,#f4f4f5)] shadow-sm' 
            : 'inner-bg border-transparent hover:border-color muted-color hover:text-[var(--vscode-editor-foreground,#f4f4f5)]'
        );
        div.onclick = () => selectConv(c.id);

        const title = c.title || 'Untitled';
        const totalM = c.stats ? (c.stats.grandTotal / 1_000_000).toFixed(1) : '0';
        const hitRate = c.stats ? c.stats.cacheHitRate : '0';
        const storageMB = c.storageMB ? c.storageMB + ' MB' : '-- MB';
        const isOrphan = Boolean(c.isOrphan);
        const orphanBadge = isOrphan ? '<span class="text-[9px] font-bold px-1 rounded bg-amber-500/20 text-amber-300 shrink-0">GHOST</span>' : '';

        div.innerHTML = 
          '<div class="flex items-center justify-between gap-1 mb-1">' +
            '<div class="flex items-center gap-1.5 truncate max-w-[280px]">' +
              '<span class="font-medium text-xs truncate ' + (isSel ? 'text-blue-300 font-semibold' : 'text-[var(--vscode-editor-foreground,#f4f4f5)]') + '">' + escapeHtml(title) + '</span>' +
              orphanBadge +
            '</div>' +
            '<div class="flex items-center gap-1.5 shrink-0">' +
              (isAct ? '<span class="text-[9px] font-bold px-1 rounded bg-emerald-500/20 text-emerald-400">ACTIVE</span>' : '') +
              '<span class="text-[10px] font-bold px-1.5 py-0.5 rounded ' + (hitRate > 90 ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400') + '">' + hitRate + '%</span>' +
              '<button class="del-btn p-1 rounded hover:bg-red-500/20 text-zinc-400 hover:text-red-400 transition-colors text-xs" title="Permanently wipe this conversation and free disk space">🗑️</button>' +
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

        container.appendChild(div);
      });
    }

    function escapeHtml(str) {
      if (!str) return '';
      return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function filterList() {
      const orphans = CONVERSATIONS.filter(c => c.isOrphan);
      const banner = document.getElementById('orphanBanner');
      if (banner) {
        if (orphans.length > 0) {
          banner.classList.remove('hidden');
          document.getElementById('orphanCount').textContent = orphans.length;
          const totDisk = orphans.reduce((sum, o) => sum + (parseFloat(o.storageMB) || 0), 0).toFixed(1);
          document.getElementById('orphanDisk').textContent = totDisk + ' MB';
        } else {
          banner.classList.add('hidden');
        }
      }

      const q = (document.getElementById('searchInput').value || '').toLowerCase();
      const filtered = CONVERSATIONS.filter(c => 
        (c.title || '').toLowerCase().includes(q) || (c.id || '').toLowerCase().includes(q)
      );
      renderList(filtered);
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

    function purgeOrphans() {
      const orphans = CONVERSATIONS.filter(c => c.isOrphan);
      if (orphans.length === 0) return;
      vscode.postMessage({ command: 'purgeOrphaned' });
    }

    function renderDetail() {
      const conv = CONVERSATIONS.find(c => c.id === selectedId) || CONVERSATIONS[0];
      if (!conv || !conv.stats) return;

      const s = conv.stats;
      document.getElementById('chatTitle').textContent = conv.title || 'Untitled Conversation';
      document.getElementById('chatBadge').textContent = s.modelName || 'gemini-3.8-flash';
      document.getElementById('chatMeta').textContent = 'ID: ' + conv.id + ' · Active: ' + (conv.lastModified ? new Date(conv.lastModified).toLocaleDateString() : 'Recent');
      document.getElementById('grandTotalText').textContent = s.grandTotal.toLocaleString();

      if (conv.id === currentActiveId) {
        document.getElementById('activePill').classList.remove('hidden');
      } else {
        document.getElementById('activePill').classList.add('hidden');
      }

      // Ghost Pill and Disk Badges
      const ghostEl = document.getElementById('ghostPill');
      if (ghostEl) {
        if (conv.isOrphan) ghostEl.classList.remove('hidden');
        else ghostEl.classList.add('hidden');
      }
      const diskEl = document.getElementById('chatDiskVal');
      if (diskEl) diskEl.textContent = (conv.storageMB || '0.0') + ' MB';

      // Compact Cost Badges
      const costEl = document.getElementById('costVal');
      if (costEl) costEl.textContent = '$' + (s.estimatedCost || '0.00');
      const savedEl = document.getElementById('costSavedVal');
      if (savedEl) savedEl.textContent = '$' + (s.costSaved || '0.00');

      // 4 Top KPI Cards
      const tot = s.grandTotal || 1;
      const lastContext = s.currentContext || (s.contextTimeline && s.contextTimeline.length > 0 ? s.contextTimeline[s.contextTimeline.length - 1].input : s.peakContext);
      const contextLimit = 255000;
      const contextPct = Math.min(100, Math.round((lastContext / contextLimit) * 100));
      const headroom = Math.max(0, contextLimit - lastContext);

      // Card 1: Context Window
      document.getElementById('kpiContext').textContent = formatTok(lastContext) + ' / 255k';
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
      document.getElementById('kpiOutputSub').textContent = 'Avg ' + (s.avgOutput || 0).toLocaleString() + ' tok / call';

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
        document.getElementById('metaLastContext').textContent = formatTok(lt.totalInput) + ' tok';
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

      // Card 4: Session Peaks
      const peakPct = Math.min(100, Math.round(((s.peakContext || 0) / 255000) * 100));
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

      // Compaction ceiling calibrated to 255,000 tokens
      const ceilingTokens = 255000;
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

      // 255k Limit Dashed Guideline
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
        ceilingLabel.textContent = '255k Compaction Limit';
        svg.appendChild(ceilingLabel);
      }

      // Compute Point Coordinates
      const points = timeline.map((pt, i) => {
        const x = timeline.length === 1 
          ? padLeft + chartW / 2 
          : padLeft + (i / (timeline.length - 1)) * chartW;
        const yContext = padTop + chartH - (pt.input / maxVal) * chartH;
        const yCached = padTop + chartH - ((pt.cached || 0) / maxVal) * chartH;
        return { x, yContext, yCached, pt };
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
        document.getElementById('ttContext').textContent = pt.input.toLocaleString() + ' tok (' + pctCeil + '% of 255k)';
        document.getElementById('ttCached').textContent = (pt.cached || 0).toLocaleString() + ' tok (' + (pt.input > 0 ? ((pt.cached / pt.input) * 100).toFixed(0) : 0) + '%)';
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

    populateDropdown();
    filterList();
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
