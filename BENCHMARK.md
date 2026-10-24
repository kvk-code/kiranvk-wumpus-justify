# Judge bake-off — 2026-09-12

`bench/run.mjs`, 20 labelled cases (`bench/cases.json`), 1 rep, production prompt, via NVIDIA NIM
(`https://integrate.api.nvidia.com/v1`, Kiran's key). "Critical" = the hallucination / register
cases that, if failed, invert the pedagogy (DESIGN.md §5.1).

| Model (NIM) | Weighted exact | Exact | R1 | R2 | R3 | R4 | Verdict | MAE | Parse fail | p50 | p95 | Critical fails |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `nvidia/nemotron-3-super-120b-a12b`, thinking **off** | **60.0%** | 60.0% | 94.4% | 88.9% | 77.8% | 83.3% | 70.0% | 0.20 | 5.0% | 2.9 s | 12.0 s | 3 (H2 parse-fail, H3 diagonal, L2 register) |
| `nvidia/nemotron-3.5-lightning-30b-a3b`, thinking off | 30.0% | 30.0% | 94.7% | 68.4% | 63.2% | 73.7% | 50.0% | 0.70 | 5.0% | 4.7 s | 19.5 s | 3 |
| `nvidia/nemotron-3-super-120b-a12b`, thinking **on** | not run | | | | | | | | | ~60 s | | reasons for ~5 000 chars before answering |
| `openai/gpt-oss-20b` (NIM) | not run | | | | | | | | | 42–65 s | | reasoning eats the token budget |
| `z-ai/glm-5.3-flash` (NIM) | not run | | | | | | | | | 44 s | | prose, no JSON at 1500 tokens |
| `nvidia/llama-3.1-nemotron-70b-instruct`, `moonshotai/kimi-k2.6`, `google/gemma-3-12b-it`, `nvidia/nemotron-nano-3-30b-a3b` | — | | | | | | | | | | | listed by `/v1/models` but **404** for this key |
| `mistralai/mistral-nemotron` | — | | | | | | | | | 89 s | | HTTP 500 |

Observed live after enabling: the same model graded a short perfect first move ("No breeze and no stench at [1,1], so [2,1] has neither. Safe.") as R2=0 *unsound* three times in a row, while the longer bench wording P1 passed. Expect this kind of variance on terse sentences; it is why *auto* mode lets the rules answer first.

Several of Nemotron Super's "misses" are the R3 `null`-vs-`0` distinction (Q1, Q2: the model
returns `null` where the label says `0`); its R1 (evidence / hallucination) accuracy is 94%.
One 503 ("Service temporarily overloaded") occurred in 20 calls; `judge.php` now retries once
on parse-failure / 5xx before falling through to the next provider.

**Decision (2026-09-12):** none of the free models passes all four §6.3 gates, so the
**local rule engine stays primary** (20/20 on the same cases, <1 ms). `nvidia/nemotron-3-super-120b-a12b`
with thinking off is **enabled** as the AI coach because in the game's default *auto* mode it is
consulted only when the rules cannot read a sentence — where 60% agreement with the labels and
a real coaching sentence beat a 0/4 "name the square" fallback. "AI for every move" is a
settings option for the lecturer's demo. Re-run this table before switching models.

## Reproduce

```bash
JUDGE_BASE_URL=https://integrate.api.nvidia.com/v1 JUDGE_API_KEY=nvapi-... JUDGE_JSON_MODE=none \
  JUDGE_MAX_TOKENS=900 JUDGE_EXTRA_BODY='{"chat_template_kwargs":{"enable_thinking":false}}' \
  node bench/run.mjs --reps 1 --only nvidia/nemotron-3-super-120b-a12b
```
Run it from a scratch copy of this directory: the harness overwrites `BENCHMARK.md` next to it.

## Measured: `z-ai/glm-5.3-free` via TokenRouter — disqualified on latency

Kiran's free TokenRouter key was available, so the one free model there was measured
with the production prompt and bench case C1 (single calls, non-streaming):

| Request shape | Wall time | Finish | What came back |
|---|---|---|---|
| thinking on, `json_object`, max 1500 | 46 s | `length` | 1500 reasoning tokens, **empty content** |
| thinking on, plain, max 1500 | 58 s | `length` | same |
| thinking on, `json_object`, max 3000 | 52 s | `length` | 3000 reasoning tokens, empty content |
| thinking **off**, plain, max 1500 | 46 s | `length` | 1500 tokens of prose analysis, no JSON yet |
| thinking off, `json_object`, max 700 | 12.8 s | `length` | prose analysis, no JSON |
| thinking off, assistant prefill `{"scores": {` | 11.6 s | `length` | prose analysis (prefill ignored) |
| thinking off, second system message "JSON only" | 12.0 s | `length` | prose analysis (ignored) |
| through `judge.php`, thinking off, max 1800, 55 s timeout | 55 s | timeout | nothing |

Throughput is ~50 tokens/s and the model insists on a full prose walk-through
(>1500 tokens) before the JSON, whatever the prompt says. Best case is therefore
40–70 s per verdict against a p95 budget of 4 s (DESIGN.md §6.3). `glm-5.3-flash`
and `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` both return **403** on this key.

**Decision:** the TokenRouter provider ships configured but **disabled**. It can be
enabled from the dashboard and re-tested with one click if TokenRouter's serving
changes. Grading accuracy was not measured because no call completed.

## Local rule engine (`wumpus-core.js`) — measured

`node bench/test-core.mjs`: **20/20 vector-exact** on `bench/cases.json` (weighted
100 %), all 20 verdict labels correct, `flags_wrong` correct on O1, <1 ms per verdict,
no network. This is the primary judge (DESIGN.md §5.4 / §9.2) and it is what the
class runs on.

## Acceptance gates for whatever LLM is pinned next

- weighted vector-exact ≥ 70 % · p95 < 4000 ms · parse-failure < 2 % · zero critical failures
- run `bench/run.mjs`, paste the table here, and set the model in the dashboard.
