const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const {
  readAllTelemetry,
  getInstallationRoots,
  setDataSource,
  deleteConversation,
  conversationMatchesWorkspace,
  selectActiveConversation,
  setCustomSqlitePath,
  dumpAnalysisCache,
  loadAnalysisCache,
  isCacheDirty,
  resetCacheDirty,
  prepareConversationsForWebview
} = require('./telemetryReader');
const { getDashboardHtml } = require('./dashboardHtml');

let statusBarItem = null;
let currentPanel = null;
let telemetryState = { conversations: [], active: null };
let activeWatchers = [];
let refreshTimer = null;
let isRefreshing = false;      // re-entrancy guard: watcher + timer + manual refresh must not stack
let lastStatusText = '';
let logChannel = null;
let extensionUri = null;
let extensionContext = null;
let catalogWarningLogged = false;
let sqliteWarningLogged = false;

function log(message) {
  if (!logChannel) logChannel = vscode.window.createOutputChannel('Antigravity Telemetry');
  logChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
}

function getDetectedEditorEnvironment() {
  const appName = (vscode.env && vscode.env.appName) || '';
  const uriScheme = (vscode.env && vscode.env.uriScheme) || '';
  const execPath = process.execPath || '';
  if (/antigravity/i.test(appName) || /antigravity/i.test(uriScheme) || /antigravity/i.test(execPath)) {
    return 'ide';
  }
  return 'extension';
}

function getConfig() {
  const cfg = vscode.workspace.getConfiguration('antigravity');
  return {
    deleteToRecycleBin: cfg.get('deleteToRecycleBin', true),
    workspaceFilter: cfg.get('workspaceFilter', 'current'),
    sqlitePath: cfg.get('sqlitePath', ''),
    dataSource: cfg.get('dataSource', 'auto'),
    enableCache: cfg.get('enableCache', true)
  };
}

function getCurrentWorkspaceFolders() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return [];
  return folders.map(f => path.normalize(f.uri.fsPath).toLowerCase());
}

function getCurrentWorkspaceName() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return '';
  return folders[0].name || path.basename(folders[0].uri.fsPath);
}

function getVisibleConversations(scope) {
  const filter = scope || getConfig().workspaceFilter;
  if (filter === 'all') {
    return telemetryState.conversations;
  }
  const currentFolders = getCurrentWorkspaceFolders();
  if (currentFolders.length === 0) {
    return telemetryState.conversations;
  }
  return telemetryState.conversations.filter(c => conversationMatchesWorkspace(c, currentFolders));
}

function getActiveConversation() {
  const visible = getVisibleConversations();
  return selectActiveConversation(visible);
}

function formatTokens(num) {
  if (!num || isNaN(num)) return '0';
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
  if (num >= 1_000) return (num / 1_000).toFixed(0) + 'k';
  return String(num);
}

let lastTelemetrySignature = '';
let activeWebviewConvId = null;
let cacheSaveTimer = null;

function computeTelemetrySignature(state) {
  if (!state || !state.conversations) return '';
  const convs = state.conversations;
  const parts = [
    String(convs.length),
    state.active ? state.active.id : '',
    state.sqliteAvailable ? '1' : '0',
    state.catalogAvailable ? '1' : '0'
  ];
  for (const c of convs) {
    const s = c.stats;
    parts.push(`${c.id}:${c.mtimeMs}:${s ? s.calls : 0}:${s ? s.grandTotal : 0}:${c.isRunning ? 1 : 0}:${c.title}`);
  }
  return parts.join('|');
}

function getCacheFilePath() {
  if (extensionContext && extensionContext.globalStorageUri) {
    const storageDir = extensionContext.globalStorageUri.fsPath;
    if (!fs.existsSync(storageDir)) {
      try {
        fs.mkdirSync(storageDir, { recursive: true });
      } catch (err) {
        log(`Failed to create storage directory ${storageDir}: ${err.message}`);
      }
    }
    return path.join(storageDir, 'telemetry-cache.json');
  }
  return null;
}

function restoreCacheFromDisk() {
  if (!getConfig().enableCache) {
    // If user disabled persistent cache, remove any stale on-disk file
    const filePath = getCacheFilePath();
    if (filePath && fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch { }
    }
    return;
  }

  // 1. Migrate legacy cache from globalState if present from v1.1.0
  if (extensionContext && extensionContext.globalState) {
    try {
      const legacyStateCache = extensionContext.globalState.get('telemetryAnalysisCache');
      if (legacyStateCache) {
        // Clean up legacy key so it stops occupying RPC/database space over Remote SSH
        extensionContext.globalState.update('telemetryAnalysisCache', undefined);
        loadAnalysisCache(legacyStateCache);
        flushCacheToDisk();
        return;
      }
    } catch { }
  }

  // 2. Read from isolated local extension storage on disk (0 network bytes across Remote SSH)
  const filePath = getCacheFilePath();
  if (filePath && fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const data = JSON.parse(raw);
      loadAnalysisCache(data);
    } catch (err) {
      log(`Failed to read telemetry cache from disk: ${err.message}`);
    }
  }
}

function scheduleSaveCache() {
  if (!getConfig().enableCache) return;
  if (cacheSaveTimer) return;
  cacheSaveTimer = setTimeout(() => {
    cacheSaveTimer = null;
    flushCacheToDisk();
  }, 3000);
}

function flushCacheToDisk() {
  if (cacheSaveTimer) {
    clearTimeout(cacheSaveTimer);
    cacheSaveTimer = null;
  }
  if (!getConfig().enableCache) return;
  if (!isCacheDirty()) return;
  const filePath = getCacheFilePath();
  if (!filePath) return;
  try {
    const dump = dumpAnalysisCache();
    const json = JSON.stringify(dump);
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, json, 'utf8');
    fs.renameSync(tmpPath, filePath);
    resetCacheDirty();
  } catch (err) {
    log(`Failed to write telemetry cache to disk: ${err.message}`);
  }
}

function updateTelemetry(options = {}) {
  const force = Boolean(options && options.force);
  // A full scan can take ~2s on a cold cache; without this guard the file watcher, the poll
  // timer and a manual refresh can all queue up behind each other.
  if (isRefreshing) return;
  isRefreshing = true;
  try {
    const cfg = getConfig();
    const hostEditor = getDetectedEditorEnvironment();
    setCustomSqlitePath(cfg.sqlitePath);
    setDataSource(cfg.dataSource);
    telemetryState = readAllTelemetry({ dataSource: cfg.dataSource, hostEditor, force });

    if (telemetryState.sqliteAvailable === false) {
      if (!sqliteWarningLogged) {
        sqliteWarningLogged = true;
        log('The sqlite3 CLI executable was not found. Configure antigravity.sqlitePath in settings.');
        vscode.window.showErrorMessage(
          'Antigravity Telemetry requires the sqlite3 CLI to read chat databases, but it was not found.',
          'Set Path',
          'Show Logs'
        ).then(choice => {
          if (choice === 'Set Path') promptSetSqlitePath();
          else if (choice === 'Show Logs') logChannel.show();
        });
      }
    } else {
      sqliteWarningLogged = false;
    }

    if (telemetryState.catalogAvailable === false && !catalogWarningLogged) {
      catalogWarningLogged = true;
      log('The conversation catalog (conversation_summaries.db) could not be read. Chat titles are ' +
        'unavailable and orphan detection is disabled until it can be read again.');
    }

    const signature = computeTelemetrySignature(telemetryState);
    const hasChanged = signature !== lastTelemetrySignature;
    lastTelemetrySignature = signature;

    if (hasChanged || force) {
      updateStatusBar();

      // Only post to webview if panel exists AND is currently visible in the editor group
      if (currentPanel && currentPanel.visible) {
        const active = getActiveConversation();
        const activeId = active ? active.id : (telemetryState.active ? telemetryState.active.id : null);
        const targetId = activeWebviewConvId || activeId;
        const payloadData = prepareConversationsForWebview(telemetryState.conversations, targetId);

        currentPanel.webview.postMessage({
          type: 'telemetryUpdate',
          data: payloadData,
          activeId: targetId,
          currentWorkspaceName: getCurrentWorkspaceName(),
          currentWorkspacePaths: getCurrentWorkspaceFolders()
        });
      }

      if (isCacheDirty()) {
        scheduleSaveCache();
      }
    }
  } catch (err) {
    log(`Refresh failed: ${err && err.stack ? err.stack : err}`);
  } finally {
    isRefreshing = false;
  }
}

// Reports a deletion outcome honestly: nothing is announced as freed unless it really is gone,
// and anything Windows refused to delete is surfaced instead of being swallowed.
async function reportDeleteResult(result, label, recycled) {
  const mb = (result.freedBytes / (1024 * 1024)).toFixed(1);
  const name = label || result.conversationId;

  if (result.failures.length === 0) {
    if (result.deletedItems.length === 0) {
      vscode.window.showInformationMessage(`Nothing to delete for "${name}" — no local files were found.`);
    } else if (recycled) {
      vscode.window.showInformationMessage(`Moved "${name}" to the Recycle Bin (${mb} MB recoverable).`);
    } else {
      vscode.window.showInformationMessage(`Permanently deleted "${name}" (freed ${mb} MB).`);
    }
    return;
  }

  for (const f of result.failures) log(`Delete failure: ${f.path} — ${f.reason}`);
  const detail = result.databaseRemoved
    ? 'Its database was removed but other files are still locked, so the chat may no longer open in Antigravity.'
    : 'The catalog entry was kept, so the chat still appears as a ghost rather than a half-deleted chat.';
  const choice = await vscode.window.showWarningMessage(
    `Could not fully delete "${name}": ${result.failures.length} item(s) are locked or in use. ${detail}`,
    'Show Details'
  );
  if (choice === 'Show Details') logChannel.show();
}

// Writing identical text or tooltip makes VS Code re-layout the status bar and dismiss/flicker
// hover widgets, so only mutate properties when their actual values change.
let lastStatusTooltip = '';
let lastStatusBgColor = null;
let lastStatusCommand = '';
let isStatusBarShown = false;

function setStatusText(text) {
  if (text === lastStatusText) return;
  lastStatusText = text;
  statusBarItem.text = text;
}

function setStatusTooltip(md) {
  const value = md ? (typeof md === 'string' ? md : md.value) : '';
  if (value === lastStatusTooltip) return;
  lastStatusTooltip = value;
  statusBarItem.tooltip = md;
}

function setStatusBackgroundColor(color) {
  if (color === lastStatusBgColor) return;
  lastStatusBgColor = color;
  statusBarItem.backgroundColor = color;
}

function setStatusCommand(cmd) {
  if (cmd === lastStatusCommand) return;
  lastStatusCommand = cmd;
  statusBarItem.command = cmd;
}

function ensureStatusBarShown() {
  if (!isStatusBarShown) {
    statusBarItem.show();
    isStatusBarShown = true;
  }
}

function updateStatusBar() {
  if (!statusBarItem) return;

  if (telemetryState && telemetryState.sqliteAvailable === false) {
    setStatusCommand('antigravity.setSqlitePath');
    setStatusText('$(error) Antigravity: sqlite3 missing');
    setStatusTooltip('sqlite3 CLI not found. Click to set sqlite3 path.');
    setStatusBackgroundColor(new vscode.ThemeColor('statusBarItem.errorBackground'));
    ensureStatusBarShown();
    return;
  }

  setStatusCommand('antigravity.showMenu');
  const active = getActiveConversation();
  if (!active || !active.stats) {
    setStatusText('Antigravity: Idle');
    const isFiltered = getConfig().workspaceFilter === 'current' && getCurrentWorkspaceFolders().length > 0;
    setStatusTooltip(isFiltered
      ? `No active conversation found for workspace "${getCurrentWorkspaceName()}". Click to open menu.`
      : 'No active conversation found. Click to open menu.');
    setStatusBackgroundColor(undefined);
    ensureStatusBarShown();
    return;
  }

  const s = active.stats;
  const rawTitle = (active.title || 'Chat').trim();
  const firstWord = rawTitle.split(/\s+/)[0] || 'Chat';
  const shortTitle = firstWord.length > 16 ? firstWord.substring(0, 14) + '..' : firstWord;

  const contextLimit = (s && s.contextLimit) || 256_000;
  const currentContext = (s && (s.contextTokens != null ? s.contextTokens : s.currentContext)) || 0;
  const contextPct = Math.min(100, Math.round((currentContext / contextLimit) * 100));
  const shortContext = formatTokens(currentContext);
  const limitStr = formatTokens(contextLimit);

  // Status Bar Text: essential info only (Title | Context | Cache)
  setStatusText(`${shortTitle} | ${shortContext} (${contextPct}%) · ${s.cacheHitRate}% cache`);

  // Native status bar styling (no background coloring based on context)
  setStatusBackgroundColor(undefined);

  // Markdown Tooltip: compact, clutter-free layout
  const filledBlocks = Math.min(12, Math.round((currentContext / contextLimit) * 12));
  const emptyBlocks = 12 - filledBlocks;
  const progressBar = '█'.repeat(filledBlocks) + '░'.repeat(emptyBlocks);

  const md = new vscode.MarkdownString('', true);
  md.supportThemeIcons = true;
  // Only our own registered commands may be invoked from the tooltip.
  md.isTrusted = {
    enabledCommands: ['antigravity.showMenu', 'antigravity.openDashboard', 'antigravity.refresh']
  };

  const wsBadge = active.workspaceName ? ` \`[${active.workspaceName}]\`` : '';
  const agentPrefix = active.isSubagent ? `$(hubot) [${active.agentName || 'subagent'}] ` : '';

  md.appendMarkdown(`**${agentPrefix}${active.title}**${wsBadge}\n\n`);
  md.appendMarkdown(`* **Context Usage:** \`${shortContext} / ${limitStr}\` (${contextPct}%)\n`);
  md.appendMarkdown(`* **Window Meter:** \`[${progressBar}]\`\n`);
  md.appendMarkdown(`* **Cache Read:** **${formatTokens(s.totalCached)}** (${s.cacheVolumeRate}% vol · ${s.cacheHitRate}% hits)\n`);
  md.appendMarkdown(`* **Uncached Input:** **${formatTokens(s.totalNonCached)}** (fresh prompt)\n`);
  md.appendMarkdown(`* **Model Output:** **${formatTokens(s.totalOutput)}** tokens\n\n`);
  md.appendMarkdown(`---\n`);
  md.appendMarkdown(`*Click to open Telemetry Menu or Visual Dashboard*`);

  setStatusTooltip(md);
  ensureStatusBarShown();
}

async function promptSetSqlitePath() {
  const current = getConfig().sqlitePath;
  const input = await vscode.window.showInputBox({
    prompt: 'Enter the full path to the sqlite3 CLI executable (leave empty for auto-detect)',
    value: current || '',
    placeHolder: 'C:\\path\\to\\sqlite3.exe'
  });
  if (input !== undefined) {
    const trimmed = input.trim();
    await vscode.workspace.getConfiguration('antigravity').update('sqlitePath', trimmed, vscode.ConfigurationTarget.Global);
    log(`Updated antigravity.sqlitePath to: ${trimmed || '(auto-detect)'}`);
    setCustomSqlitePath(trimmed);
    vscode.window.showInformationMessage(`Antigravity sqlite3 path updated to: ${trimmed || '(auto-detect)'}`);
    updateTelemetry();
  }
}

async function showMenu() {
  if (telemetryState && telemetryState.sqliteAvailable === false) {
    const choice = await vscode.window.showQuickPick([
      {
        label: '$(error) sqlite3 executable not found',
        description: 'Configure path to sqlite3.exe CLI',
        action: 'setSqlitePath'
      },
      {
        label: '$(output) Show Logs',
        description: 'Open Antigravity Telemetry OutputChannel',
        action: 'showLogs'
      }
    ], { placeHolder: 'sqlite3 CLI not found — telemetry unavailable' });
    if (choice) {
      if (choice.action === 'setSqlitePath') promptSetSqlitePath();
      else if (choice.action === 'showLogs') logChannel.show();
    }
    return;
  }

  const active = getActiveConversation();
  const activeTitle = active ? active.title : 'No active chat';
  const activeStats = active && active.stats ? active.stats : null;

  const currentContext = activeStats ? formatTokens(activeStats.currentContext) : '0';
  const readTok = activeStats ? formatTokens(activeStats.totalCached) : '0';
  const writeTok = activeStats ? formatTokens(activeStats.totalNonCached) : '0';
  const outTok = activeStats ? formatTokens(activeStats.totalOutput) : '0';
  const visible = getVisibleConversations();
  const convCount = visible.length;
  const recycle = getConfig().deleteToRecycleBin;
  const wsFilter = getConfig().workspaceFilter;
  const wsName = getCurrentWorkspaceName();
  const filterDesc = wsFilter === 'current' && wsName ? ` (${wsName})` : '';

  const items = [
    {
      label: `$(pulse) Active: ${activeTitle}`,
      description: `Context: ${currentContext} · Read: ${readTok} · Write: ${writeTok} · Output: ${outTok}`,
      action: 'activeDetail'
    },
    {
      label: '$(graph) Open Full Visual Dashboard',
      description: 'Spacious editor tab with live SVG charts & context timeline',
      action: 'openDashboard'
    },
    {
      label: `$(history) Browse Past Conversations (${convCount} sessions${filterDesc})...`,
      description: `Search and inspect previous chat telemetry${filterDesc ? ` in ${wsName}` : ''}`,
      action: 'browseHistory'
    },
    {
      label: recycle ? '$(trash) Delete a Conversation (Move to Recycle Bin)...' : '$(trash) Delete a Conversation (Free Disk Space)...',
      description: recycle ? 'Remove a conversation — its files go to the Recycle Bin' : 'Permanently wipe a conversation and all its stored files',
      action: 'deleteConv'
    }
  ];

  const host = getDetectedEditorEnvironment();
  const currentSourceSetting = getConfig().dataSource;
  const activeSourceName = currentSourceSetting === 'auto'
    ? `Auto (${host === 'ide' ? 'Antigravity IDE' : 'Antigravity Extension'})`
    : (currentSourceSetting === 'ide' ? 'Antigravity IDE' : (currentSourceSetting === 'extension' ? 'Antigravity Extension' : 'Both (Merged)'));

  items.push({
    label: `$(database) Data Source: ${activeSourceName}...`,
    description: 'Switch data source between Antigravity IDE, Antigravity Extension, or Both',
    action: 'switchDataSource'
  });

  items.push({
    label: '$(gear) Configure sqlite3 Path...',
    description: getConfig().sqlitePath ? `Current: ${getConfig().sqlitePath}` : 'Auto-detecting from system PATH and common locations',
    action: 'setSqlitePath'
  });

  const cacheActive = getConfig().enableCache;
  items.push({
    label: `$(archive) Persistent Startup Cache: ${cacheActive ? 'Enabled' : 'Disabled'}`,
    description: cacheActive ? 'Sub-50ms instant startup cache is active. Click to disable.' : 'Persistent cache disabled (fresh scan on startup). Click to enable.',
    action: 'toggleCache'
  });

  items.push({
    label: '$(sync) Refresh Telemetry Now',
    description: 'Re-scan local databases for latest turn data',
    action: 'refresh'
  });

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Antigravity Telemetry: Select an option'
  });

  if (!selected) return;

  if (selected.action === 'openDashboard') {
    openDashboard();
  } else if (selected.action === 'refresh') {
    updateTelemetry();
    vscode.window.showInformationMessage('Antigravity Telemetry refreshed.');
  } else if (selected.action === 'activeDetail') {
    openDashboard(active ? active.id : null);
  } else if (selected.action === 'browseHistory') {
    showHistoryPicker();
  } else if (selected.action === 'deleteConv') {
    promptDeleteConversation();
  } else if (selected.action === 'switchDataSource') {
    promptSwitchDataSource();
  } else if (selected.action === 'setSqlitePath') {
    promptSetSqlitePath();
  } else if (selected.action === 'toggleCache') {
    const nextVal = !getConfig().enableCache;
    await vscode.workspace.getConfiguration('antigravity').update('enableCache', nextVal, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`Antigravity persistent cache ${nextVal ? 'enabled' : 'disabled'}.`);
  }
}

async function promptSwitchDataSource() {
  const current = getConfig().dataSource;
  const host = getDetectedEditorEnvironment();
  const options = [
    {
      label: `${current === 'auto' ? '$(check) ' : ''}Auto (Active Editor)`,
      description: `Automatically loads ${host === 'ide' ? 'Antigravity IDE' : 'Antigravity Extension'} based on the current window`,
      value: 'auto'
    },
    {
      label: `${current === 'ide' ? '$(check) ' : ''}Antigravity IDE`,
      description: 'Show conversations from standalone Antigravity IDE (~/.gemini/antigravity-ide)',
      value: 'ide'
    },
    {
      label: `${current === 'extension' ? '$(check) ' : ''}Antigravity Extension`,
      description: 'Show conversations from Antigravity Extension in VS Code (~/.gemini/antigravity)',
      value: 'extension'
    },
    {
      label: `${current === 'both' ? '$(check) ' : ''}Both (Merged)`,
      description: 'Merge conversations from both Antigravity IDE and Antigravity Extension',
      value: 'both'
    }
  ];

  const picked = await vscode.window.showQuickPick(options, {
    placeHolder: 'Select Antigravity Telemetry Data Source'
  });

  if (picked) {
    await vscode.workspace.getConfiguration('antigravity').update('dataSource', picked.value, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`Antigravity Telemetry data source set to: ${picked.label.replace('$(check) ', '')}`);
    updateTelemetry();
  }
}

async function showHistoryPicker() {
  const convs = getVisibleConversations();
  if (!convs || convs.length === 0) {
    const wsName = getCurrentWorkspaceName();
    vscode.window.showInformationMessage(
      wsName ? `No Antigravity conversations found for workspace "${wsName}".` : 'No Antigravity conversations found.'
    );
    return;
  }

  const active = getActiveConversation();
  const items = convs.map(c => {
    const s = c.stats;
    const isAct = active && active.id === c.id;
    const badge = isAct ? ' (ACTIVE)' : '';
    const wsBadge = c.workspaceName ? ` [${c.workspaceName}]` : '';
    const dateStr = c.lastModified ? new Date(c.lastModified).toLocaleString() : '';

    const prefix = c.isSubagent ? `[${c.agentName || 'subagent'}] ` : '';
    const icon = c.isSubagent ? '$(hubot)' : '$(comment-discussion)';

    return {
      label: `${icon} ${prefix}${c.title || 'Untitled'}${wsBadge}${badge}`,
      description: `${formatTokens(s ? s.grandTotal : 0)} tok · ${s ? s.cacheHitRate : 0}% cache · ${s ? s.calls : 0} calls`,
      detail: `Peak Context: ${formatTokens(s ? s.peakContext : 0)} | Last Active: ${dateStr}`,
      convId: c.id
    };
  });

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Search conversation history by title, ID, or tokens...'
  });

  if (selected) {
    openDashboard(selected.convId);
  }
}

async function promptDeleteConversation() {
  const convs = getVisibleConversations();
  if (!convs || convs.length === 0) {
    const wsName = getCurrentWorkspaceName();
    vscode.window.showInformationMessage(
      wsName ? `No Antigravity conversations found for workspace "${wsName}".` : 'No Antigravity conversations found.'
    );
    return;
  }

  const active = getActiveConversation();
  const items = convs.map(c => {
    const s = c.stats;
    const isAct = active && active.id === c.id;
    const badge = isAct ? ' (ACTIVE)' : '';
    const wsBadge = c.workspaceName ? ` [${c.workspaceName}]` : '';
    const dateStr = c.lastModified ? new Date(c.lastModified).toLocaleString() : '';
    const prefix = c.isSubagent ? `[${c.agentName || 'subagent'}] ` : '';

    return {
      label: `$(trash) ${prefix}${c.title || 'Untitled'}${wsBadge}${badge}`,
      description: `${c.storageMB} MB · ${formatTokens(s ? s.grandTotal : 0)} tok`,
      detail: `ID: ${c.id} | Last Active: ${dateStr}`,
      convId: c.id,
      convTitle: c.title
    };
  });

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a conversation to permanently delete and free disk space...'
  });

  if (!selected) return;

  const recycle = getConfig().deleteToRecycleBin;
  const confirm = await vscode.window.showWarningMessage(
    `Delete "${selected.convTitle || selected.convId}"?\n` +
    `This removes its database, brain transcripts, artifacts and summary records.` +
    (recycle ? ' Files are moved to the Recycle Bin so you can restore them.' : ' This cannot be undone.'),
    { modal: true },
    recycle ? 'Move to Recycle Bin' : 'Delete Permanently'
  );

  if (confirm) {
    try {
      const res = deleteConversation(selected.convId, { recycleBin: recycle });
      await reportDeleteResult(res, selected.convTitle, recycle);
      updateTelemetry();
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to delete conversation: ${err.message}`);
    }
  }
}

function openDashboard(selectedConvId) {
  const active = getActiveConversation();
  const targetId = selectedConvId || activeWebviewConvId || (active ? active.id : (telemetryState.conversations[0] ? telemetryState.conversations[0].id : ''));
  activeWebviewConvId = targetId;

  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.Active);
    currentPanel.webview.postMessage({
      type: 'telemetryUpdate',
      data: prepareConversationsForWebview(telemetryState.conversations, targetId),
      activeId: targetId,
      workspaceFilter: getConfig().workspaceFilter,
      currentWorkspaceName: getCurrentWorkspaceName(),
      currentWorkspacePaths: getCurrentWorkspaceFolders()
    });
    return;
  }

  const mediaRoot = extensionUri ? vscode.Uri.joinPath(extensionUri, 'media') : null;

  currentPanel = vscode.window.createWebviewPanel(
    'antigravityTelemetry',
    'Antigravity Token Intelligence',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: mediaRoot ? [mediaRoot] : []
    }
  );

  if (mediaRoot) {
    currentPanel.iconPath = vscode.Uri.joinPath(mediaRoot, 'icon.png');
  }

  currentPanel.onDidChangeViewState(e => {
    if (e.webviewPanel.visible) {
      updateTelemetry({ force: true });
    }
  });

  const cssUri = mediaRoot ? currentPanel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'dashboard.css')).toString() : '';
  const iconUri = mediaRoot ? currentPanel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'icon.png')).toString() : '';
  const nonce = Date.now().toString(36) + Math.random().toString(36).slice(2);

  currentPanel.webview.html = getDashboardHtml(
    prepareConversationsForWebview(telemetryState.conversations, targetId),
    targetId,
    {
      cssUri,
      iconUri,
      nonce,
      cspSource: currentPanel.webview.cspSource,
      deleteToRecycleBin: getConfig().deleteToRecycleBin,
      workspaceFilter: getConfig().workspaceFilter,
      currentWorkspaceName: getCurrentWorkspaceName(),
      currentWorkspacePaths: getCurrentWorkspaceFolders()
    }
  );

  currentPanel.webview.onDidReceiveMessage(async message => {
    if (message.command === 'deleteConversation') {
      const { conversationId, title } = message;
      const recycle = getConfig().deleteToRecycleBin;
      try {
        const res = deleteConversation(conversationId, { recycleBin: recycle });
        await reportDeleteResult(res, title, recycle);
        updateTelemetry({ force: true });
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to delete conversation: ${err.message}`);
      }
    } else if (message.command === 'refresh') {
      updateTelemetry({ force: true });
    } else if (message.command === 'selectConversation') {
      activeWebviewConvId = message.conversationId;
    } else if (message.command === 'getTimeline') {
      activeWebviewConvId = message.conversationId;
      const conv = telemetryState.conversations.find(c => c.id === message.conversationId);
      const timeline = (conv && conv.stats && conv.stats.contextTimeline) ? conv.stats.contextTimeline : [];
      if (currentPanel && currentPanel.visible) {
        currentPanel.webview.postMessage({
          type: 'timelineData',
          conversationId: message.conversationId,
          timeline
        });
      }
    }
  });

  currentPanel.onDidDispose(() => {
    currentPanel = null;
    activeWebviewConvId = null;
  });
}

function activate(context) {
  extensionUri = context.extensionUri;
  extensionContext = context;

  // Restore persistent telemetry cache from local extension storage (< 50ms, 0 network bytes)
  try {
    restoreCacheFromDisk();
  } catch (err) {
    log(`Failed to load persistent telemetry cache: ${err.message}`);
  }

  // Create Status Bar Item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'antigravity.showMenu';
  statusBarItem.name = 'Antigravity Telemetry';
  context.subscriptions.push(statusBarItem);

  // Register Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('antigravity.showMenu', showMenu),
    vscode.commands.registerCommand('antigravity.openDashboard', () => openDashboard()),
    vscode.commands.registerCommand('antigravity.refresh', () => {
      updateTelemetry({ force: true });
      vscode.window.showInformationMessage('Antigravity Telemetry refreshed.');
    }),
    vscode.commands.registerCommand('antigravity.deleteConversation', promptDeleteConversation),
    vscode.commands.registerCommand('antigravity.setSqlitePath', promptSetSqlitePath),
    vscode.commands.registerCommand('antigravity.showLogs', () => logChannel.show())
  );

  // Initial read
  updateTelemetry();

  function setupWatchers() {
    for (const w of activeWatchers) {
      try { w.close(); } catch { }
    }
    activeWatchers = [];

    const roots = getInstallationRoots(getConfig().dataSource, getDetectedEditorEnvironment());

    for (const root of roots) {
      // Conversation databases change on every turn. If Antigravity keeps a WAL open the write
      // lands in <id>.db-wal, so match the whole file family rather than only ".db".
      if (fs.existsSync(root.convDir)) {
        let dbDebounce = null;
        try {
          const w = fs.watch(root.convDir, (eventType, filename) => {
            if (filename && !/\.db(-wal|-shm|-journal)?$/.test(filename)) return;
            clearTimeout(dbDebounce);
            dbDebounce = setTimeout(() => updateTelemetry(), 400);
          });
          activeWatchers.push(w);
        } catch (err) {
          log(`Watcher error on ${root.convDir}: ${err.message}`);
        }
      }

      // The catalog db carries titles, step counts and the killed flag.
      if (root.summariesDb && fs.existsSync(root.antigravityDir)) {
        let summaryDebounce = null;
        try {
          const sw = fs.watch(root.antigravityDir, (eventType, filename) => {
            if (filename && path.basename(filename) !== path.basename(root.summariesDb)) return;
            clearTimeout(summaryDebounce);
            summaryDebounce = setTimeout(() => updateTelemetry(), 600);
          });
          activeWatchers.push(sw);
        } catch (err) {
          log(`Watcher error on ${root.antigravityDir}: ${err.message}`);
        }
      }

      // For Antigravity IDE, watch state.vscdb in globalStorage
      if (root.stateVscdb && fs.existsSync(root.stateVscdb)) {
        let vscdbDebounce = null;
        const vscdbDir = path.dirname(root.stateVscdb);
        try {
          const vw = fs.watch(vscdbDir, (eventType, filename) => {
            if (filename && !/^state\.vscdb/i.test(path.basename(filename))) return;
            clearTimeout(vscdbDebounce);
            vscdbDebounce = setTimeout(() => updateTelemetry(), 800);
          });
          activeWatchers.push(vw);
        } catch (err) {
          log(`Watcher error on ${vscdbDir}: ${err.message}`);
        }
      }
    }
  }

  setupWatchers();

  context.subscriptions.push({
    dispose: () => {
      for (const w of activeWatchers) {
        try { w.close(); } catch { }
      }
      activeWatchers = [];
    }
  });

  // Polling heartbeat: only while the window is focused (the watcher still covers changes
  // made from the Antigravity window), and refresh as soon as focus comes back.
  refreshTimer = setInterval(() => {
    if (!vscode.window.state.focused) return;
    updateTelemetry();
  }, 10000);

  context.subscriptions.push(
    { dispose: () => clearInterval(refreshTimer) },
    vscode.window.onDidChangeWindowState(state => {
      if (state.focused) updateTelemetry();
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('antigravity.workspaceFilter') && currentPanel) {
        currentPanel.webview.postMessage({
          type: 'workspaceFilterConfigUpdate',
          workspaceFilter: getConfig().workspaceFilter
        });
      }
      if (e.affectsConfiguration('antigravity.sqlitePath')) {
        setCustomSqlitePath(getConfig().sqlitePath);
      }
      if (e.affectsConfiguration('antigravity.enableCache')) {
        const enabled = getConfig().enableCache;
        if (!enabled) {
          const filePath = getCacheFilePath();
          if (filePath && fs.existsSync(filePath)) {
            try { fs.unlinkSync(filePath); } catch { }
          }
        } else {
          scheduleSaveCache();
        }
      }
      if (e.affectsConfiguration('antigravity.dataSource')) {
        setupWatchers();
        updateTelemetry();
      } else if (e.affectsConfiguration('antigravity')) {
        updateTelemetry();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      updateTelemetry();
    })
  );
}

function deactivate() {
  flushCacheToDisk();
  for (const w of activeWatchers) {
    try { w.close(); } catch { }
  }
  activeWatchers = [];
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  if (logChannel) { logChannel.dispose(); logChannel = null; }
}

module.exports = {
  activate,
  deactivate
};

