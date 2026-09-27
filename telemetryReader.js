const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, execFileSync } = require('child_process');
const { fileURLToPath } = require('url');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Reject varints that cannot be represented exactly (e.g. the 2^64-1 sentinel found in
// some rows) so bogus values can never leak into the UI as numbers.
const MAX_SAFE_VARINT = BigInt(Number.MAX_SAFE_INTEGER);

// Real Antigravity conversation IDs are UUIDs. Enforced before any SQL/FS write.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Storage size: the brain/ walk costs ~300ms for the whole install, so only re-walk a chat
// when it actually changed (and at most every 5 min), or as a slow safety net every 30 min.
const STORAGE_TTL_MS = 5 * 60 * 1000;
const STORAGE_MAX_AGE_MS = 30 * 60 * 1000;

// Per-conversation analysis cache: id -> { mtimeMs, size, stats, storageBytes, storageCheckedAt }
// Keyed on (mtimeMs, size) so an unchanged DB costs zero sqlite3 spawns.
const analysisCache = new Map();

function clearAnalysisCache() {
  analysisCache.clear();
}

// ---------------------------------------------------------------------------
// Protobuf wire decoder
// ---------------------------------------------------------------------------

function safeVarintNumber(val) {
  if (typeof val !== 'bigint' || val > MAX_SAFE_VARINT) return null;
  return Number(val);
}

function asPrintableString(buf) {
  if (!buf || buf.length === 0 || buf.length > 512) return null;
  const text = buf.toString('utf8');
  // Must round-trip (no invalid UTF-8) and contain no control chars other than tab/LF/CR.
  if (!/^[\t\n\r\x20-\x7E]*$/.test(text)) return null;
  if (Buffer.byteLength(text, 'utf8') !== buf.length) return null;
  return text;
}

function parseProto(buf) {
  let offset = 0;
  const result = [];
  while (offset < buf.length) {
    const key = readVarint(buf, offset);
    if (!key) break;
    offset = key.nextOffset;
    const tag = safeVarintNumber(key.val >> 3n);
    const wireType = Number(key.val & 7n);
    // Field number 0 is illegal in protobuf; treat it as a desync and stop rather than
    // inventing bogus tags from misaligned bytes.
    if (!tag) break;
    if (wireType === 0) {
      const v = readVarint(buf, offset);
      if (!v) break;
      offset = v.nextOffset;
      result.push({ tag, type: 'varint', val: safeVarintNumber(v.val) });
    } else if (wireType === 1) {
      if (offset + 8 > buf.length) break;
      const v = buf.readBigUInt64LE(offset);
      offset += 8;
      result.push({ tag, type: 'fixed64', val: v.toString() });
    } else if (wireType === 2) {
      const lenObj = readVarint(buf, offset);
      if (!lenObj) break;
      offset = lenObj.nextOffset;
      const len = safeVarintNumber(lenObj.val);
      if (len === null || offset + len > buf.length) break;
      const subBuf = buf.slice(offset, offset + len);
      offset += len;
      const text = asPrintableString(subBuf);
      if (text !== null) {
        result.push({ tag, type: 'string', val: text });
      } else {
        try {
          const subParsed = parseProto(subBuf);
          if (subParsed.length > 0) result.push({ tag, type: 'message', val: subParsed });
          else result.push({ tag, type: 'bytes' });
        } catch {
          result.push({ tag, type: 'bytes' });
        }
      }
    } else if (wireType === 5) {
      if (offset + 4 > buf.length) break;
      offset += 4;
    } else {
      break;
    }
  }
  return result;
}


function readVarint(buf, offset) {
  let res = 0n;
  let shift = 0n;
  let cur = offset;
  while (cur < buf.length) {
    const b = BigInt(buf[cur]);
    cur++;
    res |= (b & 0x7Fn) << shift;
    shift += 7n;
    if ((b & 0x80n) === 0n) return { val: res, nextOffset: cur };
  }
  return null;
}

let customSqlitePath = null;
let cachedSqlitePath = null;

// Override from the `antigravity.sqlitePath` setting. Clears the cached resolution only when the
// value actually changes, so a settings refresh does not re-spawn `--version` probes needlessly.
function setCustomSqlitePath(customPath) {
  const trimmed = typeof customPath === 'string' ? customPath.trim() : '';
  const next = trimmed || null;
  if (customSqlitePath !== next) {
    customSqlitePath = next;
    cachedSqlitePath = null;
  }
}

// Returns the resolved sqlite3 executable, or **null** when nothing works. Returning null (rather
// than the bare string 'sqlite3') is what lets callers surface a real error instead of silently
// failing every query and looking like "no chats".
function getSqliteBinary() {
  if (cachedSqlitePath) return cachedSqlitePath;
  const candidates = [];
  if (customSqlitePath) candidates.push(customSqlitePath);
  candidates.push(
    'C:\\Users\\Harsh\\adb-fastboot\\platform-tools\\sqlite3.exe',
    'sqlite3',
    'sqlite3.exe'
  );
  for (const c of candidates) {
    try {
      execSync(`"${c}" --version`, { stdio: 'ignore' });
      cachedSqlitePath = c;
      return c;
    } catch {
      // try next
    }
  }
  return null;
}

function getAntigravityPaths() {
  const userHome = os.homedir();
  const antigravityDir = path.join(userHome, '.gemini', 'antigravity');
  const convDir = path.join(antigravityDir, 'conversations');
  const summariesDb = path.join(antigravityDir, 'conversation_summaries.db');
  return { antigravityDir, convDir, summariesDb };
}

function parseWorkspaceInfo(rawUris) {
  if (!rawUris || typeof rawUris !== 'string') {
    return { workspacePaths: [], workspaceName: '' };
  }
  try {
    const list = JSON.parse(rawUris);
    if (!Array.isArray(list)) return { workspacePaths: [], workspaceName: '' };
    const paths = [];
    for (const u of list) {
      if (typeof u !== 'string') continue;
      try {
        if (u.startsWith('file://')) {
          paths.push(fileURLToPath(u));
        } else {
          paths.push(u);
        }
      } catch {
        paths.push(u);
      }
    }
    let name = '';
    if (paths.length > 0 && paths[0]) {
      name = path.basename(paths[0]) || paths[0];
    }
    return { workspacePaths: paths, workspaceName: name };
  } catch {
    return { workspacePaths: [], workspaceName: '' };
  }
}

function conversationMatchesWorkspace(conv, currentFolderPaths) {
  if (!currentFolderPaths || currentFolderPaths.length === 0) return true;

  let paths = conv && conv.workspacePaths;
  if (!paths || !Array.isArray(paths) || paths.length === 0) {
    if (conv && conv.workspaceUris) {
      const info = parseWorkspaceInfo(conv.workspaceUris);
      paths = info.workspacePaths;
    }
  }
  if (!paths || paths.length === 0) return false;

  for (const rawP of paths) {
    const normP = path.normalize(rawP).replace(/[\\/]+$/, '').toLowerCase();
    for (const cur of currentFolderPaths) {
      const curNorm = path.normalize(cur).replace(/[\\/]+$/, '').toLowerCase();
      if (normP === curNorm || curNorm.startsWith(normP + path.sep) || normP.startsWith(curNorm + path.sep)) {
        return true;
      }
    }
  }
  return false;
}

// Returns a Map of conversationId -> { id, title, stepCount, lastModified, ... } from the global
// conversation_summaries.db. Three possible outcomes:
//   { <id>: ... }  → successful read
//   {}    → the catalog genuinely has no rows (or does not exist yet)
//   null  → the catalog could not be read (sqlite3 missing/locked/error)
// Callers MUST distinguish these: treating "unreadable" as "empty" makes every conversation
// look like an orphan, which is how a purge could be offered for healthy chats.
function getConversationSummaries(summariesDb, sqliteBin) {
  if (!fs.existsSync(summariesDb)) return {};
  try {
    const sql = `SELECT conversation_id, ifnull(title,'') AS title, ifnull(preview,'') AS preview, ifnull(step_count,0) AS step_count, ifnull(last_modified_time,'') AS last_modified_time, ifnull(workspace_uris,'') AS workspace_uris, ifnull(parent_conversation_id,'') AS parent_conversation_id, ifnull(nesting_depth,0) AS nesting_depth, ifnull(agent_name,'') AS agent_name, ifnull(killed,0) AS killed FROM conversation_summaries ORDER BY last_modified_time DESC;`;
    const out = execSync(`"${sqliteBin}" "${summariesDb}" -json "${sql}"`, { maxBuffer: 10 * 1024 * 1024 }).toString();
    const rows = JSON.parse(out);
    const map = {};
    for (const r of rows) {
      if (!r.conversation_id) continue;
      const title = r.title || r.preview || 'Untitled Conversation';
      const wsInfo = parseWorkspaceInfo(r.workspace_uris);
      map[r.conversation_id] = {
        id: r.conversation_id,
        title,
        stepCount: Number(r.step_count) || 0,
        lastModified: r.last_modified_time,
        workspaceUris: r.workspace_uris,
        workspacePaths: wsInfo.workspacePaths,
        workspaceName: wsInfo.workspaceName,
        parentConversationId: r.parent_conversation_id,
        nestingDepth: Number(r.nesting_depth) || 0,
        agentName: r.agent_name,
        isSubagent: Boolean(r.parent_conversation_id || r.agent_name),
        killed: Boolean(r.killed)
      };
    }
    // Resolve parent titles in a second pass — a child can precede its parent in the result set.
    for (const id of Object.keys(map)) {
      const parentId = map[id].parentConversationId;
      if (parentId && map[parentId]) map[id].parentTitle = map[parentId].title;
    }
    return map;
  } catch (err) {
    // Fallback if -json is unsupported in ancient sqlite3 versions
    try {
      const sep = '---AGSEP---';
      const sql = `SELECT conversation_id || '${sep}' || ifnull(title,'') || '${sep}' || ifnull(preview,'') || '${sep}' || ifnull(step_count,0) || '${sep}' || ifnull(last_modified_time,'') || '${sep}' || ifnull(workspace_uris,'') FROM conversation_summaries ORDER BY last_modified_time DESC;`;
      const out = execSync(`"${sqliteBin}" "${summariesDb}" "${sql}"`, { maxBuffer: 10 * 1024 * 1024 }).toString();
      const map = {};
      for (const line of out.split('\n')) {
        const clean = line.replace(/\r$/, '');
        if (!clean.trim()) continue;
        const parts = clean.split(sep);
        if (parts.length < 2) continue;
        const id = parts[0];
        const title = parts[1] || parts[2] || 'Untitled Conversation';
        const wsRaw = parts[5] || '';
        const wsInfo = parseWorkspaceInfo(wsRaw);
        map[id] = {
          id,
          title,
          stepCount: parseInt(parts[3], 10) || 0,
          lastModified: parts[4] || '',
          workspaceUris: wsRaw,
          workspacePaths: wsInfo.workspacePaths,
          workspaceName: wsInfo.workspaceName
        };
      }
      return map;
    } catch {
      return null;
    }
  }
}


// Usage counters are varints; anything else (string/bytes/null from an over-large varint)
// must never be treated as a number.
function numField(fieldMap, tag) {
  const v = fieldMap[tag];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// One sqlite3 spawn that returns the structural facts (row count / highest idx) plus only the
// rows added since `lastIdx`. The structural facts are what make it safe to trust the cache:
// a row count that went *down* means rows were deleted, and a lower max(idx) means the table
// was rewritten, in which case the running totals must be rebuilt from scratch.
function queryNewRows(sqliteBin, dbPath, lastIdx) {
  const sql = `SELECT count(*) || '#' || ifnull(max(idx),-1) FROM gen_metadata; SELECT idx, quote(data) FROM gen_metadata WHERE idx > ${lastIdx} ORDER BY idx ASC;`;
  const out = execSync(`"${sqliteBin}" "${dbPath}" "${sql}"`, { maxBuffer: 128 * 1024 * 1024 }).toString();
  const lines = out.split('\n').filter(l => l.trim().length > 0);

  let structural = null;
  const rows = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (structural === null && /^\d+#-?\d+$/.test(trimmed)) {
      const [count, maxIdx] = trimmed.split('#');
      structural = { count: parseInt(count, 10), maxIdx: parseInt(maxIdx, 10) };
      continue;
    }
    rows.push(line);
  }
  return { structural, rows };
}

// Reads only the turns that were added since `prior` (when supplied), so an unchanged or
// already-seen conversation costs a single bounded query instead of a full re-parse.
function analyzeConversation(dbPath, sqliteBin, prior) {
  const incremental = Boolean(prior && typeof prior.lastIdx === 'number' && prior.lastIdx >= 0);

  let lines = [];
  if (incremental) {
    let res;
    try {
      res = queryNewRows(sqliteBin, dbPath, prior.lastIdx);
    } catch {
      return null;
    }
    const s = res.structural;
    // Rows deleted, or the table rewritten with lower indices: rebuild from scratch.
    if (s && (s.count < (prior.totalRows || 0) || s.maxIdx < prior.lastIdx)) {
      return analyzeConversation(dbPath, sqliteBin, null);
    }
    lines = res.rows;
  } else {
    let rawOut = '';
    try {
      rawOut = execSync(`"${sqliteBin}" "${dbPath}" "SELECT idx, quote(data) FROM gen_metadata ORDER BY idx ASC;"`, { maxBuffer: 128 * 1024 * 1024 }).toString();
    } catch {
      return null;
    }
    lines = rawOut.split('\n').filter(l => l.trim().length > 0);
    if (lines.length === 0) return null;
  }

  if (lines.length === 0) return prior; // DB touched but nothing new to parse

  // Running state, seeded from the previous analysis when we are only reading new turns.
  let totalNonCached = incremental ? prior.totalNonCached : 0;
  let totalCached = incremental ? prior.totalCached : 0;
  let totalOutput = incremental ? prior.totalOutput : 0;
  let totalThinking = incremental ? prior.totalThinking : 0;
  let totalResponse = incremental ? prior.totalResponse : 0;
  let cacheHits = incremental ? prior.cacheHits : 0;
  let cacheMisses = incremental ? prior.cacheMisses : 0;
  let modelName = (incremental && prior.modelName) || 'gemini-3.8-flash';
  let prevContext = incremental ? prior.prevContext : 0;
  let contextTokens = incremental && typeof prior.contextTokens === 'number' ? prior.contextTokens : null;
  let contextLimit = incremental && typeof prior.contextLimit === 'number' ? prior.contextLimit : 256000;
  let hasSeenCeiling = incremental ? Boolean(prior && prior.hasSeenCeiling) : false;
  let isCompacted = incremental ? prior.isCompacted : false;
  let compactionsCount = incremental ? prior.compactionsCount : 0;
  let compactedAmount = incremental ? prior.compactedAmount : 0;
  let peakOutput = incremental ? prior.peakOutput : 0;
  let peakThinking = incremental ? prior.peakThinking : 0;
  let lastTurn = incremental ? prior.lastTurn : null;
  let calls = incremental ? prior.calls : 0;
  let totalRows = (incremental ? prior.totalRows : 0) + lines.length;
  let lastIdx = incremental ? prior.lastIdx : -1;
  let lastKeptIdx = incremental ? prior.lastKeptIdx : -1;
  // Seed from the raw running peaks, not the derived values: the derived peak also folds in the
  // newest turn, which would make it "sticky" across an incremental pass but not across a full one.
  let peakContextSeen = incremental ? (prior.peakContextSeen || 0) : 0;
  let minContextSeen = incremental && typeof prior.minContextSeen === 'number' ? prior.minContextSeen : null;
  let firstContext = incremental ? prior.firstContext : null;

  const contextTimeline = incremental ? prior.contextTimeline.slice() : [];

  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const line = lines[lineNo];
    const pipeIdx = line.indexOf('|');
    if (pipeIdx === -1) continue;
    const idx = parseInt(line.substring(0, pipeIdx));
    if (!Number.isFinite(idx)) continue;
    const hexPart = line.substring(pipeIdx + 1).trim();
    const match = hexPart.match(/X'([0-9A-Fa-f]+)'/);
    if (!match) continue;
    const parsed = parseProto(Buffer.from(match[1], 'hex'));

    const t1 = parsed.find(f => f.tag === 1);
    if (!t1 || t1.type !== 'message') continue;

    const m = t1.val.find(f => f.tag === 19);
    if (m && m.type === 'string' && m.val) modelName = m.val;

    const t4 = t1.val.find(f => f.tag === 4);
    if (!t4 || t4.type !== 'message') continue;

    const fieldMap = {};
    t4.val.forEach(f => { fieldMap[f.tag] = f.val; });

    const nonCached = numField(fieldMap, 2);
    const cached = numField(fieldMap, 5);
    const output = numField(fieldMap, 3);
    const thinking = numField(fieldMap, 9);
    const resp = numField(fieldMap, 10);
    const totalInput = nonCached + cached;

    // Decode authoritative context from tag 1 -> tag 9 -> tag 10
    // tag 1 = live context tokens, tag 4 = context ceiling (256000)
    let rowContext = null;
    let rowLimit = null;
    const t9 = t1.val.find(f => f.tag === 9);
    if (t9 && t9.type === 'message') {
      const t10 = t9.val.find(f => f.tag === 10);
      if (t10 && t10.type === 'message') {
        const ctxMap = {};
        t10.val.forEach(f => { ctxMap[f.tag] = f.val; });
        if (typeof ctxMap[1] === 'number' && Number.isFinite(ctxMap[1])) {
          rowContext = ctxMap[1];
        }
        if (typeof ctxMap[4] === 'number' && Number.isFinite(ctxMap[4])) {
          rowLimit = ctxMap[4];
        }
      }
    }

    // Per-row fallback: early rows may lack tag9.tag10 while later rows have it.
    // Fall back to (fresh + cached) and 255000 per row.
    const effectiveContext = rowContext !== null ? rowContext : totalInput;
    if (rowLimit !== null) {
      contextLimit = rowLimit;
      hasSeenCeiling = true;
    } else if (!hasSeenCeiling) {
      contextLimit = 255000;
    }
    contextTokens = effectiveContext;

    if (output > peakOutput) peakOutput = output;
    if (thinking > peakThinking) peakThinking = thinking;

    let turnCompacted = false;
    let turnCompactedAmt = 0;
    if (prevContext > 0 && effectiveContext < prevContext - 10000) {
      isCompacted = true;
      turnCompacted = true;
      turnCompactedAmt = prevContext - effectiveContext;
      compactionsCount++;
      compactedAmount = turnCompactedAmt;
    }
    prevContext = effectiveContext;

    totalNonCached += nonCached;
    totalCached += cached;
    totalOutput += output;
    totalThinking += thinking;
    totalResponse += resp;

    if (cached > 0) cacheHits++;
    else cacheMisses++;

    calls++;
    lastIdx = idx;

    lastTurn = {
      turn: idx + 1,
      totalInput,
      context: effectiveContext,
      cached,
      fresh: nonCached,
      output,
      thinking,
      response: resp,
      isCompacted: turnCompacted,
      compactedAmount: turnCompactedAmt
    };

    if (firstContext === null) firstContext = effectiveContext;
    if (effectiveContext > peakContextSeen) peakContextSeen = effectiveContext;
    if (minContextSeen === null || effectiveContext < minContextSeen) minContextSeen = effectiveContext;

    // Decimate to roughly ~70 chart points, but always keep the first 100 turns, every
    // compaction and every cold start (cached === 0). The stride grows with the conversation
    // so the timeline stays bounded without dropping interesting turns.
    //
    // The keep-decision deliberately ignores how rows were batched (we never force-keep the
    // last row of a batch), so an incremental pass keeps exactly the same points as a full
    // pass. The newest turn is appended for display in readAllTelemetry().
    const turnNumber = idx + 1;
    const stride = Math.max(1, Math.ceil(turnNumber / 70));
    if (turnNumber <= 100 || turnCompacted || cached === 0 || (idx - lastKeptIdx) >= stride) {
      lastKeptIdx = idx;
      contextTimeline.push({
        idx,
        turn: turnNumber,
        input: effectiveContext,
        totalInput,
        cached,
        fresh: nonCached,
        output,
        thinking,
        isCompacted: turnCompacted,
        compactedAmount: turnCompactedAmt
      });
    }
  }

  const totalInput = totalNonCached + totalCached;
  const grandTotal = totalInput + totalOutput;
  const currentContext = contextTokens !== null ? contextTokens : (lastTurn ? lastTurn.totalInput : 0);
  const peakContext = Math.max(peakContextSeen, currentContext);
  const minContext = minContextSeen === null ? currentContext : Math.min(minContextSeen, currentContext);

  const avgContext = calls > 0 ? Math.round(totalInput / calls) : 0;
  const avgOutput = calls > 0 ? Math.round(totalOutput / calls) : 0;
  const avgThinking = calls > 0 ? Math.round(totalThinking / calls) : 0;
  const avgCached = calls > 0 ? Math.round(totalCached / calls) : 0;

  return {
    calls,
    modelName,
    // Incremental-analysis state: carried into the next refresh so only new turns are read.
    lastIdx,
    lastKeptIdx,
    prevContext,
    firstContext,
    totalRows,
    peakContextSeen,
    minContextSeen,
    totalInput,
    totalCached,
    totalNonCached,
    totalOutput,
    totalThinking,
    totalResponse,
    grandTotal,
    currentContext,
    peakContext,
    minContext,
    contextTokens,
    contextLimit,
    hasSeenCeiling,
    isCompacted,
    compactionsCount,
    compactedAmount,
    cacheHits,
    cacheMisses,
    avgContext,
    avgOutput,
    avgThinking,
    avgCached,
    peakOutput,
    peakThinking,
    lastTurn,
    cacheHitRate: calls > 0 ? ((cacheHits / calls) * 100).toFixed(1) : '0.0',
    cacheVolumeRate: totalInput > 0 ? ((totalCached / totalInput) * 100).toFixed(1) : '0.0',
    thinkingRate: totalOutput > 0 ? ((totalThinking / totalOutput) * 100).toFixed(1) : '0.0',
    contextTimeline
  };
}

function getDirSize(dir) {
  let size = 0;
  if (!fs.existsSync(dir)) return 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        size += getDirSize(full);
      } else {
        try { size += fs.statSync(full).size; } catch { }
      }
    }
  } catch { }
  return size;
}

function getConversationStorageSize(id) {
  const { antigravityDir, convDir } = getAntigravityPaths();
  let total = 0;
  const dbPath = path.join(convDir, `${id}.db`);
  const walPath = path.join(convDir, `${id}.db-wal`);
  const shmPath = path.join(convDir, `${id}.db-shm`);
  const brainPath = path.join(antigravityDir, 'brain', id);
  const annPath = path.join(antigravityDir, 'annotations', `${id}.pbtxt`);
  const browserPath = path.join(antigravityDir, 'browser_recordings', id);
  const impPath = path.join(antigravityDir, 'implicit', `${id}.pb`);

  for (const p of [dbPath, walPath, shmPath, annPath, impPath]) {
    if (fs.existsSync(p)) {
      try { total += fs.statSync(p).size; } catch { }
    }
  }
  total += getDirSize(brainPath);
  total += getDirSize(browserPath);
  return total;
}

function validateConversationId(conversationId) {
  if (!conversationId || typeof conversationId !== 'string') return null;
  const trimmed = conversationId.trim();
  return UUID_RE.test(trimmed) ? trimmed : null;
}

// Every on-disk layer a conversation owns. Mirrors the layout documented in AGENTS.md.
function collectConversationTargets(id) {
  const { antigravityDir, convDir } = getAntigravityPaths();
  const candidates = [
    { path: path.join(convDir, `${id}.db`), kind: 'file' },
    { path: path.join(convDir, `${id}.db-wal`), kind: 'file' },
    { path: path.join(convDir, `${id}.db-shm`), kind: 'file' },
    { path: path.join(antigravityDir, 'brain', id), kind: 'dir' },
    { path: path.join(antigravityDir, 'annotations', `${id}.pbtxt`), kind: 'file' },
    { path: path.join(antigravityDir, 'browser_recordings', id), kind: 'dir' },
    { path: path.join(antigravityDir, 'implicit', `${id}.pb`), kind: 'file' }
  ];
  const targets = [];
  for (const c of candidates) {
    if (!fs.existsSync(c.path)) continue;
    let bytes = 0;
    try {
      bytes = c.kind === 'dir' ? getDirSize(c.path) : fs.statSync(c.path).size;
    } catch { /* size unknown; still delete */ }
    targets.push({ ...c, bytes });
  }
  return targets;
}

// Moves the given paths to the Windows Recycle Bin in a single PowerShell call.
// Returns [{ path, reason }] for whatever PowerShell could not process. This is used only to
// explain failures — the authoritative check is the post-delete existence test in
// deleteConversation, so a broken/unavailable PowerShell cannot cause a false success.
function recyclePaths(items) {
  if (items.length === 0) return [];
  const script = [
    'Add-Type -AssemblyName Microsoft.VisualBasic',
    '$items = $env:AG_RECYCLE_ITEMS | ConvertFrom-Json',
    '$failed = @()',
    'foreach ($it in $items) {',
    '  try {',
    "    if ($it.kind -eq 'dir') {",
    '      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($it.path, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)',
    '    } else {',
    '      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($it.path, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)',
    '    }',
    '  } catch { $failed += [pscustomobject]@{ path = $it.path; reason = $_.Exception.Message } }',
    '}',
    'ConvertTo-Json -InputObject @($failed) -Compress'
  ].join('\n');

  let out = '';
  try {
    out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, AG_RECYCLE_ITEMS: JSON.stringify(items) },
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true
    }).toString().trim();
  } catch (err) {
    return items.map(it => ({ path: it.path, reason: `Recycle Bin call failed: ${err.message}` }));
  }

  if (!out) return [];
  try {
    const parsed = JSON.parse(out);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list
      .filter(f => f && f.path)
      .map(f => ({ path: f.path, reason: String(f.reason || 'unknown error') }));
  } catch {
    return [];
  }
}

/**
 * Deletes a conversation across all of its storage layers.
 *
 * Honest by construction: nothing is reported as freed unless the path is verified gone, and
 * the row in conversation_summaries.db is only removed when *every* file was deleted (a locked
 * DB otherwise leaves an orphaned "ghost" catalog entry behind).
 *
 * @param {string} conversationId  UUID of the conversation.
 * @param {{recycleBin?: boolean}} [options]  Defaults to the Recycle Bin for recoverability.
 */
function deleteConversation(conversationId, options = {}) {
  const safeId = validateConversationId(conversationId);
  if (!safeId) {
    throw new Error('Invalid conversation ID: expected a UUID');
  }

  const useRecycleBin = options.recycleBin !== false;
  const { summariesDb } = getAntigravityPaths();
  const sqliteBin = getSqliteBinary();
  if (!sqliteBin) {
    throw new Error('sqlite3 executable not found. Configure antigravity.sqlitePath in settings.');
  }
  const targets = collectConversationTargets(safeId);
  const deletedItems = [];
  const failures = [];
  let freedBytes = 0;
  let summaryRowDeleted = false;

  // 1. Remove the files (Recycle Bin by default, permanent when explicitly requested).
  //    PowerShell's own error messages are kept only as explanations; the truth about what
  //    happened comes from the existence check in step 2.
  const recycleReasons = new Map();
  if (targets.length > 0) {
    if (useRecycleBin) {
      for (const r of recyclePaths(targets)) recycleReasons.set(r.path, r.reason);
    } else {
      for (const t of targets) {
        try {
          if (t.kind === 'dir') fs.rmSync(t.path, { recursive: true, force: true });
          else fs.unlinkSync(t.path);
        } catch (err) {
          recycleReasons.set(t.path, `${err.code || 'ERROR'}: ${err.message}`);
        }
      }
    }
  }

  // 2. Verify: only count what is actually gone.
  for (const t of targets) {
    if (fs.existsSync(t.path)) {
      failures.push({ path: t.path, reason: recycleReasons.get(t.path) || 'Still present after deletion (file is locked?)' });
    } else {
      deletedItems.push(t.path);
      freedBytes += t.bytes;
    }
  }

  const dbTarget = targets.find(t => t.path === path.join(getAntigravityPaths().convDir, `${safeId}.db`));
  const databaseRemoved = Boolean(dbTarget) && !fs.existsSync(dbTarget.path);

  // 3. Only touch the catalog when the whole conversation was removed.
  if (failures.length === 0 && fs.existsSync(summariesDb)) {
    try {
      const out = execSync(`"${sqliteBin}" "${summariesDb}" "DELETE FROM conversation_summaries WHERE conversation_id = '${safeId}'; SELECT changes();"`, { maxBuffer: 1024 * 1024 }).toString();
      const removed = parseInt(out.split('\n').map(l => l.trim()).filter(Boolean).pop(), 10) || 0;
      if (removed > 0) {
        deletedItems.push(`conversation_summaries entry: ${safeId}`);
        summaryRowDeleted = true;
      }
    } catch (err) {
      failures.push({ path: `${summariesDb} (row ${safeId})`, reason: `Could not remove catalog row: ${err.message}` });
    }
  }

  analysisCache.delete(safeId);

  return {
    success: failures.length === 0,
    conversationId: safeId,
    deletedItems,
    failures,
    freedBytes,
    recycled: useRecycleBin && failures.length === 0 && deletedItems.length > 0,
    summaryRowDeleted,
    databaseRemoved
  };
}

// The decimated timeline is deterministic per conversation, but the newest turn is not
// guaranteed to be one of the sampled points — add it for display without touching the cached
// array (the cache keeps the canonical sample that the next incremental pass builds on).
function withLatestTimeline(stats) {
  const timeline = stats.contextTimeline;
  const last = stats.lastTurn;
  if (!last) return stats;
  if (timeline.length > 0 && timeline[timeline.length - 1].turn === last.turn) return stats;
  const latest = {
    idx: stats.lastIdx,
    turn: last.turn,
    input: last.context != null ? last.context : last.totalInput,
    totalInput: last.totalInput,
    cached: last.cached,
    fresh: last.fresh,
    output: last.output,
    thinking: last.thinking,
    isCompacted: last.isCompacted,
    compactedAmount: last.compactedAmount
  };
  return { ...stats, contextTimeline: timeline.concat([latest]) };
}

// Picks the conversation the footer should describe. Prefers a human chat so a background worker
// finishing later cannot take over the status bar; falls back to the first entry only when the
// list contains nothing but subagents.
function selectActiveConversation(conversations) {
  if (!conversations || conversations.length === 0) return null;
  return conversations.find(c => !c.isSubagent) || conversations[0];
}

// WAL/SHM sidecar signature, or '' when Antigravity is not holding the DB open.
function walSignatureOf(dbPath) {
  const walPath = `${dbPath}-wal`;
  if (!fs.existsSync(walPath)) return '';
  try {
    const st = fs.statSync(walPath);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return '';
  }
}

function readAllTelemetry() {
  const { convDir, summariesDb } = getAntigravityPaths();
  if (!fs.existsSync(convDir)) {
    return { conversations: [], active: null, catalogAvailable: true, sqliteAvailable: getSqliteBinary() !== null };
  }

  const sqliteBin = getSqliteBinary();
  // A missing CLI is reported explicitly so the UI can say so, rather than showing "no chats".
  if (!sqliteBin) {
    return { conversations: [], active: null, catalogAvailable: false, sqliteAvailable: false };
  }
  const summaryMap = getConversationSummaries(summariesDb, sqliteBin);
  // null means "unreadable", which must not be mistaken for "no chats have summaries" —
  // that would flag every healthy conversation as an orphan.
  const catalogAvailable = summaryMap !== null;
  const catalog = summaryMap || {};
  const now = Date.now();

  const dbFiles = fs.readdirSync(convDir).filter(f => f.endsWith('.db'));
  const convStatsList = [];
  const seen = new Set();

  let mostRecentFile = null;
  let mostRecentTime = 0;

  for (const f of dbFiles) {
    const fullPath = path.join(convDir, f);
    const cId = f.replace(/\.db$/, '');
    seen.add(cId);

    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.mtimeMs > mostRecentTime) {
      mostRecentTime = stat.mtimeMs;
      mostRecentFile = cId;
    }

    // ---- analysis: reuse the cache unless this conversation actually changed ----
    const entry = analysisCache.get(cId);
    // A live WAL is where writes land, so it is part of the freshness signature even though
    // the main .db mtime/size may be untouched.
    const walSignature = walSignatureOf(fullPath);
    const changed = !entry
      || entry.mtimeMs !== stat.mtimeMs
      || entry.size !== stat.size
      || entry.walSignature !== walSignature;
    // A shrunken file means rows were removed or the DB was rewritten: never patch incrementally.
    const shrank = Boolean(entry && stat.size < entry.size);

    let stats = null;
    if (entry && !changed) {
      stats = entry.stats; // zero sqlite3 spawns
    } else {
      stats = analyzeConversation(fullPath, sqliteBin, shrank ? null : (entry ? entry.stats : null));
      if (!stats && entry) stats = entry.stats; // keep the last good reading
      if (!stats) continue;
      analysisCache.set(cId, {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        walSignature,
        stats,
        storageBytes: entry ? entry.storageBytes : null,
        storageCheckedAt: entry ? entry.storageCheckedAt : 0
      });
    }

    if (!stats || stats.calls === 0) continue;

    // ---- storage size: expensive (walks brain/), so cached with a TTL ----
    const cacheEntry = analysisCache.get(cId);
    const storageAge = now - (cacheEntry.storageCheckedAt || 0);
    const needsStorageWalk = cacheEntry.storageBytes == null
      || storageAge > STORAGE_MAX_AGE_MS
      || (changed && storageAge > STORAGE_TTL_MS);

    if (needsStorageWalk) {
      cacheEntry.storageBytes = getConversationStorageSize(cId);
      cacheEntry.storageCheckedAt = now;
    }

    const storageBytes = cacheEntry.storageBytes || 0;
    const hasSummary = Boolean(catalog[cId]);
    const summary = catalog[cId] || {
      id: cId,
      title: catalogAvailable ? 'Dead Ghost Chat (Deleted in Antigravity)' : 'Untitled Conversation (catalog unreadable)',
      stepCount: 0,
      lastModified: stat.mtime.toISOString(),
      workspaceUris: '',
      workspacePaths: [],
      workspaceName: ''
    };

    convStatsList.push({
      ...summary,
      isOrphan: catalogAvailable && !hasSummary,
      storageBytes,
      storageMB: (storageBytes / (1024 * 1024)).toFixed(1),
      mtimeMs: stat.mtimeMs,
      stats: withLatestTimeline(stats)
    });
  }

  // Drop cache entries for conversations that no longer exist.
  for (const key of analysisCache.keys()) {
    if (!seen.has(key)) analysisCache.delete(key);
  }

  // Sort by most recently modified
  convStatsList.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const active = selectActiveConversation(convStatsList);

  return {
    conversations: convStatsList,
    active,
    catalogAvailable,
    sqliteAvailable: true
  };
}

module.exports = {
  readAllTelemetry,
  getAntigravityPaths,
  getConversationStorageSize,
  deleteConversation,
  parseWorkspaceInfo,
  conversationMatchesWorkspace,
  selectActiveConversation,
  getSqliteBinary,
  setCustomSqlitePath,
  // exposed for tooling / self-check scripts
  analyzeConversation,
  parseProto,
  validateConversationId,
  clearAnalysisCache,
  recyclePaths
};

