#!/usr/bin/env node
// Asserts the canonical world's computed percept map matches Module 3 slide 5
// (slides/module3/s05_wumpus_world_setup.js). Run in CI / before deploy:
//
//   node bench/verify-world.mjs
//
// If this fails, the world coordinates in the game are wrong. Fix the
// coordinates — never edit the expected map to match a broken world.

const WORLDS = {
  canonical: { size: 4, start: [1, 1], wumpus: [1, 3], pits: [[3, 4], [3, 1]], gold: [4, 1] },
};

const eq = (a, b) => a[0] === b[0] && a[1] === b[1];

// The single adjacency function for the whole game. 4-directional, never diagonal.
export function neighbours([c, r], size = 4) {
  return [[c + 1, r], [c - 1, r], [c, r + 1], [c, r - 1]]
    .filter(([a, b]) => a >= 1 && a <= size && b >= 1 && b <= size);
}

export function perceptsAt([c, r], w) {
  const adj = neighbours([c, r], w.size);
  const p = [];
  if (adj.some((n) => eq(n, w.wumpus))) p.push('stench');
  if (adj.some((n) => w.pits.some((pit) => eq(pit, n)))) p.push('breeze');
  if (eq([c, r], w.gold)) p.push('glitter');
  return p;
}

// Ground truth, read off slides/module3/s05_wumpus_world_setup.js grid[][].
// Row 4 top. Only the letters the slide actually prints.
const SLIDE = {
  '1,4': [], '2,4': ['breeze'], '3,4': ['pit'], '4,4': [],
  '1,3': ['wumpus'], '2,3': [], '3,3': [], '4,3': [],
  '1,2': ['stench'], '2,2': [], '3,2': ['breeze'], '4,2': [],
  '1,1': ['start'], '2,1': ['breeze'], '3,1': ['pit'], '4,1': ['gold'],
};

let fails = 0;
const w = WORLDS.canonical;

// 1. Every square the slide labels with a percept must actually have it.
for (const [key, labels] of Object.entries(SLIDE)) {
  const [c, r] = key.split(',').map(Number);
  const got = perceptsAt([c, r], w);
  for (const label of labels) {
    if (label === 'stench' || label === 'breeze') {
      if (!got.includes(label)) {
        console.error(`FAIL [${key}] slide says ${label}, computed ${JSON.stringify(got)}`);
        fails++;
      }
    }
  }
}

// 2. Contents must sit where the slide puts them.
const contentChecks = [
  ['wumpus', w.wumpus, '1,3'],
  ['gold', w.gold, '4,1'],
  ['pit', w.pits[0], '3,4'],
  ['pit', w.pits[1], '3,1'],
];
for (const [what, coord, expected] of contentChecks) {
  const key = coord.join(',');
  if (key !== expected) { console.error(`FAIL ${what} at [${key}], slide says [${expected}]`); fails++; }
}

// 3. The start square MUST be percept-free or the first move is undeducible
//    and the game is unfair. This is the load-bearing assertion.
const startP = perceptsAt(w.start, w);
if (startP.length) {
  console.error(`FAIL start [${w.start}] has percepts ${JSON.stringify(startP)} — first move not deducible`);
  fails++;
}

// 4. Start's neighbours must be genuinely safe (they are provably safe from 3,
//    so anything else means the world is self-inconsistent).
for (const n of neighbours(w.start, w.size)) {
  const danger = eq(n, w.wumpus) || w.pits.some((p) => eq(p, n));
  if (danger) { console.error(`FAIL [${n}] adjacent to start is lethal but start has no percept`); fails++; }
}

// 5. No diagonals, checked at all four corners.
for (const corner of [[1, 1], [4, 4], [1, 4], [4, 1]]) {
  const ns = neighbours(corner, 4);
  if (ns.length !== 2) { console.error(`FAIL corner [${corner}] has ${ns.length} neighbours, want 2`); fails++; }
  for (const n of ns) {
    if (n[0] !== corner[0] && n[1] !== corner[1]) { console.error(`FAIL diagonal neighbour ${n} of ${corner}`); fails++; }
  }
}

// Report the full map for eyeballing against the projected slide.
console.log('\nCanonical world percept map (row 4 at top):');
for (let r = 4; r >= 1; r--) {
  let line = '';
  for (let c = 1; c <= 4; c++) {
    const here = eq([c, r], w.wumpus) ? 'W' : w.pits.some((p) => eq(p, [c, r])) ? 'P' : eq([c, r], w.gold) ? 'G' : '·';
    const p = perceptsAt([c, r], w);
    const tag = (p.includes('stench') ? 'S' : '') + (p.includes('breeze') ? 'B' : '');
    line += `[${c},${r}]${here}${tag.padEnd(2)}  `;
  }
  console.log('  ' + line);
}

console.log(fails ? `\n${fails} FAILURE(S)` : '\nAll world assertions passed.');
process.exit(fails ? 1 : 0);
