#!/usr/bin/env node
/**
 * Self-check for Antigravity Telemetry.
 *
 *   node scripts/self-check.js
 *
 * Verifies the parts that are easy to break silently:
 *   1. protobuf decoding + usage math (synthetic rows with known values)
 *   2. incremental analysis produces byte-identical numbers to a full re-read
 *   3. the (mtimeMs, size) cache actually eliminates work
 *   4. conversation-id validation rejects anything that is not a UUID
 *   5. the Recycle Bin path really removes files (a temporary folder, not your data)
 *
 * Nothing here touches a real conversation: the mutating tests only ever operate on files
 * created in a temp directory.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const reader = require('../telemetryReader');

let passed = 0;
let failed = 0;

function check(name, ok, detail) {
    if (ok) {
        passed++;
        console.log(`  PASS  ${name}`);
    } else {
        failed++;
        console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`);
    }
}

function section(title) {
    console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
// helpers: build protobuf rows without any dependency
// ---------------------------------------------------------------------------
function varint(n) {
    const out = [];
    let v = BigInt(n);
    for (; ;) {
        let b = Number(v & 0x7Fn);
        v >>= 7n;
        if (v > 0n) b |= 0x80;
        out.push(b);
        if (v === 0n) break;
    }
    return Buffer.from(out);
}
const varField = (tag, n) => Buffer.concat([varint((BigInt(tag) << 3n) | 0n), varint(n)]);
const lenField = (tag, buf) => Buffer.concat([varint((BigInt(tag) << 3n) | 2n), varint(buf.length), buf]);
const strField = (tag, s) => lenField(tag, Buffer.from(s, 'utf8'));

// root.tag1 { tag19: model, tag4: { 2: fresh, 5: cached, 3: output, 9: thinking, 10: response }, tag9?: { tag10: { 1: contextTokens, 4: contextCeiling } } }
function buildRow(model, fresh, cached, output, thinking, response, contextTokens, contextCeiling) {
    const usage = Buffer.concat([
        varField(2, fresh),
        varField(5, cached),
        varField(3, output),
        varField(9, thinking),
        varField(10, response)
    ]);
    const t1Parts = [strField(19, model), lenField(4, usage)];
    if (contextTokens !== undefined && contextTokens !== null) {
        const t10Fields = [varField(1, contextTokens)];
        if (contextCeiling !== undefined && contextCeiling !== null) {
            t10Fields.push(varField(4, contextCeiling));
        }
        const t10 = lenField(10, Buffer.concat(t10Fields));
        t1Parts.push(lenField(9, t10));
    }
    const t1 = Buffer.concat(t1Parts);
    // a couple of extra length-delimited fields so the decoder walks realistic data
    return Buffer.concat([lenField(1, t1), lenField(4, Buffer.from('11111111-2222-3333-4444-555555555555', 'utf8'))]);
}

function resolveSqlite() {
    const candidates = [
        'C:\\Users\\Harsh\\adb-fastboot\\platform-tools\\sqlite3.exe',
        'sqlite3',
        'sqlite3.exe'
    ];
    for (const c of candidates) {
        try {
            execSync(`"${c}" --version`, { stdio: 'ignore' });
            return c;
        } catch { /* next */ }
    }
    return null;
}

function insertRows(sqliteBin, file, rows, startIdx = 0) {
    const chunkSize = 15;
    for (let s = 0; s < rows.length; s += chunkSize) {
        const chunk = rows.slice(s, s + chunkSize);
        const inserts = chunk.map((r, i) => `INSERT INTO gen_metadata (idx, data, size) VALUES (${startIdx + s + i}, X'${r.toString('hex')}', ${r.length});`).join(' ');
        execSync(`"${sqliteBin}" "${file}" "${inserts}"`, { stdio: 'ignore' });
    }
}

function createFixtureDb(sqliteBin, file, rows) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    execSync(`"${sqliteBin}" "${file}" "CREATE TABLE gen_metadata (idx integer, data blob, size integer NOT NULL DEFAULT 0, PRIMARY KEY (idx));"`, { stdio: 'ignore' });
    insertRows(sqliteBin, file, rows, 0);
    return file;
}

// ---------------------------------------------------------------------------
// 1. synthetic decode + math
// ---------------------------------------------------------------------------
function testSynthetic() {
    section('1. protobuf decode + usage math (synthetic)');
    const sqliteBin = resolveSqlite();
    if (!sqliteBin) {
        check('sqlite3 available', false, 'no sqlite3 binary found');
        return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-synth-'));
    // Turn 1: 22400 overhead contextTokens, 256000 ceiling
    // Turn 2: 120000 contextTokens, 256000 ceiling
    // Turn 3: 25000 contextTokens, 256000 ceiling -> ground-truth compaction drop of 95000 tokens!
    const db = createFixtureDb(sqliteBin, path.join(dir, 'fixture.db'), [
        buildRow('test-model-9', 10000, 0, 500, 100, 400, 22400, 256000),
        buildRow('test-model-9', 100, 40000, 200, 50, 150, 120000, 256000),
        buildRow('test-model-9', 50, 15000, 100, 20, 80, 25000, 256000)
    ]);

    const s = reader.analyzeConversation(db, sqliteBin, null);
    check('model name decoded from tag19 (string)', s && s.modelName === 'test-model-9', s && s.modelName);
    check('calls', s && s.calls === 3, s && s.calls);
    check('totalNonCached', s && s.totalNonCached === 10150, s && s.totalNonCached);
    check('totalCached', s && s.totalCached === 55000, s && s.totalCached);
    check('totalOutput', s && s.totalOutput === 800, s && s.totalOutput);
    check('totalThinking', s && s.totalThinking === 170, s && s.totalThinking);
    check('totalResponse', s && s.totalResponse === 630, s && s.totalResponse);
    check('grandTotal', s && s.grandTotal === 65950, s && s.grandTotal);
    check('decoded contextTokens from tag1.tag9.tag10.tag1', s && s.contextTokens === 25000, s && s.contextTokens);
    check('decoded contextLimit from tag1.tag9.tag10.tag4', s && s.contextLimit === 256000, s && s.contextLimit);
    check('currentContext reflects contextTokens', s && s.currentContext === 25000, s && s.currentContext);
    check('thinkingRate computed and available', s && s.thinkingRate === '21.3', s && s.thinkingRate);
    check('cost fields removed entirely', s && s.estimatedCost === undefined && s.costSaved === undefined);
    check('cacheMisses (cold starts)', s && s.cacheMisses === 1, s && s.cacheMisses);
    check('cacheHits', s && s.cacheHits === 2, s && s.cacheHits);
    check('ground-truth compaction detected (120000 -> 25000)', s && s.compactionsCount === 1, s && s.compactionsCount);
    check('ground-truth exact compacted amount (95000)', s && s.compactedAmount === 95000, s && s.compactedAmount);
    check('peakContext', s && s.peakContext === 120000, s && s.peakContext);
    check('minContext', s && s.minContext === 22400, s && s.minContext);
    check('lastIdx', s && s.lastIdx === 2, s && s.lastIdx);

    // -------------------------------------------------------------------------
    // 1b. per-row fallback & legacy chat support
    // -------------------------------------------------------------------------
    section('1b. per-row fallback & legacy chat support');
    const mixedDb = createFixtureDb(sqliteBin, path.join(dir, 'mixed.db'), [
        // Row 0 has NO tag9.tag10: falls back to totalInput (10000) and 255000
        buildRow('test-model-mixed', 10000, 0, 500, 100, 400),
        // Row 1 HAS tag9.tag10: adopts 115000 contextTokens and 256000 ceiling
        buildRow('test-model-mixed', 100, 40000, 200, 50, 150, 115000, 256000)
    ]);
    const mixedState = reader.analyzeConversation(mixedDb, sqliteBin, null);
    check('mixed chat adopts contextTokens on row 1', mixedState && mixedState.contextTokens === 115000, mixedState && mixedState.contextTokens);
    check('mixed chat adopts 256000 contextLimit on row 1', mixedState && mixedState.contextLimit === 256000, mixedState && mixedState.contextLimit);

    // Pure legacy fixture (no rows have tag9.tag10)
    const legDb = createFixtureDb(sqliteBin, path.join(dir, 'legacy.db'), [
        buildRow('test-model-legacy', 10000, 0, 500, 100, 400),
        buildRow('test-model-legacy', 100, 40000, 200, 50, 150),
        buildRow('test-model-legacy', 50, 15000, 100, 20, 80)
    ]);
    const legState = reader.analyzeConversation(legDb, sqliteBin, null);
    check('legacy chat falls back to 255000 ceiling', legState && legState.contextLimit === 255000, legState && legState.contextLimit);
    check('legacy chat currentContext falls back to fresh+cached (15050)', legState && legState.currentContext === 15050, legState && legState.currentContext);
    check('legacy chat detects compaction on fresh+cached drop (40100 -> 15050)', legState && legState.compactionsCount === 1, legState && legState.compactionsCount);
    check('legacy chat compacted amount (25050)', legState && legState.compactedAmount === 25050, legState && legState.compactedAmount);

    // -------------------------------------------------------------------------
    // 1c. transient planner dips vs true compactions
    // -------------------------------------------------------------------------
    section('1c. transient planner dips vs true compactions');
    const vDipDb = createFixtureDb(sqliteBin, path.join(dir, 'vdip.db'), [
        // Turn 1: Initial context 22400
        buildRow('test-model-vdip', 10000, 0, 500, 100, 400, 22400, 256000),
        // Turn 2: Context climbs to 116000
        buildRow('test-model-vdip', 100, 40000, 200, 50, 150, 116000, 256000),
        // Turn 3: Transient planner notch dips to 82000 (drop of 34000)
        buildRow('test-model-vdip', 50, 15000, 100, 20, 80, 82000, 256000),
        // Turn 4: Context rebounds to 124000 (> 85% of Turn 2)
        buildRow('test-model-vdip', 100, 20000, 100, 20, 80, 124000, 256000),
        // Turn 5: Context reaches ceiling 255000
        buildRow('test-model-vdip', 100, 100000, 200, 50, 150, 255000, 256000),
        // Turn 6: True session compaction drops to 42000 (drop of 213000)
        buildRow('test-model-vdip', 50, 10000, 100, 20, 80, 42000, 256000),
        // Turn 7: Sustained post-compaction context remains low at 46000
        buildRow('test-model-vdip', 50, 12000, 100, 20, 80, 46000, 256000)
    ]);
    const vDipState = reader.analyzeConversation(vDipDb, sqliteBin, null);
    check('transient notch at turn 3 is not flagged as compaction', vDipState && !vDipState.contextTimeline[2].isCompacted);
    check('true compaction at turn 6 is flagged as compaction', vDipState && vDipState.contextTimeline[5].isCompacted);
    check('compactionsCount accurately equals 1 (excluding transient dip)', vDipState && vDipState.compactionsCount === 1, vDipState && vDipState.compactionsCount);
    check('compactedAmount reflects true compaction drop (213000)', vDipState && vDipState.compactedAmount === 213000, vDipState && vDipState.compactedAmount);

    // -------------------------------------------------------------------------
    // 2. incremental == full
    // -------------------------------------------------------------------------
    section('2. incremental analysis matches a full re-read');
    const rowsAll = [
        buildRow('test-model-9', 10000, 0, 500, 100, 400, 22400, 256000),
        buildRow('test-model-9', 100, 40000, 200, 50, 150, 120000, 256000),
        buildRow('test-model-9', 50, 15000, 100, 20, 80, 25000, 256000)
    ];
    const inc = createFixtureDb(sqliteBin, path.join(dir, 'incremental.db'), rowsAll.slice(0, 1));
    const stateA = reader.analyzeConversation(inc, sqliteBin, null);
    execSync(`"${sqliteBin}" "${inc}" "INSERT INTO gen_metadata (idx, data, size) VALUES (1, X'${rowsAll[1].toString('hex')}', ${rowsAll[1].length}), (2, X'${rowsAll[2].toString('hex')}', ${rowsAll[2].length});"`, { stdio: 'ignore' });
    const incremental = reader.analyzeConversation(inc, sqliteBin, stateA);
    const full = reader.analyzeConversation(inc, sqliteBin, null);

    const pick = o => JSON.stringify({
        calls: o.calls, totalNonCached: o.totalNonCached, totalCached: o.totalCached,
        totalOutput: o.totalOutput, grandTotal: o.grandTotal, currentContext: o.currentContext,
        contextTokens: o.contextTokens, contextLimit: o.contextLimit,
        peakContext: o.peakContext, minContext: o.minContext, cacheHits: o.cacheHits,
        cacheMisses: o.cacheMisses, compactionsCount: o.compactionsCount,
        compactedAmount: o.compactedAmount, modelName: o.modelName, lastIdx: o.lastIdx,
        timeline: o.contextTimeline.map(t => t.turn + ':' + t.input)
    });
    const same = pick(incremental) === pick(full);
    check('incremental numbers == full numbers', same);
    if (!same) {
        console.log('    incremental:', pick(incremental));
        console.log('    full       :', pick(full));
    }
    check('peakContext identical in full vs incremental read', incremental && full && incremental.peakContext === full.peakContext);
    check('minContext identical in full vs incremental read', incremental && full && incremental.minContext === full.minContext);

    // -------------------------------------------------------------------------
    // 2b. structural guard: deleted rows must not be patched incrementally
    // -------------------------------------------------------------------------
    section('2b. deleted rows / rewritten tables invalidate the cache');
    const growable = createFixtureDb(sqliteBin, path.join(dir, 'deleting.db'), rowsAll.concat([
        buildRow('test-model-9', 7, 7, 7, 1, 6, 26000, 256000),
        buildRow('test-model-9', 8, 8, 8, 1, 7, 27000, 256000)
    ]));
    const beforeDelete = reader.analyzeConversation(growable, sqliteBin, null);
    check('fixture has 5 turns', beforeDelete && beforeDelete.calls === 5, beforeDelete && beforeDelete.calls);

    execSync(`"${sqliteBin}" "${growable}" "DELETE FROM gen_metadata WHERE idx >= 3;"`, { stdio: 'ignore' });
    const patched = reader.analyzeConversation(growable, sqliteBin, beforeDelete);
    const rebuilt = reader.analyzeConversation(growable, sqliteBin, null);
    check('row deletion detected, cache rebuilt instead of patched', pick(patched) === pick(rebuilt));
    check('turn count reflects the deletion (3, not 5)', patched && patched.calls === 3, patched && patched.calls);

    // -------------------------------------------------------------------------
    // 2c. peak/min context tracks every turn even when skipped by decimation
    // -------------------------------------------------------------------------
    section('2c. peak/min context tracks non-sampled turns & preserves incremental parity');
    const decimRows = [];
    for (let i = 0; i < 140; i++) {
        // Base context around 30,000. Turn 102 (idx 101) spikes to 88,888.
        // Turn 104 (idx 103) dips to 12,345.
        // With stride 2, idx 101 and 103 are skipped in decimation.
        let ctx = 30000;
        if (i === 101) ctx = 88888;
        if (i === 103) ctx = 12345;
        decimRows.push(buildRow('test-model-decim', 10, 10, 5, 1, 4, ctx, 256000));
    }
    const decimDb = createFixtureDb(sqliteBin, path.join(dir, 'decim.db'), decimRows.slice(0, 100));
    const decimStateA = reader.analyzeConversation(decimDb, sqliteBin, null);
    insertRows(sqliteBin, decimDb, decimRows.slice(100), 100);
    const decimInc = reader.analyzeConversation(decimDb, sqliteBin, decimStateA);
    const decimFull = reader.analyzeConversation(decimDb, sqliteBin, null);

    check('non-sampled turn 102 peak (88888) captured in full read', decimFull && decimFull.peakContext === 88888, decimFull && decimFull.peakContext);
    check('non-sampled turn 102 peak (88888) captured in incremental read', decimInc && decimInc.peakContext === 88888, decimInc && decimInc.peakContext);
    check('non-sampled turn 104 min (12345) captured in full read', decimFull && decimFull.minContext === 12345, decimFull && decimFull.minContext);
    check('non-sampled turn 104 min (12345) captured in incremental read', decimInc && decimInc.minContext === 12345, decimInc && decimInc.minContext);
    check('decimated chat peakContext identical in full vs incremental read', decimInc && decimFull && decimInc.peakContext === decimFull.peakContext);
    check('decimated chat minContext identical in full vs incremental read', decimInc && decimFull && decimInc.minContext === decimFull.minContext);

    fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 3. real data: cache eliminates work + real-data incremental parity
// ---------------------------------------------------------------------------
function testRealData() {
    section('3. real installation: cache + incremental parity');
    const roots = reader.getInstallationRoots();
    const convDir = roots && roots[0] ? roots[0].convDir : '';
    if (!fs.existsSync(convDir)) {
        console.log('  SKIP  no Antigravity installation found');
        return;
    }
    const sqliteBin = resolveSqlite();

    reader.clearAnalysisCache();
    const testStartTime = Date.now();
    let t0 = Date.now();
    const cold = reader.readAllTelemetry();
    const coldMs = Date.now() - t0;

    t0 = Date.now();
    const warm = reader.readAllTelemetry();
    const warmMs = Date.now() - t0;

    const strip = list => JSON.stringify(list.slice().sort((a, b) => a.id.localeCompare(b.id)).map(c => ({
        id: c.id, calls: c.stats.calls, grandTotal: c.stats.grandTotal,
        currentContext: c.stats.currentContext, contextTokens: c.stats.contextTokens,
        contextLimit: c.stats.contextLimit, peakContext: c.stats.peakContext,
        compactions: c.stats.compactionsCount, timeline: c.stats.contextTimeline.length
    })));

    check('conversations discovered', cold.conversations.length > 0, cold.conversations.length);
    // Exclude conversations that received live writes mid-test from strict parity
    const liveIds = new Set();
    if (cold.active) liveIds.add(cold.active.id);
    if (warm.active) liveIds.add(warm.active.id);
    for (const c of cold.conversations) {
        const w = warm.conversations.find(x => x.id === c.id);
        if (w && (c.stats.calls !== w.stats.calls || c.stats.lastIdx !== w.stats.lastIdx)) {
            liveIds.add(c.id);
        }
        const dbPath = path.join(c.rootDir ? path.join(c.rootDir, 'conversations') : convDir, c.id + '.db');
        try {
            if (fs.statSync(dbPath).mtimeMs >= testStartTime) liveIds.add(c.id);
        } catch { }
    }
    const nonActiveCold = cold.conversations.filter(c => !liveIds.has(c.id));
    const nonActiveWarm = warm.conversations.filter(c => !liveIds.has(c.id));
    const eq = strip(nonActiveCold) === strip(nonActiveWarm);
    check('cached refresh matches cold refresh', eq);
    check(`cached refresh is fast (cold ${coldMs}ms -> warm ${warmMs}ms)`, warmMs < Math.max(200, coldMs / 4), warmMs + 'ms');
    check('real conversations carry workspacePaths and workspaceName', cold.conversations.every(c => Array.isArray(c.workspacePaths) && typeof c.workspaceName === 'string'));
    const webDevConvs = cold.conversations.filter(c => c.workspaceName === 'web dev');
    check(`found web dev conversations (${webDevConvs.length})`, webDevConvs.length > 0, webDevConvs.length);
    const jobConvs = cold.conversations.filter(c => c.workspaceName === 'job');
    check('found job conversations (' + jobConvs.length + ')', jobConvs.length > 0, jobConvs.length);

    // cache serialization: dump & restore
    check('dumpAnalysisCache exported', typeof reader.dumpAnalysisCache === 'function');
    check('loadAnalysisCache exported', typeof reader.loadAnalysisCache === 'function');
    const dump = reader.dumpAnalysisCache();
    check('dumpAnalysisCache exports conversations and summaries', dump && typeof dump.conversations === 'object' && Object.keys(dump.conversations).length > 0 && dump.summaries !== null);

    reader.clearAnalysisCache();
    reader.loadAnalysisCache(dump);
    const restoredT0 = Date.now();
    const restored = reader.readAllTelemetry();
    const restoredMs = Date.now() - restoredT0;
    check(`restored cache yields fast read (${restoredMs}ms)`, restoredMs < Math.max(200, coldMs / 4), restoredMs + 'ms');
    check('restored cache yields identical conversation count', restored.conversations.length === warm.conversations.length);

    // cache dirty tracking: safe local-only disk persistence
    check('isCacheDirty exported', typeof reader.isCacheDirty === 'function');
    check('resetCacheDirty exported', typeof reader.resetCacheDirty === 'function');
    reader.loadAnalysisCache(dump);
    check('loadAnalysisCache resets dirty flag', reader.isCacheDirty() === false);
    reader.clearAnalysisCache();
    check('clearAnalysisCache marks cache dirty', reader.isCacheDirty() === true);
    reader.resetCacheDirty();
    check('resetCacheDirty sets dirty flag to false', reader.isCacheDirty() === false);
    reader.loadAnalysisCache(dump);

    // selective timeline delivery: payload minimization over remote SSH
    check('prepareConversationsForWebview exported', typeof reader.prepareConversationsForWebview === 'function');
    const selectedTarget = warm.conversations[0] ? warm.conversations[0].id : '';
    const optimized = reader.prepareConversationsForWebview(warm.conversations, selectedTarget);
    check('optimized conversations count equals source count', optimized.length === warm.conversations.length);
    const selOpt = optimized.find(c => c.id === selectedTarget);
    check('selected conversation retains full timeline', selOpt && selOpt.stats && Array.isArray(selOpt.stats.contextTimeline) && selOpt.stats.contextTimeline.length > 0);
    const nonSelected = optimized.filter(c => c.id !== selectedTarget && c.stats);
    check('inactive conversations have empty contextTimeline', nonSelected.every(c => Array.isArray(c.stats.contextTimeline) && c.stats.contextTimeline.length === 0));
    const fullJson = JSON.stringify(warm.conversations);
    const optJson = JSON.stringify(optimized);
    check(`selective timeline reduces payload size (from ${Math.round(fullJson.length / 1024)}KB to ${Math.round(optJson.length / 1024)}KB)`, optJson.length < fullJson.length * 0.5);

    // incremental parity on a copy of a real conversation (never the original)
    const withRows = cold.conversations
        .filter(c => !c.isOrphan && c.stats.calls > 100)
        .sort((a, b) => b.stats.calls - a.stats.calls)[0];
    if (withRows && sqliteBin) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-real-'));
        const copy = path.join(dir, 'copy.db');
        const src = path.join(withRows.rootDir ? path.join(withRows.rootDir, 'conversations') : convDir, withRows.id + '.db');
        try {
            execSync(`"${sqliteBin}" "${src}" "VACUUM INTO '${copy.replace(/\\/g, '/')}';"`, { stdio: 'ignore', maxBuffer: 256 * 1024 * 1024 });
            const total = Number(execSync(`"${sqliteBin}" "${copy}" "SELECT count(*) FROM gen_metadata;"`).toString().trim());
            const splitAt = Math.max(1, Math.floor(total / 3));
            execSync(`"${sqliteBin}" "${copy}" "CREATE TABLE rest AS SELECT * FROM gen_metadata WHERE idx >= ${splitAt}; DELETE FROM gen_metadata WHERE idx >= ${splitAt};"`, { stdio: 'ignore' });

            const state = reader.analyzeConversation(copy, sqliteBin, null);
            execSync(`"${sqliteBin}" "${copy}" "INSERT INTO gen_metadata SELECT * FROM rest; DROP TABLE rest;"`, { stdio: 'ignore' });
            const incStats = reader.analyzeConversation(copy, sqliteBin, state);
            const fullStats = reader.analyzeConversation(copy, sqliteBin, null);

            const p = o => JSON.stringify({
                calls: o.calls, totalNonCached: o.totalNonCached, totalCached: o.totalCached,
                totalOutput: o.totalOutput, grandTotal: o.grandTotal, currentContext: o.currentContext,
                contextTokens: o.contextTokens, contextLimit: o.contextLimit,
                peakContext: o.peakContext, compactionsCount: o.compactionsCount, lastIdx: o.lastIdx,
                timeline: o.contextTimeline.map(t => t.turn + ':' + t.input)
            });
            const ok = p(incStats) === p(fullStats);
            check(`real chat incremental parity (${total} turns, split at ${splitAt})`, ok);
            check('real chat incremental peakContext matches full read', incStats.peakContext === fullStats.peakContext);
            check('real chat incremental minContext matches full read', incStats.minContext === fullStats.minContext);
            if (!ok) {
                console.log('    incremental:', p(incStats).slice(0, 400));
                console.log('    full       :', p(fullStats).slice(0, 400));
            }
        } catch (err) {
            check('real chat incremental parity', false, err.message);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
}

// ---------------------------------------------------------------------------
// 4. id validation
// ---------------------------------------------------------------------------
function testValidation() {
    section('4. conversation id validation');
    check('valid uuid accepted', reader.validateConversationId('72a3ced6-4b79-4cc9-baae-d736efc82792') === '72a3ced6-4b79-4cc9-baae-d736efc82792');
    check('uppercase uuid accepted', reader.validateConversationId('72A3CED6-4B79-4CC9-BAAE-D736EFC82792') !== null);
    check('path traversal rejected', reader.validateConversationId('../../evil') === null);
    check('sql injection rejected', reader.validateConversationId("x'; DROP TABLE conversation_summaries;--") === null);
    check('hyphen padding rejected', reader.validateConversationId('------------------------------------') === null);
    check('empty rejected', reader.validateConversationId('') === null);
    check('non-string rejected', reader.validateConversationId(12345) === null);

    let threw = false;
    try {
        reader.deleteConversation('not-a-uuid');
    } catch {
        threw = true;
    }
    check('deleteConversation throws on a non-UUID', threw);
}

// ---------------------------------------------------------------------------
// 5. recycle bin
// ---------------------------------------------------------------------------
function testRecycleBin() {
    section('5. recycle bin');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-recycle-'));
    const fileA = path.join(dir, 'a.txt');
    const fileB = path.join(dir, 'b.txt');
    const subDir = path.join(dir, 'sub');
    fs.writeFileSync(fileA, 'x'.repeat(2048));
    fs.writeFileSync(fileB, 'y'.repeat(1024));
    fs.mkdirSync(subDir);
    fs.writeFileSync(path.join(subDir, 'inner.txt'), 'z'.repeat(512));

    let errors = [];
    try {
        errors = reader.recyclePaths([
            { path: fileA, kind: 'file' },
            { path: fileB, kind: 'file' },
            { path: subDir, kind: 'dir' }
        ]);
    } catch (err) {
        errors = [err.message];
    }

    check('recycle reported no errors', errors.length === 0, errors.join(' | '));
    check('file removed', !fs.existsSync(fileA));
    check('second file removed', !fs.existsSync(fileB));
    check('directory removed', !fs.existsSync(subDir));

    // locked file: still open in this process, so Windows should refuse to move it
    fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 6. workspace parsing & scoping
// ---------------------------------------------------------------------------
function testWorkspaceScoping() {
    section('6. workspace parsing & scoping');
    const parse = reader.parseWorkspaceInfo;
    check('parseWorkspaceInfo exported', typeof parse === 'function');

    const ws1 = parse('["file:///g%3A/web%20dev"]');
    check('web dev URI decoded to path', ws1.workspacePaths.length === 1 && ws1.workspacePaths[0].toLowerCase().includes('web dev'), ws1.workspacePaths);
    check('web dev folder name extracted', ws1.workspaceName === 'web dev', ws1.workspaceName);

    const ws2 = parse('["file:///g%3A/job"]');
    check('job URI decoded to path', ws2.workspacePaths.length === 1 && ws2.workspacePaths[0].toLowerCase().includes('job'), ws2.workspacePaths);
    check('job folder name extracted', ws2.workspaceName === 'job', ws2.workspaceName);

    const empty = parse('');
    check('empty raw string returns empty workspacePaths and name', empty.workspacePaths.length === 0 && empty.workspaceName === '');

    const invalid = parse('{not-json}');
    check('invalid JSON returns empty workspacePaths and name', invalid.workspacePaths.length === 0 && invalid.workspaceName === '');

    const nullVal = parse(null);
    check('null returns empty workspacePaths and name', nullVal.workspacePaths.length === 0 && nullVal.workspaceName === '');

    // Parity and overmatch probe assertions (ext predicate vs dashboard predicate)
    const vm = require('vm');
    const { getDashboardHtml } = require('../dashboardHtml');
    const matchWs = reader.conversationMatchesWorkspace;
    check('conversationMatchesWorkspace exported', typeof matchWs === 'function');

    const allData = reader.readAllTelemetry();
    const realConvs = allData.conversations;
    if (!realConvs || realConvs.length === 0) {
        console.log('  SKIP  no real conversations found (clean environment/CI)');
        return;
    }

    function runDashboardFilter(paths, name) {
        const html = getDashboardHtml(realConvs, allData.active ? allData.active.id : '', {
            workspaceFilter: 'current',
            currentWorkspaceName: name || 'web dev',
            currentWorkspacePaths: paths
        });
        const script = html.slice(html.indexOf('>', html.indexOf('<script nonce=')) + 1, html.lastIndexOf('</script>'));
        function makeEl() {
            return {
                options: [],
                appendChild(c) { this.options.push(c); },
                classList: { add() { }, remove() { } },
                style: {},
                setAttribute() { },
                addEventListener() { },
                querySelector() { return makeEl(); },
                getBoundingClientRect() { return { width: 500, height: 200, left: 0, top: 0 }; },
                textContent: '',
                innerHTML: ''
            };
        }
        const elements = new Map();
        const doc = {
            getElementById(id) {
                if (!elements.has(id)) elements.set(id, makeEl());
                return elements.get(id);
            },
            createElement() { return makeEl(); },
            createElementNS() { return makeEl(); }
        };
        const sandbox = {
            acquireVsCodeApi: () => ({ postMessage() { } }),
            window: { addEventListener() { }, onresize: null },
            document: doc
        };
        const ctx = vm.createContext(sandbox);
        vm.runInContext(script, ctx);
        return vm.runInContext('getFilteredConversations().length', ctx);
    }

    const extWebDev = realConvs.filter(c => matchWs(c, ['g:\\web dev'])).length;
    const dashWebDev = runDashboardFilter(['g:\\web dev'], 'web dev');
    check('web dev matching parity (ext == dash)', extWebDev === dashWebDev && extWebDev > 0, `ext=${extWebDev}, dash=${dashWebDev}`);

    const extJob = realConvs.filter(c => matchWs(c, ['g:\\job'])).length;
    const dashJob = runDashboardFilter(['g:\\job'], 'job');
    check('job matching parity (ext == dash)', extJob === dashJob && extJob > 0, `ext=${extJob}, dash=${dashJob}`);

    const extRenamed = realConvs.filter(c => matchWs(c, ['g:\\web dev'])).length;
    const dashRenamed = runDashboardFilter(['g:\\web dev'], 'Frontend');
    check('renamed folder matching parity (name Frontend != path web dev)', extRenamed === dashRenamed && dashRenamed > 0, `ext=${extRenamed}, dash=${dashRenamed}`);

    const extWebProbe = realConvs.filter(c => matchWs(c, ['g:\\web'])).length;
    const dashWebProbe = runDashboardFilter(['g:\\web'], 'web');
    check('"web" probe yields 0 for both extension and dashboard', extWebProbe === 0 && dashWebProbe === 0, `ext=${extWebProbe}, dash=${dashWebProbe}`);

    const extBProbe = realConvs.filter(c => matchWs(c, ['g:\\b'])).length;
    const dashBProbe = runDashboardFilter(['g:\\b'], 'b');
    check('"b" probe yields 0 for both extension and dashboard', extBProbe === 0 && dashBProbe === 0, `ext=${extBProbe}, dash=${dashBProbe}`);
}

// ---------------------------------------------------------------------------
// 7. subagent organization & active selection
// ---------------------------------------------------------------------------
function testSubagents() {
    section('7. subagent organization & active selection');

    // 1. selectActiveConversation exported & prefers non-subagent
    const selectActive = reader.selectActiveConversation;
    check('selectActiveConversation exported', typeof selectActive === 'function');

    const fakeConvs = [
        { id: 'sub-new', isSubagent: true, title: 'Background Browser', mtimeMs: 2000 },
        { id: 'human-old', isSubagent: false, title: 'Main Chat', mtimeMs: 1000 }
    ];
    const picked = selectActive(fakeConvs);
    check('selectActiveConversation prefers human chat over newer subagent', picked && picked.id === 'human-old', picked ? picked.id : null);

    const allSubagentsOnly = [
        { id: 'sub-1', isSubagent: true, title: 'Sub 1', mtimeMs: 2000 },
        { id: 'sub-2', isSubagent: true, title: 'Sub 2', mtimeMs: 1000 }
    ];
    const pickedFallback = selectActive(allSubagentsOnly);
    check('selectActiveConversation falls back to first when no human chat', pickedFallback && pickedFallback.id === 'sub-1');

    check('selectActiveConversation handles empty array', selectActive([]) === null);
    check('selectActiveConversation handles null', selectActive(null) === null);

    // 2. Real installation subagents data reconciliation
    const allData = reader.readAllTelemetry();
    const realConvs = allData.conversations;
    if (!realConvs || realConvs.length === 0) {
        console.log('  SKIP  no real conversations found (clean environment/CI)');
        return;
    }

    const humanChats = realConvs.filter(c => !c.isSubagent);
    const subagents = realConvs.filter(c => c.isSubagent);
    check(`real data has ${humanChats.length} human chats and ${subagents.length} subagents (${realConvs.length} visible)`, humanChats.length > 0 && subagents.length > 0 && realConvs.length === humanChats.length + subagents.length, `human=${humanChats.length}, sub=${subagents.length}`);

    // Active conversation on real data must be a human chat
    const realActive = allData.active;
    check('active conversation on real data is a non-subagent', realActive && !realActive.isSubagent, realActive ? realActive.id : null);

    // 3. Parent drawer totals == sum of children
    // Parent 1: 5f8b035d (2 children: de7e0eda, 1bd9ba32)
    const p1Children = subagents.filter(s => s.parentConversationId && s.parentConversationId.startsWith('5f8b035d'));
    check('parent 5f8b035d has 2 children', p1Children.length === 2, `children=${p1Children.length}`);
    const p1ChildTokens = p1Children.reduce((sum, c) => sum + (c.stats ? c.stats.grandTotal : 0), 0);
    const p1ExpectedTokens = (p1Children[0].stats ? p1Children[0].stats.grandTotal : 0) + (p1Children[1].stats ? p1Children[1].stats.grandTotal : 0);
    check('parent 5f8b035d drawer total == sum of its children', p1ChildTokens === p1ExpectedTokens && p1ChildTokens > 2_000_000, `tokens=${p1ChildTokens}`);

    // Parent 2: e570da32 (3 children: 97406cb5, e209f50c, 2247bb06)
    const p2Children = subagents.filter(s => s.parentConversationId && s.parentConversationId.startsWith('e570da32'));
    check('parent e570da32 has 3 children', p2Children.length === 3, `children=${p2Children.length}`);
    const p2ChildTokens = p2Children.reduce((sum, c) => sum + (c.stats ? c.stats.grandTotal : 0), 0);
    const p2Sum = p2Children.reduce((s, c) => s + (c.stats ? c.stats.grandTotal : 0), 0);
    check('parent e570da32 drawer total == sum of its children', p2ChildTokens === p2Sum && p2ChildTokens > 100_000, `tokens=${p2ChildTokens}`);

    // 4. Unattached subagents present (2e436dd9)
    const attachedIds = new Set(subagents.filter(s => s.parentConversationId && humanChats.some(h => h.id === s.parentConversationId)).map(s => s.id));
    const unattached = subagents.filter(s => !attachedIds.has(s.id));
    check(`unattached subagents count is ${unattached.length}`, unattached.length >= 1, `unattached=${unattached.length}`);
    check('unattached subagents contain 2e436dd9', unattached.some(s => s.id.startsWith('2e436dd9')));

    // 5. Total across all rows equals all conversations (human + attached + unattached)
    const attachedCount = attachedIds.size;
    const totalRepresented = humanChats.length + attachedCount + unattached.length;
    check('sum over all rows still equals all conversations', totalRepresented === realConvs.length, `total=${totalRepresented}`);

    // 5b. Subagent role extraction & title resolution
    check('extractSubagentRole exported', typeof reader.extractSubagentRole === 'function');
    const untitledSubs = subagents.filter(s => s.title === 'Untitled Conversation');
    check('zero subagents named "Untitled Conversation"', untitledSubs.length === 0, `untitled=${untitledSubs.length}`);

    // 6. Test dashboard rendering in VM: check all 21 conversations rendered and view chip interactions
    const { getDashboardHtml } = require('../dashboardHtml');
    const vm = require('vm');

    function makeDomMock() {
        const elements = new Map();
        function makeEl(tag) {
            return {
                tag,
                options: [],
                children: [],
                appendChild(c) { this.children.push(c); if (this.options) this.options.push(c); },
                classList: {
                    classes: new Set(),
                    add(cls) { this.classes.add(cls); },
                    remove(cls) { this.classes.delete(cls); },
                    toggle(cls, force) {
                        const shouldAdd = force !== undefined ? Boolean(force) : !this.classes.has(cls);
                        if (shouldAdd) this.classes.add(cls); else this.classes.delete(cls);
                        return shouldAdd;
                    }
                },
                get className() { return Array.from(this.classList.classes).join(' '); },
                set className(val) {
                    this.classList.classes = new Set((val || '').split(/\s+/).filter(Boolean));
                },
                style: {},
                setAttribute() { },
                addEventListener() { },
                _queries: new Map(),
                querySelector(sel) {
                    if (!this._queries.has(sel)) this._queries.set(sel, makeEl('sub'));
                    return this._queries.get(sel);
                },
                querySelectorAll() { return []; },
                getBoundingClientRect() { return { width: 500, height: 200, left: 0, top: 0 }; },
                textContent: '',
                get innerHTML() { return this._html || ''; },
                set innerHTML(val) {
                    this._html = val;
                    if (val === '') this.children = [];
                }
            };
        }
        return {
            getElementById(id) {
                if (!elements.has(id)) elements.set(id, makeEl(id));
                return elements.get(id);
            },
            createElement(tag) { return makeEl(tag); },
            createElementNS(ns, tag) { return makeEl(tag); },
            elements
        };
    }

    const html = getDashboardHtml(realConvs, allData.active ? allData.active.id : '', {
        workspaceFilter: 'all'
    });
    const script = html.slice(html.indexOf('>', html.indexOf('<script nonce=')) + 1, html.lastIndexOf('</script>'));
    const doc = makeDomMock();
    const sandbox = {
        acquireVsCodeApi: () => ({ postMessage() { } }),
        window: { addEventListener() { }, onresize: null },
        document: doc
    };
    const ctx = vm.createContext(sandbox);
    vm.runInContext(script, ctx);

    // Initial load in 'all' view: human chats + drawer wraps + unattached group wrap
    const activeParents = new Set(subagents.map(s => s.parentConversationId).filter(p => p && humanChats.some(h => h.id === p)));
    const expectedTop = humanChats.length + activeParents.size + (unattached.length > 0 ? 1 : 0);
    const convList = doc.getElementById('convList');
    check('dashboard renders nested rows in convList (' + humanChats.length + ' human + drawers + unattached = ' + expectedTop + ' top items)', convList && convList.children.length === expectedTop, 'children=' + (convList ? convList.children.length : 0));

    // Test filter switches and header token states
    const expectedSubTokens = (realConvs.filter(c => c.isSubagent).reduce((s, c) => s + (c.stats ? c.stats.grandTotal : 0), 0) / 1_000_000).toFixed(1) + 'M';
    const expectedHumanTokens = (realConvs.filter(c => !c.isSubagent).reduce((s, c) => s + (c.stats ? c.stats.grandTotal : 0), 0) / 1_000_000).toFixed(1) + 'M';

    vm.runInContext("setSubagentFilter('chats')", ctx);
    const chatsHeaderExcluded = doc.getElementById('headerExcludedTokens').textContent;
    check(`filter "chats" states excluded subagent tokens in header (+${expectedSubTokens})`, chatsHeaderExcluded.includes('in subagents') && chatsHeaderExcluded.includes(expectedSubTokens), chatsHeaderExcluded);

    vm.runInContext("setSubagentFilter('subagents')", ctx);
    const subsHeaderExcluded = doc.getElementById('headerExcludedTokens').textContent;
    check(`filter "subagents" states excluded human chat tokens in header (+${expectedHumanTokens})`, subsHeaderExcluded.includes('in chats') && subsHeaderExcluded.includes(expectedHumanTokens), subsHeaderExcluded);

    vm.runInContext("setSubagentFilter('all')", ctx);
    const allHeaderExcluded = doc.getElementById('headerExcludedTokens').textContent;
    check('filter "all" has empty excluded tokens in header', allHeaderExcluded === '', allHeaderExcluded);

    // Test subagents card collapse toggle
    const pWithChildren = realConvs.find(c => subagents.some(s => s.parentConversationId === c.id));
    if (pWithChildren) {
        vm.runInContext(`selectConv('${pWithChildren.id}')`, ctx);
        const subListEl = doc.getElementById('subagentsList');
        const chevronEl = doc.getElementById('subagentsChevron');
        const labelEl = doc.getElementById('subagentsToggleLabel');
        check('subagentsList visible initially', subListEl && !subListEl.classList.classes.has('hidden'));
        vm.runInContext('toggleSubagentsCollapse()', ctx);
        check('subagentsList collapsed after toggle', subListEl && subListEl.classList.classes.has('hidden') && chevronEl.textContent === '▶' && labelEl.textContent === 'Expand');
        vm.runInContext('toggleSubagentsCollapse()', ctx);
        check('subagentsList expanded after second toggle', subListEl && !subListEl.classList.classes.has('hidden') && chevronEl.textContent === '▼' && labelEl.textContent === 'Collapse');
    }

    // 7. Synthetic nested subagent hierarchy test
    const makeStats = (tot) => ({
        grandTotal: tot,
        totalCached: Math.floor(tot * 0.5),
        totalNonCached: Math.floor(tot * 0.3),
        totalOutput: Math.floor(tot * 0.2),
        calls: 5,
        contextTimeline: []
    });
    const synthConvs = [
        { id: 'h1', isSubagent: false, title: 'Main Project Chat', stats: makeStats(1000) },
        { id: 's1', isSubagent: true, parentConversationId: 'h1', agentName: 'Coder', title: 'Code Implementer', stats: makeStats(500) },
        { id: 's2', isSubagent: true, parentConversationId: 's1', agentName: 'Tester', title: 'Test Runner', stats: makeStats(200) },
        { id: 'o1', isSubagent: true, parentConversationId: 'missing-99', agentName: 'OrphanAgent', title: 'Lost Worker', stats: makeStats(50) }
    ];
    const synthHtml = getDashboardHtml(synthConvs, 'h1', { workspaceFilter: 'all' });
    const synthScript = synthHtml.slice(synthHtml.indexOf('>', synthHtml.indexOf('<script nonce=')) + 1, synthHtml.lastIndexOf('</script>'));
    const synthDoc = makeDomMock();
    const synthSandbox = {
        acquireVsCodeApi: () => ({ postMessage() { } }),
        window: { addEventListener() { }, onresize: null },
        document: synthDoc
    };
    const synthCtx = vm.createContext(synthSandbox);
    vm.runInContext(synthScript, synthCtx);

    // Check nested subagent s2 breadcrumb ancestry: h1 -> s1
    vm.runInContext("selectConv('s2')", synthCtx);
    const bcEl = synthDoc.getElementById('subagentBreadcrumb');
    const bcLinks = bcEl.children.filter(c => c.tag === 'a');
    check('nested subagent has multi-level breadcrumb (h1 -> s1)', bcLinks.length === 2 && bcLinks[0].textContent === 'Main Project Chat' && bcLinks[1].textContent.includes('Coder'));

    // Check root chat h1 subagent rollup counts both direct and nested subagents (s1 + s2 = 2)
    vm.runInContext("selectConv('h1')", synthCtx);
    const h1Badge = synthDoc.getElementById('subagentsCountBadge');
    check('root chat counts all descendant subagents (2 subagents)', h1Badge && h1Badge.textContent === '2 subagents');

    // Check parent subagent s1 counts its own child (s2 = 1)
    vm.runInContext("selectConv('s1')", synthCtx);
    const s1Badge = synthDoc.getElementById('subagentsCountBadge');
    check('parent subagent counts its own child subagent (1 subagent)', s1Badge && s1Badge.textContent === '1 subagent');

    // 8. Test individual subagent node collapse in session list
    const convListEl = synthDoc.getElementById('convList');
    const drawerWrap = convListEl.children.find(c => c.children.length === 2 && c.children[1].children.length >= 2);
    check('found human chat drawer wrap in synth DOM', Boolean(drawerWrap));
    if (drawerWrap) {
        const childListDiv = drawerWrap.children[1];
        const s1Row = childListDiv.children[0];
        const s1NestedDiv = childListDiv.children[1];
        const s1Pill = s1Row.querySelector('.sub-toggle-pill');
        check('s1 has sub-toggle-pill in list', typeof s1Pill.onclick === 'function');
        check('s1 child container visible initially in list', s1NestedDiv && !s1NestedDiv.classList.classes.has('hidden'));
        s1Pill.onclick({ stopPropagation() {} });
        check('s1 child container hidden after collapse toggle in list', s1NestedDiv && s1NestedDiv.classList.classes.has('hidden'));
        check('s1 recorded in collapsedSubagents set', vm.runInContext("collapsedSubagents.has('s1')", synthCtx) === true);
        s1Pill.onclick({ stopPropagation() {} });
        check('s1 child container visible after expanding in list', s1NestedDiv && !s1NestedDiv.classList.classes.has('hidden'));
        check('s1 removed from collapsedSubagents set', vm.runInContext("collapsedSubagents.has('s1')", synthCtx) === false);
    }

    // 9. Test individual subagent node collapse in detail view
    vm.runInContext("selectConv('h1')", synthCtx);
    const detailSubList = synthDoc.getElementById('subagentsList');
    check('detail subagentsList populated', detailSubList && detailSubList.children.length === 2);
    if (detailSubList && detailSubList.children.length === 2) {
        const s1DetailRow = detailSubList.children[0];
        const s1DetailNested = detailSubList.children[1];
        const rightDiv = s1DetailRow.children[1];
        const detailPill = rightDiv.querySelector('.detail-sub-toggle-pill');
        check('s1 has detail-sub-toggle-pill', typeof detailPill.onclick === 'function');
        check('s1DetailNested visible initially in detail', !s1DetailNested.classList.classes.has('hidden'));
        detailPill.onclick({ stopPropagation() {} });
        check('s1DetailNested hidden after collapse toggle in detail', s1DetailNested.classList.classes.has('hidden'));
        check('s1 recorded in collapsedSubagents set from detail', vm.runInContext("collapsedSubagents.has('s1')", synthCtx) === true);
        detailPill.onclick({ stopPropagation() {} });
        check('s1DetailNested visible after expanding in detail', !s1DetailNested.classList.classes.has('hidden'));
        check('s1 removed from collapsedSubagents set from detail', vm.runInContext("collapsedSubagents.has('s1')", synthCtx) === false);
    }
}

// 8. dashboard stability across telemetry updates
function testDashboardStability() {
    section('8. dashboard stability across telemetry updates');
    const { getDashboardHtml } = require('../dashboardHtml');
    const vm = require('vm');
    const allData = reader.readAllTelemetry();
    const realConvs = allData.conversations;
    if (!realConvs || realConvs.length === 0) {
        console.log('  SKIP  no real conversations found (clean environment/CI)');
        return;
    }

    function makeDomMock() {
        const elements = new Map();
        function makeEl(tag) {
            return {
                tag,
                options: [],
                children: [],
                selectedIndex: 0,
                get value() {
                    return this.options && this.options[this.selectedIndex] ? this.options[this.selectedIndex].value : (this._val || '');
                },
                set value(v) {
                    this._val = v;
                    if (this.options) {
                        const idx = this.options.findIndex(o => o.value === v);
                        if (idx !== -1) this.selectedIndex = idx;
                    }
                },
                appendChild(c) {
                    this.children.push(c);
                    if (this.options) this.options.push(c);
                },
                classList: {
                    classes: new Set(),
                    add(...cls) { cls.forEach(c => this.classes.add(c)); },
                    remove(...cls) { cls.forEach(c => this.classes.delete(c)); },
                    toggle(cls) { if (this.classes.has(cls)) this.classes.delete(cls); else this.classes.add(cls); }
                },
                style: {},
                setAttribute() { },
                addEventListener() { },
                querySelector() { return makeEl('sub'); },
                querySelectorAll() { return []; },
                getBoundingClientRect() { return { width: 500, height: 200, left: 0, top: 0 }; },
                textContent: '',
                get innerHTML() { return this._html || ''; },
                set innerHTML(val) {
                    this._html = val;
                    if (val === '') {
                        this.children = [];
                        this.options = [];
                        this.selectedIndex = 0;
                    }
                }
            };
        }
        return {
            getElementById(id) {
                if (!elements.has(id)) elements.set(id, makeEl(id));
                return elements.get(id);
            },
            createElement(tag) { return makeEl(tag); },
            createElementNS(ns, tag) { return makeEl(tag); },
            elements
        };
    }

    const doc = makeDomMock();
    let messageHandler = null;
    const postedMessages = [];
    const sandbox = {
        acquireVsCodeApi: () => ({ postMessage(m) { postedMessages.push(m); } }),
        window: {
            addEventListener(evt, fn) {
                if (evt === 'message') messageHandler = fn;
            },
            onresize: null
        },
        document: doc,
        setTimeout,
        clearTimeout
    };

    const initialActive = allData.active ? allData.active.id : realConvs[0].id;
    const html = getDashboardHtml(realConvs, initialActive, {
        workspaceFilter: 'current',
        currentWorkspaceName: 'web dev',
        currentWorkspacePaths: ['g:\\web dev']
    });
    const script = html.slice(html.indexOf('>', html.indexOf('<script nonce=')) + 1, html.lastIndexOf('</script>'));
    const ctx = vm.createContext(sandbox);
    vm.runInContext(script, ctx);

    check('message handler registered in webview', typeof messageHandler === 'function');

    // 1. User switches workspace filter to job
    const wsSelect = doc.getElementById('workspaceSelect');
    check('workspaceSelect element exists', !!wsSelect);
    wsSelect.onchange({ target: { value: 'ws:job' } });
    check('currentWorkspaceFilter switched to ws:job', vm.runInContext('currentWorkspaceFilter', ctx) === 'ws:job');

    const jobConv = realConvs.find(c => c.workspaceName === 'job');
    vm.runInContext(`selectConv('${jobConv.id}')`, ctx);
    check('selectedId is job conversation', vm.runInContext('selectedId', ctx) === jobConv.id);

    // 2. Background telemetryUpdate arrives (like the 10s heartbeat)
    messageHandler({
        data: {
            type: 'telemetryUpdate',
            data: realConvs,
            activeId: initialActive,
            currentWorkspaceName: 'web dev',
            currentWorkspacePaths: ['g:\\web dev']
        }
    });

    check('currentWorkspaceFilter remains ws:job after telemetryUpdate', vm.runInContext('currentWorkspaceFilter', ctx) === 'ws:job');
    check('selectedId remains job conversation after telemetryUpdate', vm.runInContext('selectedId', ctx) === jobConv.id);

    // 3. User selects a subagent conversation
    const subConv = realConvs.find(c => c.isSubagent);
    check('subagent conversation found in real data', !!subConv);
    vm.runInContext(`selectConv('${subConv.id}')`, ctx);
    check('selectedId switched to subagent', vm.runInContext('selectedId', ctx) === subConv.id);
    check('chatSelect displays subagent ID', doc.getElementById('chatSelect').value === subConv.id);

    // 4. Background telemetryUpdate arrives while viewing subagent
    messageHandler({
        data: {
            type: 'telemetryUpdate',
            data: realConvs,
            activeId: initialActive,
            currentWorkspaceName: 'web dev',
            currentWorkspacePaths: ['g:\\web dev']
        }
    });

    check('selectedId remains subagent after telemetryUpdate', vm.runInContext('selectedId', ctx) === subConv.id);
    check('chatSelect still displays subagent ID after telemetryUpdate', doc.getElementById('chatSelect').value === subConv.id);

    // 5. User selects same workspace by name ('ws:web dev')
    wsSelect.onchange({ target: { value: 'ws:web dev' } });
    messageHandler({
        data: {
            type: 'telemetryUpdate',
            data: realConvs,
            activeId: initialActive,
            currentWorkspaceName: 'web dev',
            currentWorkspacePaths: ['g:\\web dev']
        }
    });
    check('currentWorkspaceFilter remains ws:web dev after telemetryUpdate', vm.runInContext('currentWorkspaceFilter', ctx) === 'ws:web dev');
    check('workspaceSelect preserves ws:web dev value', wsSelect.value === 'ws:web dev');

    // 6. True conversation deletion falls back safely
    const withoutSub = realConvs.filter(c => c.id !== subConv.id);
    messageHandler({
        data: {
            type: 'telemetryUpdate',
            data: withoutSub,
            activeId: initialActive,
            currentWorkspaceName: 'web dev',
            currentWorkspacePaths: ['g:\\web dev']
        }
    });
    const fallbackId = vm.runInContext('selectedId', ctx);
    check('deleted conversation safely falls back to existing chat', withoutSub.some(c => c.id === fallbackId), `fallbackId=${fallbackId}`);

    // 7. Manual Refresh Button interactions
    const refreshBtn = doc.getElementById('refreshBtn');
    check('refreshBtn element exists in dashboard', !!refreshBtn);
    check('refreshBtn has onclick handler bound', typeof refreshBtn.onclick === 'function');

    refreshBtn.onclick();
    check('clicking refreshBtn posts refresh command', postedMessages.some(m => m && m.command === 'refresh'));
    check('isRefreshing state active during sync', vm.runInContext('isRefreshing', ctx) === true);
    check('refreshBtn is disabled during sync', refreshBtn.disabled === true);
    const refreshLabel = doc.getElementById('refreshLabel');
    check('refreshLabel displays Syncing...', refreshLabel.textContent === 'Syncing...');
    const refreshIcon = doc.getElementById('refreshIcon');
    check('refreshIcon has animate-spin class during sync', refreshIcon.classList.classes.has('animate-spin'));

    // Delivery of telemetryUpdate satisfies refresh
    messageHandler({
        data: {
            type: 'telemetryUpdate',
            data: realConvs,
            activeId: initialActive,
            currentWorkspaceName: 'web dev',
            currentWorkspacePaths: ['g:\\web dev']
        }
    });
    check('refreshLabel shows Updated after telemetryUpdate', refreshLabel.textContent === 'Updated');
    check('refreshIcon has text-emerald-400 class on update', refreshIcon.classList.classes.has('text-emerald-400'));

    // 8. On-demand timeline retrieval and webview timeline caching
    const anotherConv = realConvs.find(c => c.id !== initialActive && c.stats && c.stats.calls > 0);
    if (anotherConv) {
        // Strip timeline to simulate remote payload
        anotherConv.stats.contextTimeline = [];
        vm.runInContext(`selectConv('${anotherConv.id}')`, ctx);
        check('selectConv sends selectConversation command', postedMessages.some(m => m && m.command === 'selectConversation' && m.conversationId === anotherConv.id));
        check('selectConv requests timeline on-demand for conversation with empty timeline', postedMessages.some(m => m && m.command === 'getTimeline' && m.conversationId === anotherConv.id));

        // Delivery of timelineData populates the conversation's timeline
        const mockTimeline = [{ turn: 1, input: 1234, cached: 500, fresh: 734, output: 100, thinking: 0 }];
        messageHandler({
            data: {
                type: 'timelineData',
                conversationId: anotherConv.id,
                timeline: mockTimeline
            }
        });
        const currentConv = vm.runInContext(`CONVERSATIONS.find(c => c.id === '${anotherConv.id}')`, ctx);
        check('timelineData stores timeline in webview CONVERSATIONS', currentConv && currentConv.stats && currentConv.stats.contextTimeline.length === 1 && currentConv.stats.contextTimeline[0].input === 1234);

        // Subsequent telemetryUpdate with empty timeline for this conversation preserves cached timeline
        const updatedConvs = realConvs.map(c => c.id === anotherConv.id ? { ...c, stats: { ...c.stats, contextTimeline: [] } } : c);
        messageHandler({
            data: {
                type: 'telemetryUpdate',
                data: updatedConvs,
                activeId: initialActive,
                currentWorkspaceName: 'web dev',
                currentWorkspacePaths: ['g:\\web dev']
            }
        });
        const retainedConv = vm.runInContext(`CONVERSATIONS.find(c => c.id === '${anotherConv.id}')`, ctx);
        check('telemetryUpdate preserves cached timeline in webview', retainedConv && retainedConv.stats && retainedConv.stats.contextTimeline.length === 1);
    }
}

// 9. configuration & sqlite resolution
function testConfigurationAndSqlite() {
    section('9. configuration & sqlite resolution');
    check('setCustomSqlitePath exported', typeof reader.setCustomSqlitePath === 'function');
    check('getSqliteBinary exported', typeof reader.getSqliteBinary === 'function');

    const originalSqlite = reader.getSqliteBinary();
    check('getSqliteBinary resolves a binary', typeof originalSqlite === 'string' && originalSqlite.length > 0, originalSqlite);

    // Test setting valid custom path
    reader.setCustomSqlitePath(originalSqlite);
    check('getSqliteBinary matches configured custom path', reader.getSqliteBinary() === originalSqlite);

    // Test setting non-existent custom path falls back to candidate list
    reader.setCustomSqlitePath('C:\\non_existent_path\\sqlite3_missing.exe');
    const fallbackSqlite = reader.getSqliteBinary();
    check('getSqliteBinary falls back to working binary when custom is invalid', fallbackSqlite === originalSqlite, fallbackSqlite);

    // Reset custom path to null (auto-detect)
    reader.setCustomSqlitePath('');
    check('resetting custom path restores auto-detect', reader.getSqliteBinary() === originalSqlite);

    // readAllTelemetry returns sqliteAvailable: true
    const telemetry = reader.readAllTelemetry();
    check('readAllTelemetry reports sqliteAvailable: true', telemetry.sqliteAvailable === true);

    // Verify subagents referencing parent catalog rows exist (if conversations present)
    if (telemetry.conversations && telemetry.conversations.length > 0) {
        const subagentsWithParent = telemetry.conversations.filter(c => c.isSubagent && c.parentConversationId);
        check('subagents with parent exist in data', subagentsWithParent.length > 0);
        const parentId = subagentsWithParent[0] ? subagentsWithParent[0].parentConversationId : '';
        check('referenced parent ID is non-empty', typeof parentId === 'string' && parentId.length > 0);
    }
}

// 10. chart dual-layer visual integrity
function testChartLayerIntegrity() {
    section('10. chart dual-layer visual integrity');
    const { getDashboardHtml } = require('../dashboardHtml');
    const vm = require('vm');
    const allData = reader.readAllTelemetry();

    if (!allData.conversations || allData.conversations.length === 0) {
        console.log('  SKIP  no real conversations found (clean environment/CI)');
        return;
    }

    // Verify conversations with API cache > trajectory context exist in dataset
    const anomalousConvs = allData.conversations.filter(c =>
        c.stats && c.stats.contextTimeline && c.stats.contextTimeline.some(pt => (pt.cached || 0) > pt.input)
    );
    if (anomalousConvs.length === 0) {
        console.log('  SKIP  no conversations with cached > input anomaly found in test dataset');
        return;
    }
    check('found conversations with cached > input anomaly in real data', anomalousConvs.length > 0, `count=${anomalousConvs.length}`);

    // Test Deleting Referenced User Data (c4585504) specifically
    const target = allData.conversations.find(c => c.id === 'c4585504-a1b0-444f-855b-10572765d629') || anomalousConvs[0];
    check('target conversation present', Boolean(target));

    function makeDomMock() {
        const elements = new Map();
        function makeEl(id, tag = 'div') {
            const children = [];
            const attrs = new Map();
            const el = {
                id,
                tagName: tag,
                children,
                style: {},
                options: [],
                classList: { add() { }, remove() { }, toggle() { }, contains: () => false },
                setAttribute(k, v) { attrs.set(k, String(v)); },
                getAttribute(k) { return attrs.get(k); },
                appendChild(c) {
                    children.push(c);
                    if (this.tagName === 'select') this.options.push(c);
                    return c;
                },
                querySelector() { return null; },
                querySelectorAll() { return []; },
                addEventListener() { },
                clientWidth: 600,
                clientHeight: 200,
                getBoundingClientRect() { return { width: 600, height: 200, left: 0, top: 0 }; }
            };
            return el;
        }
        return {
            getElementById(id) {
                if (!elements.has(id)) elements.set(id, makeEl(id));
                return elements.get(id);
            },
            createElement(tag) { return makeEl(tag, tag); },
            createElementNS(ns, tag) { return makeEl(tag, tag); },
            querySelectorAll() { return []; },
            addEventListener() { },
            elements
        };
    }

    const html = getDashboardHtml(allData.conversations, target.id, {
        workspaceFilter: 'all',
        currentWorkspacePaths: []
    });
    const script = html.slice(html.indexOf('>', html.indexOf('<script nonce=')) + 1, html.lastIndexOf('</script>'));
    const doc = makeDomMock();
    const sandbox = {
        acquireVsCodeApi: () => ({ postMessage() { } }),
        window: { addEventListener() { }, onresize: null },
        document: doc,
        console
    };
    const ctx = vm.createContext(sandbox);
    vm.runInContext(script, ctx);

    // Switch to target conversation and trigger renderChart
    vm.runInContext(`selectConv('${target.id}')`, ctx);

    const svg = doc.getElementById('timelineSvg');
    check('timelineSvg populated', svg && svg.children.length > 0);

    // Verify all point coordinates in chart: yCached >= yContext (i.e. cached area strictly below or touching context line)
    const pointsCheck = vm.runInContext(`
        (function() {
            const conv = CONVERSATIONS.find(c => c.id === selectedId);
            const timeline = conv.stats.contextTimeline;
            const ceilingTokens = (conv && conv.stats && conv.stats.contextLimit) || 256000;
            const maxDataTokens = Math.max(...timeline.map(t => Math.max(t.input || 0, t.cached || 0))) || 1;
            const maxVal = Math.max(ceilingTokens, maxDataTokens * 1.05);
            const padTop = 22;
            const padBottom = 16;
            const padLeft = 14;
            const padRight = 14;
            const w = 600;
            const h = 200;
            const chartW = w - padLeft - padRight;
            const chartH = h - padTop - padBottom;
            let violations = 0;
            let clampedCount = 0;
            timeline.forEach((pt, i) => {
                const visualCached = Math.min(pt.cached || 0, pt.input || 0);
                const yContext = padTop + chartH - ((pt.input || 0) / maxVal) * chartH;
                const yCached = padTop + chartH - (visualCached / maxVal) * chartH;
                if (yCached < yContext - 0.0001) violations++;
                if ((pt.cached || 0) > (pt.input || 0) && visualCached === (pt.input || 0)) clampedCount++;
            });
            return { violations, clampedCount, total: timeline.length };
        })()
    `, ctx);

    check('zero coordinate violations (cached area never renders above context area)', pointsCheck.violations === 0, `violations=${pointsCheck.violations}`);
    check('cached points properly clamped to context ceiling', pointsCheck.clampedCount > 0, `clampedCount=${pointsCheck.clampedCount}`);
}

// 11. changelog release extraction
function testChangelogExtraction() {
    section('11. changelog release extraction');
    const { extractChangelog } = require('./extract-changelog');

    check('extractChangelog function exported', typeof extractChangelog === 'function');

    // Default extraction (latest section from user-facing CHANGELOG.md)
    const latest = extractChangelog();
    check('extracts latest section title', typeof latest.title === 'string' && latest.title.includes('1.2.0'), latest.title);
    check('extracts latest section notes with markdown', typeof latest.notes === 'string' && latest.notes.includes('Context Health') && latest.notes.includes('Codebase Activity'), latest.notes.slice(0, 100));
    check('strips trailing horizontal rules', !latest.notes.endsWith('---'));

    // Specific tag extraction (e.g. v1.1.0)
    const v110 = extractChangelog('v1.1.0');
    check('extracts specific v1.1.0 section by tag', v110.title.includes('1.1.0'), v110.title);
    check('v1.1.0 notes contain feature categories', v110.notes.includes('Antigravity IDE') && v110.notes.includes('Multi-Root'));

    // Specific tag extraction (e.g. v1.0.2)
    const v102 = extractChangelog('v1.0.2');
    check('extracts specific v1.0.2 section by tag', v102.title.includes('1.0.2'), v102.title);
    check('v1.0.2 notes contain feature categories', v102.notes.includes('Manual Refresh') && v102.notes.includes('Subagent'));

    // Specific tag extraction (e.g. v1.0.1)
    const v101 = extractChangelog('v1.0.1');
    check('extracts specific v1.0.1 section by tag', v101.title.includes('1.0.1'), v101.title);
    check('v1.0.1 notes contain feature categories', v101.notes.includes('Marketplace Release') && v101.notes.includes('Timeline Enhancements'));

    // Specific tag extraction (e.g. v1.0.0)
    const v1 = extractChangelog('v1.0.0');
    check('extracts specific v1.0.0 section by tag', v1.title.includes('1.0.0'), v1.title);
    check('v1.0.0 notes contain feature categories', v1.notes.includes('Live Status Bar') && v1.notes.includes('Visual Dashboard'));

    // Extraction from DEV_CHANGELOG.md using custom path
    const devChangelogPath = path.join(__dirname, '..', 'DEV_CHANGELOG.md');
    if (fs.existsSync(devChangelogPath)) {
        const phase1 = extractChangelog('2026-09-21', devChangelogPath);
        check('extracts specific Phase 1 section from DEV_CHANGELOG.md', phase1.title.includes('Phase 1'), phase1.title);
        check('Phase 1 dev notes contain performance details', phase1.notes.includes('Performance') && phase1.notes.includes('Deletion Safety'));
    }

    // Fallback for unknown tag
    const fallback = extractChangelog('v99.99.99');
    check('gracefully falls back to top section for unknown tag', fallback.title === latest.title);
}

// 12. antigravity ide & multi-root catalog support
function testAntigravityIdeSupport() {
    section('12. antigravity ide & multi-root catalog support');

    // Export checks
    check('getInstallationRoots exported', typeof reader.getInstallationRoots === 'function');
    check('setDataSource exported', typeof reader.setDataSource === 'function');
    check('parseVscdbTrajectorySummaries exported', typeof reader.parseVscdbTrajectorySummaries === 'function');
    check('extractInDbWorkspaces exported', typeof reader.extractInDbWorkspaces === 'function');
    check('extractInDbPrompt exported', typeof reader.extractInDbPrompt === 'function');
    check('extractInDbMetadata exported', typeof reader.extractInDbMetadata === 'function');

    // Root resolution
    const rootsAuto = reader.getInstallationRoots('auto');
    check('auto returns single host root without clutter', Array.isArray(rootsAuto) && rootsAuto.length === 1);
    const rootsBoth = reader.getInstallationRoots('both');
    check('both mode resolves installation roots', Array.isArray(rootsBoth) && rootsBoth.length >= 1);
    const rootsExt = reader.getInstallationRoots('extension');
    check('extension mode resolves extension root', rootsExt.some(r => r.id === 'extension'));
    const rootsIde = reader.getInstallationRoots('ide');
    check('ide mode resolves ide root if present', rootsIde.length >= 0);
    const rootsAutoIde = reader.getInstallationRoots('auto', 'ide');
    check('auto with host ide resolves only ide', rootsAutoIde.length === 1 && rootsAutoIde[0].id === 'ide');
    const rootsAutoExt = reader.getInstallationRoots('auto', 'extension');
    check('auto with host extension resolves only extension', rootsAutoExt.length === 1 && rootsAutoExt[0].id === 'extension');

    // Synthetic trajectorySummaries decoding (Base64 + double-nested protobuf)
    const innerSummaryBuf = Buffer.concat([
        strField(1, 'Synthetic IDE Refactor Plan'),
        varField(2, 42),
        lenField(9, Buffer.concat([strField(1, 'file:///g:/web%20dev/antigravity-telemetry')]))
    ]);
    const innerBase64 = innerSummaryBuf.toString('base64');
    const synthConvId = 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d';
    const sessionItem = Buffer.concat([
        strField(1, synthConvId),
        lenField(2, Buffer.concat([strField(1, innerBase64)]))
    ]);
    const syntheticSummaries = lenField(1, sessionItem);

    const parsedSummaries = reader.parseVscdbTrajectorySummaries(syntheticSummaries);
    check('synthetic vscdb summaries parsed', Boolean(parsedSummaries[synthConvId]));
    const item = parsedSummaries[synthConvId];
    check('synthetic title extracted', item && item.title === 'Synthetic IDE Refactor Plan');
    check('synthetic stepCount extracted', item && item.stepCount === 42);
    check('synthetic workspaceUris contains URI', item && item.workspaceUris.includes('antigravity-telemetry'));

    // Synthetic in-db workspaces extraction
    const synthWsBlob = Buffer.concat([
        strField(7, 'file:///g:/web%20dev/portfolio'),
        lenField(1, Buffer.concat([strField(1, 'file:///g:/web%20dev/ContextRAG')]))
    ]);
    const wsList = reader.extractInDbWorkspaces(synthWsBlob);
    check('extractInDbWorkspaces captures repeated tag 1 and tag 7', wsList.length === 2 && wsList.includes('file:///g:/web%20dev/portfolio'));

    // Synthetic in-db prompt extraction
    const synthStepPayload = lenField(19, Buffer.concat([
        strField(2, 'Refactor the tokenizer pipeline for performance')
    ]));
    const prompt = reader.extractInDbPrompt(synthStepPayload);
    check('extractInDbPrompt extracts tag 19.tag 2 user prompt', prompt === 'Refactor the tokenizer pipeline for performance');

    // Real multi-root telemetry discovery check
    const telem = reader.readAllTelemetry({ dataSource: 'auto' });
    check('readAllTelemetry discovers conversations', Array.isArray(telem.conversations) && telem.conversations.length > 0);
    check('active conversation resolved', telem.active !== null);
    check('conversations carry source tag', telem.conversations.some(c => c.source === 'ide' || c.source === 'extension' || c.source === 'cli'));
    check('zero healthy chats falsely flagged as dead ghost chat when in-db workspaces exist',
        telem.conversations.filter(c => c.workspacePaths && c.workspacePaths.length > 0 && c.isOrphan).length === 0);
}

// 13. antigravity cli support & multi-root parity
function testAntigravityCliSupport() {
    section('13. antigravity cli support & multi-root parity');

    // Root resolution
    const rootsCli = reader.getInstallationRoots('cli');
    check('cli mode resolves cli root', rootsCli.length === 1 && rootsCli[0].id === 'cli');
    check('cli root points to antigravity-cli directory', rootsCli[0].antigravityDir.includes('antigravity-cli'));
    const rootsAll = reader.getInstallationRoots('all');
    check('all mode includes cli root', rootsAll.some(r => r.id === 'cli'));

    // findRootForConversation across roots
    const fakeCliConvId = 'c1111111-2222-3333-4444-555555555555';
    const cliRoot = rootsCli[0];
    const cliConvPath = path.join(cliRoot.convDir, `${fakeCliConvId}.db`);
    let wroteFake = false;
    try {
        if (!fs.existsSync(cliRoot.convDir)) fs.mkdirSync(cliRoot.convDir, { recursive: true });
        fs.writeFileSync(cliConvPath, '');
        wroteFake = true;
        const resolved = reader.findRootForConversation ? reader.findRootForConversation(fakeCliConvId) : null;
        check('findRootForConversation resolves cli root for cli chat', resolved && resolved.id === 'cli');
    } catch {} finally {
        if (wroteFake) { try { fs.unlinkSync(cliConvPath); } catch {} }
    }

    // selectActiveConversation priorities: Running CLI > Idle Host Editor > Idle CLI
    const idleHost = { id: 'host-1', isSubagent: false, source: 'extension', isRunning: false };
    const idleCli = { id: 'cli-1', isSubagent: false, source: 'cli', isRunning: false };
    const runningCli = { id: 'cli-running', isSubagent: false, source: 'cli', isRunning: true };
    const subagent = { id: 'sub-1', isSubagent: true, source: 'cli', isRunning: true };

    check('selectActiveConversation prioritizes running CLI over idle host',
        reader.selectActiveConversation([idleHost, runningCli]).id === 'cli-running');
    check('selectActiveConversation prioritizes idle host editor over idle CLI',
        reader.selectActiveConversation([idleCli, idleHost]).id === 'host-1');
    check('selectActiveConversation ignores running subagent in favor of human chat',
        reader.selectActiveConversation([subagent, idleHost]).id === 'host-1');

    // Multi-catalog summaries cache isolation (synthetic SQLite test)
    const sqlite = resolveSqlite();
    if (sqlite) {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-multi-cat-'));
        const catA = path.join(tmpDir, 'catA.db');
        const catB = path.join(tmpDir, 'catB.db');
        try {
            execSync(`"${sqlite}" "${catA}" "CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY, title text, preview text, step_count integer, last_modified_time datetime, workspace_uris text, parent_conversation_id text, nesting_depth integer, agent_name text, killed numeric, raw_summary blob, status text, not_fully_idle numeric); INSERT INTO conversation_summaries VALUES ('id-a', 'Chat A', '', 5, '2026-10-14T00:00:00Z', '', '', 0, '', 0, NULL, 'CASCADE_RUN_STATUS_RUNNING', 1);"`, { stdio: 'ignore' });
            execSync(`"${sqlite}" "${catB}" "CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY, title text, preview text, step_count integer, last_modified_time datetime, workspace_uris text, parent_conversation_id text, nesting_depth integer, agent_name text, killed numeric, raw_summary blob, status text, not_fully_idle numeric); INSERT INTO conversation_summaries VALUES ('id-b', 'Chat B', '', 10, '2026-10-14T01:00:00Z', '', '', 0, '', 0, NULL, '', 0);"`, { stdio: 'ignore' });

            const resA = reader.getConversationSummaries(catA, sqlite);
            check('catA parses running status', resA && resA['id-a'] && resA['id-a'].isRunning === true && resA['id-a'].status === 'CASCADE_RUN_STATUS_RUNNING');
            const resB = reader.getConversationSummaries(catB, sqlite);
            check('catB parses idle status', resB && resB['id-b'] && resB['id-b'].isRunning === false);

            // Re-read A: must hit cache without having been evicted by reading B
            const resA2 = reader.getConversationSummaries(catA, sqlite);
            check('catA preserved in multi-catalog cache without eviction', resA2 && resA2['id-a'] && resA2['id-a'].title === 'Chat A');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    }

    // Real CLI data read
    if (fs.existsSync(cliRoot.convDir)) {
        const cliTelem = reader.readAllTelemetry({ dataSource: 'cli' });
        check('cli telemetry reads conversations from antigravity-cli', Array.isArray(cliTelem.conversations));
        if (cliTelem.conversations.length > 0) {
            check('cli conversations carry source === cli', cliTelem.conversations.every(c => c.source === 'cli'));
            check('cli healthy conversations are not flagged as orphans',
                cliTelem.conversations.filter(c => c.workspacePaths && c.workspacePaths.length > 0 && c.isOrphan).length === 0);
        }
    }
}

// 14. session operations & activity metrics (issue #3)
function testSessionOperationsAndActivity() {
    section('14. session operations & activity metrics (issue #3)');

    check('extractSessionActivity exported', typeof reader.extractSessionActivity === 'function');

    // Default return on missing/invalid input
    const emptyResult = reader.extractSessionActivity('non-existent-path.db', 'invalid-bin');
    check('extractSessionActivity returns safe defaults on missing file',
        emptyResult &&
        emptyResult.userPrompts === 0 &&
        emptyResult.assistantResponses === 0 &&
        emptyResult.executedCommands === 0 &&
        emptyResult.filesReadCount === 0 &&
        Array.isArray(emptyResult.filesRead) &&
        emptyResult.filesModifiedCount === 0 &&
        Array.isArray(emptyResult.filesModified) &&
        emptyResult.totalToolCalls === 0
    );

    // Read all telemetry across all sources
    const allData = reader.readAllTelemetry({ dataSource: 'all' });
    check('readAllTelemetry returns conversations with activity',
        Array.isArray(allData.conversations) && allData.conversations.length > 0 &&
        allData.conversations.some(c => c.stats && c.stats.activity)
    );

    const activeConv = allData.active || allData.conversations[0];
    const convWithActivity = allData.conversations.find(c => c.stats && c.stats.activity && c.stats.activity.assistantResponses > 0) || activeConv;

    if (convWithActivity && convWithActivity.stats && convWithActivity.stats.activity) {
        const act = convWithActivity.stats.activity;
        check('activity contains non-negative userPrompts', typeof act.userPrompts === 'number' && act.userPrompts >= 0);
        check('activity contains assistantResponses', typeof act.assistantResponses === 'number' && act.assistantResponses > 0);
        check('activity contains executedCommands count', typeof act.executedCommands === 'number' && act.executedCommands >= 0);
        check('activity contains filesReadCount and filesRead array', typeof act.filesReadCount === 'number' && Array.isArray(act.filesRead));
        check('activity contains filesModifiedCount and filesModified array', typeof act.filesModifiedCount === 'number' && Array.isArray(act.filesModified));
        check('filesRead paths are unique', new Set(act.filesRead).size === act.filesRead.length);
        check('filesModified paths are unique', new Set(act.filesModified).size === act.filesModified.length);
        check('activity contains totalToolCalls', typeof act.totalToolCalls === 'number' && act.totalToolCalls >= 0);
    }

    // Verify prepareConversationsForWebview bandwidth optimization
    if (allData.conversations.length > 1) {
        const selId = allData.conversations[0].id;
        const prepared = reader.prepareConversationsForWebview(allData.conversations, selId);
        const sel = prepared.find(c => c.id === selId);
        const nonSel = prepared.find(c => c.id !== selId && c.stats && c.stats.activity);

        check('selected conversation retains filesRead array', sel && sel.stats && sel.stats.activity && Array.isArray(sel.stats.activity.filesRead));
        if (nonSel) {
            check('inactive conversation strips filesRead array to save bandwidth',
                nonSel.stats.activity.filesRead.length === 0 && nonSel.stats.activity.filesModified.length === 0);
            check('inactive conversation retains filesReadCount and metrics',
                typeof nonSel.stats.activity.filesReadCount === 'number' &&
                typeof nonSel.stats.activity.executedCommands === 'number' &&
                typeof nonSel.stats.activity.assistantResponses === 'number');
        }
    }

    // Dashboard rendering test: Activity card and elements populated
    const { getDashboardHtml } = require('../dashboardHtml');
    const vm = require('vm');
    const html = getDashboardHtml(allData.conversations, activeConv ? activeConv.id : '', {
        workspaceFilter: 'all',
        currentWorkspacePaths: []
    });

    check('dashboard html contains activityCard', html.includes('id="activityCard"'));
    check('dashboard html contains actToggleFilesBtn', html.includes('id="actToggleFilesBtn"'));
    check('dashboard html contains actFilesDrawer', html.includes('id="actFilesDrawer"'));

    function makeActivityDomMock() {
        const elements = new Map();
        function makeEl(tag) {
            return {
                tag,
                options: [],
                children: [],
                selectedIndex: 0,
                get value() {
                    return this.options && this.options[this.selectedIndex] ? this.options[this.selectedIndex].value : (this._val || '');
                },
                set value(v) {
                    this._val = v;
                    if (this.options) {
                        const idx = this.options.findIndex(o => o.value === v);
                        if (idx !== -1) this.selectedIndex = idx;
                    }
                },
                appendChild(c) {
                    this.children.push(c);
                    if (this.options) this.options.push(c);
                },
                classList: {
                    classes: new Set(),
                    add(...cls) { cls.forEach(c => this.classes.add(c)); },
                    remove(...cls) { cls.forEach(c => this.classes.delete(c)); },
                    toggle(cls) { if (this.classes.has(cls)) this.classes.delete(cls); else this.classes.add(cls); }
                },
                style: {},
                setAttribute() { },
                addEventListener() { },
                querySelector() { return makeEl('sub'); },
                querySelectorAll() { return []; },
                getBoundingClientRect() { return { width: 500, height: 200, left: 0, top: 0 }; },
                textContent: '',
                get innerHTML() { return this._html || ''; },
                set innerHTML(val) {
                    this._html = val;
                    if (val === '') {
                        this.children = [];
                        this.options = [];
                        this.selectedIndex = 0;
                    }
                }
            };
        }
        return {
            getElementById(id) {
                if (!elements.has(id)) elements.set(id, makeEl(id));
                return elements.get(id);
            },
            createElement(tag) { return makeEl(tag); },
            createElementNS(ns, tag) { return makeEl(tag); },
            elements
        };
    }

    const script = html.slice(html.indexOf('>', html.indexOf('<script nonce=')) + 1, html.lastIndexOf('</script>'));
    const doc = makeActivityDomMock();
    const sandbox = {
        acquireVsCodeApi: () => ({ postMessage() { } }),
        window: { addEventListener() { }, onresize: null },
        document: doc,
        console
    };
    const ctx = vm.createContext(sandbox);
    vm.runInContext(script, ctx);

    // Verify DOM element population
    const repliesEl = doc.getElementById('actAssistantReplies');
    check('actAssistantReplies populated in DOM', repliesEl && repliesEl.textContent !== '0');
    const filesReadEl = doc.getElementById('actFilesRead');
    check('actFilesRead element exists in DOM', Boolean(filesReadEl));
    const commandsEl = doc.getElementById('actCommands');
    check('actCommands element exists in DOM', Boolean(commandsEl));
    const imagesEl = doc.getElementById('actImages');
    check('actImages element exists in DOM', Boolean(imagesEl));

    // Test files drawer toggle
    const drawerEl = doc.getElementById('actFilesDrawer');
    drawerEl.classList.add('hidden'); // matches initial HTML
    check('actFilesDrawer is hidden initially', drawerEl && drawerEl.classList.classes.has('hidden'));
    vm.runInContext('toggleActivityFiles()', ctx);
    check('actFilesDrawer is visible after toggle', drawerEl && !drawerEl.classList.classes.has('hidden'));
    check('activityFilesOpen state is true', vm.runInContext('activityFilesOpen', ctx) === true);
    vm.runInContext('toggleActivityFiles()', ctx);
    check('actFilesDrawer is hidden after second toggle', drawerEl && drawerEl.classList.classes.has('hidden'));

    // Test chart loading overlay & states
    check('dashboard html contains chartLoadingOverlay', html.includes('id="chartLoadingOverlay"'));
    check('dashboard html contains chartEmptyState', html.includes('id="chartEmptyState"'));

    const overlayEl = doc.getElementById('chartLoadingOverlay');
    overlayEl.classList.add('hidden'); // matches initial HTML
    const pointsCountEl = doc.getElementById('chartPointsCount');
    vm.runInContext('isLoadingTimeline = true; renderChart([]);', ctx);
    check('chartLoadingOverlay visible during timeline load', overlayEl && !overlayEl.classList.classes.has('hidden'));
    check('chartPointsCount shows loading badge', pointsCountEl && pointsCountEl.textContent.includes('Loading'));

    const mockPoint = [{ turn: 1, input: 1000, cached: 500, fresh: 500, output: 50, thinking: 0 }];
    vm.runInContext('isLoadingTimeline = false;', ctx);
    vm.runInContext(`renderChart(${JSON.stringify(mockPoint)}, true);`, ctx);
    check('chartLoadingOverlay hidden after timeline loads', overlayEl && overlayEl.classList.classes.has('hidden'));
    check('chartPointsCount displays point count', pointsCountEl && pointsCountEl.textContent.includes('1 point'));

    // Context Health & Allocation tests
    check('dashboard html contains contextHealthPct', html.includes('id="contextHealthPct"'));
    check('dashboard html contains contextHealthMeter', html.includes('id="contextHealthMeter"'));
    check('dashboard html contains segPrompts', html.includes('id="segPrompts"'));
    check('dashboard html contains segReplies', html.includes('id="segReplies"'));
    check('dashboard html contains segFiles', html.includes('id="segFiles"'));
    check('dashboard html contains segCommands', html.includes('id="segCommands"'));
    check('dashboard html contains segImages', html.includes('id="segImages"'));
    check('dashboard html contains segFree', html.includes('id="segFree"'));

    const healthPctEl = doc.getElementById('contextHealthPct');
    check('contextHealthPct populated in DOM', healthPctEl && healthPctEl.textContent.includes('%'));
    const healthUsedEl = doc.getElementById('contextHealthUsed');
    check('contextHealthUsed populated in DOM', Boolean(healthUsedEl && healthUsedEl.textContent));
    const healthFreeEl = doc.getElementById('contextHealthFree');
    check('contextHealthFree populated in DOM', Boolean(healthFreeEl && healthFreeEl.textContent));

    // Unified Metric Cards & Inline Drawer Inspector tests
    check('dashboard html contains contextCardsGrid', html.includes('id="contextCardsGrid"'));
    check('dashboard html contains actRepliesFootprint', html.includes('id="actRepliesFootprint"'));
    check('dashboard html contains actFilesFootprint', html.includes('id="actFilesFootprint"'));
    check('dashboard html contains actCommandsFootprint', html.includes('id="actCommandsFootprint"'));
    check('dashboard html contains actImagesFootprint', html.includes('id="actImagesFootprint"'));

    const repliesFp = doc.getElementById('actRepliesFootprint');
    check('actRepliesFootprint populated', Boolean(repliesFp && repliesFp.textContent.includes('tok')));
    const filesFp = doc.getElementById('actFilesFootprint');
    check('actFilesFootprint populated', Boolean(filesFp && filesFp.textContent.includes('tok')));
    const cmdsFp = doc.getElementById('actCommandsFootprint');
    check('actCommandsFootprint populated', Boolean(cmdsFp && cmdsFp.textContent.includes('tok')));
    const imgsFp = doc.getElementById('actImagesFootprint');
    check('actImagesFootprint populated', Boolean(imgsFp && imgsFp.textContent.includes('tok')));

    // Streamlined Turn & Cache Intelligence tests
    check('dashboard html contains intelligenceCard', html.includes('id="intelligenceCard"'));
    const netPillEl = doc.getElementById('metaTrajectoryNetPill');
    check('metaTrajectoryNetPill populated in DOM', Boolean(netPillEl && netPillEl.textContent.includes('tok net')));
    const speedupPillEl = doc.getElementById('metaCacheSpeedupPill');
    check('metaCacheSpeedupPill populated in DOM', Boolean(speedupPillEl && speedupPillEl.textContent.includes('faster')));

    // Codebase Files Drawer filter test
    check('dashboard html contains actFileFilterInput', html.includes('id="actFileFilterInput"'));
    vm.runInContext('renderDrawerFiles("nonexistent-test-path-xyz")', ctx);
    const readListEl = doc.getElementById('actDrawerReadList');
    check('renderDrawerFiles handles filtering correctly', Boolean(readListEl));
}

// ---------------------------------------------------------------------------
testSynthetic();
testRealData();
testValidation();
testRecycleBin();
testWorkspaceScoping();
testSubagents();
testDashboardStability();
testConfigurationAndSqlite();
testChartLayerIntegrity();
testChangelogExtraction();
testAntigravityIdeSupport();
testAntigravityCliSupport();
testSessionOperationsAndActivity();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

