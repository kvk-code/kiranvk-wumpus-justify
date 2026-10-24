#!/usr/bin/env node
// Unit tests for wumpus-core.js: worlds, adjacency, knowledge, and the local judge
// against bench/cases.json. Run: node bench/test-core.mjs   (exit 0 = green)
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const W = require(join(HERE, '..', 'wumpus-core.js'));

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.error('FAIL', msg); } };

// 1. adjacency: four corners, never diagonal, never off-board
const sets = { '1,1': ['2,1', '1,2'], '4,1': ['3,1', '4,2'], '1,4': ['2,4', '1,3'], '4,4': ['3,4', '4,3'] };
for (const [k, exp] of Object.entries(sets)) {
  const got = W.neighbours(W.parseKey(k)).map(W.key).sort();
  ok(JSON.stringify(got) === JSON.stringify(exp.sort()), `neighbours(${k}) = ${got}`);
}
ok(W.neighbours([2, 2]).length === 4 && !W.adjacent([2, 2], [3, 3]), 'no diagonal adjacency');

// 2. canonical world matches slide 5 (DESIGN.md §3.2) — computed, never hard-coded
const can = W.WORLDS.canonical;
const expectB = ['2,1', '2,4', '3,2', '3,3', '4,1', '4,4'], expectS = ['1,2', '1,4', '2,3'];
const B = [], S = [];
for (let c = 1; c <= 4; c++) for (let r = 1; r <= 4; r++) { const p = W.perceptsAt([c, r], can); if (p.includes('breeze')) B.push(`${c},${r}`); if (p.includes('stench')) S.push(`${c},${r}`); }
ok(JSON.stringify(B.sort()) === JSON.stringify(expectB), `canonical breeze map ${B}`);
ok(JSON.stringify(S.sort()) === JSON.stringify(expectS), `canonical stench map ${S}`);
ok(W.perceptsAt([2, 2], can).length === 0, '[2,2] is percept-free (teaching subtlety)');

// 3. every shipped world is fair: start percept-free, start neighbours safe, gold reachable
for (const id of ['canonical', 'fork', 'cruel']) {
  const w = W.WORLDS[id];
  ok(W.perceptsAt(w.start, w).length === 0, `${id}: start has no percepts`);
  for (const n of W.neighbours(w.start)) ok(!W.eq(n, w.wumpus) && !w.pits.some((p) => W.eq(p, n)), `${id}: ${W.key(n)} safe`);
}
for (const seed of [1, 7, 1234, 2026, 99999]) {
  const w = W.randomWorld(seed);
  ok(W.perceptsAt(w.start, w).length === 0, `random ${seed}: start clean`);
  ok(!W.eq(w.gold, w.wumpus) && !w.pits.some((p) => W.eq(p, w.gold)), `random ${seed}: gold not on danger`);
  ok(JSON.stringify(W.randomWorld(seed)) === JSON.stringify(w), `random ${seed}: deterministic`);
}

// 4. knowledge engine
const hist = [{ square: [1, 1], percepts: [] }, { square: [2, 1], percepts: ['breeze'] }, { square: [1, 2], percepts: ['stench'] }];
const K = W.knowledge(hist, [[1, 1], [2, 1], [1, 2]]);
ok(K['2,2'].safe === true, '[2,2] proved safe after 3 moves (no stench at 2,1; no breeze at 1,2)');
ok(K['3,1'].pit === 'yes', '[3,1] proved pit by elimination');
ok(K['1,3'].wumpus === 'yes', '[1,3] proved wumpus by elimination');
const K2 = W.knowledge(hist.slice(0, 2), [[1, 1], [2, 1]]);
ok(K2['2,2'].pit === 'maybe' && K2['3,1'].pit === 'maybe' && K2['1,2'].safe, 'after 2 moves: 2,2 and 3,1 open, 1,2 safe');

// 5. the local judge never receives the world: its only inputs are the request fields
const src = readFileSync(join(HERE, '..', 'wumpus-core.js'), 'utf8');
const judgeBody = src.slice(src.indexOf('function localJudge('), src.indexOf('function hash('));
ok(!/WORLDS|perceptsAt|randomWorld|getWorld/.test(judgeBody), 'localJudge body references no world data');

// 6. bench cases
const { cases } = JSON.parse(readFileSync(join(HERE, 'cases.json'), 'utf8'));
let exact = 0, wExact = 0, wTot = 0, dimHits = 0, dimN = 0, verdictHits = 0;
const dims = ['R1', 'R2', 'R3', 'R4'];
for (const c of cases) {
  const v = W.localJudge({ ...c, action: 'move' });
  const got = v.scores;
  const isExact = dims.every((d) => (got[d] ?? null) === (c.expect[d] ?? null));
  const w = c.weight || 1; wTot += w;
  if (isExact) { exact++; wExact += w; }
  for (const d of dims) { dimN++; if ((got[d] ?? null) === (c.expect[d] ?? null)) dimHits++; }
  if (v.verdict === c.expect_verdict) verdictHits++;
  const flagsOK = c.id !== 'O1-overclaim-two-two' || v.flags_wrong.includes('2,2');
  console.log(`${isExact ? 'OK  ' : 'MISS'} ${c.id.padEnd(30)} got ${JSON.stringify(got)} want ${JSON.stringify(c.expect)} verdict ${v.verdict}/${c.expect_verdict}${flagsOK ? '' : ' FLAGS-MISS'}`);
  if (!isExact || process.env.VERBOSE) console.log('      ', JSON.stringify(v._debug), '\n       coaching:', v.coaching, '\n       formal:', v.formal);
  if (!flagsOK) fails++;
}
console.log(`\nlocal judge: exact ${exact}/${cases.length}, weighted ${(100 * wExact / wTot).toFixed(1)}%, per-dim ${(100 * dimHits / dimN).toFixed(1)}%, verdict ${verdictHits}/${cases.length}`);
if (exact < cases.length) fails++;
console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL GREEN');
process.exit(fails ? 1 : 0);
