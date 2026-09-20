const vscode = require('vscode');
const fs = require('fs');
const { readAllTelemetry, getAntigravityPaths, deleteConversation, purgeOrphanedData } = require('./telemetryReader');
const { getDashboardHtml } = require('./dashboardHtml');

let statusBarItem = null;
let currentPanel = null;
let telemetryState = { conversations: [], active: null };
let watcher = null;
let refreshTimer = null;

function formatTokens(num) {
  if (!num || isNaN(num)) return '0';
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
  if (num >= 1_000) return (num / 1_000).toFixed(0) + 'k';
  return String(num);
}

function updateTelemetry() {
  try {
    telemetryState = readAllTelemetry();
    updateStatusBar();
    if (currentPanel) {
      currentPanel.webview.postMessage({
        type: 'telemetryUpdate',
        data: telemetryState.conversations,
        activeId: telemetryState.active ? telemetryState.active.id : null
      });
    }
  } catch (err) {
    console.error('Antigravity Telemetry update error:', err);
  }
}

function updateStatusBar() {
  if (!statusBarItem) return;

  const active = telemetryState.active;
  if (!active || !active.stats) {
    statusBarItem.text = 'Antigravity: Idle';
    statusBarItem.tooltip = 'Antigravity Telemetry: No active conversation found.';
    statusBarItem.backgroundColor = undefined;
    statusBarItem.show();
    return;
  }

  const s = active.stats;
  const rawTitle = (active.title || 'Chat').trim();
  const firstWord = rawTitle.split(/\s+/)[0] || 'Chat';
  const shortTitle = firstWord.length > 16 ? firstWord.substring(0, 14) + '..' : firstWord;

  const contextLimit = 255_000; // ~255k effective working ceiling before auto-compaction
  const currentContext = s.currentContext || 0;
  const contextPct = Math.min(100, Math.round((currentContext / contextLimit) * 100));
  const shortContext = formatTokens(currentContext);

  // Status Bar Text: essential info only (Title | Context | Cache)
  statusBarItem.text = `${shortTitle} | ${shortContext} (${contextPct}%) · ${s.cacheHitRate}% cache`;

  // Native status bar styling (no background coloring based on context)
  statusBarItem.backgroundColor = undefined;

  // Markdown Tooltip
  const filledBlocks = Math.min(12, Math.round((currentContext / contextLimit) * 12));
  const emptyBlocks = 12 - filledBlocks;
  const progressBar = '█'.repeat(filledBlocks) + '░'.repeat(emptyBlocks);

  const md = new vscode.MarkdownString();
  md.isTrusted = true;
  md.appendMarkdown(`### ⚡ Antigravity Telemetry: Active Chat\n\n`);
  md.appendMarkdown(`**${active.title}**\n\n`);
  md.appendMarkdown(`---\n\n`);
  md.appendMarkdown(`* **Context Usage:** \`${shortContext} / 255k\` tokens (${contextPct}%)\n`);
  md.appendMarkdown(`* **Window Meter:** \`[${progressBar}]\`\n`);
  md.appendMarkdown(`* **Cache Read:** **${formatTokens(s.totalCached)}** (${s.cacheVolumeRate}% vol · ${s.cacheHitRate}% hits)\n`);
  md.appendMarkdown(`* **Cache Write:** **${formatTokens(s.totalNonCached)}** (fresh prompt)\n`);
  md.appendMarkdown(`* **Model Output:** **${formatTokens(s.totalOutput)}** tokens\n\n`);
  md.appendMarkdown(`---\n`);
  md.appendMarkdown(`*Click to open Telemetry Menu or Visual Dashboard*`);

  statusBarItem.tooltip = md;
  statusBarItem.show();
}

async function showMenu() {
  const active = telemetryState.active;
  const activeTitle = active ? active.title : 'No active chat';
  const activeStats = active && active.stats ? active.stats : null;

  const currentContext = activeStats ? formatTokens(activeStats.currentContext) : '0';
  const readTok = activeStats ? formatTokens(activeStats.totalCached) : '0';
  const writeTok = activeStats ? formatTokens(activeStats.totalNonCached) : '0';
  const outTok = activeStats ? formatTokens(activeStats.totalOutput) : '0';
  const convCount = telemetryState.conversations.length;
  const orphans = telemetryState.conversations.filter(c => c.isOrphan);

  // Level 1 QuickPick
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
      label: `$(history) Browse Past Conversations (${convCount} sessions)...`,
      description: 'Search and inspect previous chat telemetry',
      action: 'browseHistory'
    },
    {
      label: '$(trash) Delete a Conversation (Free Disk Space)...',
      description: 'Permanently wipe any conversation and all its stored files',
      action: 'deleteConv'
    }
  ];

  if (orphans.length > 0) {
    items.push({
      label: `$(flame) Purge ${orphans.length} Dead Ghost Chat(s)...`,
      description: 'Clean up chats deleted in Antigravity that still consume disk space',
      action: 'purgeOrphans'
    });
  }

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
  } else if (selected.action === 'purgeOrphans') {
    try {
      const res = purgeOrphanedData();
      const mb = (res.totalFreed / (1024 * 1024)).toFixed(1);
      vscode.window.showInformationMessage(`Purged ${res.purgedCount} dead ghost chat(s) (freed ${mb} MB).`);
      updateTelemetry();
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to purge ghost chats: ${err.message}`);
    }
  }
}

async function showHistoryPicker() {
  const convs = telemetryState.conversations;
  if (!convs || convs.length === 0) {
    vscode.window.showInformationMessage('No Antigravity conversations found.');
    return;
  }

  const items = convs.map(c => {
    const s = c.stats;
    const isAct = telemetryState.active && telemetryState.active.id === c.id;
    const badge = isAct ? ' (ACTIVE)' : '';
    const dateStr = c.lastModified ? new Date(c.lastModified).toLocaleString() : '';

    return {
      label: `$(comment-discussion) ${c.title || 'Untitled'}${badge}`,
      description: `${formatTokens(s.grandTotal)} tok · ${s.cacheHitRate}% cache · ${s.calls} calls`,
      detail: `Peak Context: ${formatTokens(s.peakContext)} | Last Active: ${dateStr}`,
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
  const convs = telemetryState.conversations;
  if (!convs || convs.length === 0) {
    vscode.window.showInformationMessage('No Antigravity conversations found.');
    return;
  }

  const items = convs.map(c => {
    const s = c.stats;
    const isAct = telemetryState.active && telemetryState.active.id === c.id;
    const badge = isAct ? ' (ACTIVE)' : (c.isOrphan ? ' [GHOST CHAT]' : '');
    const dateStr = c.lastModified ? new Date(c.lastModified).toLocaleString() : '';

    return {
      label: `$(trash) ${c.title || 'Untitled'}${badge}`,
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

  const confirm = await vscode.window.showWarningMessage(
    `Permanently delete "${selected.convTitle || selected.convId}"?\nThis will completely wipe its database, brain transcripts, artifacts, and summaries from disk.`,
    { modal: true },
    'Delete Permanently'
  );

  if (confirm === 'Delete Permanently') {
    try {
      const res = deleteConversation(selected.convId);
      const mb = (res.freedBytes / (1024 * 1024)).toFixed(1);
      vscode.window.showInformationMessage(`Permanently deleted "${selected.convTitle}" (freed ${mb} MB).`);
      updateTelemetry();
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to delete conversation: ${err.message}`);
    }
  }
}

function openDashboard(selectedConvId) {
  const targetId = selectedConvId || (telemetryState.active ? telemetryState.active.id : '');

  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.Active);
    currentPanel.webview.postMessage({
      type: 'telemetryUpdate',
      data: telemetryState.conversations,
      activeId: targetId
    });
    return;
  }

  currentPanel = vscode.window.createWebviewPanel(
    'antigravityTelemetry',
    'Antigravity Token Intelligence',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true
    }
  );

  currentPanel.webview.html = getDashboardHtml(telemetryState.conversations, targetId);

  currentPanel.webview.onDidReceiveMessage(async message => {
    if (message.command === 'deleteConversation') {
      const { conversationId, title } = message;
      try {
        const res = deleteConversation(conversationId);
        const mb = (res.freedBytes / (1024 * 1024)).toFixed(1);
        vscode.window.showInformationMessage(`Permanently deleted "${title || conversationId}" (freed ${mb} MB).`);
        updateTelemetry();
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to delete conversation: ${err.message}`);
      }
    } else if (message.command === 'purgeOrphaned') {
      try {
        const res = purgeOrphanedData();
        const mb = (res.totalFreed / (1024 * 1024)).toFixed(1);
        vscode.window.showInformationMessage(`Purged ${res.purgedCount} dead ghost chat(s) (freed ${mb} MB).`);
        updateTelemetry();
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to purge ghost chats: ${err.message}`);
      }
    }
  });

  currentPanel.onDidDispose(() => {
    currentPanel = null;
  });
}

function activate(context) {
  // Create Status Bar Item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'antigravity.showMenu';
  context.subscriptions.push(statusBarItem);

  // Register Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('antigravity.showMenu', showMenu),
    vscode.commands.registerCommand('antigravity.openDashboard', () => openDashboard()),
    vscode.commands.registerCommand('antigravity.refresh', () => {
      updateTelemetry();
      vscode.window.showInformationMessage('Antigravity Telemetry refreshed.');
    }),
    vscode.commands.registerCommand('antigravity.deleteConversation', promptDeleteConversation)
  );

  // Initial read
  updateTelemetry();

  // Watch for database updates
  const { convDir } = getAntigravityPaths();
  if (fs.existsSync(convDir)) {
    let debounceTimer = null;
    try {
      watcher = fs.watch(convDir, (eventType, filename) => {
        if (filename && filename.endsWith('.db')) {
          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            updateTelemetry();
          }, 400);
        }
      });
      context.subscriptions.push({ dispose: () => watcher && watcher.close() });
    } catch (err) {
      console.warn('Antigravity Telemetry watcher error:', err);
    }
  }

  // Polling heartbeat every 10 seconds
  refreshTimer = setInterval(() => {
    updateTelemetry();
  }, 10000);

  context.subscriptions.push({ dispose: () => clearInterval(refreshTimer) });
}

function deactivate() {
  if (watcher) watcher.close();
  if (refreshTimer) clearInterval(refreshTimer);
}

module.exports = {
  activate,
  deactivate
};

