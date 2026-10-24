#!/usr/bin/env node
// Tests for wumpus-logic.js: textbook cases, and a differential test against the fast propagator in wumpus-core.js
// (the propagator must never claim more than the truth table; we count how often the truth table finds more).
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const W = require(join(HERE, '..', 'wumpus-core.js'));
const L = require(join(HERE, '..', 'wumpus-logic.js'));
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.error('FAIL', m); } };

// 1. textbook: after [1,1] (nothing) → ¬P(2,1) entailed, with a short resolution proof
const h1 = [{ square: [1, 1], percepts: [] }];
let a = L.ask(h1, { kind: 'noPit', squares: [[2, 1]] });
ok(a.status === 'entailed' && a.tt.entailed === true, 'TT: ¬P(2,1) entailed after empty [1,1]');
ok(a.resolution.proved && a.resolution.steps.length <= 6, 'resolution proof for ¬P(2,1) is short: ' + a.resolution.steps.length);
console.log('proof ¬P(2,1):'); for (const s of a.resolution.steps) console.log('  ' + s.n + '. ' + s.text.padEnd(28) + ' ' + s.label);
a = L.ask(h1, { kind: 'safe', squares: [[1, 2]] }); ok(a.status === 'entailed', 'safe(1,2) entailed');
a = L.ask(h1, { kind: 'noPit', squares: [[2, 2]] }); ok(a.status === 'open' && a.tt.counterexample, 'noPit(2,2) open with a counterexample: ' + JSON.stringify(a.tt.counterexample));

// 2. the [2,2] lesson: breeze at [2,1], stench at [1,2] → [2,2] proved safe; [3,1] pit; [1,3] wumpus
const h2 = [{ square: [1, 1], percepts: [] }, { square: [2, 1], percepts: ['breeze'] }, { square: [1, 2], percepts: ['stench'] }];
ok(L.ask(h2, { kind: 'safe', squares: [[2, 2]] }).status === 'entailed', 'safe(2,2) entailed at move 3');
ok(L.ask(h2, { kind: 'pit', squares: [[3, 1]] }).status === 'entailed', 'P(3,1) entailed');
ok(L.ask(h2, { kind: 'wumpus', squares: [[1, 3]] }).status === 'entailed', 'W(1,3) entailed');
ok(L.ask(h2, { kind: 'pit', squares: [[2, 2]] }).status === 'refuted', 'P(2,2) refuted');
ok(L.ask(h2.slice(0, 2), { kind: 'pitOr', squares: [[2, 2], [3, 1]] }).status === 'entailed', 'P(2,2)∨P(3,1) entailed after breeze at [2,1]');
ok(L.ask(h2.slice(0, 2), { kind: 'pitOr', squares: [[2, 2], [3, 1], [1, 1]] }).status === 'entailed', 'weaker disjunction still entailed');
// 3. consistency of a student's derived set
let c = L.consistent(h2.slice(0, 2), [{ kind: 'pit', squares: [[2, 2]] }, { kind: 'noPit', squares: [[2, 2]] }]);
ok(c.consistent === false && c.culprits.length === 2, 'contradictory pair flagged: ' + JSON.stringify(c));
c = L.consistent(h2.slice(0, 2), [{ kind: 'noPit', squares: [[2, 2]] }, { kind: 'noPit', squares: [[3, 1]] }]);
ok(c.consistent === false, 'both candidates pit-free contradicts the breeze: ' + JSON.stringify(c));
ok(L.consistent(h2, [{ kind: 'pit', squares: [[3, 1]] }, { kind: 'safe', squares: [[2, 2]] }]).consistent === true, 'consistent set passes');

// 4. differential test: propagator (fast, sound, incomplete) vs truth table (complete) over random worlds and walks
function rnd(seed) { let a = seed | 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
let cases = 0, agree = 0, ttMore = 0, unsound = 0, ttTooBig = 0, maxSyms = 0;
const kinds = ['noPit', 'noW', 'safe', 'pit', 'wumpus'];
for (let seed = 1; seed <= 400; seed++) {
  const r = rnd(seed); const world = W.randomWorld(1000 + seed);
  // random safe walk of 1–6 steps (never onto a pit/wumpus, so the history is a live agent's)
  const hist = [{ square: world.start, percepts: W.perceptsAt(world.start, world) }]; let pos = world.start; const seen = new Set([W.key(pos)]);
  const bad = (s) => W.eq(s, world.wumpus) || world.pits.some((p) => W.eq(p, s));
  for (let step = 0; step < 1 + Math.floor(r() * 6); step++) {
    const opts = W.neighbours(pos).filter((n) => !bad(n)); if (!opts.length) break;
    pos = opts[Math.floor(r() * opts.length)];
    if (!seen.has(W.key(pos))) { seen.add(W.key(pos)); hist.push({ square: pos, percepts: W.perceptsAt(pos, world) }); }
  }
  const visited = hist.map((h) => h.square);
  const K = W.knowledge(hist, visited);
  for (let c1 = 1; c1 <= 4; c1++) for (let r1 = 1; r1 <= 4; r1++) for (const kind of kinds) {
    const s = { kind, squares: [[c1, r1]] };
    const fast = W.checkSentence(hist, visited, s);
    const full = L.ask(hist, s, { ttLimit: 3000000 });
    if (full.tt.symbols > maxSyms) maxSyms = full.tt.symbols;
    if (full.status === 'unknown') { ttTooBig++; continue; }
    cases++;
    if (fast === full.status) agree++;
    else if (fast === 'open') ttMore++;
    else { unsound++; if (unsound <= 5) console.error('UNSOUND?', seed, kind, [c1, r1], 'fast', fast, 'tt', full.status, JSON.stringify(hist)); }
  }
}
console.log(`\ndifferential: ${cases} queries · agree ${agree} · truth table finds more ${ttMore} (${(100 * ttMore / cases).toFixed(2)}%) · propagator over-claims ${unsound} · too big for TT ${ttTooBig} · max symbols ${maxSyms}`);
ok(unsound === 0, 'propagator never claims what the truth table denies');
console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL GREEN');
process.exit(fails ? 1 : 0);
