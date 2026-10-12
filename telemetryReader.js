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

// Per-conversation analysis cache: id -> { mtimeMs, size, walSignature, stats, storageBytes, storageCheckedAt }
// Keyed on (mtimeMs, size, walSignature) so an unchanged DB costs zero sqlite3 spawns.
const analysisCache = new Map();

// Global catalog summaries cache: cached parsing of conversation_summaries.db
let summariesCache = {
  mtimeMs: 0,
  size: 0,
  walSignature: '',
  map: null
};

// VS Code state store cache: cached parsing of state.vscdb (Antigravity IDE)
let vscdbCache = {
  mtimeMs: 0,
  size: 0,
  map: null
};

function clearAnalysisCache() {
  analysisCache.clear();
  summariesCache = { mtimeMs: 0, size: 0, walSignature: '', map: null };
  vscdbCache = { mtimeMs: 0, size: 0, map: null };
}

function dumpAnalysisCache() {
  const conversations = {};
  for (const [id, entry] of analysisCache.entries()) {
    conversations[id] = entry;
  }
  return {
    conversations,
    summaries: summariesCache.map ? {
      mtimeMs: summariesCache.mtimeMs,
      size: summariesCache.size,
      walSignature: summariesCache.walSignature,
      map: summariesCache.map
    } : null,
    vscdb: vscdbCache.map ? {
      mtimeMs: vscdbCache.mtimeMs,
      size: vscdbCache.size,
      map: vscdbCache.map
    } : null
  };
}

function loadAnalysisCache(cached) {
  if (!cached || typeof cached !== 'object') return;
  const convs = cached.conversations || (cached.summaries ? null : cached);
  if (convs && typeof convs === 'object') {
    analysisCache.clear();
    for (const [id, entry] of Object.entries(convs)) {
      if (entry && typeof entry === 'object' && typeof entry.mtimeMs === 'number' && entry.stats) {
        analysisCache.set(id, entry);
      }
    }
  }
  if (cached.summaries && typeof cached.summaries === 'object' && cached.summaries.map) {
    summariesCache = {
      mtimeMs: cached.summaries.mtimeMs || 0,
      size: cached.summaries.size || 0,
      walSignature: cached.summaries.walSignature || '',
      map: cached.summaries.map
    };
  }
  if (cached.vscdb && typeof cached.vscdb === 'object' && cached.vscdb.map) {
    vscdbCache = {
      mtimeMs: cached.vscdb.mtimeMs || 0,
      size: cached.vscdb.size || 0,
      map: cached.vscdb.map
    };
  }
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

let currentDataSource = 'auto';

function setDataSource(source) {
  currentDataSource = source || 'auto';
}

function detectRunningEnvironment() {
  if (process.execPath && /antigravity/i.test(process.execPath)) {
    return 'ide';
  }
  return null;
}

function getInstallationRoots(preference, hostEditor) {
  const pref = preference || currentDataSource || 'auto';

  const userHome = os.homedir();
  const extensionDir = path.join(userHome, '.gemini', 'antigravity');
  const ideDir = path.join(userHome, '.gemini', 'antigravity-ide');

  const candidateVscdb = [];
  if (process.platform === 'win32' && process.env.APPDATA) {
    candidateVscdb.push(
      path.join(process.env.APPDATA, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb'),
      path.join(process.env.APPDATA, 'Antigravity', 'User', 'globalStorage', 'state.vscdb')
    );
  } else if (process.platform === 'darwin') {
    candidateVscdb.push(
      path.join(userHome, 'Library', 'Application Support', 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb'),
      path.join(userHome, 'Library', 'Application Support', 'Antigravity', 'User', 'globalStorage', 'state.vscdb')
    );
  } else {
    candidateVscdb.push(
      path.join(userHome, '.config', 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb'),
      path.join(userHome, '.config', 'Antigravity', 'User', 'globalStorage', 'state.vscdb'),
      path.join(userHome, '.config', 'antigravity', 'User', 'globalStorage', 'state.vscdb')
    );
  }

  let vscdbPath = '';
  for (const cand of candidateVscdb) {
    if (fs.existsSync(cand)) {
      vscdbPath = cand;
      break;
    }
  }
  if (!vscdbPath && candidateVscdb.length > 0) {
    vscdbPath = candidateVscdb[0];
  }

  const hasExtension = fs.existsSync(extensionDir);
  const hasIde = fs.existsSync(ideDir);

  const ideRoot = {
    id: 'ide',
    name: 'Antigravity IDE',
    antigravityDir: ideDir,
    convDir: path.join(ideDir, 'conversations'),
    summariesDb: path.join(ideDir, 'conversation_summaries.db'),
    stateVscdb: fs.existsSync(vscdbPath) ? vscdbPath : null
  };

  const extensionRoot = {
    id: 'extension',
    name: 'Antigravity Extension',
    antigravityDir: extensionDir,
    convDir: path.join(extensionDir, 'conversations'),
    summariesDb: path.join(extensionDir, 'conversation_summaries.db'),
    stateVscdb: null
  };

  const roots = [];

  if (pref === 'ide') {
    if (hasIde) roots.push(ideRoot);
  } else if (pref === 'extension') {
    if (hasExtension) roots.push(extensionRoot);
  } else if (pref === 'both') {
    if (hasIde) roots.push(ideRoot);
    if (hasExtension) roots.push(extensionRoot);
  } else {
    // pref === 'auto' -> strictly select the active host editor environment to prevent clutter
    const target = hostEditor || detectRunningEnvironment();
    if (target === 'ide' && hasIde) {
      roots.push(ideRoot);
    } else if (target === 'extension' && hasExtension) {
      roots.push(extensionRoot);
    } else if (hasIde && !hasExtension) {
      roots.push(ideRoot);
    } else if (hasExtension && !hasIde) {
      roots.push(extensionRoot);
    } else if (hasIde && hasExtension) {
      // Both exist outside of an explicit host: prefer extension without merging
      roots.push(extensionRoot);
    }
  }

  // Fallback if roots is still empty
  if (roots.length === 0) {
    if (hasIde) roots.push(ideRoot);
    else roots.push(extensionRoot);
  }

  return roots;
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

// Extracts the subagent role/task string from Antigravity's raw_summary protobuf blob.
// In the protobuf layout: Tag 17 (invocation metadata) -> Tag 8 (subagent spec) -> Tag 2 (role string).
function extractSubagentRole(hexRaw) {
  if (!hexRaw || typeof hexRaw !== 'string') return '';
  const buf = Buffer.from(hexRaw, 'hex');
  let offset = 0;

  function findTag(limit, targetTag) {
    while (offset < limit) {
      const v = readVarint(buf, offset);
      if (!v) break;
      offset = v.nextOffset;
      const tagWire = Number(v.val);
      const fNum = tagWire >> 3;
      const wType = tagWire & 7;
      if (wType === 0) {
        const v0 = readVarint(buf, offset);
        if (!v0) break;
        offset = v0.nextOffset;
      } else if (wType === 2) {
        const lenObj = readVarint(buf, offset);
        if (!lenObj) break;
        offset = lenObj.nextOffset;
        const len = Number(lenObj.val);
        const start = offset;
        const end = offset + len;
        if (fNum === targetTag) {
          return { start, end, len };
        }
        offset = end;
      } else if (wType === 1) {
        offset += 8;
      } else if (wType === 5) {
        offset += 4;
      } else {
        break;
      }
    }
    return null;
  }

  try {
    const t17 = findTag(buf.length, 17);
    if (!t17) return '';
    offset = t17.start;
    const t8 = findTag(t17.end, 8);
    if (!t8) return '';
    offset = t8.start;
    const t2 = findTag(t8.end, 2);
    if (!t2) return '';
    return buf.subarray(t2.start, t2.end).toString('utf8').trim();
  } catch {
    return '';
  }
}

// Returns a Map of conversationId -> { id, title, stepCount, lastModified, ... } from the global
// conversation_summaries.db. Three possible outcomes:
//   { <id>: ... }  → successful read
//   {}    → the catalog genuinely has no rows (or does not exist yet)
//   null  → the catalog could not be read (sqlite3 missing/locked/error)
// Callers MUST distinguish these: treating "unreadable" as "empty" makes every conversation
// look like an orphan, which is how a purge could be offered for healthy chats.
function getConversationSummaries(summariesDb, sqliteBin) {
  let stat = null;
  try {
    stat = fs.statSync(summariesDb);
  } catch {
    return {};
  }

  const walSig = walSignatureOf(summariesDb);
  if (summariesCache.map &&
      summariesCache.mtimeMs === stat.mtimeMs &&
      summariesCache.size === stat.size &&
      summariesCache.walSignature === walSig) {
    return summariesCache.map;
  }

  try {
    const sql = `SELECT conversation_id, ifnull(title,'') AS title, ifnull(preview,'') AS preview, ifnull(step_count,0) AS step_count, ifnull(last_modified_time,'') AS last_modified_time, ifnull(workspace_uris,'') AS workspace_uris, ifnull(parent_conversation_id,'') AS parent_conversation_id, ifnull(nesting_depth,0) AS nesting_depth, ifnull(agent_name,'') AS agent_name, ifnull(killed,0) AS killed, HEX(raw_summary) AS hex_raw FROM conversation_summaries ORDER BY last_modified_time DESC;`;
    const out = execSync(`"${sqliteBin}" "${summariesDb}" -json "${sql}"`, { maxBuffer: 10 * 1024 * 1024 }).toString();
    const rows = JSON.parse(out);
    const map = {};
    for (const r of rows) {
      if (!r.conversation_id) continue;
      const isSubagent = Boolean(r.parent_conversation_id || r.agent_name);
      const subagentRole = (isSubagent && r.hex_raw) ? extractSubagentRole(r.hex_raw) : '';

      let title = r.title ? r.title.trim() : '';
      if (!title || title === 'Untitled Conversation' || title === '<original_task>') {
        if (isSubagent && subagentRole) {
          title = subagentRole;
        } else if (r.preview && r.preview.trim() && r.preview !== '<original_task>') {
          title = r.preview.trim();
        } else if (isSubagent && r.agent_name) {
          title = r.agent_name;
        } else {
          title = 'Untitled Conversation';
        }
      }

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
        agentRole: subagentRole,
        isSubagent,
        killed: Boolean(r.killed)
      };
    }
    // Resolve parent titles in a second pass — a child can precede its parent in the result set.
    for (const id of Object.keys(map)) {
      const parentId = map[id].parentConversationId;
      if (parentId && map[parentId]) map[id].parentTitle = map[parentId].title;
    }
    summariesCache = {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      walSignature: walSig,
      map
    };
    return map;
  } catch (err) {
    // Fallback if -json is unsupported in ancient sqlite3 versions
    try {
      const sep = '---AGSEP---';
      const sql = `SELECT conversation_id || '${sep}' || replace(replace(ifnull(title,''),char(10),' '),char(13),'') || '${sep}' || replace(replace(ifnull(preview,''),char(10),' '),char(13),'') || '${sep}' || ifnull(step_count,0) || '${sep}' || ifnull(last_modified_time,'') || '${sep}' || ifnull(workspace_uris,'') || '${sep}' || ifnull(parent_conversation_id,'') || '${sep}' || ifnull(nesting_depth,0) || '${sep}' || ifnull(agent_name,'') || '${sep}' || ifnull(killed,0) || '${sep}' || ifnull(HEX(raw_summary),'') FROM conversation_summaries ORDER BY last_modified_time DESC;`;
      const out = execSync(`"${sqliteBin}" "${summariesDb}" "${sql}"`, { maxBuffer: 10 * 1024 * 1024 }).toString();
      const map = {};
      for (const line of out.split('\n')) {
        const clean = line.replace(/\r$/, '');
        if (!clean.trim()) continue;
        const parts = clean.split(sep);
        if (parts.length < 2) continue;
        const id = parts[0];
        const rTitle = parts[1] || '';
        const rPreview = parts[2] || '';
        const stepCount = parseInt(parts[3], 10) || 0;
        const lastModified = parts[4] || '';
        const wsRaw = parts[5] || '';
        const parentConversationId = parts[6] || '';
        const nestingDepth = parseInt(parts[7], 10) || 0;
        const agentName = parts[8] || '';
        const killed = Boolean(parseInt(parts[9], 10) || 0);
        const hexRaw = parts[10] || '';

        const isSubagent = Boolean(parentConversationId || agentName);
        const subagentRole = (isSubagent && hexRaw) ? extractSubagentRole(hexRaw) : '';

        let title = rTitle ? rTitle.trim() : '';
        if (!title || title === 'Untitled Conversation' || title === '<original_task>') {
          if (isSubagent && subagentRole) {
            title = subagentRole;
          } else if (rPreview && rPreview.trim() && rPreview !== '<original_task>') {
            title = rPreview.trim();
          } else if (isSubagent && agentName) {
            title = agentName;
          } else {
            title = 'Untitled Conversation';
          }
        }

        const wsInfo = parseWorkspaceInfo(wsRaw);
        map[id] = {
          id,
          title,
          stepCount,
          lastModified,
          workspaceUris: wsRaw,
          workspacePaths: wsInfo.workspacePaths,
          workspaceName: wsInfo.workspaceName,
          parentConversationId,
          nestingDepth,
          agentName,
          agentRole: subagentRole,
          isSubagent,
          killed
        };
      }
      for (const id of Object.keys(map)) {
        const parentId = map[id].parentConversationId;
        if (parentId && map[parentId]) map[id].parentTitle = map[parentId].title;
      }
      summariesCache = {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        walSignature: walSig,
        map
      };
      return map;
    } catch {
      return null;
    }
  }
}

function parseInnerSummary(buf) {
  let offset = 0;
  let title = '';
  let stepCount = 0;
  let lastModified = '';
  const wsUris = [];
  while (offset < buf.length) {
    const k = readVarint(buf, offset);
    if (!k) break;
    offset = k.nextOffset;
    const tag = Number(k.val >> 3n);
    const wire = Number(k.val & 7n);
    if (wire === 2) {
      const l = readVarint(buf, offset);
      if (!l) break;
      offset = l.nextOffset;
      const len = safeVarintNumber(l.val);
      if (len === null || offset + len > buf.length) break;
      const slice = buf.slice(offset, offset + len);
      offset += len;
      if (tag === 1) {
        title = slice.toString('utf8').trim();
      } else if (tag === 3) {
        let to = 0;
        let sec = 0;
        while (to < slice.length) {
          const tk = readVarint(slice, to);
          if (!tk) break;
          to = tk.nextOffset;
          const ttag = Number(tk.val >> 3n);
          const twire = Number(tk.val & 7n);
          if (twire === 0) {
            const tv = readVarint(slice, to);
            if (!tv) break;
            to = tv.nextOffset;
            if (ttag === 1) sec = safeVarintNumber(tv.val) || 0;
          } else if (twire === 2) {
            const tl = readVarint(slice, to);
            if (!tl) break;
            to = tl.nextOffset + (safeVarintNumber(tl.val) || 0);
          }
        }
        if (sec > 0) {
          lastModified = new Date(sec * 1000).toISOString();
        }
      } else if (tag === 9) {
        let wso = 0;
        while (wso < slice.length) {
          const wsk = readVarint(slice, wso);
          if (!wsk) break;
          wso = wsk.nextOffset;
          const wstag = Number(wsk.val >> 3n);
          const wswire = Number(wsk.val & 7n);
          if (wswire === 2) {
            const wsl = readVarint(slice, wso);
            if (!wsl) break;
            wso = wsl.nextOffset;
            const wslen = safeVarintNumber(wsl.val) || 0;
            const wsslice = slice.slice(wso, wso + wslen);
            wso += wslen;
            if (wstag === 1) {
              const u = wsslice.toString('utf8');
              if (u.startsWith('file://')) wsUris.push(u);
            }
          } else if (wswire === 0) {
            const wv = readVarint(slice, wso);
            if (!wv) break;
            wso = wv.nextOffset;
          }
        }
      } else if (tag === 17 || tag === 21) {
        const uris = extractInDbWorkspaces(slice);
        for (const u of uris) wsUris.push(u);
      }
    } else if (wire === 0) {
      const v = readVarint(buf, offset);
      if (!v) break;
      offset = v.nextOffset;
      if (tag === 2) stepCount = safeVarintNumber(v.val) || 0;
    }
  }
  return {
    title,
    stepCount,
    lastModified,
    workspaceUris: JSON.stringify(Array.from(new Set(wsUris)))
  };
}

function parseVscdbTrajectorySummaries(buf) {
  const map = {};
  let offset = 0;
  while (offset < buf.length) {
    const k = readVarint(buf, offset);
    if (!k) break;
    offset = k.nextOffset;
    const tag = Number(k.val >> 3n);
    const wire = Number(k.val & 7n);
    if (wire === 2) {
      const lenObj = readVarint(buf, offset);
      if (!lenObj) break;
      offset = lenObj.nextOffset;
      const len = safeVarintNumber(lenObj.val);
      if (len === null || offset + len > buf.length) break;
      const itemSlice = buf.slice(offset, offset + len);
      offset += len;
      if (tag === 1) {
        let cId = '';
        let innerBase64 = '';
        let io = 0;
        while (io < itemSlice.length) {
          const ik = readVarint(itemSlice, io);
          if (!ik) break;
          io = ik.nextOffset;
          const itag = Number(ik.val >> 3n);
          const iwire = Number(ik.val & 7n);
          if (iwire === 2) {
            const ilenObj = readVarint(itemSlice, io);
            if (!ilenObj) break;
            io = ilenObj.nextOffset;
            const ilen = safeVarintNumber(ilenObj.val) || 0;
            const islice = itemSlice.slice(io, io + ilen);
            io += ilen;
            if (itag === 1) {
              cId = islice.toString('utf8');
            } else if (itag === 2) {
              let c2o = 0;
              while (c2o < islice.length) {
                const c2k = readVarint(islice, c2o);
                if (!c2k) break;
                c2o = c2k.nextOffset;
                const c2tag = Number(c2k.val >> 3n);
                const c2wire = Number(c2k.val & 7n);
                if (c2wire === 2) {
                  const c2lenObj = readVarint(islice, c2o);
                  if (!c2lenObj) break;
                  c2o = c2lenObj.nextOffset;
                  const c2len = safeVarintNumber(c2lenObj.val) || 0;
                  const c2slice = islice.slice(c2o, c2o + c2len);
                  c2o += c2len;
                  if (c2tag === 1) innerBase64 = c2slice.toString('utf8');
                } else if (c2wire === 0) {
                  const v = readVarint(islice, c2o);
                  if (!v) break;
                  c2o = v.nextOffset;
                }
              }
            }
          } else if (iwire === 0) {
            const v = readVarint(itemSlice, io);
            if (!v) break;
            io = v.nextOffset;
          }
        }
        if (cId && innerBase64) {
          try {
            const innerBuf = Buffer.from(innerBase64, 'base64');
            const summary = parseInnerSummary(innerBuf);
            if (summary) {
              map[cId] = { id: cId, ...summary };
            }
          } catch {}
        }
      }
    } else if (wire === 0) {
      const v = readVarint(buf, offset);
      if (!v) break;
      offset = v.nextOffset;
    }
  }
  return map;
}

function getVscdbSummaries(vscdbPath, sqliteBin) {
  if (!vscdbPath || !sqliteBin) return null;
  let stat = null;
  try {
    stat = fs.statSync(vscdbPath);
  } catch {
    return null;
  }

  if (vscdbCache.map &&
      vscdbCache.mtimeMs === stat.mtimeMs &&
      vscdbCache.size === stat.size) {
    return vscdbCache.map;
  }

  try {
    const sql = "SELECT value FROM ItemTable WHERE key = 'antigravityUnifiedStateSync.trajectorySummaries';";
    const out = execSync(`"${sqliteBin}" "${vscdbPath}" "${sql}"`, { maxBuffer: 32 * 1024 * 1024 }).toString().trim();
    if (!out) return {};
    const buf = Buffer.from(out, 'base64');
    const rawMap = parseVscdbTrajectorySummaries(buf);
    const map = {};
    for (const [id, s] of Object.entries(rawMap)) {
      const wsInfo = parseWorkspaceInfo(s.workspaceUris);
      map[id] = {
        id,
        title: s.title || 'Untitled Conversation',
        stepCount: s.stepCount || 0,
        lastModified: s.lastModified || stat.mtime.toISOString(),
        workspaceUris: s.workspaceUris || '',
        workspacePaths: wsInfo.workspacePaths,
        workspaceName: wsInfo.workspaceName,
        parentConversationId: '',
        nestingDepth: 0,
        agentName: '',
        agentRole: '',
        isSubagent: false,
        killed: false,
        source: 'ide'
      };
    }
    vscdbCache = {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      map
    };
    return map;
  } catch {
    return null;
  }
}

function extractInDbWorkspaces(buf) {
  const wsUris = [];
  let offset = 0;
  while (offset < buf.length) {
    const k = readVarint(buf, offset);
    if (!k) break;
    offset = k.nextOffset;
    const tag = Number(k.val >> 3n);
    const wire = Number(k.val & 7n);
    if (wire === 2) {
      const l = readVarint(buf, offset);
      if (!l) break;
      offset = l.nextOffset;
      const len = safeVarintNumber(l.val);
      if (len === null || offset + len > buf.length) break;
      const slice = buf.slice(offset, offset + len);
      offset += len;
      if (tag === 1) {
        let io = 0;
        while (io < slice.length) {
          const ik = readVarint(slice, io);
          if (!ik) break;
          io = ik.nextOffset;
          const itag = Number(ik.val >> 3n);
          const iwire = Number(ik.val & 7n);
          if (iwire === 2) {
            const il = readVarint(slice, io);
            if (!il) break;
            io = il.nextOffset;
            const ilen = safeVarintNumber(il.val) || 0;
            const islice = slice.slice(io, io + ilen);
            io += ilen;
            if (itag === 1) {
              const u = islice.toString('utf8');
              if (u.startsWith('file://')) wsUris.push(u);
            }
          } else if (iwire === 0) {
            const iv = readVarint(slice, io);
            if (!iv) break;
            io = iv.nextOffset;
          }
        }
      } else if (tag === 7) {
        const u = slice.toString('utf8');
        if (u.startsWith('file://')) wsUris.push(u);
      }
    } else if (wire === 0) {
      const v = readVarint(buf, offset);
      if (!v) break;
      offset = v.nextOffset;
    }
  }
  return Array.from(new Set(wsUris));
}

function extractInDbPrompt(buf) {
  let offset = 0;
  while (offset < buf.length) {
    const k = readVarint(buf, offset);
    if (!k) break;
    offset = k.nextOffset;
    const tag = Number(k.val >> 3n);
    const wire = Number(k.val & 7n);
    if (wire === 2) {
      const l = readVarint(buf, offset);
      if (!l) break;
      offset = l.nextOffset;
      const len = safeVarintNumber(l.val);
      if (len === null || offset + len > buf.length) break;
      const slice = buf.slice(offset, offset + len);
      offset += len;
      if (tag === 19) {
        let io = 0;
        while (io < slice.length) {
          const ik = readVarint(slice, io);
          if (!ik) break;
          io = ik.nextOffset;
          const itag = Number(ik.val >> 3n);
          const iwire = Number(ik.val & 7n);
          if (iwire === 2) {
            const il = readVarint(slice, io);
            if (!il) break;
            io = il.nextOffset;
            const ilen = safeVarintNumber(il.val) || 0;
            const islice = slice.slice(io, io + ilen);
            io += ilen;
            if (itag === 2) {
              return islice.toString('utf8').trim();
            }
          } else if (iwire === 0) {
            const iv = readVarint(slice, io);
            if (!iv) break;
            io = iv.nextOffset;
          }
        }
      }
    } else if (wire === 0) {
      const v = readVarint(buf, offset);
      if (!v) break;
      offset = v.nextOffset;
    }
  }
  return '';
}

function extractInDbMetadata(dbPath, sqliteBin) {
  let wsUris = [];
  let prompt = '';
  try {
    const sql = "SELECT (SELECT hex(data) FROM trajectory_metadata_blob WHERE id='main') AS hex_ws, (SELECT hex(step_payload) FROM steps WHERE idx=0) AS hex_step;";
    const out = execSync(`"${sqliteBin}" "${dbPath}" -json "${sql}"`, { maxBuffer: 32 * 1024 * 1024, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }).toString().trim();
    if (out) {
      const rows = JSON.parse(out);
      if (rows && rows[0]) {
        if (rows[0].hex_ws) wsUris = extractInDbWorkspaces(Buffer.from(rows[0].hex_ws, 'hex'));
        if (rows[0].hex_step) prompt = extractInDbPrompt(Buffer.from(rows[0].hex_step, 'hex'));
      }
    }
  } catch {}

  const wsRaw = JSON.stringify(wsUris);
  const wsInfo = parseWorkspaceInfo(wsRaw);
  let cleanTitle = prompt ? prompt.replace(/[\r\n]+/g, ' ').trim() : '';
  if (cleanTitle.length > 80) cleanTitle = cleanTitle.slice(0, 77) + '...';

  return {
    title: cleanTitle || 'Active Session',
    workspaceUris: wsRaw,
    workspacePaths: wsInfo.workspacePaths,
    workspaceName: wsInfo.workspaceName
  };
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
  const out = execSync(`"${sqliteBin}" "${dbPath}" "${sql}"`, { maxBuffer: 128 * 1024 * 1024, stdio: ['pipe', 'pipe', 'ignore'] }).toString();
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
      rawOut = execSync(`"${sqliteBin}" "${dbPath}" "SELECT idx, quote(data) FROM gen_metadata ORDER BY idx ASC;"`, { maxBuffer: 128 * 1024 * 1024, stdio: ['pipe', 'pipe', 'ignore'] }).toString();
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
      isCompacted: false,
      compactedAmount: 0
    };

    if (firstContext === null) firstContext = effectiveContext;
    if (effectiveContext > peakContextSeen) peakContextSeen = effectiveContext;
    if (minContextSeen === null || effectiveContext < minContextSeen) minContextSeen = effectiveContext;

    // Keep 1:1 timeline fidelity across all turns so chart tooltip and horizontal progression
    // reflect exact turns without downsampling distortion.
    const turnNumber = idx + 1;
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
      isCompacted: false,
      compactedAmount: 0
    });
  }

  // Reconcile true compactions across the full contextTimeline:
  // Antigravity IDE prunes tool output during intermediate planner steps between sub-trajectories,
  // creating transient single-turn V-dips (e.g. ~116k -> ~82k -> ~124k) that rebound on the next turn.
  // True session compactions are sustained drops (resetting context back to ~20k-40k at ceiling).
  compactionsCount = 0;
  compactedAmount = 0;
  isCompacted = false;

  for (let i = 0; i < contextTimeline.length; i++) {
    const curr = contextTimeline[i];
    const prev = i > 0 ? contextTimeline[i - 1] : null;
    let turnCompacted = false;
    let turnCompactedAmt = 0;

    if (prev && prev.input > 0 && curr.input < prev.input - 10000) {
      const drop = prev.input - curr.input;
      const next1 = i + 1 < contextTimeline.length ? contextTimeline[i + 1] : null;
      const next2 = i + 2 < contextTimeline.length ? contextTimeline[i + 2] : null;
      // If a subsequent turn within 2 turns rebounds back to >= 85% of pre-drop context,
      // it was a transient planner dip, NOT a true session compaction.
      const isTransient = Boolean(
        (next1 && next1.input >= prev.input * 0.85) ||
        (next2 && next2.input >= prev.input * 0.85)
      );
      if (!isTransient) {
        turnCompacted = true;
        turnCompactedAmt = drop;
        compactionsCount++;
        compactedAmount = drop;
        isCompacted = true;
      }
    }

    curr.isCompacted = turnCompacted;
    curr.compactedAmount = turnCompactedAmt;
  }

  if (lastTurn && contextTimeline.length > 0) {
    const lastItem = contextTimeline[contextTimeline.length - 1];
    lastTurn.isCompacted = lastItem.isCompacted;
    lastTurn.compactedAmount = lastItem.compactedAmount;
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

function findRootForConversation(id) {
  const roots = getInstallationRoots('both');
  for (const r of roots) {
    if (fs.existsSync(path.join(r.convDir, `${id}.db`))) {
      return r;
    }
  }
  return roots[0];
}

function getConversationStorageSize(id, customDir) {
  const root = customDir ? { antigravityDir: customDir, convDir: path.join(customDir, 'conversations') } : findRootForConversation(id);
  const antigravityDir = root.antigravityDir;
  const convDir = root.convDir;
  let total = 0;
  const dbPath = path.join(convDir, `${id}.db`);
  const walPath = path.join(convDir, `${id}.db-wal`);
  const shmPath = path.join(convDir, `${id}.db-shm`);
  const brainPath = path.join(antigravityDir, 'brain', id);
  const annPath = path.join(antigravityDir, 'annotations', `${id}.pbtxt`);
  const browserPath = path.join(antigravityDir, 'browser_recordings', id);
  const impPath = path.join(antigravityDir, 'implicit', `${id}.pb`);

  for (const p of [dbPath, walPath, shmPath, annPath, impPath]) {
    try { total += fs.statSync(p).size; } catch { }
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
function collectConversationTargets(id, customDir) {
  const root = customDir ? { antigravityDir: customDir, convDir: path.join(customDir, 'conversations') } : findRootForConversation(id);
  const antigravityDir = root.antigravityDir;
  const convDir = root.convDir;
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
 * @param {{recycleBin?: boolean, rootDir?: string}} [options]  Defaults to the Recycle Bin for recoverability.
 */
function deleteConversation(conversationId, options = {}) {
  const safeId = validateConversationId(conversationId);
  if (!safeId) {
    throw new Error('Invalid conversation ID: expected a UUID');
  }

  const useRecycleBin = options.recycleBin !== false;
  const root = options.rootDir
    ? { antigravityDir: options.rootDir, convDir: path.join(options.rootDir, 'conversations'), summariesDb: path.join(options.rootDir, 'conversation_summaries.db') }
    : findRootForConversation(safeId);
  const sqliteBin = getSqliteBinary();
  if (!sqliteBin) {
    throw new Error('sqlite3 executable not found. Configure antigravity.sqlitePath in settings.');
  }
  const targets = collectConversationTargets(safeId, root.antigravityDir);
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

  const dbTarget = targets.find(t => t.path === path.join(root.convDir, `${safeId}.db`));
  const databaseRemoved = Boolean(dbTarget) && !fs.existsSync(dbTarget.path);

  // 3. Only touch the catalog when the whole conversation was removed.
  const summariesDb = root.summariesDb || path.join(root.antigravityDir, 'conversation_summaries.db');
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

function readAllTelemetry(options = {}) {
  const force = Boolean(options && options.force);
  if (force) {
    summariesCache = { mtimeMs: 0, size: 0, walSignature: '', map: null };
    vscdbCache = { mtimeMs: 0, size: 0, map: null };
  }
  const dataSource = (options && options.dataSource) || currentDataSource;
  const roots = getInstallationRoots(dataSource, options && options.hostEditor);
  const sqliteBin = getSqliteBinary();

  // A missing CLI is reported explicitly so the UI can say so, rather than showing "no chats".
  if (!sqliteBin) {
    return { conversations: [], active: null, catalogAvailable: false, sqliteAvailable: false };
  }

  let overallCatalogAvailable = false;
  const catalog = {};

  for (const root of roots) {
    let rootCatalog = null;
    if (root.summariesDb && fs.existsSync(root.summariesDb)) {
      rootCatalog = getConversationSummaries(root.summariesDb, sqliteBin);
      if (rootCatalog !== null) {
        overallCatalogAvailable = true;
        Object.assign(catalog, rootCatalog);
      }
    }
    if (root.stateVscdb && fs.existsSync(root.stateVscdb)) {
      const vscdbMap = getVscdbSummaries(root.stateVscdb, sqliteBin);
      if (vscdbMap !== null) {
        overallCatalogAvailable = true;
        for (const [id, s] of Object.entries(vscdbMap)) {
          if (!catalog[id]) catalog[id] = s;
        }
      }
    }
  }

  const catalogAvailable = overallCatalogAvailable;
  const now = Date.now();
  const fileEntries = [];

  for (const root of roots) {
    if (!fs.existsSync(root.convDir)) continue;
    let dbFiles = [];
    try {
      dbFiles = fs.readdirSync(root.convDir).filter(f => f.endsWith('.db'));
    } catch {
      continue;
    }
    for (const f of dbFiles) {
      const fullPath = path.join(root.convDir, f);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.size === 0) continue;
        let mtimeMs = stat.mtimeMs;
        let walSignature = '';
        const walPath = `${fullPath}-wal`;
        try {
          const walStat = fs.statSync(walPath);
          walSignature = `${walStat.mtimeMs}:${walStat.size}`;
          if (walStat.mtimeMs > mtimeMs) {
            mtimeMs = walStat.mtimeMs;
          }
        } catch {}
        fileEntries.push({ f, fullPath, cId: f.replace(/\.db$/, ''), stat, mtimeMs, walSignature, root });
      } catch { }
    }
  }

  if (fileEntries.length === 0) {
    return { conversations: [], active: null, catalogAvailable, sqliteAvailable: true };
  }

  // Deduplicate conversations present in multiple roots: prefer newer mtime
  const byId = new Map();
  for (const entry of fileEntries) {
    const existing = byId.get(entry.cId);
    if (!existing || entry.mtimeMs > existing.mtimeMs) {
      byId.set(entry.cId, entry);
    }
  }

  const dedupedEntries = Array.from(byId.values());
  dedupedEntries.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const convStatsList = [];
  const seen = new Set();

  for (const { fullPath, cId, stat, mtimeMs, walSignature, root } of dedupedEntries) {
    seen.add(cId);

    // ---- analysis: reuse the cache unless this conversation actually changed ----
    const entry = analysisCache.get(cId);
    // A live WAL is where writes land, so it is part of the freshness signature even though
    // the main .db mtime/size may be untouched.
    const changed = !entry
      || entry.mtimeMs !== stat.mtimeMs
      || entry.size !== stat.size
      || entry.walSignature !== walSignature;
    // A shrunken file means rows were removed or the DB was rewritten: never patch incrementally.
    const shrank = Boolean(entry && stat.size < entry.size);

    let stats = null;
    if (entry && !changed && !force) {
      stats = entry.stats; // zero sqlite3 spawns
    } else {
      stats = analyzeConversation(fullPath, sqliteBin, (shrank || force) ? null : (entry ? entry.stats : null));
      if (!stats && entry) stats = entry.stats; // keep the last good reading
      if (!stats) continue;
      analysisCache.set(cId, {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        walSignature,
        stats,
        storageBytes: entry ? entry.storageBytes : null,
        storageCheckedAt: entry ? entry.storageCheckedAt : 0,
        inDbMetadata: entry ? entry.inDbMetadata : null
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
      cacheEntry.storageBytes = getConversationStorageSize(cId, root.antigravityDir);
      cacheEntry.storageCheckedAt = now;
    }

    const storageBytes = cacheEntry.storageBytes || 0;
    const hasSummary = Boolean(catalog[cId]);

    // Fallback: in-db metadata extraction for active or uncataloged chats
    let inDbMeta = cacheEntry.inDbMetadata;
    const hasActiveWal = fs.existsSync(`${fullPath}-wal`);
    const isRecentlyActive = hasActiveWal || (now - stat.mtimeMs < 24 * 60 * 60 * 1000);

    if (!hasSummary) {
      if (!inDbMeta || changed) {
        inDbMeta = extractInDbMetadata(fullPath, sqliteBin);
        cacheEntry.inDbMetadata = inDbMeta;
      }
    }

    let summary;
    let isOrphan = false;

    if (hasSummary) {
      summary = catalog[cId];
      isOrphan = false;
    } else if (isRecentlyActive || (inDbMeta && inDbMeta.workspacePaths && inDbMeta.workspacePaths.length > 0)) {
      summary = {
        id: cId,
        title: (inDbMeta && inDbMeta.title) ? inDbMeta.title : 'Active Session',
        stepCount: stats.calls || 0,
        lastModified: stat.mtime.toISOString(),
        workspaceUris: (inDbMeta && inDbMeta.workspaceUris) || '',
        workspacePaths: (inDbMeta && inDbMeta.workspacePaths) || [],
        workspaceName: (inDbMeta && inDbMeta.workspaceName) || '',
        parentConversationId: '',
        nestingDepth: 0,
        agentName: '',
        agentRole: '',
        isSubagent: false,
        killed: false,
        source: root.id
      };
      isOrphan = false;
    } else {
      summary = {
        id: cId,
        title: catalogAvailable ? 'Dead Ghost Chat (Deleted in Antigravity)' : 'Untitled Conversation (catalog unreadable)',
        stepCount: 0,
        lastModified: stat.mtime.toISOString(),
        workspaceUris: (inDbMeta && inDbMeta.workspaceUris) || '',
        workspacePaths: (inDbMeta && inDbMeta.workspacePaths) || [],
        workspaceName: (inDbMeta && inDbMeta.workspaceName) || '',
        source: root.id
      };
      isOrphan = catalogAvailable;
    }

    convStatsList.push({
      ...summary,
      isOrphan,
      storageBytes,
      storageMB: (storageBytes / (1024 * 1024)).toFixed(1),
      mtimeMs,
      source: root.id,
      rootDir: root.antigravityDir,
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
  getInstallationRoots,
  setDataSource,
  getConversationStorageSize,
  deleteConversation,
  parseWorkspaceInfo,
  conversationMatchesWorkspace,
  selectActiveConversation,
  getSqliteBinary,
  setCustomSqlitePath,
  dumpAnalysisCache,
  loadAnalysisCache,
  // exposed for tooling / self-check scripts
  analyzeConversation,
  parseProto,
  validateConversationId,
  clearAnalysisCache,
  recyclePaths,
  extractSubagentRole,
  getVscdbSummaries,
  parseVscdbTrajectorySummaries,
  extractInDbWorkspaces,
  extractInDbPrompt,
  extractInDbMetadata
};

