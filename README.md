# Wumpus Justify — say why you move: a reasoning-graded Wumpus World

**Live:** https://kiranvk.me/ai/wumpus/  ·  free, no login

Students move through a 4×4 Wumpus World but must **type a justification before every move**. The reasoning is graded,
not the outcome: a lucky guess scores zero, sound reasoning that gets you killed scores full marks. A knowledge-base panel
turns percepts into propositional sentences, checks entailment and shows resolution proofs (PECST522 AI, Module 3).

## Files
| File | Role |
|---|---|
| `game.html` + `index.php` | The game (index.php injects cache-bust + judge prompt) |
| `wumpus-core.js` | Engine, knowledge model and the local rule-engine judge |
| `wumpus-logic.js` | Propositional logic engine: CNF, model checking, resolution |
| `judge.php` + `lib.php` | Optional LLM judge proxy with rate limits; also the shared helper used by the Logic Lab and LEX–YACC Lab relays |
| `admin/`, `lecturer/` | Maintainer dashboard and lecturer view (password-protected on the server) |
| `PROMPT.md`, `BENCHMARK.md`, `bench/` | Judge prompt, benchmark and tests |

## Run it locally
```bash
git clone https://github.com/kvk-code/kiranvk-wumpus-justify.git && cd kiranvk-wumpus-justify
php -S localhost:8000        # then open http://localhost:8000/
```
```bash
node bench/test-core.mjs && node bench/verify-world.mjs
php admin/setup.php --user you --password '…'   # local dashboard login (stored in $HOME/wumpus-config/)
```

## AI features and secrets
The game works fully offline with the local rule-engine judge. The optional LLM judge reads provider keys from `$HOME/wumpus-config/` (or `$WUMPUS_CONFIG_DIR`), set with `php admin/setup.php`.
No key, password or log file is in this repository. Server-side settings live in a config directory **outside the web root** and are never published.

## Relationship to the website
This repo is an exact mirror of https://kiranvk.me/ai/wumpus/. Every deploy of the site publishes the same files here (`sync:` commits).
Community pull requests are reviewed, merged into the site source, deployed, and then come back here with the next sync.

## Licence
Code: MIT (see `LICENSE`). Third-party components and data: see `THIRD_PARTY.md` where present.
Built by **Kiran V K**, Assistant Professor, Dept. of CSE, NSS College of Engineering, Palakkad, for KTU students. Live: https://kiranvk.me/ai/wumpus/
