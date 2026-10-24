/* Wumpus Justify — core engine + local rule-engine judge.
 * Works in the browser (window.WumpusCore) and in Node (module.exports).
 * DESIGN.md §3 (mechanics), §5.4 (local judge). No hidden-world knowledge ever
 * enters the judge: localJudge() receives only what the LLM judge receives.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WumpusCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ───────────────────────────── worlds ─────────────────────────────
  const WORLDS = {
    canonical: {
      id: 'canonical', name: 'Canonical', blurb: 'Matches Module 3 slide 5. Use this in class.',
      size: 4, start: [1, 1], wumpus: [1, 3], pits: [[3, 4], [3, 1]], gold: [4, 1],
    },
    fork: {
      id: 'fork', name: 'Fork', blurb: 'Two breezes, one shared candidate. Nothing past row 2 is provable until you commit.',
      size: 4, start: [1, 1], wumpus: [3, 3], pits: [[3, 1], [1, 3]], gold: [4, 2],
    },
    cruel: {
      id: 'cruel', name: 'Cruel', blurb: 'The gold sits next to the Wumpus. Shoot, or accept a known risk.',
      size: 4, start: [1, 1], wumpus: [3, 3], pits: [[2, 2], [2, 4]], gold: [4, 3],
    },
  };

  const eq = (a, b) => !!a && !!b && a[0] === b[0] && a[1] === b[1];
  const key = (sq) => sq[0] + ',' + sq[1];
  const parseKey = (k) => k.split(',').map(Number);

  // The single adjacency function for the whole game. 4-directional, never diagonal.
  function neighbours(sq, size) {
    size = size || 4;
    const c = sq[0], r = sq[1];
    return [[c + 1, r], [c - 1, r], [c, r + 1], [c, r - 1]]
      .filter((n) => n[0] >= 1 && n[0] <= size && n[1] >= 1 && n[1] <= size);
  }
  const adjacent = (a, b) => neighbours(a).some((n) => eq(n, b));

  function perceptsAt(sq, w, wumpusAlive) {
    const adj = neighbours(sq, w.size);
    const p = [];
    if (adj.some((n) => eq(n, w.wumpus))) p.push('stench'); // stench persists even if dead (AIMA)
    if (adj.some((n) => w.pits.some((pit) => eq(pit, n)))) p.push('breeze');
    if (eq(sq, w.gold)) p.push('glitter');
    return p;
  }

  // Deterministic PRNG so ?seed=1234 gives the whole class one world.
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function reachable(w) {
    // gold reachable from start without stepping on a pit or the wumpus
    const bad = (s) => eq(s, w.wumpus) || w.pits.some((p) => eq(p, s));
    const seen = new Set([key(w.start)]);
    const q = [w.start];
    while (q.length) {
      const s = q.shift();
      if (eq(s, w.gold)) return true;
      for (const n of neighbours(s, w.size)) {
        if (bad(n) || seen.has(key(n))) continue;
        seen.add(key(n)); q.push(n);
      }
    }
    return false;
  }

  function randomWorld(seed) {
    const rnd = mulberry32(Number(seed) || 1);
    const size = 4;
    const start = [1, 1];
    const forbidden = [start].concat(neighbours(start, size)).map(key); // fairness: start + its neighbours are clean
    const all = [];
    for (let c = 1; c <= size; c++) for (let r = 1; r <= size; r++) if (!forbidden.includes(key([c, r]))) all.push([c, r]);
    for (let attempt = 0; attempt < 500; attempt++) {
      const pool = all.slice();
      const pick = () => pool.splice(Math.floor(rnd() * pool.length), 1)[0];
      const wumpus = pick();
      const nPits = 1 + Math.floor(rnd() * 3); // 1–3
      const pits = [];
      for (let i = 0; i < nPits; i++) pits.push(pick());
      const goldPool = all.filter((s) => !eq(s, wumpus) && !pits.some((p) => eq(p, s)));
      const gold = goldPool[Math.floor(rnd() * goldPool.length)];
      const w = { id: 'random', name: 'Random #' + seed, blurb: 'Seeded world ' + seed + '. Everyone with this seed gets the same cave.', size, start, wumpus, pits, gold };
      if (perceptsAt(start, w).length === 0 && reachable(w)) return w;
    }
    return Object.assign({}, WORLDS.canonical, { id: 'random', name: 'Random #' + seed + ' (fallback)' });
  }

  function getWorld(id, seed) {
    if (id === 'random') return randomWorld(seed == null ? 1234 : seed);
    return WORLDS[id] || WORLDS.canonical;
  }

  // ───────────────────────────── knowledge ─────────────────────────────
  // What a student can PROVE from their percept history alone. Never sees the world.
  // history: [{square:[c,r], percepts:[...]}], visited: [[c,r]...]
  function knowledge(history, visited, size) {
    size = size || 4;
    const K = {};
    for (let c = 1; c <= size; c++) for (let r = 1; r <= size; r++) K[key([c, r])] = { pit: 'maybe', wumpus: 'maybe', visited: false };
    const vis = (visited || []).concat(history.map((h) => h.square));
    for (const v of vis) { const k = key(v); if (K[k]) { K[k].visited = true; K[k].pit = 'no'; K[k].wumpus = 'no'; } }
    const dead = history.some((h) => (h.percepts || []).includes('scream'));
    if (dead) for (const k in K) K[k].wumpus = 'no';

    // absence of a percept clears every neighbour
    for (const h of history) {
      const ps = h.percepts || [];
      const known = h.known || ['breeze', 'stench']; // a real percept record knows every percept; a cited-only record knows only what was cited
      const adj = neighbours(h.square, size);
      if (known.includes('breeze') && !ps.includes('breeze')) for (const n of adj) K[key(n)].pit = 'no';
      if (known.includes('stench') && !ps.includes('stench')) for (const n of adj) if (!dead) K[key(n)].wumpus = 'no';
    }
    // unit propagation on presence
    let changed = true, guard = 0;
    while (changed && guard++ < 20) {
      changed = false;
      for (const h of history) {
        const ps = h.percepts || [];
        const adj = neighbours(h.square, size);
        if (ps.includes('breeze')) {
          const cands = adj.filter((n) => K[key(n)].pit !== 'no');
          if (cands.length === 1 && K[key(cands[0])].pit !== 'yes') { K[key(cands[0])].pit = 'yes'; changed = true; }
        }
      }
      if (!dead) {
        // single wumpus: intersection of all stench neighbourhoods
        const stenches = history.filter((h) => (h.percepts || []).includes('stench'));
        if (stenches.length) {
          let inter = null;
          for (const h of stenches) {
            const set = new Set(neighbours(h.square, size).filter((n) => K[key(n)].wumpus !== 'no').map(key));
            inter = inter === null ? set : new Set([...inter].filter((k) => set.has(k)));
          }
          for (const k in K) if (K[k].wumpus !== 'no' && !inter.has(k) && !K[k].visited) {
            // a square outside the intersection cannot be the (single) wumpus
            if (K[k].wumpus !== 'no') { K[k].wumpus = 'no'; changed = true; }
          }
          if (inter.size === 1) { const only = [...inter][0]; if (K[only].wumpus !== 'yes') { K[only].wumpus = 'yes'; changed = true; } }
        }
      }
    }
    for (const k in K) K[k].safe = K[k].pit === 'no' && K[k].wumpus === 'no';
    return K;
  }

  // ───────────────────────────── local judge ─────────────────────────────
  const PERCEPT_WORDS = {
    breeze: ['breeze', 'breezy', 'breez', 'wind', 'windy', 'draft', 'draught', 'air'],
    stench: ['stench', 'smell', 'smelly', 'stink', 'stinky', 'odour', 'odor', 'scent', 'smelt', 'smelled', 'stenchy'],
    glitter: ['glitter', 'glittering', 'shine', 'shining', 'sparkle'],
  };
  // Words students use for "a percept in general". Negated ⇒ nothing sensed; affirmed alone ⇒ not specific enough to count.
  const GENERIC = ['perception', 'perceptions', 'percept', 'percepts', 'input', 'inputs', 'signal', 'signals', 'sensation', 'sensations', 'observation', 'observations', 'reading', 'readings', 'clue', 'clues', 'hint', 'hints', 'indication', 'indications', 'sign', 'signs', 'feeling', 'feelings', 'sense', 'senses', 'warning', 'warnings', 'alert', 'alerts', 'danger', 'dangers', 'threat', 'threats'];
  const NEG = ['no', 'not', 'nt', 'never', 'without', 'neither', 'nor', 'zero', 'illa', 'illaa', 'nothing', 'than', 'instead', 'cannot', 'cant', 'didnt', 'dont', 'doesnt', 'wasnt', 'isnt', 'absent', 'free'];
  const NOTHING = /\b(nothing|no percepts?|no sense|nothing at all|onnum illa|onnum illaa|felt none|sensed none|no signals?|no signs?|clean|empty|quiet|calm|all clear|nil|none|blank|null|zero|no input|no data|not (feel|felt|sense|sensed|get|got|notice|noticed|observe|observed) (any|anything|something)|did nt (feel|sense|get|notice|observe|have|perceive|receive)|do nt (feel|sense|get|notice|observe|have|perceive)|(felt|sensed|got|noticed|observed|perceived|received|had|have) nothing|no perception|not perceive|nothing (felt|sensed|there|here|found|observed|perceived))\b/;
  const HEDGE = ['might', 'may', 'could', 'possibly', 'probably', 'maybe', 'perhaps', 'chance', 'chances', 'risk', 'risky', 'risking', 'unsure', 'uncertain', 'doubt', 'doubtful', 'gamble', 'gambling', 'likely', 'unlikely', 'suspect', 'suspicious', 'dangerous', 'danger', 'kill', 'die', 'possible', 'should', 'hopefully', 'hope', 'guess', 'worst', 'bet', 'try', 'trying', 'seems', 'seem'];
  const HEDGE_PHRASES = [/not sure/, /cannot tell/, /can't tell/, /cant tell/, /don't know/, /dont know/, /no idea/, /not certain/, /can't be sure/, /cannot be sure/, /cant be sure/, /may be/, /accept the risk/, /taking a risk/, /take the risk/, /no other (option|choice|way)/, /only (option|choice|way)/, /50\s*%/, /half/]; // "i think" is register, not a logical hedge (bench L2)
  const ABS_PHRASES = [/no chance/, /no risk/, /zero risk/, /zero chance/, /no way/, /no doubt/, /for sure/, /100\s*%/, /without doubt/, /guaranteed/, /must be safe/, /has to be safe/, /no danger/];
  const ABS = ['definitely', 'certainly', 'surely', 'sure', 'certain', 'completely', 'totally', 'absolutely', 'obviously', 'clearly', 'guaranteed', 'confident', 'confirmed', 'proved', 'proven', 'must', 'always', 'fully', 'perfectly', 'ensured', 'ensure'];
  const SAFE_WORDS = ['safe', 'ok', 'okay', 'fine', 'clear', 'harmless', 'secure', 'safely'];
  const ELIM_WORDS = ['safe', 'started', 'start', 'starting', 'already', 'went', 'walked', 'visited', 'know', 'known', 'been', 'came', 'came from', 'was there', 'stood', 'standing', 'ruled', 'eliminated', 'exclude', 'excluded', 'survived', 'alive', 'nothing happened'];

  function normText(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[’‘`]/g, "'")
      .replace(/n't\b/g, ' nt')
      .replace(/'/g, '')
      .replace(/[→⇒]/g, ' so ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Replace coordinates with tokens q{c}{r}; also map here/start/target words later.
  function tokeniseSquares(text) {
    // [1,1] (1,1) 1,1 1.1 "1 , 1" "square 1 1"
    return text
      .replace(/[\[\(]\s*([1-4])\s*[,\.\s]{1,3}\s*([1-4])\s*[\]\)]/g, ' q$1$2 ')
      .replace(/\b([1-4])\s*[,\.]{1,2}\s*([1-4])\b/g, ' q$1$2 ')
      .replace(/\b(square|cell|room|box)\s+([1-4])\s+([1-4])\b/g, ' q$2$3 ')
      .replace(/\b(row|col|column)\s+[1-4]\b/g, ' $1x ');
  }

  const W_eq = eq;
  function localJudge(req) {
    const history = req.percept_history || [];
    const visited = req.visited || history.map((h) => h.square);
    const target = req.target_square;
    const current = req.current_square || (history.length ? history[history.length - 1].square : [1, 1]);
    const start = req.start_square || [1, 1];
    const action = req.action || 'move';
    const moveNumber = req.move_number || 1;
    const rawText = String(req.justification || '');
    const K = knowledge(history, visited);
    const histBy = {};
    for (const h of history) histBy[key(h.square)] = h.percepts || [];
    const distinctVisited = new Set(visited.map(key)).size;
    const r3Applicable = distinctVisited >= 2 && moveNumber > 1;

    // ---------- parse ----------
    let text = tokeniseSquares(normText(rawText));
    if (distinctVisited === 1 && !/\bq[1-4][1-4]\b/.test(text)) {
      // students sometimes number squares 1, 2, 3…: with one square visited, "1" is the start and "2" is the target
      text = text.replace(/\b(at|on|in|from|square|cell|room|position)\s+1\b/g, ' $1 q' + current[0] + current[1] + ' ')
        .replace(/\b(to|towards|into|square|cell|room)\s+2\b/g, target ? ' $1 q' + target[0] + target[1] + ' ' : ' $1 2 ');
    }
    text = text.replace(/[^a-z0-9%\s\.\;\!\?\,]/g, ' ');
    const sentences = text.split(/[\.\;\!\?\n]+/).map((s) => s.trim()).filter(Boolean);
    const observations = []; // {sq, percept, present, sentenceIdx}
    const mentionedSquares = new Set();
    const invented = [];
    let ruleOnly = false;
    let vagueGeneric = false; // "there was a signal" — a percept word with no percept
    let carry = null; // last observation square, carried across sentences

    const squareOfToken = (tok) => (/^q[1-4][1-4]$/.test(tok) ? [Number(tok[1]), Number(tok[2])] : null);

    function resolveSquare(clauseTokens, prevClauseSq, nextClauseSq) {
      for (const t of clauseTokens) { const s = squareOfToken(t); if (s) return s; }
      const joined = clauseTokens.join(' ');
      if (/\b(here|this square|current|where i am|i am standing|standing|my square|present square)\b/.test(joined)) return current;
      if (/\b(start|starting|beginning|first square)\b/.test(joined)) return start;
      if (prevClauseSq) return prevClauseSq;
      if (nextClauseSq) return nextClauseSq;
      if (carry) return carry;
      if (/\b(i (felt|feel|sensed|sense|smelt|smelled|smell|heard|hear|noticed|notice|got|get|found|find|detected|detect|had|have|perceived|perceive|received|receive)|there (was|is|were)|felt|sensed|detected|perceived)\b/.test(joined)) return current;
      if (distinctVisited === 1) return current; // only one square has ever been sensed: "no perception on 1" can only mean it
      return null;
    }

    sentences.forEach((sentence, si) => {
      const clauses = sentence.split(/\s*,\s*|\b(?:so|but|because|therefore|hence|and|since|then|which|while|whereas|also|thus)\b/).map((c) => c.trim()).filter(Boolean);
      const clauseTokens = clauses.map((c) => c.split(/\s+/));
      const clauseSq = clauseTokens.map((toks) => { for (const t of toks) { const s = squareOfToken(t); if (s) return s; } return null; });
      clauseTokens.forEach((toks, ci) => {
        for (const t of toks) { const s = squareOfToken(t); if (s) mentionedSquares.add(key(s)); }
        const joined = toks.join(' ');
        // rule restatement: "breeze means a pit is adjacent" without a square → not an observation
        const isRule = !clauseSq[ci] && /\b(breeze|stench|smell|glitter)\w*\s+(means|mean|implies|imply|indicates|indicate|tells|tell|shows|show|is the rule|rule)\b/.test(joined);
        if (isRule) { ruleOnly = true; return; }
        // find percept mentions
        const found = [];
        toks.forEach((tok, i) => {
          for (const p in PERCEPT_WORDS) {
            if (PERCEPT_WORDS[p].includes(tok)) {
              // negation within 4 tokens back, not crossing another percept word
              let neg = false;
              for (let j = i - 1; j >= Math.max(0, i - 4); j--) {
                const bt = toks[j];
                if (Object.values(PERCEPT_WORDS).some((arr) => arr.includes(bt))) {
                  // "no breeze or stench": inherit the previous percept's negation when joined by or/and/nor
                  const between = toks.slice(j + 1, i);
                  if (between.every((b) => ['or', 'and', 'nor', 'a', 'any', 'the'].includes(b)) && found.length) neg = !found[found.length - 1].present;
                  break;
                }
                if (NEG.includes(bt)) { neg = true; break; }
              }
              // "breeze-free", "smell illa" (postfix negation, Malayalam)
              if (!neg && i + 2 < toks.length + 1) {
                const after = toks.slice(i + 1, i + 4).join(' ');
                if (/^(illa|illaa|free|absent|onnum illa|um illa|is not|was not|not|nt)\b/.test(after) || /\b(illa|um illa)\b/.test(after)) neg = true;
              }
              found.push({ percept: p, present: !neg });
            }
          }
        });
        let genericNeg = false, genericPos = false;
        if (!found.length) toks.forEach((tok, i) => {
          if (!GENERIC.includes(tok)) return;
          let neg = false;
          for (let j = i - 1; j >= Math.max(0, i - 4); j--) if (NEG.includes(toks[j]) || toks[j] === 'any') { neg = NEG.includes(toks[j]) || neg; }
          if (neg || /\b(illa|nil|none|absent|zero)\b/.test(toks.slice(i + 1, i + 3).join(' '))) genericNeg = true; else genericPos = true;
        });
        if ((NOTHING.test(joined) || genericNeg) && !found.length) {
          found.push({ percept: 'breeze', present: false }, { percept: 'stench', present: false });
        }
        if (genericPos && !found.length) vagueGeneric = true;
        if (!found.length) return;
        const sq = resolveSquare(toks, ci > 0 ? clauseSq[ci - 1] : null, ci + 1 < clauses.length ? clauseSq[ci + 1] : null);
        if (!sq) return;
        // Percept words describing the TARGET (prediction, not observation) are ignored
        if (target && eq(sq, target) && !histBy[key(sq)]) return;
        for (const f of found) {
          if (!observations.some((o) => W_eq(o.sq, sq) && o.percept === f.percept && o.present === f.present)) observations.push({ sq, percept: f.percept, present: f.present, si });
          carry = sq;
        }
      });
    });

    // ---------- truthfulness ----------
    const cited = []; // true observations
    for (const o of observations) {
      const hp = histBy[key(o.sq)];
      if (!hp) { invented.push(o); continue; }
      const actually = hp.includes(o.percept);
      if (actually === o.present) cited.push(o); else invented.push(o);
    }
    const citedSquares = [...new Set(cited.map((o) => key(o.sq)))];
    const R1 = cited.length > 0 && invented.length === 0 ? 1 : 0;

    // ---------- claim about the target ----------
    const tKey = target ? key(target) : null;
    const tTok = target ? 'q' + target[0] + target[1] : null;
    const targetSentences = sentences.filter((s) => tTok && s.includes(tTok));
    const splitClauses = (sen) => sen.split(/\s*,\s*|\b(?:so|but|because|therefore|hence|and|since|then|which|while|whereas|also|thus)\b/).map((c) => c.trim()).filter(Boolean);
    const claimClauses = [];
    for (const sen of targetSentences) for (const cl of splitClauses(sen)) {
      const sqs = cl.match(/\bq[1-4][1-4]\b/g) || [];
      if (cl.includes(tTok) || sqs.length === 0) claimClauses.push(cl); // the target's own clause, or a pronoun clause ("it", "there")
    }
    const lastSen = sentences.slice(-1).join(' ');
    if (lastSen && !claimClauses.includes(lastSen)) for (const cl of splitClauses(lastSen)) { const sqs = cl.match(/\bq[1-4][1-4]\b/g) || []; if (!tTok || cl.includes(tTok) || sqs.length === 0) claimClauses.push(cl); }
    const claimText = (claimClauses.length ? claimClauses : sentences.slice(-1)).join(' . ');
    const lastSentence = sentences.slice(-1).join(' ');
    const allText = sentences.join(' . ');

    function negatedWord(str, word) {
      const re = new RegExp('((?:\\S+\\s+){0,4})\\b' + word + '\\b', 'g');
      let m, any = false, negated = false;
      while ((m = re.exec(str))) {
        any = true;
        const before = m[1].split(/\s+/);
        if (before.some((b) => ['not', 'nt', 'never', 'no', 'un' + word, 'isnt', 'wasnt', 'cannot', 'cant', 'wont', 'dont'].includes(b))) negated = true;
      }
      return any ? (negated ? 'neg' : 'pos') : null;
    }
    const safeStatus = SAFE_WORDS.map((w) => negatedWord(claimText, w)).filter(Boolean);
    const claimsSafe = safeStatus.includes('pos') && !safeStatus.includes('neg') && !/\bunsafe\b/.test(claimText);
    const claimsPitFree = /\b(no|not|nt|never|zero|illa|cannot|cant|free of|isnt|wont)\b[^\.]{0,25}\b(pit|pits|hole)\b/.test(claimText) || /\bpit\w*\s+(um\s+)?(illa|free|absent)\b/.test(claimText) || /\bpit\w*\s+(is|are|was)\s+not\b/.test(claimText) || /\bnot\s+(a|the)\s+pit\b/.test(claimText);
    const claimsWumpusFree = /\b(no|not|nt|never|zero|illa|cannot|cant|free of|isnt|wont)\b[^\.]{0,25}\b(wumpus|monster|beast)\b/.test(claimText) || /\bwumpus\w*\s+(um\s+)?(illa|free|absent)\b/.test(claimText) || /\bwumpus\s+(is|are|was)\s+not\b/.test(claimText);
    const claimsWumpusHere = action === 'shoot' && !!tTok && (new RegExp('\\bwumpus\\b[^\\.]{0,30}\\b(in|at|is|inside)\\s+(the\\s+)?' + tTok + '\\b').test(allText) || new RegExp('\\b' + tTok + '\\b[^\\.]{0,20}\\b(is|has|holds|contains|must be)\\b[^\\.]{0,12}\\bwumpus\\b').test(allText));
    const fullySafe = claimsSafe || (claimsPitFree && claimsWumpusFree);

    // certainty language (target sentences, else last sentence)
    let certText = claimText;
    let absCount = 0, hedgeCount = 0;
    for (const re of ABS_PHRASES) if (re.test(certText)) { absCount++; certText = certText.replace(re, ' '); }
    for (const re of HEDGE_PHRASES) if (re.test(certText)) { hedgeCount++; certText = certText.replace(re, ' '); }
    const certToks = certText.split(/\s+/);
    for (const t of certToks) { if (ABS.includes(t)) absCount++; if (HEDGE.includes(t)) hedgeCount++; }
    // "i think" is a register hedge, not a logical one (bench L2)
    const hedged = hedgeCount > absCount;

    // diagonal / adjacency errors
    const diagBad = /\bdiagonal/.test(allText) && !/\b(not|never|no|isnt|nt)\s+(\w+\s+){0,2}diagonal/.test(allText) && !/\bdiagonal\w*\s+(is|are|does|dont|do)\s+not\b/.test(allText) && !/\b(no|never|not)\s+diagonal/.test(allText);
    let adjBad = false;
    for (const mk of mentionedSquares) {
      const sq = parseKey(mk);
      if (K[mk] && K[mk].visited) continue;
      if (target && eq(sq, target)) continue;
      if (eq(sq, current)) continue;
      if (!cited.some((o) => adjacent(o.sq, sq)) && !invented.some((o) => adjacent(o.sq, sq))) adjBad = true;
    }

    // ---------- R2 ----------
    const citedHistory = [];
    const bySq = {};
    for (const o of cited) { (bySq[key(o.sq)] = bySq[key(o.sq)] || []).push(o); }
    for (const k in bySq) {
      // build a partial percept record: present percepts as cited; absent ones only if cited absent
      const sq = parseKey(k);
      const ps = [], known = [];
      const actual = histBy[k];
      for (const p of ['breeze', 'stench', 'glitter', 'scream']) {
        const citedP = bySq[k].find((o) => o.percept === p);
        if (citedP) { known.push(p); if (citedP.present) ps.push(p); }
        else if (actual.includes(p)) { ps.push(p); known.push(p); } // not cited but really there → stays present (no credit for ignoring it)
      }
      // an uncited ABSENCE stays unknown: the student gets no inference they did not state
      citedHistory.push({ square: sq, percepts: ps, known });
    }
    // squares never cited contribute only "visited ⇒ safe", not their percepts
    const CK = knowledge(citedHistory, visited);
    const ct = tKey ? CK[tKey] : null;
    const bears = !!target && (cited.some((o) => adjacent(o.sq, target)) || (K[tKey] && K[tKey].visited) || mentionedSquares.has(tKey));
    let R2 = 0, r2why = '';
    if (R1) {
      if (diagBad || adjBad) { R2 = 0; r2why = 'adjacency'; }
      else if (action === 'shoot' || claimsWumpusHere) {
        const cand = ct && ct.wumpus !== 'no' && cited.some((o) => o.percept === 'stench' && o.present && adjacent(o.sq, target));
        R2 = cand ? 1 : 0; r2why = cand ? '' : 'wumpus-not-candidate';
      } else if (fullySafe || claimsPitFree || claimsWumpusFree) {
        const relevant = fullySafe ? ['breeze', 'stench'] : claimsPitFree ? ['breeze'] : ['stench'];
        const candidateFrom = cited.find((o) => o.present && relevant.includes(o.percept) && adjacent(o.sq, target) && ct && (o.percept === 'breeze' ? ct.pit !== 'no' : ct.wumpus !== 'no'));
        // candidate-elimination argument (bench C1): "breeze at X ⇒ pit in N(X); target ∉ N(X); candidates named" handles that danger for a non-adjacent target
        const elim = (p) => cited.some((o) => o.present && o.percept === p && !adjacent(o.sq, target) && neighbours(o.sq).some((n) => mentionedSquares.has(key(n)) && !K[key(n)].visited));
        const pitOK = !!ct && (ct.pit === 'no' || elim('breeze'));
        const wOK = !!ct && (ct.wumpus === 'no' || elim('stench'));
        if (candidateFrom) { R2 = 0; r2why = 'candidate:' + candidateFrom.percept + '@' + key(candidateFrom.sq); }
        else if (fullySafe) {
          if (pitOK && wOK) R2 = 1;
          else { R2 = 0; r2why = pitOK ? 'pit-only' : wOK ? 'wumpus-only' : 'no-reach'; }
        } else if (claimsPitFree) { R2 = pitOK ? 1 : 0; r2why = R2 ? '' : 'no-reach'; }
        else { R2 = wOK ? 1 : 0; r2why = R2 ? '' : 'no-reach'; }
      } else { R2 = bears ? 1 : 0; r2why = bears ? '' : 'no-reach'; }
    }

    // ---------- R3 ----------
    let R3 = null;
    if (r3Applicable) {
      const elim = [...mentionedSquares].some((mk) => K[mk] && K[mk].visited && !citedSquares.includes(mk) && ELIM_WORDS.some((w) => allText.includes(w)))
        || (/\b(start|started|starting|already|went|walked|visited|been|came|survived|nothing happened)\b/.test(allText) && citedSquares.length >= 1 && distinctVisited >= 2 && [...mentionedSquares].some((mk) => K[mk] && K[mk].visited && mk !== citedSquares[0]));
      R3 = R1 && (citedSquares.length >= 2 || (citedSquares.length >= 1 && elim)) ? 1 : 0;
    }

    // ---------- R4 ----------
    let R4 = 0;
    let proved = false;
    if (target) {
      if (action === 'shoot' || claimsWumpusHere) proved = K[tKey].wumpus === 'yes';
      else proved = K[tKey].safe;
    }
    if (R1) R4 = proved ? (hedged ? 0 : 1) : (hedged ? 1 : 0);

    // ignored percept at a cited square (O2): cited only absence at a square that also has a present percept
    let ignoredPercept = null;
    for (const k of citedSquares) {
      const actual = histBy[k];
      for (const p of ['breeze', 'stench']) if (actual.includes(p) && !cited.some((o) => key(o.sq) === k && o.percept === p)) ignoredPercept = { sq: parseKey(k), percept: p };
    }

    // ---------- flags ----------
    const flags_wrong = [];
    const flags = req.student_flags || {};
    for (const fk in flags) if (String(flags[fk]).toUpperCase() === 'SAFE' && K[fk] && !K[fk].safe) flags_wrong.push(fk);

    // ---------- totals / verdict ----------
    const scores = { R1, R2, R3, R4 };
    const dims = ['R1', 'R2', 'R3', 'R4'].filter((d) => scores[d] !== null);
    const total = dims.reduce((a, d) => a + scores[d], 0);
    const max = dims.length;
    let verdict;
    if (!cited.length && !invented.length) verdict = 'unsupported';
    else if (invented.length && !cited.length) verdict = 'unsound';
    else if (R1 === 0 || R2 === 0) verdict = 'unsound';
    else if (total === max) verdict = 'sound';
    else verdict = 'partial';

    // ---------- coaching ----------
    const fmt = (sq) => '[' + sq[0] + ',' + sq[1] + ']';
    // What exactly was missing for R3: name the candidates they listed and the visited square that eliminates one
    let r3Specific = '';
    if (R3 === 0 && R1) {
      const pres = cited.filter((o) => o.present && (o.percept === 'breeze' || o.percept === 'stench'));
      for (const o of pres) {
        const adj = neighbours(o.sq);
        const visAdj = adj.filter((n) => K[key(n)].visited && !citedSquares.includes(key(n)));
        const listed = adj.filter((n) => mentionedSquares.has(key(n)) && !K[key(n)].visited);
        if (visAdj.length) {
          const danger = o.percept === 'breeze' ? 'pit' : 'Wumpus';
          r3Specific = (listed.length ? 'You listed ' + listed.map(fmt).join(' and ') + ' as ' + danger + ' candidates but never said why ' + fmt(visAdj[0]) + ' is not one' : 'The ' + o.percept + ' at ' + fmt(o.sq) + ' also points at ' + fmt(visAdj[0]))
            + ' \u2014 you already stood there, so it is safe. Say that, and the ' + o.percept + ' narrows to ' + adj.filter((n) => !K[key(n)].visited).map(fmt).join(' or ') + '.';
          break;
        }
      }
      if (!r3Specific) {
        const unused = history.map((h) => h.square).filter((sq) => !citedSquares.includes(key(sq)) && !eq(sq, target));
        if (unused.length) {
          const bearing = unused.filter((sq) => target && adjacent(sq, target));
          const u0 = bearing[0] || unused[0];
          const hp = histBy[key(u0)] || [];
          const desc = hp.filter((p) => p !== 'scream').length ? 'felt ' + hp.filter((p) => p !== 'scream').join(' and ') : 'sensed nothing';
          r3Specific = bearing.length
            ? 'You used only ' + citedSquares.map((k) => fmt(parseKey(k))).join(' and ') + '. You also stood on ' + fmt(u0) + ' and ' + desc + ' there \u2014 it is next to ' + fmt(target) + ', so it says something about it. Use both.'
            : 'You used only ' + citedSquares.map((k) => fmt(parseKey(k))).join(' and ') + '. You also stood on ' + fmt(u0) + ' and ' + desc + ' there. It is not next to ' + fmt(target) + ' \u2014 say so ("the ' + (hp[0] || 'percept') + ' at ' + fmt(u0) + ' does not reach ' + fmt(target) + '") and you have combined both observations.';
        }
      }
      if (!r3Specific && target && K[tKey] && K[tKey].visited && !mentionedSquares.has(tKey)) r3Specific = 'Why is ' + fmt(target) + ' safe to go back to? Because you have already stood on it. Say so.';
    }
    const pick = (arr) => arr[Math.abs(hash(rawText)) % arr.length];
    let coaching = '';
    if (invented.length) {
      const o = invented[0];
      const hp = histBy[key(o.sq)];
      if (!hp) coaching = 'You cited ' + fmt(o.sq) + ', but you have never stood there. You can only reason from squares you have actually visited.';
      else if (o.present) coaching = 'You said there was a ' + o.percept + ' at ' + fmt(o.sq) + ' — there was not. Check your percept list before reasoning from it; an invented percept earns nothing.';
      else coaching = 'You said there was no ' + o.percept + ' at ' + fmt(o.sq) + ', but you did sense one there. Re-read what you actually perceived.';
    } else if (!cited.length) {
      coaching = vagueGeneric
        ? 'I can see you are describing what you sensed, but not which square or which percept. Say it like "no breeze, no stench at [1,1]" — name the square and the (missing) percept.'
        : ruleOnly
        ? pick(['You restated the rule, but you never applied it. Which square did you visit, and what did you sense there?', 'Rules alone prove nothing. Name a square you stood on and the percept (or its absence) you got there.'])
        : pick(['Name the square and what you sensed there. "It looks safe" is a guess, not a reason.', 'Where is your evidence? Start with "At [c,r] I sensed …" and build from that.', 'The judge scores reasons, not moves. Cite a percept at a square you have visited.', 'A feeling is not a percept. Which visited square, and what did you (not) sense there?']);
    } else if (diagBad) {
      coaching = 'Adjacent never means diagonal. A breeze or stench points only up, down, left or right — recount your candidate squares.';
    } else if (adjBad) {
      coaching = 'One of the squares you named is not adjacent to the square where you sensed the percept. Only up/down/left/right neighbours are candidates.';
    } else if (R2 === 0) {
      if (r2why === 'pit-only') coaching = pick(['No breeze rules out a pit — but not the Wumpus. Did you smell anything at that square?', 'You have handled the pit. What about the Wumpus? A square is only safe when BOTH are ruled out.']);
      else if (r2why === 'wumpus-only') coaching = pick(['No stench rules out the Wumpus — but not a pit. Was there a breeze?', 'Wumpus handled; pits not. Both dangers must be excluded before you may call it safe.']);
      else if (r2why.startsWith('candidate:')) { const [p, at] = r2why.slice(10).split('@'); coaching = 'A ' + p + ' at ' + fmt(parseKey(at)) + ' makes ' + fmt(target) + ' a ' + (p === 'breeze' ? 'pit' : 'Wumpus') + ' candidate — it is evidence of danger, not of safety.'; }
      else if (r2why === 'wumpus-not-candidate') coaching = 'Your stench evidence does not put the Wumpus in ' + fmt(target) + '. It must be adjacent to a square where you actually smelt it.';
      else if (ignoredPercept) coaching = 'You cited ' + fmt(ignoredPercept.sq) + ' but left out the ' + ignoredPercept.percept + ' you sensed there. Every percept counts, especially the ones that hurt your plan.';
      else coaching = pick(['Your evidence does not reach ' + fmt(target) + '. Which visited square is next to it, and what did you sense there?', 'The percept you cited says nothing about ' + fmt(target) + ' — it only constrains the neighbours of the square where you sensed it.']);
    } else if (R4 === 0 && !hedged) {
      coaching = pick(['You claimed certainty, but your evidence does not rule out every danger at ' + fmt(target) + '. Say "might" until you have proved it.', 'Careful: is ' + fmt(target) + ' proved safe, or merely not yet proved dangerous? Those are different things.', 'Sound so far, but the certainty is not earned — one of the two dangers is still open at ' + fmt(target) + '.']);
    } else if (R4 === 0 && hedged) {
      coaching = pick(['You have already proved ' + fmt(target) + ' is safe — your own evidence rules out both dangers. Trust your deduction and say so.', 'Under-confident: track what you have proved. Nothing you sensed leaves any danger possible at ' + fmt(target) + '.']);
    } else if (R3 === 0) {
      coaching = r3Specific || pick(['You used one square\u2019s percepts. You have visited more than one. What does the other square tell you?', 'Correct, but you left information on the table. Bring in a second observation to narrow the candidates.']);
    } else {
      coaching = pick(['Clean reasoning: you named the evidence and it licenses exactly what you claimed.', 'Good. Specific evidence, valid step, and your confidence matches what you proved.', 'That is how a logician moves: percept, rule, conclusion, and no more certainty than earned.']);
      if (R3 === 1) coaching = pick(['Excellent — you combined observations from different squares to pin the candidates.', 'Strong: two observations, a correct elimination, and honest certainty language.', coaching]);
    }
    if (coaching.length > 300) coaching = coaching.slice(0, 297) + '…';

    // ---------- formal rendering ----------
    const P = (sq) => '(' + sq[0] + ',' + sq[1] + ')';
    const prem = cited.map((o) => (o.present ? '' : '¬') + (o.percept === 'breeze' ? 'B' : o.percept === 'stench' ? 'S' : 'G') + P(o.sq));
    const uniqPrem = [...new Set(prem)];
    let concl = '';
    let rule = '';
    if (target) {
      if (action === 'shoot' || claimsWumpusHere) { concl = 'W' + P(target); rule = 'Modus Ponens on S ⇒ W-adjacent'; }
      else if (fullySafe) { concl = '¬P' + P(target) + ' ∧ ¬W' + P(target); rule = 'Modus Tollens (¬B ⇒ ¬P, ¬S ⇒ ¬W)'; }
      else if (claimsPitFree) { concl = '¬P' + P(target); rule = 'Modus Tollens (¬B ⇒ ¬P)'; }
      else if (claimsWumpusFree) { concl = '¬W' + P(target); rule = 'Modus Tollens (¬S ⇒ ¬W)'; }
      else if (hedged) {
        const br = cited.filter((o) => o.percept === 'breeze' && o.present);
        const st = cited.filter((o) => o.percept === 'stench' && o.present);
        const parts = [];
        for (const o of br) parts.push('(' + neighbours(o.sq).filter((n) => !K[key(n)].visited).map((n) => 'P' + P(n)).join(' ∨ ') + ')');
        for (const o of st) parts.push('(' + neighbours(o.sq).filter((n) => !K[key(n)].visited).map((n) => 'W' + P(n)).join(' ∨ ') + ')');
        concl = parts.length ? parts.join(' ∧ ') + ' — ' + P(target) + ' unresolved' : '?' + P(target);
        rule = 'Unit Resolution (candidate elimination)';
      }
    }
    if (R3 === 1 && !/Resolution/.test(rule)) rule += ' + Unit Resolution';
    const formal = uniqPrem.length && concl ? uniqPrem.join(' ∧ ') + ' ⇒ ' + concl : (uniqPrem.length ? uniqPrem.join(' ∧ ') : '');

    // Per-dimension "what was missing", so the UI never shows a bare "R3 0" (phones have no hover)
    const NAMES = { R1: 'cite evidence', R2: 'valid inference step', R3: 'combine information', R4: 'certainty matches evidence' };
    const missing = [];
    if (R1 === 0) missing.push({ dim: 'R1', name: NAMES.R1, why: invented.length ? 'you cited a percept that is not in your history (' + (invented[0].present ? '' : 'no ') + invented[0].percept + ' at ' + fmt(invented[0].sq) + ')' : 'no percept at a visited square was named' });
    if (R2 === 0 && R1) missing.push({ dim: 'R2', name: NAMES.R2, why: diagBad ? 'diagonal squares are not adjacent' : adjBad ? 'a square you named is not adjacent to where you sensed the percept' : r2why === 'pit-only' ? 'no breeze rules out a pit only; the Wumpus is not handled' : r2why === 'wumpus-only' ? 'no stench rules out the Wumpus only; a pit is not handled' : r2why.startsWith('candidate:') ? 'the percept you cited makes ' + fmt(target) + ' a danger candidate, not a safe square' : 'the evidence you cited does not reach ' + fmt(target) });
    if (R3 === 0 && R1) missing.push({ dim: 'R3', name: NAMES.R3, why: r3Specific ? r3Specific.replace(/\s\u2014.*$/, '') : 'only one observation used although more were available' });
    if (R4 === 0 && R1) missing.push({ dim: 'R4', name: NAMES.R4, why: hedged ? 'you hedged about ' + fmt(target) + ' although your evidence proves it' : 'you claimed certainty about ' + fmt(target) + ' that your evidence does not give' });

    // the claims this sentence makes, as KB sentences (checked against the KB by the panel)
    const claims = [];
    if (target && cited.length) {
      if (action === 'shoot' || claimsWumpusHere) claims.push({ kind: 'wumpus', squares: [target] });
      else if (fullySafe) claims.push({ kind: 'safe', squares: [target] });
      else { if (claimsPitFree) claims.push({ kind: 'noPit', squares: [target] }); if (claimsWumpusFree) claims.push({ kind: 'noW', squares: [target] }); }
      if (!fullySafe && !claimsPitFree) for (const o of cited) if (o.present && o.percept === 'breeze') { const c = neighbours(o.sq).filter((n) => mentionedSquares.has(key(n)) && !K[key(n)].visited); if (c.length) claims.push({ kind: 'pitOr', squares: c }); }
      if (!fullySafe && !claimsWumpusFree && action !== 'shoot') for (const o of cited) if (o.present && o.percept === 'stench') { const c = neighbours(o.sq).filter((n) => mentionedSquares.has(key(n)) && !K[key(n)].visited); if (c.length) claims.push({ kind: 'wOr', squares: c }); }
    }

    return {
      scores, total, max, verdict, coaching, formal, flags_wrong, missing, claims,
      rule: R1 ? rule : '',
      judge: 'local',
      _debug: { cited: cited.map((o) => (o.present ? '' : '¬') + o.percept + '@' + key(o.sq)), invented: invented.map((o) => (o.present ? '' : '¬') + o.percept + '@' + key(o.sq)), fullySafe, claimsPitFree, claimsWumpusFree, hedged, proved, r2why, diagBad, adjBad, r3Applicable },
    };
  }

  // ───────────────────────────── knowledge base (student-facing) ─────────────────────────────
  // TELL: one percept sentence per visited square. These are facts and are never wrong.
  function kbPercepts(history) {
    const seen = new Set(); const out = [];
    for (const h of history || []) {
      const k = key(h.square); if (seen.has(k)) continue; seen.add(k);
      const ps = h.percepts || []; const P = '(' + h.square[0] + ',' + h.square[1] + ')';
      const parts = [(ps.includes('breeze') ? '' : '¬') + 'B' + P, (ps.includes('stench') ? '' : '¬') + 'S' + P];
      if (ps.includes('glitter')) parts.push('G' + P);
      out.push({ square: h.square, text: parts.join(' ∧ '), scream: ps.includes('scream') });
    }
    return out;
  }
  const KB_KINDS = { noPit: 'no pit at', noW: 'no Wumpus at', safe: 'safe:', pit: 'a pit at', wumpus: 'the Wumpus at', pitOr: 'a pit in one of', wOr: 'the Wumpus in one of' };
  function sentenceText(s) {
    const P = (sq) => '(' + sq[0] + ',' + sq[1] + ')';
    const sqs = s.squares || [];
    switch (s.kind) {
      case 'noPit': return '¬P' + P(sqs[0]);
      case 'noW': return '¬W' + P(sqs[0]);
      case 'safe': return '¬P' + P(sqs[0]) + ' ∧ ¬W' + P(sqs[0]);
      case 'pit': return 'P' + P(sqs[0]);
      case 'wumpus': return 'W' + P(sqs[0]);
      case 'pitOr': return sqs.map((q) => 'P' + P(q)).join(' ∨ ');
      case 'wOr': return sqs.map((q) => 'W' + P(q)).join(' ∨ ');
      default: return '?';
    }
  }
  // Does the KB (percepts + rules) entail the sentence? 'entailed' | 'refuted' | 'open'
  function checkSentence(history, visited, s) {
    const K = knowledge(history, visited);
    const sqs = (s.squares || []).filter((q) => K[key(q)]);
    if (!sqs.length) return 'open';
    const k0 = K[key(sqs[0])];
    const tri = (status, want) => (status === want ? 'entailed' : status === 'maybe' ? 'open' : 'refuted');
    switch (s.kind) {
      case 'noPit': return tri(k0.pit, 'no');
      case 'noW': return tri(k0.wumpus, 'no');
      case 'pit': return tri(k0.pit, 'yes');
      case 'wumpus': return tri(k0.wumpus, 'yes');
      case 'safe': return k0.safe ? 'entailed' : (k0.pit === 'yes' || k0.wumpus === 'yes') ? 'refuted' : 'open';
      case 'pitOr': case 'wOr': {
        const f = s.kind === 'pitOr' ? 'pit' : 'wumpus';
        const listed = new Set(sqs.map(key));
        if (sqs.every((q) => K[key(q)][f] === 'no')) return 'refuted';
        if (sqs.some((q) => K[key(q)][f] === 'yes')) return 'entailed';
        const pc = s.kind === 'pitOr' ? 'breeze' : 'stench';
        // a disjunction is entailed when some percept's surviving candidates all lie inside the listed squares
        for (const h of history || []) {
          if (!(h.percepts || []).includes(pc)) continue;
          const cands = neighbours(h.square).filter((n) => K[key(n)][f] !== 'no');
          if (cands.length && cands.every((n) => listed.has(key(n)))) return 'entailed';
        }
        return 'open';
      }
    }
    return 'open';
  }

  // Unit resolution on a disjunction: which disjuncts does the KB already refute, and what is left?
  // P(3,1) ∨ P(2,2) ∨ P(1,1) with ¬P(1,1) known  ⟹  P(3,1) ∨ P(2,2)
  function resolveDisjunction(history, visited, s) {
    if (s.kind !== 'pitOr' && s.kind !== 'wOr') return null;
    const K = knowledge(history, visited); const f = s.kind === 'pitOr' ? 'pit' : 'wumpus';
    const dead = [], remaining = [];
    for (const q of s.squares || []) (K[key(q)] && K[key(q)][f] === 'no' ? dead : remaining).push(q);
    if (!dead.length) return null;
    return { dead, remaining, resolved: remaining.length === 1 ? { kind: s.kind === 'pitOr' ? 'pit' : 'wumpus', squares: remaining } : remaining.length ? { kind: s.kind, squares: remaining } : null };
  }

  // Plain-language explanation of a verdict for the student: what they know, why each dimension scored, and a model sentence.
  function explainVerdict(req, v) {
    const seenH = new Set();
    const history = (req.percept_history || []).filter((h) => { const k = key(h.square); if (seenH.has(k)) return false; seenH.add(k); return true; });
    const visited = req.visited || history.map((h) => h.square);
    const target = req.target_square;
    const K = knowledge(history, visited);
    const fmt = (sq) => '[' + sq[0] + ',' + sq[1] + ']';
    const NAMES = { R1: 'Cite evidence', R2: 'Valid step', R3: 'Combine information', R4: 'Honest certainty' };
    const lines = [];
    // 1. what is known
    const safeUnvisited = [], pitC = [], wC = [], pitSure = [], wSure = [];
    // only squares that a sensed breeze/stench actually implicates count as "candidates"
    const implicatedPit = new Set(), implicatedW = new Set();
    for (const h of history) { const ps = h.percepts || []; for (const n of neighbours(h.square)) { if (ps.includes('breeze')) implicatedPit.add(key(n)); if (ps.includes('stench')) implicatedW.add(key(n)); } }
    for (const k in K) { const sq = parseKey(k); if (K[k].visited) continue; if (K[k].safe) safeUnvisited.push(fmt(sq)); if (K[k].pit === 'yes') pitSure.push(fmt(sq)); else if (K[k].pit === 'maybe' && implicatedPit.has(k)) pitC.push(fmt(sq)); if (K[k].wumpus === 'yes') wSure.push(fmt(sq)); else if (K[k].wumpus === 'maybe' && implicatedW.has(k)) wC.push(fmt(sq)); }
    const seen = new Set(); const obs = [];
    for (const h of history) { const k = key(h.square); if (seen.has(k)) continue; seen.add(k); const ps = (h.percepts || []).filter((p) => p !== 'scream'); obs.push(fmt(h.square) + ': ' + (ps.length ? ps.join(', ') : 'nothing')); }
    lines.push('WHAT YOU KNOW RIGHT NOW. Sensed so far \u2014 ' + obs.join('; ') + '.');
    if (target) {
      // explicit geometry so nobody (student or AI) confuses columns with rows: [c,r], [1,1] bottom-left
      const dirs = neighbours(target).map((n) => fmt(n) + ' (' + (n[0] > target[0] ? 'right' : n[0] < target[0] ? 'left' : n[1] > target[1] ? 'above' : 'below') + ')');
      lines.push('Geometry: squares are [column,row], [1,1] is bottom-left. The neighbours of ' + fmt(target) + ' are ' + dirs.join(', ') + '; nothing else is adjacent to it (no diagonals).');
    }
    const tk = target ? K[key(target)] : null;
    if (target) {
      if (tk.visited) lines.push(fmt(target) + ' is proved safe: you have already stood on it.');
      else {
        const why = [];
        for (const h of history) { if (!adjacent(h.square, target)) continue; const ps = h.percepts || []; if (!ps.includes('breeze')) why.push('no breeze at ' + fmt(h.square) + ' rules out a pit'); else why.push('the breeze at ' + fmt(h.square) + ' leaves a pit possible'); if (!ps.includes('stench')) why.push('no stench at ' + fmt(h.square) + ' rules out the Wumpus'); else why.push('the stench at ' + fmt(h.square) + ' leaves the Wumpus possible'); }
        lines.push(fmt(target) + ' is ' + (tk.safe ? 'PROVED SAFE' : (tk.pit === 'yes' || tk.wumpus === 'yes') ? 'PROVED DANGEROUS' : 'NOT YET PROVED SAFE') + (why.length ? ': ' + why.join('; ') + '.' : ': no visited square is next to it, so nothing you sensed reaches it.'));
      }
    }
    if (pitSure.length || wSure.length) lines.push('Proved dangerous: ' + [...pitSure.map((x) => x + ' (pit)'), ...wSure.map((x) => x + ' (Wumpus)')].join(', ') + '.');
    if (pitC.length || wC.length) lines.push('Still open: ' + [pitC.length ? 'a pit could be at ' + pitC.join(' or ') : '', wC.length ? 'the Wumpus could be at ' + wC.join(' or ') : ''].filter(Boolean).join('; ') + '.');
    if (safeUnvisited.length) lines.push('Unvisited squares you have already proved safe: ' + safeUnvisited.join(', ') + '.');
    // 2. per dimension
    const miss = {}; for (const m of (v.missing || [])) miss[m.dim] = m.why;
    const dim = [];
    for (const d of ['R1', 'R2', 'R3', 'R4']) {
      const sc = v.scores[d];
      if (sc === null) { dim.push(d + ' ' + NAMES[d] + ': not applicable (only one square sensed so far).'); continue; }
      if (sc === 1) dim.push(d + ' ' + NAMES[d] + ': \u2713 ' + ({ R1: 'you named a real percept at a square you visited.', R2: 'the conclusion follows from that percept and the adjacency rule.', R3: 'you brought in more than one observation.', R4: 'your confidence matches what the evidence proves.' })[d]);
      else dim.push(d + ' ' + NAMES[d] + ': \u2717 ' + (miss[d] || ({ R1: 'no percept at a visited square was named', R2: 'the cited percept does not license the claim', R3: 'only one observation was used', R4: 'confidence did not match the evidence' })[d]).replace(/\.$/, '') + '.');
    }
    lines.push('YOUR SCORE, DIMENSION BY DIMENSION. ' + dim.join(' '));
    // 3. model sentence
    if (target) {
      const parts = [];
      for (const h of history) {
        if (seen.has(key(h.square)) && !adjacent(h.square, target)) continue;
        const ps = h.percepts || [];
        if (!adjacent(h.square, target)) continue;
        parts.push((ps.includes('breeze') ? 'there was a breeze' : 'no breeze') + ' and ' + (ps.includes('stench') ? 'a stench' : 'no stench') + ' at ' + fmt(h.square) + ', which is next to ' + fmt(target));
      }
      const others = history.filter((h) => !adjacent(h.square, target) && (h.percepts || []).some((p) => p === 'breeze' || p === 'stench'));
      const seenO = new Set(); const otherTxt = [];
      for (const h of others) { const k = key(h.square); if (seenO.has(k)) continue; seenO.add(k); const ps = (h.percepts || []).filter((p) => p === 'breeze' || p === 'stench'); const cands = neighbours(h.square).filter((n) => !K[key(n)].visited).map(fmt); otherTxt.push('the ' + ps.join(' and ') + ' at ' + fmt(h.square) + ' only concerns ' + (cands.join(' or ') || 'its own neighbours') + ', not ' + fmt(target)); }
      let concl;
      if (tk.visited) concl = 'I have already stood on ' + fmt(target) + ', so it is safe';
      else if (tk.safe) concl = 'so ' + fmt(target) + ' has no pit and no Wumpus: it is safe';
      else if (tk.pit === 'yes' || tk.wumpus === 'yes') concl = 'so ' + fmt(target) + ' is proved dangerous and I should not go there';
      else concl = 'so ' + fmt(target) + ' might still have ' + (tk.pit === 'maybe' && tk.wumpus === 'maybe' ? 'a pit or the Wumpus' : tk.pit === 'maybe' ? 'a pit' : 'the Wumpus') + '; I know the risk and take it' + (safeUnvisited.length ? ' (or I could go to ' + safeUnvisited[0] + ', which is proved safe)' : '');
      lines.push('A FULL-CREDIT SENTENCE HERE: "' + [...parts, ...otherTxt].join('; ') + (parts.length || otherTxt.length ? ', ' : '') + concl + '."');
    }
    return lines;
  }

  function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; return h; }

  // Normalise any judge output (LLM or local) per PROMPT.md "Client-side validation".
  function normaliseVerdict(v, req) {
    if (v && typeof v === 'object' && !v.scores && ('R1' in v || 'R2' in v)) v = Object.assign({}, v, { scores: { R1: v.R1, R2: v.R2, R3: v.R3, R4: v.R4 } }); // flat-schema models
    if (!v || typeof v !== 'object' || !v.scores) return null;
    const s = {};
    for (const k of ['R1', 'R2', 'R3', 'R4']) {
      const x = v.scores[k];
      s[k] = x === 1 || x === 0 ? x : (x === null ? null : (x === true ? 1 : x === false ? 0 : null));
    }
    const history = req.percept_history || [];
    const distinctVisited = new Set((req.visited || history.map((h) => h.square)).map(key)).size;
    if ((req.move_number || 1) === 1 || distinctVisited < 2) s.R3 = null;
    for (const k of ['R1', 'R2', 'R4']) if (s[k] === null) s[k] = 0;
    const dims = ['R1', 'R2', 'R3', 'R4'].filter((d) => s[d] !== null);
    const total = dims.reduce((a, d) => a + s[d], 0);
    const max = dims.length;
    let verdict = ['sound', 'partial', 'unsound', 'unsupported'].includes(v.verdict) ? v.verdict : (total === max ? 'sound' : total === 0 ? 'unsupported' : 'partial');
    if (total === max && verdict !== 'sound') verdict = 'sound';
    let coaching = String(v.coaching || '').trim();
    if (coaching.length > 300) coaching = coaching.slice(0, 297) + '…';
    const formal = String(v.formal || '').slice(0, 200);
    const flags_wrong = Array.isArray(v.flags_wrong) ? v.flags_wrong.map(String) : [];
    const NAMES = { R1: 'cite evidence', R2: 'valid inference step', R3: 'combine information', R4: 'certainty matches evidence' };
    const missing = Array.isArray(v.missing) ? v.missing : ['R1', 'R2', 'R3', 'R4'].filter((d) => s[d] === 0).map((d) => ({ dim: d, name: NAMES[d], why: '' }));
    return { scores: s, total, max, verdict, coaching, formal, flags_wrong, rule: v.rule || '', missing };
  }

  return { WORLDS, neighbours, adjacent, perceptsAt, randomWorld, getWorld, knowledge, localJudge, normaliseVerdict, explainVerdict, kbPercepts, sentenceText, checkSentence, resolveDisjunction, KB_KINDS, key, parseKey, eq };
});
