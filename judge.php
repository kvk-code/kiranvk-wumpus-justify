<?php
// Wumpus Justify — LLM judge proxy. Holds the provider keys server-side (config lives outside the web root).
// POST JSON {§5.3 request fields, action?, access_code?, user_key?}  → {ok:true, verdict, provider, model, ms} | {ok:false, reason}
//   user_key = a student's own NVIDIA NIM key: relayed for that one call with the server's model/settings, never stored.
// POST JSON {test_key:"nvapi-..."}                           → {ok, ms, model, error}  (one tiny call to validate a student's key)
// POST JSON {tally:"local"}                                → 204 (counts a local-judge decision; no text is sent)
// GET  ?info=1                                             → public status: is an AI coach available right now
declare(strict_types=1);
require __DIR__ . '/lib.php';
header('X-Content-Type-Options: nosniff');

$cfg = wj_load_config();
wj_lecturer_session_start();
$lect = wj_is_lecturer($cfg);

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'GET') {
    $avail = false; $label = '';
    $u = wj_read_usage();
    if ($cfg['access_mode'] !== 'off') {
        foreach ($cfg['providers'] as $p) {
            if (empty($p['enabled']) || empty($p['key'])) continue;
            $t = wj_provider_today($u, $p['id']);
            if ($t['calls'] < (int)$p['daily_cap']) { $avail = true; $label = $p['label']; break; }
        }
    }
    $nv = wj_provider_by_id($cfg, 'nvidia');
    wj_json(['version' => WJ_VERSION, 'mode' => $cfg['access_mode'], 'available' => $avail, 'provider' => $avail ? $label : null,
        'lecturer' => $lect, 'byok_model' => $cfg['byok_model'], 'nvidia_model' => $nv ? $nv['model'] : null, 'day' => wj_today(),
        'class_world' => $cfg['class_world'] ?? ['mode' => 'fresh']]);
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') wj_json(['ok' => false, 'reason' => 'method'], 405);
$in = json_decode((string)file_get_contents('php://input'), true);
if (!is_array($in)) wj_json(['ok' => false, 'reason' => 'bad-json'], 400);

// Telemetry: count local-judge decisions (and client-side BYOK) so the dashboard shows class activity. No text.
if (isset($in['tally'])) {
    $which = in_array($in['tally'], ['local', 'byok'], true) ? $in['tally'] : 'local';
    $fmt = wj_with_usage(function (&$u) use ($which) { $d = &$u['days'][wj_today()]; $d[$which]['calls'] = ($d[$which]['calls'] ?? 0) + 1; return true; });
    http_response_code(204); exit;
}

$isLecturer = $lect || ($cfg['lecturer_code'] !== '' && hash_equals($cfg['lecturer_code'], (string)($in['access_code'] ?? '')));
$userKey = trim((string)($in['user_key'] ?? ($in['test_key'] ?? '')));
if ($userKey !== '' && !wj_valid_user_key($userKey)) wj_json(['ok' => false, 'reason' => 'bad-key', 'detail' => 'An NVIDIA NIM key looks like nvapi-… (get one at build.nvidia.com)']);
$nvidia = wj_provider_by_id($cfg, 'nvidia');

// "Test key": one tiny call with the student's key and the server's model settings
if (isset($in['test_key'])) {
    if ($userKey === '' || !$nvidia) wj_json(['ok' => false, 'reason' => 'bad-key']);
    $sample = ['target_square' => [2, 1], 'current_square' => [1, 1], 'move_number' => 1, 'percept_history' => [['square' => [1, 1], 'percepts' => []]], 'visited' => [[1, 1]], 'student_flags' => new stdClass(), 'justification' => 'No breeze and no stench at [1,1], so [2,1] has neither. Safe.'];
    $r = wj_call_provider($nvidia, $sample, max(5, min(60, (int)$cfg['timeout_s'])), null, $userKey);
    wj_with_usage(function (&$u) use ($r) { $d = &$u['days'][wj_today()]; $d['byok']['tests'] = ($d['byok']['tests'] ?? 0) + 1; $u['events'][] = ['t' => wj_now_iso(), 'p' => 'byok (key test)', 'model' => $r['model'], 'http' => $r['http'], 'ms' => $r['ms'], 'ok' => $r['ok'], 'err' => $r['error']]; return true; });
    wj_json(['ok' => $r['ok'], 'ms' => $r['ms'], 'model' => $r['model'], 'error' => $r['error'], 'verdict' => $r['verdict']]);
}

$req = wj_clean_request($in);
if (!$req) wj_json(['ok' => false, 'reason' => 'bad-request'], 400);

// "Explain": a plain-language tutor note on a verdict the student did not understand. Same key rules as judging.
$explain = !empty($in['explain']);
if ($explain) {
    $vv = is_array($in['verdict'] ?? null) ? $in['verdict'] : null;
    if (!$vv) wj_json(['ok' => false, 'reason' => 'bad-request'], 400);
    $req['judge_scores'] = ['R1' => $vv['scores']['R1'] ?? null, 'R2' => $vv['scores']['R2'] ?? null, 'R3' => $vv['scores']['R3'] ?? null, 'R4' => $vv['scores']['R4'] ?? null];
    $req['judge_verdict'] = substr((string)($vv['verdict'] ?? ''), 0, 12);
    $req['judge_coaching'] = mb_substr((string)($vv['coaching'] ?? ''), 0, 300);
    // grounding: rule-engine facts (derived from percepts only), the game log so far, and any follow-up thread
    $facts = []; foreach (array_slice((array)($in['facts'] ?? []), 0, 12) as $f) if (is_string($f)) $facts[] = mb_substr($f, 0, 500);
    if ($facts) $req['facts'] = $facts;
    $tr = []; foreach (array_slice((array)($in['transcript'] ?? []), 0, 10) as $t) if (is_array($t)) $tr[] = ['move' => (int)($t['n'] ?? 0), 'target' => is_array($t['target'] ?? null) ? $t['target'] : null, 'sentence' => mb_substr((string)($t['text'] ?? ''), 0, 300), 'scores' => (array)($t['scores'] ?? []), 'verdict' => substr((string)($t['verdict'] ?? ''), 0, 12)];
    if ($tr) $req['transcript_so_far'] = $tr;
    $q = trim((string)($in['question'] ?? '')); if ($q !== '') $req['question'] = mb_substr($q, 0, 300);
    if (($in['style'] ?? '') === 'different') $req['style'] = 'different';
    $chat = []; foreach (array_slice((array)($in['chat'] ?? []), -4) as $c) if (is_array($c)) $chat[] = ['student' => mb_substr((string)($c['q'] ?? ''), 0, 300), 'tutor' => mb_substr((string)($c['a'] ?? ''), 0, 700)];
    if ($chat) $req['earlier_tutor_turns'] = $chat;
}

if ($cfg['access_mode'] === 'off' && !$isLecturer) wj_json(['ok' => false, 'reason' => 'disabled']);
$useOwnKey = $userKey !== '' && !$isLecturer; // the lecturer's browser always uses the embedded key
if (!$useOwnKey && !$isLecturer) {
    if ($cfg['access_mode'] === 'byok') wj_json(['ok' => false, 'reason' => 'need-key']);
    if ($cfg['access_mode'] === 'code') wj_json(['ok' => false, 'reason' => 'unauthorized']);
}

// per-IP per-minute limit (hashed, daily-rotating key; lecturer code bypasses)
$ipKey = wj_ip_hash(); $minute = wj_minute_key();
$limited = wj_with_usage(function (&$u) use ($ipKey, $minute, $cfg, $isLecturer) {
    $b = $u['ip'][$ipKey] ?? ['m' => $minute, 'n' => 0];
    if ($b['m'] !== $minute) $b = ['m' => $minute, 'n' => 0];
    $b['n']++; $u['ip'][$ipKey] = $b;
    if ($isLecturer) return false;
    if ($b['n'] > (int)$cfg['ip_per_minute'] * ($useOwnKey ? 4 : 1)) { $d = &$u['days'][wj_today()]; $d['blocked']['calls'] = ($d['blocked']['calls'] ?? 0) + 1; return true; }
    return false;
});
if ($limited) wj_json(['ok' => false, 'reason' => 'too-many']);

$timeout = max(5, min(60, (int)$cfg['timeout_s']));

if ($explain) {
    // pick the key: student's own, else the first enabled server provider (lecturer / open mode)
    $p = null; $k = null;
    if ($useOwnKey) { $p = $nvidia; $k = $userKey; }
    else foreach ($cfg['providers'] as $cand) if (!empty($cand['enabled']) && $cand['key'] !== '') { $p = $cand; break; }
    if (!$p) wj_json(['ok' => false, 'reason' => 'no-provider']);
    $r = wj_call_provider($p, $req, $timeout, null, $k, true);
    wj_with_usage(function (&$u) use ($r, $useOwnKey) { $d = &$u['days'][wj_today()]; $d['explain']['calls'] = ($d['explain']['calls'] ?? 0) + 1; if (!$r['ok']) $u['events'][] = ['t' => wj_now_iso(), 'p' => ($useOwnKey ? 'byok' : 'server') . ' (explain)', 'model' => $r['model'], 'http' => $r['http'], 'ms' => $r['ms'], 'ok' => false, 'err' => $r['error']]; return true; });
    if ($r['ok']) wj_json(['ok' => true, 'text' => $r['text'], 'model' => $r['model'], 'ms' => $r['ms']]);
    wj_json(['ok' => false, 'reason' => 'upstream', 'detail' => $r['error']]);
}

// Student's own NVIDIA key: relay once with the server's model/settings. Not stored, not logged.
if ($useOwnKey) {
    if (!$nvidia) wj_json(['ok' => false, 'reason' => 'no-provider']);
    $r = wj_call_provider($nvidia, $req, $timeout, null, $userKey);
    if (!$r['ok'] && ($r['error'] === 'parse-failure' || $r['http'] >= 500 || str_starts_with($r['error'], 'empty content'))) { $r2 = wj_call_provider($nvidia, $req, $timeout, null, $userKey); $r2['ms'] += $r['ms']; if (!$r2['ok']) $r2['error'] = $r['error'] . ' / retry: ' . $r2['error']; $r = $r2; }
    wj_with_usage(function (&$u) use ($r) {
        $d = &$u['days'][wj_today()]; $d['byok']['calls'] = ($d['byok']['calls'] ?? 0) + 1;
        if ($r['ok']) $d['byok']['ok'] = ($d['byok']['ok'] ?? 0) + 1; else $d['byok']['fail'] = ($d['byok']['fail'] ?? 0) + 1;
        $d['byok']['lat'][] = $r['ms']; if (count($d['byok']['lat']) > 300) $d['byok']['lat'] = array_slice($d['byok']['lat'], -300);
        if (!$r['ok']) $u['events'][] = ['t' => wj_now_iso(), 'p' => 'byok', 'model' => $r['model'], 'http' => $r['http'], 'ms' => $r['ms'], 'ok' => false, 'err' => $r['error']];
        return true;
    });
    if ($r['ok']) wj_json(['ok' => true, 'verdict' => $r['verdict'], 'provider' => 'byok', 'label' => 'your NVIDIA key', 'model' => $r['model'], 'ms' => $r['ms']]);
    wj_json(['ok' => false, 'reason' => $r['http'] === 401 || $r['http'] === 403 ? 'key-rejected' : ($r['http'] === 429 ? 'key-rate-limited' : 'upstream'), 'detail' => $r['error']]);
}

$tried = [];
foreach ($cfg['providers'] as $p) {
    if (empty($p['enabled']) || empty($p['key'])) continue;
    $id = $p['id'];
    // reserve a slot under the caps atomically
    $allowed = wj_with_usage(function (&$u) use ($id, $p, $minute) {
        $d = &$u['days'][wj_today()][$id]; if (!is_array($d)) $d = []; $d += ['calls' => 0, 'ok' => 0, 'fail' => 0, 'lat' => [], 'min' => 0, 'min_n' => 0];
        if ($d['calls'] >= (int)$p['daily_cap']) return 'daily';
        if (($d['min'] ?? 0) !== $minute) { $d['min'] = $minute; $d['min_n'] = 0; }
        if ($d['min_n'] >= (int)$p['minute_cap']) return 'minute';
        $d['calls']++; $d['min_n']++;
        return 'ok';
    });
    if ($allowed !== 'ok') { $tried[] = "$id: cap-$allowed"; continue; }

    $r = wj_call_provider($p, $req, $timeout);
    // one retry on a transient failure (parse-failure, 5xx, empty content) before falling through to the next provider
    if (!$r['ok'] && ($r['error'] === 'parse-failure' || $r['http'] >= 500 || str_starts_with($r['error'], 'empty content'))) {
        $r2 = wj_call_provider($p, $req, $timeout);
        $r2['ms'] += $r['ms']; $r2['error'] = $r2['ok'] ? '' : $r['error'] . ' / retry: ' . $r2['error'];
        $r = $r2;
    }
    wj_with_usage(function (&$u) use ($id, $r) {
        $d = &$u['days'][wj_today()][$id]; if (!is_array($d)) $d = [];
        if ($r['ok']) $d['ok'] = ($d['ok'] ?? 0) + 1; else $d['fail'] = ($d['fail'] ?? 0) + 1;
        $d['lat'][] = $r['ms']; if (count($d['lat']) > 300) $d['lat'] = array_slice($d['lat'], -300);
        $u['events'][] = ['t' => wj_now_iso(), 'p' => $id, 'model' => $r['model'], 'http' => $r['http'], 'ms' => $r['ms'], 'ok' => $r['ok'], 'err' => $r['error']];
        return true;
    });
    if ($r['ok']) {
        wj_json(['ok' => true, 'verdict' => $r['verdict'], 'provider' => $id, 'label' => $p['label'], 'model' => $r['model'], 'ms' => $r['ms']]);
    }
    $tried[] = "$id: " . $r['error'];
}
wj_json(['ok' => false, 'reason' => $tried ? 'upstream' : 'no-provider', 'tried' => $tried]);
