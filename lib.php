<?php
// Wumpus Justify — shared server helpers (config, usage, provider calls).
// Config + usage live OUTSIDE the web root: $HOME/wumpus-config/ (0700).
// Never logs student text. See DESIGN.md §5.3, §9.4 (6).
declare(strict_types=1);

const WJ_VERSION = '1.0.0';
const WJ_TZ = 'Asia/Kolkata';

function wj_config_dir(): string {
    $d = getenv('WUMPUS_CONFIG_DIR');
    if ($d) return rtrim($d, '/');
    $home = getenv('HOME');
    if (!$home && !empty($_SERVER['DOCUMENT_ROOT'])) $home = dirname($_SERVER['DOCUMENT_ROOT']);
    if (!$home) $home = dirname(__DIR__, 3);
    return rtrim($home, '/') . '/wumpus-config';
}

function wj_default_providers(): array {
    return [
        [
            'id' => 'tokenrouter', 'label' => 'TokenRouter · GLM 5.3 (free)',
            'base_url' => 'https://api.tokenrouter.com/v1', 'model' => 'z-ai/glm-5.3-free', 'fallback_models' => [],
            // Disabled by default: measured 2026-09-12, GLM 5.3 free via TokenRouter writes 1500+ tokens of prose analysis
            // before any JSON at ~50 tok/s (12–58 s, never inside the 55 s timeout). Wired and testable from the dashboard; see BENCHMARK.md.
            'key' => '', 'enabled' => false, 'daily_cap' => 300, 'minute_cap' => 20,
            'json_mode' => 'none', 'max_tokens' => 1800, 'temperature' => 0.2, 'extra_body' => ['thinking' => ['type' => 'disabled']],
        ],
        [
            'id' => 'openrouter', 'label' => 'OpenRouter (free tier)',
            'base_url' => 'https://openrouter.ai/api/v1', 'model' => 'nvidia/nemotron-3-super-120b-a12b:free',
            'fallback_models' => ['nex-agi/nex-n2.5-pro:free', 'dots-studio/dots-3-note-preview:free'],
            'key' => '', 'enabled' => false, 'daily_cap' => 45, 'minute_cap' => 15,
            'json_mode' => 'json_schema', 'max_tokens' => 700, 'temperature' => 0.2, 'extra_body' => ['reasoning' => ['effort' => 'low']],
        ],
        [
            'id' => 'nvidia', 'label' => 'NVIDIA NIM (build.nvidia.com)',
            'base_url' => 'https://integrate.api.nvidia.com/v1', 'model' => 'nvidia/nemotron-3-ultra-550b-a55b', 'fallback_models' => ['openai/gpt-oss-20b'], 'primary_timeout_s' => 20,
            'key' => '', 'enabled' => false, 'daily_cap' => 2000, 'minute_cap' => 35,
            // thinking OFF is essential: with it on, Nemotron 3 reasons for ~60 s per verdict (measured 2026-09-12)
            'json_mode' => 'none', 'max_tokens' => 900, 'temperature' => 0.2, 'extra_body' => ['chat_template_kwargs' => ['enable_thinking' => false]],
        ],
    ];
}

function wj_default_config(): array {
    return [
        'admin_user' => 'kiran',
        'admin_hash' => '',
        'access_mode' => 'open',        // off | code | open
        'lecturer_code' => '',
        'ip_per_minute' => 8,
        'timeout_s' => 55,
        'byok_model' => 'nvidia/nemotron-3-super-120b-a12b:free',
        // what the public game opens with: fresh random cave per load, or a cave pinned by the lecturer
        'class_world' => ['mode' => 'fresh', 'world' => 'canonical', 'seed' => 1234],
        'providers' => wj_default_providers(),
    ];
}

function wj_ensure_dir(): string {
    $dir = wj_config_dir();
    if (!is_dir($dir)) @mkdir($dir, 0700, true);
    return $dir;
}

function wj_load_config(): array {
    $f = wj_ensure_dir() . '/config.json';
    $c = [];
    if (is_file($f)) { $c = json_decode((string)file_get_contents($f), true) ?: []; }
    $d = wj_default_config();
    $c = array_merge($d, $c);
    // merge provider defaults by id so new fields appear after upgrades
    $byId = [];
    foreach ($c['providers'] as $p) if (!empty($p['id'])) $byId[$p['id']] = $p;
    $out = [];
    foreach ($d['providers'] as $dp) { $out[] = array_merge($dp, $byId[$dp['id']] ?? []); unset($byId[$dp['id']]); }
    foreach ($byId as $p) $out[] = array_merge($d['providers'][0], $p);
    // keep the user's ordering when it exists
    if (!empty($c['providers'])) {
        $order = array_values(array_map(fn($p) => $p['id'], $c['providers']));
        usort($out, fn($a, $b) => (array_search($a['id'], $order) === false ? 99 : array_search($a['id'], $order)) <=> (array_search($b['id'], $order) === false ? 99 : array_search($b['id'], $order)));
    }
    $c['providers'] = $out;
    return $c;
}

function wj_save_config(array $c): void {
    $dir = wj_ensure_dir();
    $tmp = $dir . '/config.json.tmp';
    file_put_contents($tmp, json_encode($c, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), LOCK_EX);
    @chmod($tmp, 0600);
    rename($tmp, $dir . '/config.json');
}

function wj_today(): string { $d = new DateTime('now', new DateTimeZone(WJ_TZ)); return $d->format('Y-m-d'); }
function wj_now_iso(): string { $d = new DateTime('now', new DateTimeZone(WJ_TZ)); return $d->format('Y-m-d H:i:s'); }
function wj_minute_key(): int { return intdiv(time(), 60); }

// usage.json under an exclusive lock: $fn(array &$u) mutates, we persist.
function wj_with_usage(callable $fn) {
    $dir = wj_ensure_dir();
    $f = $dir . '/usage.json';
    $h = fopen($f, 'c+');
    if (!$h) return null;
    flock($h, LOCK_EX);
    $raw = stream_get_contents($h);
    $u = $raw ? (json_decode($raw, true) ?: []) : [];
    $u += ['days' => [], 'events' => [], 'ip' => [], 'login_fail' => []];
    $ret = $fn($u);
    // prune: keep 35 days, 80 events, stale ip buckets
    krsort($u['days']); $u['days'] = array_slice($u['days'], 0, 35, true); ksort($u['days']);
    $u['events'] = array_slice($u['events'], -80);
    $nowMin = wj_minute_key();
    foreach ($u['ip'] as $k => $v) if (($v['m'] ?? 0) < $nowMin - 2) unset($u['ip'][$k]);
    foreach ($u['login_fail'] as $k => $v) if (($v['t'] ?? 0) < time() - 900) unset($u['login_fail'][$k]);
    ftruncate($h, 0); rewind($h);
    fwrite($h, json_encode($u, JSON_UNESCAPED_SLASHES));
    fflush($h); flock($h, LOCK_UN); fclose($h);
    @chmod($f, 0600);
    return $ret;
}

function wj_read_usage(): array {
    $f = wj_config_dir() . '/usage.json';
    if (!is_file($f)) return ['days' => [], 'events' => [], 'ip' => [], 'login_fail' => []];
    return (json_decode((string)file_get_contents($f), true) ?: []) + ['days' => [], 'events' => [], 'ip' => [], 'login_fail' => []];
}

function wj_ip_hash(): string {
    $ip = $_SERVER['HTTP_CF_CONNECTING_IP'] ?? $_SERVER['REMOTE_ADDR'] ?? '0';
    return substr(hash('sha256', $ip . '|' . wj_today() . '|wj'), 0, 16); // rotates daily, never stores the raw IP
}

function wj_mask_key(string $k): string {
    if ($k === '') return '(not set)';
    if (strlen($k) < 10) return '••••';
    return substr($k, 0, 5) . '…' . substr($k, -4);
}

function wj_system_prompt(): string {
    $f = __DIR__ . '/judge-prompt.txt';
    return is_file($f) ? trim((string)file_get_contents($f)) : 'You grade Wumpus World justifications. Return JSON with scores R1-R4, total, max, verdict, coaching, formal, flags_wrong.';
}

function wj_schema(): array {
    return [
        'type' => 'object', 'additionalProperties' => false,
        'required' => ['scores', 'total', 'max', 'verdict', 'coaching', 'formal', 'flags_wrong'],
        'properties' => [
            'scores' => ['type' => 'object', 'additionalProperties' => false, 'required' => ['R1', 'R2', 'R3', 'R4'],
                'properties' => ['R1' => ['type' => ['integer', 'null']], 'R2' => ['type' => ['integer', 'null']], 'R3' => ['type' => ['integer', 'null']], 'R4' => ['type' => ['integer', 'null']]]],
            'total' => ['type' => 'integer'], 'max' => ['type' => 'integer'],
            'verdict' => ['type' => 'string', 'enum' => ['sound', 'partial', 'unsound', 'unsupported']],
            'coaching' => ['type' => 'string'], 'formal' => ['type' => 'string'],
            'flags_wrong' => ['type' => 'array', 'items' => ['type' => 'string']],
        ],
    ];
}

// Sanitise the request we forward: only the §5.3 fields, bounded sizes. The hidden world never passes through here.
function wj_clean_request(array $in): ?array {
    $sq = function ($v) { return is_array($v) && count($v) === 2 && is_int($v[0]) && is_int($v[1]) && $v[0] >= 1 && $v[0] <= 4 && $v[1] >= 1 && $v[1] <= 4 ? [$v[0], $v[1]] : null; };
    $target = $sq($in['target_square'] ?? null);
    $current = $sq($in['current_square'] ?? null);
    if (!$target || !$current) return null;
    $hist = [];
    foreach (($in['percept_history'] ?? []) as $h) {
        $s = $sq($h['square'] ?? null); if (!$s) continue;
        $ps = array_values(array_filter(array_map('strval', (array)($h['percepts'] ?? [])), fn($p) => in_array($p, ['breeze', 'stench', 'glitter', 'bump', 'scream'], true)));
        $hist[] = ['square' => $s, 'percepts' => $ps];
        if (count($hist) > 40) break;
    }
    if (!$hist) return null;
    $visited = [];
    foreach (($in['visited'] ?? []) as $v) { $s = $sq($v); if ($s) $visited[] = $s; if (count($visited) > 16) break; }
    $flags = [];
    foreach ((array)($in['student_flags'] ?? []) as $k => $v) {
        if (!preg_match('/^[1-4],[1-4]$/', (string)$k)) continue;
        $v = strtoupper(substr((string)$v, 0, 14));
        if (in_array($v, ['SAFE', 'PIT?', 'WUMPUS?', 'PIT?+WUMPUS?'], true)) $flags[$k] = $v;
    }
    $just = trim((string)($in['justification'] ?? ''));
    if (mb_strlen($just) > 1200) $just = mb_substr($just, 0, 1200);
    $action = in_array($in['action'] ?? 'move', ['move', 'shoot', 'retreat'], true) ? $in['action'] : 'move';
    $mv = (int)($in['move_number'] ?? 1);
    $out = [
        'target_square' => $target, 'current_square' => $current, 'move_number' => max(1, min(200, $mv)),
        'percept_history' => $hist, 'visited' => $visited ?: array_map(fn($h) => $h['square'], $hist),
        'student_flags' => $flags ?: new stdClass(), 'justification' => $just,
    ];
    if ($action === 'shoot') {
        $out['action'] = 'shoot';
        $out['note'] = 'The student is firing their single arrow and claims the Wumpus is at target_square. Grade the justification of THAT claim (where the Wumpus is), using the same four dimensions.';
    } elseif ($action === 'retreat') {
        $out['action'] = 'retreat';
        $out['note'] = 'The student is retreating to an already-visited square and chose to justify it anyway. Grade normally.';
    }
    return $out;
}

// Some models flatten the schema ({"R1":1,...} at top level). Accept both shapes.
function wj_shape(?array $j): ?array {
    if (!is_array($j)) return null;
    if (isset($j['scores']) && is_array($j['scores'])) return $j;
    if (array_key_exists('R1', $j) || array_key_exists('R2', $j)) {
        $j['scores'] = ['R1' => $j['R1'] ?? null, 'R2' => $j['R2'] ?? null, 'R3' => $j['R3'] ?? null, 'R4' => $j['R4'] ?? null];
        return $j;
    }
    return null;
}
function wj_parse_verdict(string $text): ?array {
    $text = trim($text);
    if ($text === '') return null;
    if ($v = wj_shape(json_decode($text, true))) return $v;
    if (preg_match('/```(?:json)?\s*([\s\S]*?)```/', $text, $m)) { if ($v = wj_shape(json_decode(trim($m[1]), true))) return $v; }
    if (preg_match('/\{[\s\S]*\}/', $text, $m)) {
        // take the outermost {...}; trim trailing junk progressively
        $s = $m[0];
        for ($i = 0; $i < 3; $i++) { if ($v = wj_shape(json_decode($s, true))) return $v; $p = strrpos($s, '}', -2); if ($p === false) break; $s = substr($s, 0, $p + 1); }
    }
    return null;
}

// PROMPT.md "Client-side validation": recompute totals, force R3 null on move 1, truncate coaching.
function wj_normalise(array $v, array $req): array {
    $s = [];
    foreach (['R1', 'R2', 'R3', 'R4'] as $k) {
        $x = $v['scores'][$k] ?? null;
        if ($x === true) $x = 1; if ($x === false) $x = 0;
        $s[$k] = ($x === 1 || $x === 0 || $x === '1' || $x === '0') ? (int)$x : null;
    }
    $distinct = count(array_unique(array_map(fn($h) => $h['square'][0] . ',' . $h['square'][1], $req['percept_history'])));
    if (($req['move_number'] ?? 1) === 1 || $distinct < 2) $s['R3'] = null;
    foreach (['R1', 'R2', 'R4'] as $k) if ($s[$k] === null) $s[$k] = 0;
    $dims = array_filter(['R1', 'R2', 'R3', 'R4'], fn($d) => $s[$d] !== null);
    $total = 0; foreach ($dims as $d) $total += $s[$d];
    $max = count($dims);
    $verdict = in_array($v['verdict'] ?? '', ['sound', 'partial', 'unsound', 'unsupported'], true) ? $v['verdict'] : ($total === $max ? 'sound' : ($total === 0 ? 'unsupported' : 'partial'));
    if ($total === $max) $verdict = 'sound';
    $coaching = trim((string)($v['coaching'] ?? ''));
    if (mb_strlen($coaching) > 300) $coaching = mb_substr($coaching, 0, 297) . '…';
    $formal = mb_substr((string)($v['formal'] ?? ''), 0, 200);
    $fw = [];
    foreach ((array)($v['flags_wrong'] ?? []) as $f) if (preg_match('/^[1-4],[1-4]$/', (string)$f)) $fw[] = (string)$f;
    return ['scores' => $s, 'total' => $total, 'max' => $max, 'verdict' => $verdict, 'coaching' => $coaching, 'formal' => $formal, 'flags_wrong' => $fw];
}

// Tutor prompt for the optional "Explain" button — plain text, not the judge's JSON contract.
function wj_explain_prompt(): string {
    return "You are a patient tutor in a first-year AI course. A student is playing a Wumpus World game where every move must be justified in English and a judge scores the justification on four dimensions: R1 cites evidence (a real percept at a visited square), R2 valid single-step inference (percept + adjacency rule, adjacent = up/down/left/right only, never diagonal), R3 combines information (two or more observations, or eliminating a candidate using an already-safe square), R4 honest certainty (definite words only for proved facts, hedged words for unproved ones). Absence of breeze at a square proves no pit in any adjacent square; absence of stench proves no Wumpus adjacent.\n\nYou receive: the student's percept history (everything they know), the move they want to make, their sentence, the judge's scores, a FACTS block, the game transcript so far, and possibly a follow-up question with earlier tutor turns.\n\nFACTS were derived by a verified rule engine from the student's own percepts. They are ground truth. Never contradict them; if your own reasoning disagrees with a fact, the fact wins and you must use it. In particular: every square listed under 'Unvisited squares you have already proved safe' IS proved safe (a square next to a visited square with no breeze and no stench is proved safe) — never call such a square unknown or unproved. Before you answer, silently check every square you are about to mention against the FACTS. Build your explanation on them and on what the student wrote in earlier moves.\n\nDefault task: in at most 160 words, addressed as 'you': (1) what you can and cannot conclude right now, tied to the specific squares; (2) for each dimension that scored 0, one sentence on what was missing from THIS sentence; (3) one improved sentence the student could have written. If 'question' is present, answer that question instead, in at most 120 words, staying inside the facts. If 'style' is 'different', give a fresh explanation with a different angle (for example a step-by-step chain, or a what-if the percept had been different) rather than repeating the earlier tutor turns.\n\nPlain text, no markdown, no JSON. Never guess or reveal where the pits, the Wumpus or the gold really are; you do not know.";
}

// Provider call with a model fallback chain (non-OpenRouter providers; OpenRouter does its own via body.models).
// The primary model gets primary_timeout_s (default 20 s); on any failure except a rejected key (401/403) the next
// model in fallback_models is tried. 2026-10-03: NVIDIA retired nemotron-3-super without notice → primary
// nemotron-3-ultra, fallback gpt-oss-20b, so one model disappearing never takes the tutor/judge down again.
function wj_call_provider(array $p, array $req, int $timeout, ?string $modelOverride = null, ?string $keyOverride = null, bool $plainText = false): array {
    $chain = ($modelOverride || str_contains((string)$p['base_url'], 'openrouter')) ? [] : array_values(array_filter((array)($p['fallback_models'] ?? []), 'is_string'));
    if (!$chain) return wj_call_provider_once($p, $req, $timeout, $modelOverride, $keyOverride, $plainText);
    $r = wj_call_provider_once($p, $req, max(5, min($timeout, (int)($p['primary_timeout_s'] ?? 20))), null, $keyOverride, $plainText);
    $tried = [];
    foreach ($chain as $fb) {
        if ($r['ok'] || in_array($r['http'], [401, 403], true)) break;
        $tried[] = $r['model'] . ': ' . $r['error'];
        $r2 = wj_call_provider_once($p, $req, $timeout, $fb, $keyOverride, $plainText);
        $r2['ms'] += $r['ms']; $r2['fallback_from'] = $tried; $r = $r2;
    }
    return $r;
}

// One provider call. Returns ['ok'=>bool,'http'=>int,'ms'=>int,'verdict'=>?array,'error'=>string,'model'=>string,'raw_len'=>int]
function wj_call_provider_once(array $p, array $req, int $timeout, ?string $modelOverride = null, ?string $keyOverride = null, bool $plainText = false): array {
    $model = $modelOverride ?: (string)$p['model'];
    $apiKey = $keyOverride !== null && $keyOverride !== '' ? $keyOverride : (string)$p['key'];
    $body = [
        'model' => $model,
        'temperature' => (float)($p['temperature'] ?? 0.2),
        'max_tokens' => (int)($p['max_tokens'] ?? 900),
        'messages' => [
            ['role' => 'system', 'content' => $plainText ? wj_explain_prompt() : wj_system_prompt()],
            ['role' => 'user', 'content' => json_encode($req, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)],
        ],
    ];
    $jm = $p['json_mode'] ?? 'none';
    if ($plainText) $jm = 'none';
    if ($jm === 'json_schema') $body['response_format'] = ['type' => 'json_schema', 'json_schema' => ['name' => 'verdict', 'strict' => true, 'schema' => wj_schema()]];
    elseif ($jm === 'json_object') $body['response_format'] = ['type' => 'json_object'];
    if (!$modelOverride && !empty($p['fallback_models']) && str_contains((string)$p['base_url'], 'openrouter')) $body['models'] = array_values($p['fallback_models']);
    $extra = $p['extra_body'] ?? [];
    if (is_object($extra)) $extra = (array)$extra;
    if (is_array($extra)) foreach ($extra as $k => $v) $body[$k] = $v;

    $headers = ['Content-Type: application/json', 'Authorization: Bearer ' . $apiKey, 'Accept: application/json'];
    if (str_contains((string)$p['base_url'], 'openrouter')) { $headers[] = 'HTTP-Referer: https://kiranvk.me'; $headers[] = 'X-Title: Wumpus Justify (PECST522)'; }

    $ch = curl_init(rtrim((string)$p['base_url'], '/') . '/chat/completions');
    curl_setopt_array($ch, [
        CURLOPT_POST => true, CURLOPT_POSTFIELDS => json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
        CURLOPT_HTTPHEADER => $headers, CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => $timeout, CURLOPT_CONNECTTIMEOUT => 8, CURLOPT_SSL_VERIFYPEER => true,
    ]);
    $t0 = microtime(true);
    $raw = curl_exec($ch);
    $ms = (int)round((microtime(true) - $t0) * 1000);
    $http = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $cerr = curl_error($ch);
    curl_close($ch);
    $out = ['ok' => false, 'http' => $http, 'ms' => $ms, 'verdict' => null, 'error' => '', 'model' => $model, 'raw_len' => is_string($raw) ? strlen($raw) : 0];
    if ($raw === false) { $out['error'] = 'curl: ' . substr($cerr, 0, 120); return $out; }
    if ($http === 429) { $out['error'] = 'rate-limited (429)'; return $out; }
    if ($http < 200 || $http >= 300) {
        $j = json_decode((string)$raw, true);
        $msg = $j['error']['message'] ?? $j['message'] ?? $j['detail'] ?? substr((string)$raw, 0, 160);
        $out['error'] = 'http ' . $http . ': ' . substr(is_string($msg) ? $msg : json_encode($msg), 0, 160);
        return $out;
    }
    $j = json_decode((string)$raw, true);
    $content = $j['choices'][0]['message']['content'] ?? null;
    if (is_array($content)) { $content = implode('', array_map(fn($c) => $c['text'] ?? '', $content)); }
    if (!is_string($content) || trim($content) === '') { $out['error'] = 'empty content (finish=' . ($j['choices'][0]['finish_reason'] ?? '?') . ')'; return $out; }
    if ($plainText) { $out['ok'] = true; $out['text'] = mb_substr(trim($content), 0, 1200); if (!empty($j['model'])) $out['model'] = (string)$j['model']; return $out; }
    $v = wj_parse_verdict($content);
    if (!$v) { $out['error'] = 'parse-failure'; return $out; }
    $out['ok'] = true; $out['verdict'] = wj_normalise($v, $req);
    if (!empty($j['model'])) $out['model'] = (string)$j['model'];
    return $out;
}

function wj_provider_today(array $u, string $id): array {
    $d = $u['days'][wj_today()][$id] ?? [];
    return $d + ['calls' => 0, 'ok' => 0, 'fail' => 0, 'lat' => []];
}

function wj_pctile(array $xs, int $p): int {
    if (!$xs) return 0; sort($xs); $i = (int)floor($p / 100 * count($xs)); return (int)$xs[min(count($xs) - 1, $i)];
}

// Lecturer session: set by lecturer/index.php (same credentials as the dashboard), read by judge.php.
// Cookie path covers /ai/wumpus/ so the game's requests carry it; the admin session is separate (wjadmin).
function wj_lecturer_session_start(): void {
    if (session_status() === PHP_SESSION_ACTIVE) return;
    session_name('wjlect');
    session_set_cookie_params(['lifetime' => 60 * 60 * 12, 'path' => '/ai/wumpus/', 'httponly' => true, 'secure' => !empty($_SERVER['HTTPS']), 'samesite' => 'Lax']);
    session_start();
}
function wj_is_lecturer(array $cfg): bool {
    return !empty($_SESSION['lect']) && $cfg['admin_hash'] !== '' && hash_equals(hash('sha256', $cfg['admin_hash']), (string)$_SESSION['lect']);
}
// A student's own key: validated by shape only, used for one call, never stored or logged.
function wj_valid_user_key(string $k): bool { return (bool)preg_match('/^nvapi-[A-Za-z0-9_\-]{20,120}$/', $k); }
function wj_provider_by_id(array $cfg, string $id): ?array { foreach ($cfg['providers'] as $p) if ($p['id'] === $id) return $p; return null; }

function wj_json(array $o, int $code = 200): void {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($o, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}
