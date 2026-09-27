const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const {
  readAllTelemetry,
  getAntigravityPaths,
  deleteConversation,
  conversationMatchesWorkspace,
  selectActiveConversation,
  setCustomSqlitePath
} = require('./telemetryReader');
const { getDashboardHtml } = require('./dashboardHtml');

let statusBarItem = null;
let currentPanel = null;
let telemetryState = { conversations: [], active: null };
let watcher = null;
let summaryWatcher = null;
let refreshTimer = null;
let isRefreshing = false;      // re-entrancy guard: watcher + timer + manual refresh must not stack
let lastStatusText = '';
let logChannel = null;
let extensionUri = null;
let catalogWarningLogged = false;
let sqliteWarningLogged = false;

function log(message) {
  if (!logChannel) logChannel = vscode.window.createOutputChannel('Antigravity Telemetry');
  logChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
}

function getConfig() {
  const cfg = vscode.workspace.getConfiguration('antigravity');
  return {
    deleteToRecycleBin: cfg.get('deleteToRecycleBin', true),
    workspaceFilter: cfg.get('workspaceFilter', 'current'),
    sqlitePath: cfg.get('sqlitePath', '')
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

function updateTelemetry() {
  // A full scan can take ~2s on a cold cache; without this guard the file watcher, the poll
  // timer and a manual refresh can all queue up behind each other.
  if (isRefreshing) return;
  isRefreshing = true;
  try {
    setCustomSqlitePath(getConfig().sqlitePath);
    telemetryState = readAllTelemetry();

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
    updateStatusBar();
    if (currentPanel) {
      const active = getActiveConversation();
      currentPanel.webview.postMessage({
        type: 'telemetryUpdate',
        data: telemetryState.conversations,
        activeId: active ? active.id : (telemetryState.active ? telemetryState.active.id : null),
        currentWorkspaceName: getCurrentWorkspaceName(),
        currentWorkspacePaths: getCurrentWorkspaceFolders()
      });
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

// Writing identical text still makes VS Code re-layout the status bar, so only assign on change.
function setStatusText(text) {
  if (text === lastStatusText) return;
  lastStatusText = text;
  statusBarItem.text = text;
}

function updateStatusBar() {
  if (!statusBarItem) return;

  if (telemetryState && telemetryState.sqliteAvailable === false) {
    statusBarItem.command = 'antigravity.setSqlitePath';
    setStatusText('$(error) Antigravity: sqlite3 missing');
    statusBarItem.tooltip = 'sqlite3 CLI not found. Click to set sqlite3 path.';
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    statusBarItem.show();
    return;
  }

  statusBarItem.command = 'antigravity.showMenu';
  const active = getActiveConversation();
  if (!active || !active.stats) {
    setStatusText('Antigravity: Idle');
    const isFiltered = getConfig().workspaceFilter === 'current' && getCurrentWorkspaceFolders().length > 0;
    statusBarItem.tooltip = isFiltered
      ? `Antigravity Telemetry: No active conversation found for workspace "${getCurrentWorkspaceName()}".`
      : 'Antigravity Telemetry: No active conversation found.';
    statusBarItem.backgroundColor = undefined;
    statusBarItem.show();
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
  statusBarItem.backgroundColor = undefined;

  // Markdown Tooltip
  const filledBlocks = Math.min(12, Math.round((currentContext / contextLimit) * 12));
  const emptyBlocks = 12 - filledBlocks;
  const progressBar = '█'.repeat(filledBlocks) + '░'.repeat(emptyBlocks);

  const md = new vscode.MarkdownString();
  // Chat titles are user data: only our own commands may be linked from the tooltip.
  md.isTrusted = {
    enabledCommands: ['antigravity.showMenu', 'antigravity.openDashboard', 'antigravity.refresh']
  };
  md.appendMarkdown(`### ⚡ Antigravity Telemetry: Active Chat\n\n`);
  md.appendMarkdown(`**${active.title}**\n\n`);
  if (active.workspaceName) {
    md.appendMarkdown(`* **Workspace:** \`${active.workspaceName}\`\n\n`);
  }
  md.appendMarkdown(`---\n\n`);
  md.appendMarkdown(`* **Context Usage:** \`${shortContext} / ${limitStr}\` tokens (${contextPct}%)\n`);
  md.appendMarkdown(`* **Window Meter:** \`[${progressBar}]\`\n`);
  md.appendMarkdown(`* **Cache Read:** **${formatTokens(s.totalCached)}** (${s.cacheVolumeRate}% vol · ${s.cacheHitRate}% hits)\n`);
  md.appendMarkdown(`* **Cache Write:** **${formatTokens(s.totalNonCached)}** (fresh prompt)\n`);
  md.appendMarkdown(`* **Model Output:** **${formatTokens(s.totalOutput)}** tokens\n\n`);
  md.appendMarkdown(`---\n`);
  md.appendMarkdown(`*Click to open Telemetry Menu or Visual Dashboard*`);

  statusBarItem.tooltip = md;
  statusBarItem.show();
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

  items.push({
    label: '$(gear) Configure sqlite3 Path...',
    description: getConfig().sqlitePath ? `Current: ${getConfig().sqlitePath}` : 'Auto-detecting from system PATH and common locations',
    action: 'setSqlitePath'
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
  } else if (selected.action === 'setSqlitePath') {
    promptSetSqlitePath();
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

    return {
      label: `$(comment-discussion) ${c.title || 'Untitled'}${wsBadge}${badge}`,
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

    return {
      label: `$(trash) ${c.title || 'Untitled'}${wsBadge}${badge}`,
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
  const targetId = selectedConvId || (active ? active.id : (telemetryState.conversations[0] ? telemetryState.conversations[0].id : ''));

  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.Active);
    currentPanel.webview.postMessage({
      type: 'telemetryUpdate',
      data: telemetryState.conversations,
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

  const cssUri = mediaRoot ? currentPanel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'dashboard.css')).toString() : '';
  const nonce = Date.now().toString(36) + Math.random().toString(36).slice(2);

  currentPanel.webview.html = getDashboardHtml(telemetryState.conversations, targetId, {
    cssUri,
    nonce,
    cspSource: currentPanel.webview.cspSource,
    deleteToRecycleBin: getConfig().deleteToRecycleBin,
    workspaceFilter: getConfig().workspaceFilter,
    currentWorkspaceName: getCurrentWorkspaceName(),
    currentWorkspacePaths: getCurrentWorkspaceFolders()
  });

  currentPanel.webview.onDidReceiveMessage(async message => {
    if (message.command === 'deleteConversation') {
      const { conversationId, title } = message;
      const recycle = getConfig().deleteToRecycleBin;
      try {
        const res = deleteConversation(conversationId, { recycleBin: recycle });
        await reportDeleteResult(res, title, recycle);
        updateTelemetry();
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to delete conversation: ${err.message}`);
      }
    }
  });

  currentPanel.onDidDispose(() => {
    currentPanel = null;
  });
}

function activate(context) {
  extensionUri = context.extensionUri;

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
      updateTelemetry();
      vscode.window.showInformationMessage('Antigravity Telemetry refreshed.');
    }),
    vscode.commands.registerCommand('antigravity.deleteConversation', promptDeleteConversation),
    vscode.commands.registerCommand('antigravity.setSqlitePath', promptSetSqlitePath),
    vscode.commands.registerCommand('antigravity.showLogs', () => logChannel.show())
  );

  // Initial read
  updateTelemetry();

  const { convDir, antigravityDir, summariesDb } = getAntigravityPaths();

  // Conversation databases change on every turn. If Antigravity keeps a WAL open the write
  // lands in <id>.db-wal, so match the whole file family rather than only ".db".
  if (fs.existsSync(convDir)) {
    let dbDebounce = null;
    try {
      watcher = fs.watch(convDir, (eventType, filename) => {
        if (filename && !/\.db(-wal|-shm|-journal)?$/.test(filename)) return;
        clearTimeout(dbDebounce);
        dbDebounce = setTimeout(() => updateTelemetry(), 400);
      });
      context.subscriptions.push({ dispose: () => watcher && watcher.close() });
    } catch (err) {
      log(`Watcher error on ${convDir}: ${err.message}`);
    }
  }

  // The catalog db carries titles, step counts and the killed flag, and was previously not
  // watched at all, so renames / deletions never showed up until the next poll.
  if (fs.existsSync(antigravityDir)) {
    let summaryDebounce = null;
    try {
      summaryWatcher = fs.watch(antigravityDir, (eventType, filename) => {
        if (filename && path.basename(filename) !== path.basename(summariesDb)) return;
        clearTimeout(summaryDebounce);
        summaryDebounce = setTimeout(() => updateTelemetry(), 600);
      });
      context.subscriptions.push({ dispose: () => summaryWatcher && summaryWatcher.close() });
    } catch (err) {
      log(`Watcher error on ${antigravityDir}: ${err.message}`);
    }
  }

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
      if (e.affectsConfiguration('antigravity')) {
        updateTelemetry();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      updateTelemetry();
    })
  );
}

function deactivate() {
  if (watcher) { watcher.close(); watcher = null; }
  if (summaryWatcher) { summaryWatcher.close(); summaryWatcher = null; }
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  if (logChannel) { logChannel.dispose(); logChannel = null; }
}

module.exports = {
  activate,
  deactivate
};

