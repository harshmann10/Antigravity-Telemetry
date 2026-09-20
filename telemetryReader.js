const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

function parseProto(buf) {
  let offset = 0;
  const result = [];
  while (offset < buf.length) {
    const key = readVarint(buf, offset);
    if (!key) break;
    offset = key.nextOffset;
    const tag = Number(key.val >> 3n);
    const wireType = Number(key.val & 7n);
    if (wireType === 0) {
      const v = readVarint(buf, offset);
      offset = v.nextOffset;
      result.push({ tag, type: 'varint', val: Number(v.val) });
    } else if (wireType === 1) {
      if (offset + 8 > buf.length) break;
      const v = buf.readBigUInt64LE(offset);
      offset += 8;
      result.push({ tag, type: 'fixed64', val: v.toString() });
    } else if (wireType === 2) {
      const lenObj = readVarint(buf, offset);
      offset = lenObj.nextOffset;
      const len = Number(lenObj.val);
      const subBuf = buf.slice(offset, offset + len);
      offset += len;
      try {
        const subParsed = parseProto(subBuf);
        if (subParsed.length > 0) result.push({ tag, type: 'message', val: subParsed });
        else result.push({ tag, type: 'bytes' });
      } catch {
        result.push({ tag, type: 'bytes' });
      }
    } else if (wireType === 5) {
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

let cachedSqlitePath = null;
function getSqliteBinary() {
  if (cachedSqlitePath) return cachedSqlitePath;
  const candidates = [
    'C:\\Users\\Harsh\\adb-fastboot\\platform-tools\\sqlite3.exe',
    'sqlite3',
    'sqlite3.exe'
  ];
  for (const c of candidates) {
    try {
      execSync(`"${c}" --version`, { stdio: 'ignore' });
      cachedSqlitePath = c;
      return c;
    } catch {
      // try next
    }
  }
  return 'sqlite3';
}

function getAntigravityPaths() {
  const userHome = os.homedir();
  const antigravityDir = path.join(userHome, '.gemini', 'antigravity');
  const convDir = path.join(antigravityDir, 'conversations');
  const summariesDb = path.join(antigravityDir, 'conversation_summaries.db');
  return { antigravityDir, convDir, summariesDb };
}

function getConversationSummaries(summariesDb, sqliteBin) {
  if (!fs.existsSync(summariesDb)) return {};
  try {
    const out = execSync(`"${sqliteBin}" "${summariesDb}" "SELECT conversation_id, title, step_count, last_modified_time FROM conversation_summaries ORDER BY last_modified_time DESC;"`, { maxBuffer: 10 * 1024 * 1024 }).toString();
    const map = {};
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split('|');
      map[parts[0]] = {
        id: parts[0],
        title: parts[1] || 'Untitled Conversation',
        stepCount: parseInt(parts[2]) || 0,
        lastModified: parts[3]
      };
    }
    return map;
  } catch {
    return {};
  }
}

function analyzeConversation(dbPath, sqliteBin) {
  let rawOut = '';
  try {
    rawOut = execSync(`"${sqliteBin}" "${dbPath}" "SELECT idx, quote(data) FROM gen_metadata ORDER BY idx ASC;"`, { maxBuffer: 50 * 1024 * 1024 }).toString();
  } catch {
    return null;
  }

  const lines = rawOut.split('\n').filter(l => l.trim().length > 0);
  if (lines.length === 0) return null;

  let totalNonCached = 0;
  let totalCached = 0;
  let totalOutput = 0;
  let totalThinking = 0;
  let totalResponse = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  let modelName = 'gemini-3.8-flash';
  let prevContext = 0;
  let isCompacted = false;
  let compactionsCount = 0;
  let compactedAmount = 0;
  let peakOutput = 0;
  let peakThinking = 0;
  let lastTurn = null;

  const contextTimeline = [];

  for (const line of lines) {
    const pipeIdx = line.indexOf('|');
    if (pipeIdx === -1) continue;
    const idx = parseInt(line.substring(0, pipeIdx));
    const hexPart = line.substring(pipeIdx + 1).trim();
    const match = hexPart.match(/X'([0-9A-Fa-f]+)'/);
    if (!match) continue;
    const parsed = parseProto(Buffer.from(match[1], 'hex'));

    const t1 = parsed.find(f => f.tag === 1);
    if (!t1 || t1.type !== 'message') continue;

    const m = t1.val.find(f => f.tag === 19);
    if (m && m.type === 'string') modelName = m.val;

    const t4 = t1.val.find(f => f.tag === 4);
    if (!t4 || t4.type !== 'message') continue;

    const fieldMap = {};
    t4.val.forEach(f => { fieldMap[f.tag] = f.val; });

    const nonCached = fieldMap[2] || 0;
    const cached = fieldMap[5] || 0;
    const output = fieldMap[3] || 0;
    const thinking = fieldMap[9] || 0;
    const resp = fieldMap[10] || 0;
    const totalInput = nonCached + cached;

    if (output > peakOutput) peakOutput = output;
    if (thinking > peakThinking) peakThinking = thinking;

    let turnCompacted = false;
    let turnCompactedAmt = 0;
    if (prevContext > 0 && totalInput < prevContext - 10000) {
      isCompacted = true;
      turnCompacted = true;
      turnCompactedAmt = prevContext - totalInput;
      compactionsCount++;
      compactedAmount = turnCompactedAmt;
    }
    prevContext = totalInput;

    totalNonCached += nonCached;
    totalCached += cached;
    totalOutput += output;
    totalThinking += thinking;
    totalResponse += resp;

    if (cached > 0) cacheHits++;
    else cacheMisses++;

    lastTurn = {
      turn: idx + 1,
      totalInput,
      cached,
      fresh: nonCached,
      output,
      thinking,
      response: resp,
      isCompacted: turnCompacted,
      compactedAmount: turnCompactedAmt
    };

    if (lines.length <= 100 || idx % Math.ceil(lines.length / 70) === 0 || idx === lines.length - 1 || turnCompacted || cached === 0) {
      contextTimeline.push({
        idx,
        turn: idx + 1,
        input: totalInput,
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
  const calls = lines.length;
  const currentContext = lastTurn ? lastTurn.totalInput : 0;
  const peakContext = Math.max(...contextTimeline.map(t => t.input), currentContext);
  const minContext = Math.min(...contextTimeline.map(t => t.input), currentContext);

  const avgContext = calls > 0 ? Math.round(totalInput / calls) : 0;
  const avgOutput = calls > 0 ? Math.round(totalOutput / calls) : 0;
  const avgThinking = calls > 0 ? Math.round(totalThinking / calls) : 0;
  const avgCached = calls > 0 ? Math.round(totalCached / calls) : 0;

  const estimatedCost = calls > 0 ? ((totalNonCached / 1e6) * 0.15 + (totalCached / 1e6) * 0.0375 + (totalOutput / 1e6) * 0.60) : 0;
  const costWithoutCache = calls > 0 ? ((totalInput / 1e6) * 0.15 + (totalOutput / 1e6) * 0.60) : 0;
  const costSaved = Math.max(0, costWithoutCache - estimatedCost);

  return {
    calls,
    modelName,
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
    estimatedCost: estimatedCost.toFixed(3),
    costSaved: costSaved.toFixed(2),
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

function deleteConversation(conversationId) {
  if (!conversationId || typeof conversationId !== 'string') {
    throw new Error('Invalid conversation ID');
  }
  const safeId = path.basename(conversationId.trim());
  if (!safeId || safeId === '.' || safeId === '..') {
    throw new Error('Invalid conversation ID');
  }

  const { antigravityDir, convDir, summariesDb } = getAntigravityPaths();
  const sqliteBin = getSqliteBinary();
  const deletedItems = [];
  let freedBytes = 0;

  function safeDeleteFile(p) {
    if (fs.existsSync(p)) {
      try {
        const stat = fs.statSync(p);
        freedBytes += stat.size;
        fs.unlinkSync(p);
        deletedItems.push(p);
      } catch (err) {
        console.warn(`Failed to delete file ${p}:`, err.message);
      }
    }
  }

  function safeDeleteDir(p) {
    if (fs.existsSync(p)) {
      try {
        freedBytes += getDirSize(p);
        fs.rmSync(p, { recursive: true, force: true });
        deletedItems.push(p);
      } catch (err) {
        console.warn(`Failed to delete directory ${p}:`, err.message);
      }
    }
  }

  // 1. Delete SQLite files in conversations/
  safeDeleteFile(path.join(convDir, `${safeId}.db`));
  safeDeleteFile(path.join(convDir, `${safeId}.db-wal`));
  safeDeleteFile(path.join(convDir, `${safeId}.db-shm`));

  // 2. Delete brain/<id> folder (transcripts, artifacts, media, scratch)
  safeDeleteDir(path.join(antigravityDir, 'brain', safeId));

  // 3. Delete annotations/<id>.pbtxt
  safeDeleteFile(path.join(antigravityDir, 'annotations', `${safeId}.pbtxt`));

  // 4. Delete browser_recordings/<id>
  safeDeleteDir(path.join(antigravityDir, 'browser_recordings', safeId));

  // 5. Delete implicit/<id>.pb
  safeDeleteFile(path.join(antigravityDir, 'implicit', `${safeId}.pb`));

  // 6. Delete row from conversation_summaries.db
  if (fs.existsSync(summariesDb)) {
    try {
      execSync(`"${sqliteBin}" "${summariesDb}" "DELETE FROM conversation_summaries WHERE conversation_id = '${safeId}';"`, { stdio: 'ignore' });
      deletedItems.push(`conversation_summaries entry: ${safeId}`);
    } catch (err) {
      console.warn(`Failed to delete from summaries db:`, err.message);
    }
  }

  return { success: true, conversationId: safeId, deletedItems, freedBytes };
}

function purgeOrphanedData() {
  const { antigravityDir, convDir, summariesDb } = getAntigravityPaths();
  const sqliteBin = getSqliteBinary();
  const summaryMap = getConversationSummaries(summariesDb, sqliteBin);
  const summaryIds = new Set(Object.keys(summaryMap));

  let totalFreed = 0;
  let purgedCount = 0;

  // 1. DB files in conversations/ with no summary
  if (fs.existsSync(convDir)) {
    const dbFiles = fs.readdirSync(convDir).filter(f => f.endsWith('.db'));
    for (const f of dbFiles) {
      const id = f.replace('.db', '');
      if (!summaryIds.has(id)) {
        const res = deleteConversation(id);
        totalFreed += res.freedBytes;
        purgedCount++;
      }
    }
  }

  // 2. Brain folders with no DB and no summary
  const brainDir = path.join(antigravityDir, 'brain');
  if (fs.existsSync(brainDir)) {
    const entries = fs.readdirSync(brainDir);
    for (const id of entries) {
      if (id === 'tempmediaStorage') continue;
      const dbPath = path.join(convDir, `${id}.db`);
      if (!fs.existsSync(dbPath) && !summaryIds.has(id)) {
        const res = deleteConversation(id);
        totalFreed += res.freedBytes;
        purgedCount++;
      }
    }
  }

  // 3. Annotations with no DB and no summary
  const annDir = path.join(antigravityDir, 'annotations');
  if (fs.existsSync(annDir)) {
    const entries = fs.readdirSync(annDir).filter(f => f.endsWith('.pbtxt'));
    for (const f of entries) {
      const id = f.replace('.pbtxt', '');
      const dbPath = path.join(convDir, `${id}.db`);
      if (!fs.existsSync(dbPath) && !summaryIds.has(id)) {
        try {
          const p = path.join(annDir, f);
          totalFreed += fs.statSync(p).size;
          fs.unlinkSync(p);
        } catch { }
      }
    }
  }

  // 4. Summaries rows with no DB and no brain
  if (fs.existsSync(summariesDb)) {
    for (const id of summaryIds) {
      const dbPath = path.join(convDir, `${id}.db`);
      const brainPath = path.join(antigravityDir, 'brain', id);
      if (!fs.existsSync(dbPath) && !fs.existsSync(brainPath)) {
        try {
          execSync(`"${sqliteBin}" "${summariesDb}" "DELETE FROM conversation_summaries WHERE conversation_id = '${id}';"`, { stdio: 'ignore' });
        } catch { }
      }
    }
  }

  return { purgedCount, totalFreed };
}

function readAllTelemetry() {
  const { convDir, summariesDb } = getAntigravityPaths();
  if (!fs.existsSync(convDir)) return { conversations: [], active: null };

  const sqliteBin = getSqliteBinary();
  const summaryMap = getConversationSummaries(summariesDb, sqliteBin);

  const dbFiles = fs.readdirSync(convDir).filter(f => f.endsWith('.db'));
  const convStatsList = [];

  let mostRecentFile = null;
  let mostRecentTime = 0;

  for (const f of dbFiles) {
    const fullPath = path.join(convDir, f);
    const stat = fs.statSync(fullPath);
    if (stat.mtimeMs > mostRecentTime) {
      mostRecentTime = stat.mtimeMs;
      mostRecentFile = f.replace('.db', '');
    }

    const cId = f.replace('.db', '');
    const hasSummary = Boolean(summaryMap[cId]);
    const summary = summaryMap[cId] || {
      id: cId,
      title: 'Dead Ghost Chat (Deleted in Antigravity)',
      stepCount: 0,
      lastModified: stat.mtime.toISOString()
    };

    const stats = analyzeConversation(fullPath, sqliteBin);
    if (!stats || stats.calls === 0) continue;

    const storageBytes = getConversationStorageSize(cId);
    const storageMB = (storageBytes / (1024 * 1024)).toFixed(1);

    convStatsList.push({
      ...summary,
      isOrphan: !hasSummary,
      storageBytes,
      storageMB,
      mtimeMs: stat.mtimeMs,
      stats
    });
  }

  // Sort by most recently modified
  convStatsList.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const active = convStatsList.find(c => c.id === mostRecentFile) || convStatsList[0] || null;

  return {
    conversations: convStatsList,
    active
  };
}

module.exports = {
  readAllTelemetry,
  getAntigravityPaths,
  getConversationStorageSize,
  deleteConversation,
  purgeOrphanedData
};

