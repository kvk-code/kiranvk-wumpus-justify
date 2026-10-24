/* Wumpus Justify — propositional logic engine, restricted to what Module 3 (PECST522) teaches:
 *   • the Wumpus world as propositional sentences (AIMA §7.4): B(c,r) ⇔ ∨ P(neighbours), S(c,r) ⇔ ∨ W(neighbours), exactly one Wumpus
 *   • conversion to CNF (clauses)
 *   • entailment by truth-table model checking:  KB ⊨ α  iff  α is true in every model of KB   (TT-ENTAILS)
 *   • resolution refutation:  KB ⊨ α  iff  KB ∧ ¬α ⊢ □ (the empty clause) by resolution        (PL-RESOLUTION)
 * No DPLL, no SAT library — the machine reasons with exactly the two procedures on the slides.
 * Works in the browser (window.WumpusLogic) and in Node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WumpusLogic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const key = (sq) => sq[0] + ',' + sq[1];
  const sym = (kind, sq) => kind + sq[0] + sq[1];            // P22, W13, B21, S12
  const pretty = (s) => (s === 'Wx' ? 'W(elsewhere)' : s[0] + '(' + s[1] + ',' + s[2] + ')');
  function neighbours(sq, size) { size = size || 4; const c = sq[0], r = sq[1]; return [[c + 1, r], [c - 1, r], [c, r + 1], [c, r - 1]].filter((n) => n[0] >= 1 && n[0] <= size && n[1] >= 1 && n[1] <= size); }

  // ---- clauses: array of literals {s: symbol, neg: bool}; a clause is a disjunction ----
  const lit = (s, neg) => ({ s, neg: !!neg });
  const clauseText = (c) => (c.length ? c.map((l) => (l.neg ? '¬' : '') + pretty(l.s)).join(' ∨ ') : '□');
  const clauseKey = (c) => c.map((l) => (l.neg ? '-' : '+') + l.s).sort().join(' ');
  function normalise(c) { // drop duplicates; null if tautology
    const seen = new Map();
    for (const l of c) { const prev = seen.get(l.s); if (prev !== undefined && prev !== l.neg) return null; seen.set(l.s, l.neg); }
    return [...seen].map(([s, neg]) => lit(s, neg)).sort((a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : 0));
  }

  // ---- the Wumpus-world KB in CNF, restricted to the FRONTIER (squares any percept can constrain) ----
  // history: [{square, percepts}] (one per distinct visited square). extraSquares: squares a query mentions.
  // Only rules for VISITED squares matter (an unvisited square's B/S is unknown, so its rule constrains nothing).
  // Pits on non-frontier squares are independent → dropped. The single Wumpus may sit off-frontier → symbol Wx ("elsewhere").
  function buildKB(history, extraSquares, size) {
    size = size || 4;
    const visited = new Map(); for (const h of history || []) visited.set(key(h.square), h);
    const frontier = new Set();
    for (const h of visited.values()) { frontier.add(key(h.square)); for (const n of neighbours(h.square, size)) frontier.add(key(n)); }
    for (const q of extraSquares || []) frontier.add(key(q));
    const sqOf = (k) => k.split(',').map(Number);
    const clauses = []; const why = new Map(); // clauseKey → provenance label
    const add = (c, label) => { const n = normalise(c); if (!n) return; const k = clauseKey(n); if (why.has(k)) return; why.set(k, label); clauses.push(n); };
    const dead = [...visited.values()].some((h) => (h.percepts || []).includes('scream'));
    for (const h of visited.values()) {
      const sq = h.square, adj = neighbours(sq, size), ps = h.percepts || [];
      // rules (CNF of the biconditionals)
      add([lit(sym('B', sq), true), ...adj.map((n) => lit(sym('P', n)))], 'rule: B' + pretty(sym('B', sq)).slice(1) + ' ⇒ pit in a neighbour');
      for (const n of adj) add([lit(sym('P', n), true), lit(sym('B', sq))], 'rule: P' + pretty(sym('P', n)).slice(1) + ' ⇒ B' + pretty(sym('B', sq)).slice(1));
      if (!dead) {
        add([lit(sym('S', sq), true), ...adj.map((n) => lit(sym('W', n)))], 'rule: S' + pretty(sym('S', sq)).slice(1) + ' ⇒ Wumpus in a neighbour');
        for (const n of adj) add([lit(sym('W', n), true), lit(sym('S', sq))], 'rule: W' + pretty(sym('W', n)).slice(1) + ' ⇒ S' + pretty(sym('S', sq)).slice(1));
      }
      // percept facts + "I stood here and lived"
      add([lit(sym('B', sq), !ps.includes('breeze'))], 'percept at ' + pretty(sym('B', sq)).slice(1));
      add([lit(sym('S', sq), !ps.includes('stench'))], 'percept at ' + pretty(sym('S', sq)).slice(1));
      add([lit(sym('P', sq), true)], 'visited ' + pretty(sym('P', sq)).slice(1) + ': no pit');
      add([lit(sym('W', sq), true)], 'visited ' + pretty(sym('W', sq)).slice(1) + ': no Wumpus');
    }
    // exactly one Wumpus, over frontier squares plus "elsewhere"
    const wSyms = [...frontier].map((k) => sym('W', sqOf(k)));
    if (dead) { for (const w of wSyms) add([lit(w, true)], 'Scream: the Wumpus is dead'); }
    else {
      const all = wSyms.concat(['Wx']);
      add(all.map((w) => lit(w)), 'there is a Wumpus somewhere');
      for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) add([lit(all[i], true), lit(all[j], true)], 'at most one Wumpus');
    }
    const symbols = [...new Set(clauses.flatMap((c) => c.map((l) => l.s)))].sort();
    return { clauses, symbols, why, frontier: [...frontier].map(sqOf) };
  }

  // ---- sentences (the KB panel's shapes) → CNF of α and of ¬α ----
  // {kind: noPit|noW|safe|pit|wumpus|pitOr|wOr, squares}
  function sentenceClauses(s) { // α as CNF
    const P = (q) => sym('P', q), W = (q) => sym('W', q);
    switch (s.kind) {
      case 'noPit': return [[lit(P(s.squares[0]), true)]];
      case 'noW': return [[lit(W(s.squares[0]), true)]];
      case 'safe': return [[lit(P(s.squares[0]), true)], [lit(W(s.squares[0]), true)]];
      case 'pit': return [[lit(P(s.squares[0]))]];
      case 'wumpus': return [[lit(W(s.squares[0]))]];
      case 'pitOr': return [s.squares.map((q) => lit(P(q)))];
      case 'wOr': return [s.squares.map((q) => lit(W(q)))];
    }
    return [];
  }
  function negatedClauses(s) { // ¬α as CNF
    const P = (q) => sym('P', q), W = (q) => sym('W', q);
    switch (s.kind) {
      case 'noPit': return [[lit(P(s.squares[0]))]];
      case 'noW': return [[lit(W(s.squares[0]))]];
      case 'safe': return [[lit(P(s.squares[0])), lit(W(s.squares[0]))]];            // ¬(¬P ∧ ¬W) = P ∨ W
      case 'pit': return [[lit(P(s.squares[0]), true)]];
      case 'wumpus': return [[lit(W(s.squares[0]), true)]];
      case 'pitOr': return s.squares.map((q) => [lit(P(q), true)]);                 // ¬(P1 ∨ P2) = ¬P1 ∧ ¬P2
      case 'wOr': return s.squares.map((q) => [lit(W(q), true)]);
    }
    return [];
  }
  const sentenceText = (s) => sentenceClauses(s).map((c) => (c.length > 1 ? '(' + clauseText(c) + ')' : clauseText(c))).join(' ∧ ');

  // ---- truth-table model checking ----
  // Enumerates every assignment over the KB's symbols (with early pruning of assignments that already falsify a clause).
  // Returns {entailed, modelsOfKB, modelsWhereAlphaFalse, counterexample}.  A counterexample is a model of KB in which α is false.
  function ttEntails(kb, alphaClauses, limit) {
    const symbols = [...new Set(kb.symbols.concat(alphaClauses.flatMap((c) => c.map((l) => l.s))))];
    const idx = new Map(symbols.map((s, i) => [s, i]));
    const clauses = kb.clauses.map((c) => c.map((l) => ({ i: idx.get(l.s), neg: l.neg })));
    const alpha = alphaClauses.map((c) => c.map((l) => ({ i: idx.get(l.s), neg: l.neg })));
    // order symbols so that unit facts come first: they prune most
    const model = new Array(symbols.length).fill(null);
    let modelsOfKB = 0, bad = 0, counterexample = null, visitedNodes = 0;
    const maxNodes = limit || 4000000;
    const clauseOk = (c) => { let undecided = false; for (const l of c) { const v = model[l.i]; if (v === null) undecided = true; else if (v !== l.neg) return true; } return undecided ? null : false; }; // true satisfied, false violated, null open
    function rec(i) {
      if (++visitedNodes > maxNodes) throw new Error('too-large');
      for (const c of clauses) if (clauseOk(c) === false) return; // prune: this partial assignment already falsifies KB
      if (i === symbols.length) {
        modelsOfKB++;
        const alphaHolds = alpha.every((c) => clauseOk(c) === true);
        if (!alphaHolds) { bad++; if (!counterexample) counterexample = symbols.map((s, j) => [s, model[j]]).filter(([, v]) => v).map(([s]) => s); }
        return;
      }
      model[i] = false; rec(i + 1); model[i] = true; rec(i + 1); model[i] = null;
    }
    try { rec(0); } catch (e) { return { entailed: null, error: 'too many symbols for a truth table (' + symbols.length + ')', symbols: symbols.length }; }
    return { entailed: bad === 0 && modelsOfKB > 0, modelsOfKB, modelsWhereAlphaFalse: bad, counterexample, symbols: symbols.length, nodes: visitedNodes, kbConsistent: modelsOfKB > 0 };
  }

  // ---- resolution refutation ----
  // Add ¬α to the KB, resolve pairs until the empty clause appears. Set-of-support: every resolvent has an ancestor in ¬α,
  // which keeps the search focused and gives a readable proof. Returns {proved, steps:[{n, clause, from:[a,b]|null, label}]}.
  function resolutionProof(kb, negAlpha, maxSteps) {
    maxSteps = maxSteps || 4000;
    const steps = []; const byKey = new Map();
    const push = (c, from, label, sos) => { const k = clauseKey(c); if (byKey.has(k)) return byKey.get(k); const st = { n: steps.length + 1, clause: c, from, label, sos: !!sos }; steps.push(st); byKey.set(k, st); return st; };
    for (const c of kb.clauses) push(c, null, kb.why.get(clauseKey(c)) || 'KB', false);
    for (const c of negAlpha) push(normalise(c) || c, null, 'negated goal (¬α)', true);
    const resolve = (a, b) => { // all resolvents of two clauses on one complementary literal
      const out = [];
      for (const la of a.clause) for (const lb of b.clause) if (la.s === lb.s && la.neg !== lb.neg) {
        const r = normalise(a.clause.filter((x) => x !== la).concat(b.clause.filter((x) => x !== lb)));
        if (r) out.push(r);
      }
      return out;
    };
    // set-of-support with UNIT PREFERENCE: always expand the shortest unexpanded support clause first
    // (a unit clause resolves away a literal for good — this is why the search reaches the empty clause fast)
    const pending = steps.filter((st) => st.sos); const expanded = new Set();
    while (pending.length && steps.length < maxSteps) {
      pending.sort((x, y) => x.clause.length - y.clause.length || x.n - y.n);
      const a = pending.shift(); if (expanded.has(a.n)) continue; expanded.add(a.n);
      const others = steps.slice().sort((x, y) => x.clause.length - y.clause.length);
      for (const b of others) {
        if (a === b) continue;
        for (const r of resolve(a, b)) {
          if (byKey.has(clauseKey(r))) continue;
          const st = push(r, [a.n, b.n], 'resolve ' + a.n + ' with ' + b.n, true);
          if (!r.length) return { proved: true, steps: proofTrace(steps, st) };
          pending.push(st);
          if (steps.length >= maxSteps) break;
        }
        if (steps.length >= maxSteps) break;
      }
    }
    return { proved: false, steps: [], searched: steps.length };
  }
  // keep only the steps that the empty clause actually depends on, renumbered
  function proofTrace(steps, last) {
    const need = new Set(); const stack = [last];
    while (stack.length) { const s = stack.pop(); if (need.has(s.n)) continue; need.add(s.n); if (s.from) for (const p of s.from) stack.push(steps[p - 1]); }
    const kept = steps.filter((s) => need.has(s.n)); const map = new Map(kept.map((s, i) => [s.n, i + 1]));
    return kept.map((s) => ({ n: map.get(s.n), text: clauseText(s.clause), from: s.from ? s.from.map((p) => map.get(p)) : null, label: s.from ? 'resolve ' + map.get(s.from[0]) + ' with ' + map.get(s.from[1]) : s.label }));
  }

  // ---- convenience: ask the KB about a sentence with both procedures ----
  function ask(history, sentence, opts) {
    opts = opts || {};
    const kb = buildKB(history, sentence.squares, opts.size);
    const tt = ttEntails(kb, sentenceClauses(sentence), opts.ttLimit);
    const res = tt.entailed === false ? { proved: false, skipped: 'not entailed' } : resolutionProof(kb, negatedClauses(sentence), opts.maxSteps);
    let status = tt.entailed === true ? 'entailed' : 'open';
    if (tt.entailed === false) { // refuted if ¬α is entailed
      const tt2 = ttEntails(kb, negatedClauses(sentence), opts.ttLimit);
      if (tt2.entailed === true) status = 'refuted';
    }
    if (tt.entailed === null) status = res.proved ? 'entailed' : 'unknown';
    return { status, tt, resolution: res, kb };
  }
  // are these sentences jointly consistent with the KB?  → {consistent, culprits:[indices]} (minimal set found by dropping one at a time)
  function consistent(history, sentences, opts) {
    const kb = buildKB(history, sentences.flatMap((s) => s.squares), (opts || {}).size);
    const withAll = { clauses: kb.clauses.concat(sentences.flatMap(sentenceClauses)), symbols: kb.symbols, why: kb.why };
    const tt = ttEntails(withAll, [], (opts || {}).ttLimit);
    if (tt.entailed === null) return { consistent: null };
    if (tt.modelsOfKB > 0) return { consistent: true };
    const culprits = [];
    for (let i = 0; i < sentences.length; i++) {
      const rest = sentences.filter((_, j) => j !== i);
      const kb2 = { clauses: kb.clauses.concat(rest.flatMap(sentenceClauses)), symbols: kb.symbols, why: kb.why };
      if (ttEntails(kb2, [], (opts || {}).ttLimit).modelsOfKB > 0) culprits.push(i);
    }
    return { consistent: false, culprits };
  }

  return { buildKB, sentenceClauses, negatedClauses, sentenceText, clauseText, ttEntails, resolutionProof, ask, consistent, pretty };
});
