#!/usr/bin/env node
// Wumpus Justify — judge bake-off harness
//
//   OPENROUTER_API_KEY=sk-or-v1-... node bench/run.mjs
//   OPENROUTER_API_KEY=... node bench/run.mjs --reps 3 --only nvidia/nemotron-3-super-120b-a12b:free
//
// Writes BENCHMARK.md next to DESIGN.md. Pin the winner in judge.php.
//
// Scoring notes:
//  - "vector exact" = all four R dimensions match the label exactly. This is the
//    number that decides the winner; mean-absolute-error on the total is a
//    tiebreaker only, because a judge can get the right total for wrong reasons.
//  - Cases tagged weight 2 count double. They are the cases where a bad judge
//    inverts the pedagogy (hallucinated percepts, grammar penalties).
//  - A model that fails the register tests (L1/L2) or the hallucination tests
//    (H1/H2/H3) is DISQUALIFIED regardless of overall score. See DESIGN.md 5.1.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// Any OpenAI-compatible endpoint works: JUDGE_BASE_URL + JUDGE_API_KEY (e.g. TokenRouter, NVIDIA NIM).
// Defaults to OpenRouter with OPENROUTER_API_KEY.
const BASE = (process.env.JUDGE_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
const KEY = process.env.JUDGE_API_KEY || process.env.OPENROUTER_API_KEY;
if (!KEY) {
  console.error('Set OPENROUTER_API_KEY (or JUDGE_BASE_URL + JUDGE_API_KEY). Free OpenRouter keys: https://openrouter.ai/keys');
  process.exit(1);
}
const JSON_MODE = process.env.JUDGE_JSON_MODE || null; // none | json_object | json_schema (overrides the STRUCTURED table)
const MAX_TOKENS = Number(process.env.JUDGE_MAX_TOKENS || 700);
const EXTRA_BODY = process.env.JUDGE_EXTRA_BODY ? JSON.parse(process.env.JUDGE_EXTRA_BODY) : {}; // e.g. '{"thinking":{"type":"disabled"}}'

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? dflt : argv[i + 1];
};
const REPS = Number(arg('reps', 3));
const ONLY = arg('only', null);

const CANDIDATES = ONLY ? [ONLY] : [
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nex-agi/nex-n2.5-pro:free',
  'dots-studio/dots-3-note-preview:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'google/gemma-4-31b-it:free',
];

// Models advertising structured_outputs per /api/v1/models on 2026-09-12.
// The rest get prompt-only JSON coercion plus a repair attempt.
const STRUCTURED = new Set([
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nex-agi/nex-n2.5-pro:free',
  'dots-studio/dots-3-note-preview:free',
]);

const { cases } = JSON.parse(readFileSync(join(HERE, 'cases.json'), 'utf8'));

// The system prompt is the fenced block in PROMPT.md — single source of truth,
// so the benchmark can never drift from what production actually sends.
const promptMd = readFileSync(join(HERE, '..', 'PROMPT.md'), 'utf8');
const SYSTEM = (() => {
  const m = promptMd.match(/```\n([\s\S]*?)\n```/);
  if (!m) throw new Error('Could not extract the judge prompt from PROMPT.md');
  return m[1].trim();
})();

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['scores', 'total', 'max', 'verdict', 'coaching', 'formal', 'flags_wrong'],
  properties: {
    scores: {
      type: 'object', additionalProperties: false,
      required: ['R1', 'R2', 'R3', 'R4'],
      properties: {
        R1: { type: ['integer', 'null'] }, R2: { type: ['integer', 'null'] },
        R3: { type: ['integer', 'null'] }, R4: { type: ['integer', 'null'] },
      },
    },
    total: { type: 'integer' },
    max: { type: 'integer' },
    verdict: { type: 'string', enum: ['sound', 'partial', 'unsound', 'unsupported'] },
    coaching: { type: 'string' },
    formal: { type: 'string' },
    flags_wrong: { type: 'array', items: { type: 'string' } },
  },
};

const requestFor = (c) => ({
  target_square: c.target_square,
  current_square: c.current_square,
  move_number: c.move_number,
  percept_history: c.percept_history,
  visited: c.visited,
  student_flags: c.student_flags ?? {},
  justification: c.justification,
});

// Some models flatten the schema ({"R1":1,...} at top level); accept both shapes, as production does.
function shape(j) {
  if (!j || typeof j !== 'object') return null;
  if (j.scores && typeof j.scores === 'object') return j;
  if ('R1' in j || 'R2' in j) return { ...j, scores: { R1: j.R1 ?? null, R2: j.R2 ?? null, R3: j.R3 ?? null, R4: j.R4 ?? null } };
  return null;
}
function parseVerdict(text) {
  if (!text) return null;
  try { const v = shape(JSON.parse(text)); if (v) return v; } catch { /* fall through */ }
  // Models without structured output often fence it or pad it with prose.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) { try { const v = shape(JSON.parse(fenced[1])); if (v) return v; } catch { /* keep going */ } }
  const span = text.match(/\{[\s\S]*\}/);
  if (span) { try { return shape(JSON.parse(span[0])); } catch { /* give up */ } }
  return null;
}

async function judge(model, c) {
  const body = {
    model,
    temperature: 0.2,
    max_tokens: MAX_TOKENS,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: JSON.stringify(requestFor(c), null, 2) },
    ],
  };
  const mode = JSON_MODE || (STRUCTURED.has(model) ? 'json_schema' : 'json_object');
  if (mode === 'json_schema') {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: 'verdict', strict: true, schema: SCHEMA },
    };
  } else if (mode === 'json_object') {
    body.response_format = { type: 'json_object' };
  }

  Object.assign(body, EXTRA_BODY);
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(BASE + '/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://kiranvk.me',
        'X-Title': 'Wumpus Justify bench (PECST522)',
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ms: Date.now() - t0, error: `network: ${e.message}` };
  }
  const ms = Date.now() - t0;

  if (res.status === 429) return { ms, error: 'rate-limited' };
  if (!res.ok) return { ms, error: `http ${res.status}: ${(await res.text()).slice(0, 160)}` };

  const json = await res.json();
  const parsed = parseVerdict(json.choices?.[0]?.message?.content);
  if (!parsed) return { ms, error: 'parse-failure' };
  return { ms, verdict: parsed };
}

// Apply the same client-side normalisation production uses (PROMPT.md), so the
// benchmark measures the judge as deployed, not as raw model output.
function normalise(v, c) {
  const s = { ...(v.scores ?? {}) };
  if (c.move_number === 1) s.R3 = null;
  for (const k of ['R1', 'R2', 'R3', 'R4']) {
    if (s[k] !== 0 && s[k] !== 1 && s[k] !== null) s[k] = null;
  }
  return s;
}

const dims = ['R1', 'R2', 'R3', 'R4'];
const sum = (o) => dims.reduce((a, k) => a + (o[k] ?? 0), 0);

(async () => {
  const results = [];

  for (const model of CANDIDATES) {
    console.error(`\n=== ${model} ===`);
    const r = {
      model, n: 0, vectorExact: 0, wVectorExact: 0, wTotal: 0,
      dimHits: { R1: 0, R2: 0, R3: 0, R4: 0 }, dimN: { R1: 0, R2: 0, R3: 0, R4: 0 },
      absErr: 0, parseFail: 0, errors: [], lat: [],
      failedCritical: [], verdictHits: 0,
    };

    for (const c of cases) {
      const w = c.weight ?? 1;
      const critical = /fluent-but-wrong|register/.test(c.tag);

      for (let rep = 0; rep < REPS; rep++) {
        const out = await judge(model, c);
        r.lat.push(out.ms);

        if (out.error) {
          if (out.error === 'parse-failure') r.parseFail++;
          else r.errors.push(`${c.id}: ${out.error}`);
          r.n++; r.wTotal += w;
          if (critical) r.failedCritical.push(`${c.id} (${out.error})`);
          console.error(`  ${c.id} rep${rep} → ERROR ${out.error}`);
          continue;
        }

        const got = normalise(out.verdict, c);
        const exact = dims.every((k) => (got[k] ?? null) === (c.expect[k] ?? null));

        r.n++; r.wTotal += w;
        if (exact) { r.vectorExact++; r.wVectorExact += w; }
        else if (critical) r.failedCritical.push(`${c.id} got ${JSON.stringify(got)} want ${JSON.stringify(c.expect)}`);

        for (const k of dims) {
          if (c.expect[k] === undefined) continue;
          r.dimN[k]++;
          if ((got[k] ?? null) === (c.expect[k] ?? null)) r.dimHits[k]++;
        }
        r.absErr += Math.abs(sum(got) - sum(c.expect));
        if (out.verdict.verdict === c.expect_verdict) r.verdictHits++;

        console.error(`  ${c.id} rep${rep} → ${exact ? 'OK ' : 'MISS'} ${JSON.stringify(got)} (${out.ms}ms)`);
      }
    }
    results.push(r);
  }

  const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + '%' : 'n/a');
  const pctile = (xs, p) => {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  };

  const ranked = [...results].sort((a, b) => (b.wVectorExact / (b.wTotal || 1)) - (a.wVectorExact / (a.wTotal || 1)));

  let md = `# Judge bake-off results

Generated by \`bench/run.mjs\` — ${new Date().toISOString()} · endpoint \`${BASE}\`
Reps per case: ${REPS} · Cases: ${cases.length} · Labels: \`bench/cases.json\`

**Winner (weighted vector-exact): \`${ranked[0]?.model ?? 'none'}\`**
${ranked[0]?.failedCritical.length ? `\n> ⚠️ The top scorer failed ${ranked[0].failedCritical.length} critical case(s). See DESIGN.md §5.1 — a model that hallucinates percepts or penalises non-native English is disqualified even if it ranks first. Check the next model down.\n` : ''}
| Model | Weighted exact | Exact | R1 | R2 | R3 | R4 | Verdict | MAE | Parse fail | p50 | p95 | Critical fails |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
`;
  for (const r of ranked) {
    md += `| \`${r.model}\` | **${pct(r.wVectorExact, r.wTotal)}** | ${pct(r.vectorExact, r.n)} `
      + dims.map((k) => `| ${pct(r.dimHits[k], r.dimN[k])} `).join('')
      + `| ${pct(r.verdictHits, r.n)} | ${(r.absErr / (r.n || 1)).toFixed(2)} | ${pct(r.parseFail, r.n)} `
      + `| ${pctile(r.lat, 50)}ms | ${pctile(r.lat, 95)}ms | ${r.failedCritical.length} |\n`;
  }

  md += `\n## Acceptance gates (DESIGN.md §6.3)\n\n`;
  for (const r of ranked) {
    const p95 = pctile(r.lat, 95);
    const gates = [
      [`weighted vector-exact ≥ 70%`, r.wVectorExact / (r.wTotal || 1) >= 0.7],
      [`p95 latency < 4000ms`, p95 < 4000],
      [`parse-failure rate < 2%`, r.parseFail / (r.n || 1) < 0.02],
      [`zero critical failures`, r.failedCritical.length === 0],
    ];
    md += `**\`${r.model}\`** — ${gates.every((g) => g[1]) ? '✅ PASSES' : '❌ FAILS'}\n`;
    for (const [name, ok] of gates) md += `- ${ok ? '✅' : '❌'} ${name}\n`;
    if (r.failedCritical.length) {
      md += `\n<details><summary>Critical failures (${r.failedCritical.length})</summary>\n\n`;
      for (const f of r.failedCritical.slice(0, 30)) md += `- ${f}\n`;
      md += `\n</details>\n`;
    }
    if (r.errors.length) {
      md += `\n<details><summary>Transport errors (${r.errors.length})</summary>\n\n`;
      for (const e of r.errors.slice(0, 20)) md += `- ${e}\n`;
      md += `\n</details>\n`;
    }
    md += `\n`;
  }

  md += `## What to do with this

1. Pin the highest-ranked model that **passes all four gates** in \`judge.php\`.
2. Put the next two passing models in the OpenRouter \`models\` fallback array.
3. If nothing passes the latency gate, drop \`reasoning.effort\` to \`low\` (or
   remove it) and re-run before switching models.
4. If nothing passes the critical-failure gate, the prompt is at fault before the
   models are — re-read PROMPT.md §"GRADING CONDUCT" and re-run. Only after that
   consider a paid model.
5. Update DESIGN.md §6.2 if the winner differs from the predicted primary
   (\`nvidia/nemotron-3-super-120b-a12b:free\`).
`;

  const out = join(HERE, '..', 'BENCHMARK.md');
  writeFileSync(out, md);
  console.error(`\nWrote ${out}`);
  console.error(`Winner: ${ranked[0]?.model} (${pct(ranked[0]?.wVectorExact, ranked[0]?.wTotal)} weighted exact)`);
})();
