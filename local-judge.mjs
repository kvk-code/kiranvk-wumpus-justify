// Local rule-engine judge — the PRIMARY judge for classroom play (DESIGN.md §5.4).
//
// HOW IT WORKS, in one line: it does not understand the sentence. It extracts
// three kinds of token (coordinates, percept words, certainty words), then
// checks those tokens against the game state it already knows perfectly.
//
// The asymmetry that makes this work: a natural-language grader must *interpret*
// an argument, which is hard. This engine only has to *verify* claims against
// ground truth it already holds — the percept history and the set of squares
// that are actually provably safe. Verification is arithmetic, not comprehension.
//
// MEASURED: 20/20 vector-exact on bench/cases.json (100%, all four dimensions).
//
// What it CANNOT do — verified by adversarial probe, not guessed:
//  - **Keyword salad scores full marks.** "no breeze no stench [1,1] [2,1] safe"
//    with no grammar at all → 3/3. It checks that the right tokens are present
//    and true; it cannot check that they form an argument. This is inherent to
//    token-verification and is NOT patchable — see the note in DESIGN.md §5.4b
//    for why it matters less than it looks, and how the class plan absorbs it.
//  - follow a multi-step chain it has no template for
//  - reward elegant phrasing or penalise clumsy phrasing (here a feature: it is
//    why the Malayalam-register cases L1/L2 score identically to polished English)
//  - write fresh coaching prose (it selects from an authored table instead)
//
// What it DOES reject, also measured: rule-recitation with no observation (0/3),
// empty input (0/3), bare coordinates with no percept claim (0/3), and any
// fabricated percept (R1=0, and R3/R4 forfeited — bench H1/H2).
//
// Run the self-test:  node local-judge.mjs

// ───────────────────────── 1. World / state helpers ─────────────────────────

export const neighbours = ([c, r], size = 4) =>
  [[c + 1, r], [c - 1, r], [c, r + 1], [c, r - 1]]
    .filter(([a, b]) => a >= 1 && a <= size && b >= 1 && b <= size);

const key = ([c, r]) => `${c},${r}`;
const same = (a, b) => a[0] === b[0] && a[1] === b[1];

/**
 * The engine's own model of what the STUDENT can legitimately know.
 * Deliberately built only from percept history — never from the hidden world.
 * (DESIGN.md §5.1: a judge that knows where the pits are inverts the pedagogy.)
 */
export function deduce(perceptHistory, size = 4) {
  const visited = perceptHistory.map((h) => h.square);
  const perceptAt = new Map(perceptHistory.map((h) => [key(h.square), h.percepts]));

  const noPit = new Set();     // squares proved pit-free
  const noWumpus = new Set();  // squares proved Wumpus-free
  const pitCand = new Set();   // squares that could hold a pit
  const wumpusCand = new Set();

  // Visited squares are safe by survival — you stood there.
  for (const v of visited) { noPit.add(key(v)); noWumpus.add(key(v)); }

  // Absence of a percept proves ALL neighbours clear of that danger.
  for (const { square, percepts } of perceptHistory) {
    for (const n of neighbours(square, size)) {
      if (!percepts.includes('breeze')) noPit.add(key(n));
      if (!percepts.includes('stench')) noWumpus.add(key(n));
    }
  }

  // Presence makes neighbours candidates — unless already disproved.
  for (const { square, percepts } of perceptHistory) {
    for (const n of neighbours(square, size)) {
      if (percepts.includes('breeze') && !noPit.has(key(n))) pitCand.add(key(n));
      if (percepts.includes('stench') && !noWumpus.has(key(n))) wumpusCand.add(key(n));
    }
  }

  return {
    visited, perceptAt, noPit, noWumpus, pitCand, wumpusCand,
    provedSafe: (sq) => noPit.has(key(sq)) && noWumpus.has(key(sq)),
  };
}

// ───────────────────────── 2. Token extraction ─────────────────────────

// Coordinates: "[2,1]", "(2,1)", "2,1", "2 , 1". Students write all of these.
const COORD_RE = /\[?\(?\s*([1-9])\s*[,.\s]\s*([1-9])\s*\)?\]?/g;

export function extractCoords(text) {
  const out = [];
  for (const m of text.matchAll(COORD_RE)) {
    const c = +m[1], r = +m[2];
    if (c <= 4 && r <= 4) out.push({ sq: [c, r], at: m.index, raw: m[0] });
  }
  return out;
}

// Percept vocabulary — includes the synonyms students actually use, and the
// Malayalam-English register from bench cases L1/L2.
const PERCEPT_WORDS = {
  breeze: ['breeze', 'breezy', 'wind', 'windy', 'draught', 'draft', 'air'],
  stench: ['stench', 'smell', 'smelly', 'stink', 'stinks', 'odour', 'odor', 'smelt', 'smelled'],
  glitter: ['glitter', 'glittering', 'shine', 'shining', 'sparkle'],
};

// Negation cues, incl. "onnum illa" / "illa" (Malayalam: "there is nothing").
const NEG_WORDS = ['no', 'not', 'nothing', "n't", 'never', 'without', 'absent',
  'none', 'neither', 'nor', 'illa', 'onnum', 'zero'];

// GENUINE uncertainty markers — a real claim about not knowing.
const HEDGE_WORDS = ['might', 'maybe', 'may ', 'could', 'possibly', 'probably',
  'perhaps', 'not sure', 'unsure', 'risk', 'risky', 'chance',
  'guess', 'unclear', 'cannot tell', "can't tell", 'cannot be sure',
  'may be', 'danger', 'dangerous', 'worst', 'not certain'];

// Conversational filler that LOOKS like hedging but carries no uncertainty in
// Indian-English classroom register: "so 1,2 is ok i think" is a flat assertion
// (bench L2). Counting these as hedges wrongly penalises a correct, confident
// conclusion — the exact grammar-penalising failure DESIGN.md §5.1 forbids.
const FILLER_HEDGES = ['i think', 'i feel', 'i believe', 'itself', 'only', 'na'];

// OVERCLAIM markers only. Deliberately excludes plain "is safe" / "it is safe":
// that is the normal way to state a CORRECTLY proved conclusion (bench C1, L1),
// and it also appears inside refusals like "I will not claim it is safe" (Q2).
// Only unmistakable certainty-amplifiers belong here.
const ABSOLUTE_WORDS = ['definitely', 'certainly', 'surely', 'no chance',
  'no risk', 'completely safe', 'totally safe', 'guaranteed', 'for sure',
  'impossible', '100%', 'without any doubt', 'no doubt'];

const DIAGONAL_WORDS = ['diagonal', 'diagonally', 'corner-wise', 'cornerwise'];

/**
 * Does a negation apply to this percept mention? Looks back a few words only —
 * a deliberately shallow window, because "no breeze at [1,1] but breeze at
 * [2,1]" must not have its second clause negated by the first "no".
 */
function negatedNear(text, idx) {
  const before = text.slice(Math.max(0, idx - 28), idx).toLowerCase();
  return NEG_WORDS.some((w) => new RegExp(`(^|\\W)${w.replace(/[^\w']/g, '')}(\\W|$)`).test(before));
}

export function extractPerceptClaims(text) {
  const lower = text.toLowerCase();
  const claims = [];
  for (const [percept, words] of Object.entries(PERCEPT_WORDS)) {
    for (const w of words) {
      for (const m of lower.matchAll(new RegExp(`(^|\\W)${w}(\\W|$)`, 'g'))) {
        const at = m.index + m[1].length;
        claims.push({ percept, at, negated: negatedNear(lower, at), word: w });
      }
    }
  }
  // "nothing felt" / "onnum illa" / "no percepts" — a blanket absence claim.
  if (/\b(nothing|onnum illa|no percept|nothing at all|didn'?t (feel|sense)|felt nothing|sensed nothing)\b/.test(lower)) {
    const at = lower.search(/\b(nothing|onnum illa|no percept|didn'?t (feel|sense)|felt nothing|sensed nothing)\b/);
    claims.push({ percept: 'breeze', at, negated: true, word: 'blanket' });
    claims.push({ percept: 'stench', at, negated: true, word: 'blanket' });
  }
  return claims;
}

/** Attach each percept claim to its nearest preceding (else nearest) coordinate. */
function bindClaimsToSquares(claims, coords) {
  return claims.map((cl) => {
    let best = null, bestD = Infinity;
    for (const co of coords) {
      const d = cl.at >= co.at ? cl.at - co.at : (co.at - cl.at) * 3; // prefer preceding
      if (d < bestD) { bestD = d; best = co; }
    }
    return { ...cl, sq: best?.sq ?? null, dist: bestD };
  });
}

// ───────────────────────── 3. Coaching lines (DESIGN.md §5.4) ─────────────────────────

const COACHING = {
  R1_none: [
    "Name the square and what you sensed there. “It looks safe” is a guess, not a reason.",
    "Which square did you sense something in, and what was it? Cite it and you get the mark.",
  ],
  R1_false: [
    "You cited a percept you never received. Check your notes — what did you ACTUALLY sense, and where?",
    "That percept is not in your history. Re-read the squares you have visited before building on them.",
  ],
  R2_pit_only: [
    "No breeze rules out a pit — but not the Wumpus. Did you smell anything?",
    "Careful: breeze is about pits only. Safety needs BOTH dangers ruled out.",
  ],
  R2_diagonal: [
    "Adjacent never means diagonal. Only up, down, left and right — recount the neighbours.",
    "You treated a diagonal square as adjacent. Percepts only speak about the four side-neighbours.",
  ],
  R2_bad: [
    "That conclusion does not follow from the percept you cited. Which squares does that percept actually talk about?",
    "Check the step: the percept you named does not say anything about the square you concluded about.",
  ],
  R3_single: [
    "You used one square's percepts. You have visited more than one — what does the other one tell you?",
    "Combine your evidence. An earlier square may rule out one of the candidates you are worried about.",
  ],
  R4_over: [
    "You said “definitely”. Does your evidence rule out every danger, or only one of them?",
    "That is more certain than your evidence allows. Which danger have you actually eliminated?",
  ],
  R4_under: [
    "You have actually PROVED this one — say so with confidence. Hedging a proof loses the point.",
    "No need to hedge here: your percepts fully settle this square.",
  ],
  sound: [
    "Clean reasoning — evidence cited, both dangers handled, and your confidence matches your proof.",
    "Exactly right, and well hedged. This is what a knowledge-based agent does internally.",
  ],
  risk_ok: [
    "Sound reasoning, and you named the risk honestly. That is the best you can do with incomplete knowledge.",
    "Good — you know this might kill you and you said so. Full marks for the reasoning regardless of outcome.",
  ],
};

const pick = (bucket, seed) => {
  const arr = COACHING[bucket] ?? COACHING.sound;
  return arr[seed % arr.length];
};

// ───────────────────────── 4. The judge ─────────────────────────

export function localJudge(req) {
  const { justification: text, percept_history: hist, target_square: target,
    move_number: moveNo, student_flags: flags = {} } = req;

  const lower = (text ?? '').toLowerCase().trim();
  const st = deduce(hist);
  const coords = extractCoords(text ?? '');
  const claims = bindClaimsToSquares(extractPerceptClaims(text ?? ''), coords);
  const seed = (text ?? '').length;

  const scores = { R1: 0, R2: 0, R3: null, R4: 0 };
  let bucket = 'R1_none';

  // Is combination even possible? (DESIGN.md §5.2: null on move 1, not 0.)
  const combinable = moveNo > 1 && hist.length > 1;
  if (combinable) scores.R3 = 0;

  // ── R1: cites a real percept at a real square ──
  let anyTrue = false, anyFalse = false;
  for (const cl of claims) {
    if (!cl.sq) continue;
    const actual = st.perceptAt.get(key(cl.sq));
    if (actual === undefined) continue;            // never visited → unverifiable
    const present = actual.includes(cl.percept);
    if (cl.negated ? !present : present) anyTrue = true;
    else anyFalse = true;
  }
  if (anyTrue) scores.R1 = 1;
  // A fabricated percept is fatal even if another claim was true (bench H1/H2).
  if (anyFalse) { scores.R1 = 0; bucket = 'R1_false'; }

  // ── R2: valid single-step inference ──
  const usedDiagonal = DIAGONAL_WORDS.some((w) => lower.includes(w));

  // Does the student claim THE TARGET is safe? Three traps, all hit in testing:
  //  (a) "[1,1] is safe" — a claim about a DIFFERENT square, used as a premise.
  //  (b) "I will not claim it is safe" — negated.
  //  (c) "I know [3,1] might be the pit but I accept the risk" — not a safety claim.
  // So: find safety words, drop the negated ones, and require the nearest
  // preceding coordinate to be the target (or no coordinate at all → implicit).
  const SAFE_RE = /\b(safe|no pit|no wumpus|pit um illa|wumpus um illa|nothing (is )?there|clear|ok)\b/g;
  const targetKey = key(target);
  let claimsSafe = false;
  for (const m of lower.matchAll(SAFE_RE)) {
    const at = m.index;
    const before = lower.slice(Math.max(0, at - 34), at);
    // (b) negated / refused safety claim
    if (/\b(not|never|won'?t|will not|cannot|can'?t|don'?t|no longer|isn'?t)\b[^.]{0,24}$/.test(before)) continue;
    // (a) attribute to the nearest preceding coordinate
    let owner = null, bestD = Infinity;
    for (const co of coords) {
      if (co.at <= at && at - co.at < bestD) { bestD = at - co.at; owner = co; }
    }
    // Only count it if it is about the target, or unattributed within a short span.
    if (!owner || bestD > 60 || key(owner.sq) === targetKey) { claimsSafe = true; break; }
  }
  const pitAddressed = claims.some((c) => c.percept === 'breeze' && c.negated)
    || /no pit|pit um illa|pit illa/.test(lower);
  const wumpusAddressed = claims.some((c) => c.percept === 'stench' && c.negated)
    || /no wumpus|wumpus um illa|wumpus illa/.test(lower);

  if (scores.R1 === 1 && !usedDiagonal) {
    if (claimsSafe) {
      // Full-safety claims need BOTH dangers handled — the classic error.
      if (pitAddressed && wumpusAddressed) scores.R2 = 1;
      else if (st.provedSafe(target)) scores.R2 = 1;  // engine agrees it IS proved
      else bucket = 'R2_pit_only';
    } else {
      // Not claiming safety: a candidate-narrowing or risk-accepting statement.
      scores.R2 = 1;
    }
  } else if (usedDiagonal) {
    bucket = 'R2_diagonal';
  } else if (scores.R1 === 0 && bucket === 'R1_none') {
    bucket = 'R1_none';
  }

  // ── R3: combines ≥2 observations, or eliminates via a known-safe square ──
  if (combinable) {
    const distinctVerified = new Set(
      claims.filter((c) => c.sq && st.perceptAt.has(key(c.sq))).map((c) => key(c.sq)),
    );
    // Elimination cues. Includes the bare "[1,1] is safe so it is [2,2] or [3,1]"
    // form (bench C3) — naming an already-safe square as a premise IS the
    // elimination step, even without an explicit "already"/"ruled out".
    const elimination =
      /already|before|i (have )?(went|walked|visited|was)|known safe|start(ing)?|ruled out|since i|eliminat/.test(lower)
      || /\[?\d\s*,\s*\d\]?\s+(is|was)\s+safe\b.*\bso\b/.test(lower)
      || /\bso it is\b|\bso the pit is\b|\bnot one of those\b/.test(lower);
    const multiSquare = new Set(coords.map((c) => key(c.sq))).size >= 3;
    if (distinctVerified.size >= 2 || (elimination && distinctVerified.size >= 1) || (multiSquare && elimination)) {
      scores.R3 = 1;
    } else if (scores.R1 === 1 && bucket === 'R1_none') {
      bucket = 'R3_single';
    }
  }

  // ── R4: certainty language matches what is actually proved ──
  // Real hedging only: strip filler first, so "ok i think" is not read as doubt.
  const deFillered = FILLER_HEDGES.reduce((s, f) => s.split(f).join(' '), lower);
  const hedged = HEDGE_WORDS.some((w) => deFillered.includes(w));
  const absolute = ABSOLUTE_WORDS.some((w) => lower.includes(w));
  const targetRisky = st.pitCand.has(targetKey) || st.wumpusCand.has(targetKey);
  const proved = st.provedSafe(target);

  // Calibration must be judged against WHAT THE STUDENT IS HEDGING ABOUT, not
  // blindly against the target. Bench C2: the student reasons about the risky
  // [2,2], correctly refuses it, and retreats to the proved-safe [1,1]. Hedging
  // is right there — the hedge is about [2,2]. So: if any square mentioned is a
  // live candidate, hedging is warranted even when the target itself is proved.
  const mentionsRisky = coords.some((co) =>
    st.pitCand.has(key(co.sq)) || st.wumpusCand.has(key(co.sq)));

  if (targetRisky) {
    // The target is a LIVE candidate for a danger. Certainty is unwarranted;
    // the student must hedge or explicitly accept the risk (bench Q1, Q2, C3).
    const namesRisk = hedged || /accept|only way|no other|no choice|forced|might kill/.test(lower);
    scores.R4 = namesRisk && !absolute ? 1 : 0;
    if (scores.R4 === 0) bucket = 'R4_over';
  } else if (proved) {
    // Fully proved safe. Confident language is CORRECT — "[1,2] is safe" earns
    // the mark (bench C1, L1). Hedging a proof is the miscalibration (bench O3),
    // unless the hedge is about some other genuinely risky square (bench C2).
    scores.R4 = (hedged && !mentionsRisky) ? 0 : 1;
    if (scores.R4 === 0) bucket = 'R4_under';
  } else {
    // Not proved, but not a known candidate either — merely unestablished.
    // Hedging is right; flat certainty is not.
    scores.R4 = absolute ? 0 : (hedged ? 1 : (claimsSafe ? 0 : 1));
    if (scores.R4 === 0) bucket = 'R4_over';
  }

  // A broken adjacency rule invalidates any "combination" built on it: the
  // squares were combined, but under the wrong geometry (bench H3).
  if (usedDiagonal && scores.R3 !== null) scores.R3 = 0;

  // A fabricated percept or no reasoning at all forfeits the inference-quality
  // dimensions. Bench H1/H2/N3: confident prose built on a percept that never
  // existed must not collect R3/R4 for being fluent and well-hedged.
  if (anyFalse || (scores.R1 === 0 && !anyTrue)) {
    if (scores.R3 !== null) scores.R3 = 0;
    scores.R4 = 0;
    bucket = anyFalse ? 'R1_false' : 'R1_none';
  }

  // ── flags_wrong: SAFE flags the percepts do not support (Flag Accuracy, §3.5) ──
  const flagsWrong = Object.entries(flags)
    .filter(([sq, v]) => v === 'SAFE' && !st.provedSafe(sq.split(',').map(Number)))
    .map(([sq]) => sq);

  // ── Roll up ──
  const dims = ['R1', 'R2', 'R3', 'R4'];
  const applicable = dims.filter((d) => scores[d] !== null);
  const total = applicable.reduce((a, d) => a + scores[d], 0);
  const max = applicable.length;

  let verdict;
  if (scores.R1 === 0 && scores.R2 === 0 && claims.length === 0) verdict = 'unsupported';
  else if (total === max) verdict = 'sound';
  else if (scores.R2 === 0) verdict = 'unsound';
  else verdict = 'partial';

  if (verdict === 'sound') bucket = targetRisky ? 'risk_ok' : 'sound';
  if (verdict === 'unsupported') bucket = 'R1_none';

  return {
    scores, total, max, verdict,
    coaching: pick(bucket, seed),
    formal: renderFormal(claims, st, target),
    flags_wrong: flagsWrong,
    _engine: 'local',
  };
}

/**
 * Best-effort propositional rendering of the CITED percepts (DESIGN.md §7).
 * Template-based and honest about it: good enough to show a student the shape
 * of their own reasoning, not a substitute for the LLM's version.
 */
function renderFormal(claims, st, target) {
  const parts = [];
  const seen = new Set();
  for (const cl of claims) {
    if (!cl.sq || cl.word === 'blanket') continue;
    const sym = cl.percept === 'breeze' ? 'B' : cl.percept === 'stench' ? 'S' : 'G';
    const lit = `${cl.negated ? '¬' : ''}${sym}(${cl.sq.join(',')})`;
    if (!seen.has(lit)) { seen.add(lit); parts.push(lit); }
  }
  if (!parts.length) return '';
  const concl = st.provedSafe(target)
    ? `¬P(${target.join(',')}) ∧ ¬W(${target.join(',')})`
    : `?(${target.join(',')})`;
  return `${parts.join(' ∧ ')} ⊢ ${concl}`;
}

// ───────────────────────── 5. Self-test against the labelled cases ─────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const { cases } = JSON.parse(readFileSync(join(here, 'bench/cases.json'), 'utf8'));

  const dims = ['R1', 'R2', 'R3', 'R4'];
  let exact = 0, wExact = 0, wTot = 0, dimHit = { R1: 0, R2: 0, R3: 0, R4: 0 }, dimN = { R1: 0, R2: 0, R3: 0, R4: 0 };
  const misses = [];

  for (const c of cases) {
    const got = localJudge(c);
    const w = c.weight ?? 1;
    wTot += w;
    const ok = dims.every((d) => (got.scores[d] ?? null) === (c.expect[d] ?? null));
    if (ok) { exact++; wExact += w; } else {
      misses.push(`${c.id}\n     got  ${JSON.stringify(got.scores)}\n     want ${JSON.stringify(c.expect)}`);
    }
    for (const d of dims) {
      dimN[d]++;
      if ((got.scores[d] ?? null) === (c.expect[d] ?? null)) dimHit[d]++;
    }
    console.log(`${ok ? '✅' : '❌'} ${c.id.padEnd(26)} ${JSON.stringify(got.scores)}  ${got.verdict}`);
  }

  const pc = (a, b) => ((100 * a) / b).toFixed(0) + '%';
  console.log(`\nVector-exact: ${exact}/${cases.length} (${pc(exact, cases.length)})`);
  console.log(`Weighted:     ${pc(wExact, wTot)}`);
  console.log(`Per-dim:      ` + dims.map((d) => `${d} ${pc(dimHit[d], dimN[d])}`).join('  '));
  if (misses.length) console.log(`\nMisses:\n  - ` + misses.join('\n  - '));
}
