<?php
// Wumpus Justify — maintainer dashboard. Password-protected; keys are stored server-side and only ever shown masked.
declare(strict_types=1);
require dirname(__DIR__) . '/lib.php';
session_name('wjadmin');
session_set_cookie_params(['lifetime' => 0, 'path' => '/ai/wumpus/admin/', 'httponly' => true, 'secure' => !empty($_SERVER['HTTPS']), 'samesite' => 'Lax']);
session_start();
header('X-Frame-Options: DENY'); header('X-Content-Type-Options: nosniff'); header('Cache-Control: no-store'); header('Referrer-Policy: no-referrer');

$cfg = wj_load_config();
$flash = []; $testResult = null; $modelList = null;
$h = fn($s) => htmlspecialchars((string)$s, ENT_QUOTES, 'UTF-8');
$csrf = $_SESSION['csrf'] ?? ($_SESSION['csrf'] = bin2hex(random_bytes(16)));
$authed = !empty($_SESSION['auth']) && $_SESSION['auth'] === hash('sha256', $cfg['admin_hash']);

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $act = $_POST['action'] ?? '';
    if ($act === 'login') {
        $ipk = wj_ip_hash();
        $blocked = wj_with_usage(function (&$u) use ($ipk) { $b = $u['login_fail'][$ipk] ?? ['t' => time(), 'n' => 0]; return $b['n'] >= 8 && $b['t'] > time() - 900; });
        if ($blocked) $flash[] = ['err', 'Too many failed logins. Wait 15 minutes.'];
        elseif ($cfg['admin_hash'] !== '' && hash_equals((string)$cfg['admin_user'], trim((string)($_POST['username'] ?? ''))) && password_verify((string)($_POST['password'] ?? ''), $cfg['admin_hash'])) {
            session_regenerate_id(true); $_SESSION['auth'] = hash('sha256', $cfg['admin_hash']); $authed = true;
            wj_with_usage(function (&$u) use ($ipk) { unset($u['login_fail'][$ipk]); return true; });
        } else {
            wj_with_usage(function (&$u) use ($ipk) { $b = $u['login_fail'][$ipk] ?? ['t' => time(), 'n' => 0]; if ($b['t'] < time() - 900) $b = ['t' => time(), 'n' => 0]; $b['n']++; $b['t'] = time(); $u['login_fail'][$ipk] = $b; return true; });
            $flash[] = ['err', 'Wrong username or password.'];
        }
    } elseif (!$authed) {
        $flash[] = ['err', 'Not signed in.'];
    } elseif (!hash_equals($csrf, (string)($_POST['csrf'] ?? ''))) {
        $flash[] = ['err', 'Form expired, try again.'];
    } else {
        switch ($act) {
            case 'logout': session_destroy(); header('Location: ./'); exit;
            case 'access':
                $cfg['access_mode'] = in_array($_POST['access_mode'] ?? '', ['off', 'code', 'open', 'byok'], true) ? $_POST['access_mode'] : 'open';
                $cfg['lecturer_code'] = trim((string)($_POST['lecturer_code'] ?? ''));
                $cfg['ip_per_minute'] = max(1, min(120, (int)($_POST['ip_per_minute'] ?? 8)));
                $cfg['timeout_s'] = max(5, min(60, (int)($_POST['timeout_s'] ?? 25)));
                $cfg['byok_model'] = trim((string)($_POST['byok_model'] ?? '')) ?: 'nvidia/nemotron-3-super-120b-a12b:free';
                wj_save_config($cfg); $flash[] = ['ok', 'Access settings saved.']; break;
            case 'world':
                $mode = ($_POST['cw_mode'] ?? 'fresh') === 'pinned' ? 'pinned' : 'fresh';
                $world = in_array($_POST['cw_world'] ?? '', ['canonical', 'fork', 'cruel', 'random'], true) ? $_POST['cw_world'] : 'canonical';
                $seed = max(1, min(999999999, (int)($_POST['cw_seed'] ?? 1234)));
                $cfg['class_world'] = ['mode' => $mode, 'world' => $world, 'seed' => $seed];
                wj_save_config($cfg); $flash[] = ['ok', $mode === 'pinned' ? "Class cave pinned: " . ($world === 'random' ? "random seed $seed" : $world) . "." : 'Public game opens with a fresh random cave on every load.'];
                break;
            case 'provider':
                $id = (string)($_POST['id'] ?? '');
                foreach ($cfg['providers'] as &$p) {
                    if ($p['id'] !== $id) continue;
                    $p['label'] = trim((string)($_POST['label'] ?? $p['label'])) ?: $p['label'];
                    $bu = trim((string)($_POST['base_url'] ?? '')); if (preg_match('#^https://[^\s]+$#', $bu)) $p['base_url'] = rtrim($bu, '/');
                    $p['model'] = trim((string)($_POST['model'] ?? $p['model'])) ?: $p['model'];
                    $p['fallback_models'] = array_values(array_filter(array_map('trim', explode(',', (string)($_POST['fallback_models'] ?? '')))));
                    $p['daily_cap'] = max(0, min(100000, (int)($_POST['daily_cap'] ?? 0)));
                    $p['minute_cap'] = max(1, min(1000, (int)($_POST['minute_cap'] ?? 20)));
                    $p['json_mode'] = in_array($_POST['json_mode'] ?? '', ['none', 'json_object', 'json_schema'], true) ? $_POST['json_mode'] : 'none';
                    $p['max_tokens'] = max(200, min(8000, (int)($_POST['max_tokens'] ?? 900)));
                    $p['temperature'] = max(0, min(1.5, (float)($_POST['temperature'] ?? 0.2)));
                    $eb = trim((string)($_POST['extra_body'] ?? ''));
                    if ($eb === '' || $eb === '{}') $p['extra_body'] = new stdClass();
                    else { $j = json_decode($eb, true); if (is_array($j)) $p['extra_body'] = $j; else $flash[] = ['err', 'extra_body is not valid JSON — left unchanged.']; }
                    $p['enabled'] = !empty($_POST['enabled']);
                    $newKey = trim((string)($_POST['key'] ?? ''));
                    if (!empty($_POST['clear_key'])) $p['key'] = '';
                    elseif ($newKey !== '') $p['key'] = $newKey;
                    $flash[] = ['ok', "Provider “{$p['label']}” saved."];
                }
                unset($p); wj_save_config($cfg); break;
            case 'move':
                $id = (string)($_POST['id'] ?? ''); $dir = $_POST['dir'] === 'up' ? -1 : 1;
                $ids = array_column($cfg['providers'], 'id'); $i = array_search($id, $ids, true);
                if ($i !== false && isset($cfg['providers'][$i + $dir])) { $tmp = $cfg['providers'][$i]; $cfg['providers'][$i] = $cfg['providers'][$i + $dir]; $cfg['providers'][$i + $dir] = $tmp; wj_save_config($cfg); }
                break;
            case 'test':
                $id = (string)($_POST['id'] ?? '');
                foreach ($cfg['providers'] as $p) if ($p['id'] === $id) {
                    if ($p['key'] === '') { $flash[] = ['err', 'No key set for ' . $p['label']]; break; }
                    $sample = [
                        'target_square' => [1, 2], 'current_square' => [1, 1], 'move_number' => 3,
                        'percept_history' => [['square' => [1, 1], 'percepts' => []], ['square' => [2, 1], 'percepts' => ['breeze']]],
                        'visited' => [[1, 1], [2, 1]], 'student_flags' => ['1,2' => 'SAFE'],
                        'justification' => (string)($_POST['justification'] ?: 'The breeze at [2,1] means a pit is in [1,1], [2,2] or [3,1]. But [1,1] is where I started and I already know it is safe, so the pit is in [2,2] or [3,1]. [1,2] is not one of those, and [1,1] had no stench so no wumpus next to it either. [1,2] is safe.'),
                    ];
                    $r = wj_call_provider($p, $sample, max(5, min(60, (int)$cfg['timeout_s'])), trim((string)($_POST['model'] ?? '')) ?: null);
                    wj_with_usage(function (&$u) use ($id, $r) { $u['events'][] = ['t' => wj_now_iso(), 'p' => $id . ' (test)', 'model' => $r['model'], 'http' => $r['http'], 'ms' => $r['ms'], 'ok' => $r['ok'], 'err' => $r['error']]; return true; });
                    $testResult = ['provider' => $p['label'], 'expect' => 'R1=1 R2=1 R3=1 R4=1 (bench case C1)'] + $r;
                }
                break;
            case 'models':
                $id = (string)($_POST['id'] ?? '');
                foreach ($cfg['providers'] as $p) if ($p['id'] === $id) {
                    $ch = curl_init(rtrim($p['base_url'], '/') . '/models');
                    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 20, CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . $p['key']]]);
                    $raw = curl_exec($ch); $code = curl_getinfo($ch, CURLINFO_RESPONSE_CODE); curl_close($ch);
                    $j = json_decode((string)$raw, true);
                    $rows = [];
                    foreach (($j['data'] ?? []) as $m) {
                        $pr = $m['pricing'] ?? null;
                        $free = $pr ? ((float)($pr['prompt'] ?? 1) == 0 && (float)($pr['completion'] ?? 1) == 0) : null;
                        $rows[] = ['id' => (string)($m['id'] ?? ''), 'free' => $free, 'ctx' => $m['context_length'] ?? null];
                    }
                    usort($rows, fn($a, $b) => strcmp($a['id'], $b['id']));
                    $modelList = ['provider' => $p['label'], 'http' => $code, 'rows' => $rows, 'error' => $rows ? '' : substr((string)$raw, 0, 200)];
                }
                break;
            case 'password':
                $np = (string)($_POST['new_password'] ?? '');
                $nu = trim((string)($_POST['new_username'] ?? ''));
                if ($nu !== '' && !preg_match('/^[A-Za-z0-9_.@-]{3,40}$/', $nu)) { $flash[] = ['err', 'Username: 3–40 letters, digits, _ . @ -']; break; }
                if ($np !== '' && strlen($np) < 10) { $flash[] = ['err', 'Password must be at least 10 characters.']; break; }
                if ($nu === '' && $np === '') { $flash[] = ['err', 'Nothing to change.']; break; }
                if ($nu !== '') $cfg['admin_user'] = $nu;
                if ($np !== '') $cfg['admin_hash'] = password_hash($np, PASSWORD_DEFAULT);
                wj_save_config($cfg); $_SESSION['auth'] = hash('sha256', $cfg['admin_hash']); $flash[] = ['ok', 'Login credentials updated.'];
                break;
        }
    }
}

$u = wj_read_usage();
$today = wj_today();
$days = [];
for ($i = 6; $i >= 0; $i--) { $d = (new DateTime('now', new DateTimeZone(WJ_TZ)))->modify("-$i day")->format('Y-m-d'); $days[$d] = $u['days'][$d] ?? []; }
$sumDay = function (array $d, string $k) { $t = 0; foreach ($d as $id => $v) if (!in_array($id, ['local', 'byok', 'blocked', 'explain'], true)) $t += (int)($v[$k] ?? 0); return $t; };
$maxCalls = 1; foreach ($days as $d) $maxCalls = max($maxCalls, $sumDay($d, 'calls') + (int)($d['local']['calls'] ?? 0));
?><!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Wumpus Justify — Maintainer</title>
<style>
:root{--bg:#1a1a2e;--bg2:#16213e;--bg3:#0f3460;--accent:#d4a853;--accent2:#e8c77b;--text:#e8e8e8;--text-dim:#a0a0b0;--danger:#e74c3c;--success:#2ecc71;--line:#2b3a5e;--font:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;--mono:'SF Mono','Fira Code',Consolas,monospace}
*{box-sizing:border-box}body{margin:0;font-family:var(--font);background:var(--bg);color:var(--text);line-height:1.5;padding:0 16px 40px}
header{padding:1rem 0 .6rem;border-bottom:2px solid var(--accent);display:flex;flex-wrap:wrap;gap:.5rem 1rem;align-items:baseline;justify-content:space-between}
h1{font-size:1.3rem;margin:0;color:var(--accent)}h2{font-size:1.05rem;color:var(--accent2);margin:1.6rem 0 .6rem;border-bottom:1px solid var(--line);padding-bottom:.25rem}
.wrap{max-width:1080px;margin:0 auto}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:.8rem 0}
.tile{background:var(--bg2);border:1px solid var(--line);border-radius:8px;padding:.6rem .8rem}.tile b{display:block;font-size:1.5rem;font-weight:600}.tile span{color:var(--text-dim);font-size:.8rem}
.card{background:var(--bg2);border:1px solid var(--line);border-radius:8px;padding:.8rem 1rem;margin:.6rem 0}
table{border-collapse:collapse;width:100%;font-size:.86rem}th,td{text-align:left;padding:.3rem .5rem;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--text-dim);font-weight:500}
.scroll{overflow-x:auto}
input[type=text],input[type=password],input[type=number],input[type=url],select,textarea{width:100%;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:.4rem .5rem;font:inherit;font-size:.9rem}
textarea{font-family:var(--mono);font-size:.8rem;min-height:3.2em}
label{display:block;font-size:.78rem;color:var(--text-dim);margin-top:.45rem}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:.4rem .8rem}
button{background:var(--bg3);color:var(--text);border:1px solid var(--accent);border-radius:6px;padding:.4rem .8rem;font:inherit;cursor:pointer}button.primary{background:var(--accent);color:#1a1a2e;font-weight:600}button.small{padding:.15rem .5rem;font-size:.8rem}
.row{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;margin-top:.6rem}
.flash{padding:.5rem .8rem;border-radius:6px;margin:.5rem 0}.flash.ok{background:rgba(46,204,113,.15);border:1px solid var(--success)}.flash.err{background:rgba(231,76,60,.15);border:1px solid var(--danger)}
.ok{color:var(--success)}.bad{color:var(--danger)}.dim{color:var(--text-dim)}
.bars{display:flex;align-items:flex-end;gap:6px;height:90px;padding:4px 0 0}.bars .b{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:2px;font-size:.7rem;color:var(--text-dim)}.bars .b i{display:block;width:70%;max-width:38px;background:var(--accent);border-radius:4px 4px 0 0}.bars .b i.l{background:var(--bg3);border-top:2px solid var(--accent2);border-radius:0}
code,pre{font-family:var(--mono);font-size:.8rem}pre{background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:.6rem;overflow-x:auto;white-space:pre-wrap}
.badge{display:inline-block;padding:.05rem .45rem;border-radius:10px;font-size:.72rem;border:1px solid var(--line);color:var(--text-dim)}.badge.on{border-color:var(--success);color:var(--success)}
.wgrid{display:grid;grid-template-columns:repeat(4,64px);gap:3px;background:var(--line);padding:3px;border-radius:8px}.wc{position:relative;height:64px;background:#0e1a33;border-radius:5px;display:flex;align-items:center;justify-content:center;font-size:1.5rem}.wc .co{position:absolute;top:2px;left:4px;font-family:var(--mono);font-size:.6rem;color:var(--text-dim)}.wc .pp{position:absolute;bottom:2px;right:5px;font-family:var(--mono);font-size:.7rem;color:var(--accent2)}
@media(max-width:480px){.wgrid{grid-template-columns:repeat(4,56px)}.wc{height:56px;font-size:1.2rem}}
details summary{cursor:pointer;color:var(--accent2)}
@media(max-width:480px){.tile b{font-size:1.2rem}}
</style></head><body><div class="wrap">
<header><h1>🐲 Wumpus Justify — maintainer</h1><div class="dim" style="font-size:.8rem">v<?= WJ_VERSION ?> · <?= $h(wj_now_iso()) ?> IST · <a style="color:var(--accent2)" href="../">open game</a></div></header>
<?php foreach ($flash as [$k, $m]) echo '<div class="flash ' . $k . '">' . $h($m) . '</div>'; ?>
<?php if ($cfg['admin_hash'] === ''): ?>
<div class="card"><h2>Not configured</h2><p>No maintainer password is set. Over SSH run:</p><pre>cd ~/kiranvk.me/ai/wumpus && php admin/setup.php --user kiran --password 'choose-a-long-password'</pre></div>
<?php elseif (!$authed): ?>
<div class="card" style="max-width:380px;margin:2rem auto"><h2 style="margin-top:0">Sign in</h2>
<form method="post"><input type="hidden" name="action" value="login"><label>Username</label><input type="text" name="username" autofocus autocomplete="username" autocapitalize="off"><label>Password</label><input type="password" name="password" autocomplete="current-password"><div class="row"><button class="primary">Sign in</button></div></form></div>
<?php else: ?>
<?php
$tToday = $u['days'][$today] ?? [];
$llmCalls = $sumDay($tToday, 'calls'); $llmOk = $sumDay($tToday, 'ok'); $llmFail = $sumDay($tToday, 'fail');
$localCalls = (int)($tToday['local']['calls'] ?? 0); $byok = (int)($tToday['byok']['calls'] ?? 0); $blocked = (int)($tToday['blocked']['calls'] ?? 0);
$allLat = []; foreach ($tToday as $id => $v) if (!in_array($id, ['local', 'byok', 'blocked', 'explain'], true)) $allLat = array_merge($allLat, $v['lat'] ?? []);
$modeLabel = ['off' => 'AI coach OFF (local rules only; lecturer login still works)', 'code' => 'AI coach: lecturer login / code only', 'open' => 'AI coach: server key for everyone (rate-limited)', 'byok' => 'AI coach: students bring their own NVIDIA key; server key only behind the lecturer login'][$cfg['access_mode']] ?? $cfg['access_mode'];
?>
<div class="tiles">
<div class="tile"><b><?= $llmCalls ?></b><span>AI verdicts today · <span class="ok">✓ <?= $llmOk ?></span> · <span class="bad">✗ <?= $llmFail ?></span></span></div>
<div class="tile"><b><?= $localCalls ?></b><span>local-rule verdicts today · <?= (int)($tToday['explain']['calls'] ?? 0) ?> AI explanations</span></div>
<div class="tile"><b><?= $allLat ? wj_pctile($allLat, 50) . '<small style="font-size:.8rem"> ms</small>' : '—' ?></b><span>p50 latency · p95 <?= $allLat ? wj_pctile($allLat, 95) . ' ms' : '—' ?></span></div>
<div class="tile"><b><?= $byok ?></b><span>student-key (BYOK) verdicts today · <span class="ok">✓ <?= (int)($tToday['byok']['ok'] ?? 0) ?></span> · <span class="bad">✗ <?= (int)($tToday['byok']['fail'] ?? 0) ?></span> · <?= $blocked ?> rate-limited</span></div>
</div>
<div class="card"><strong><?= $h($modeLabel) ?></strong> · providers in order:
<?php foreach ($cfg['providers'] as $p) { $t = wj_provider_today($u, $p['id']); $on = !empty($p['enabled']) && $p['key'] !== ''; echo ' <span class="badge' . ($on ? ' on' : '') . '">' . $h($p['label']) . ' ' . ($on ? $t['calls'] . '/' . $p['daily_cap'] : ($p['key'] === '' ? 'no key' : 'off')) . '</span>'; } ?>
</div>

<h2>Last 7 days</h2>
<div class="card">
<div class="bars" role="img" aria-label="Verdicts per day, last 7 days">
<?php foreach ($days as $d => $v) { $ai = $sumDay($v, 'calls'); $lo = (int)($v['local']['calls'] ?? 0); ?>
<div class="b" title="<?= $d ?>: <?= $ai ?> AI, <?= $lo ?> local"><i style="height:<?= max(2, (int)round(60 * $ai / $maxCalls)) ?>px" title="AI <?= $ai ?>"></i><i class="l" style="height:<?= (int)round(60 * $lo / $maxCalls) ?>px" title="local <?= $lo ?>"></i><?= substr($d, 5) ?></div>
<?php } ?>
</div>
<div class="dim" style="font-size:.75rem">solid gold bar = AI verdicts · outlined bar = local-rule verdicts (client tally). Hover a bar for the numbers.</div>
<div class="scroll"><table><tr><th>day</th><?php foreach ($cfg['providers'] as $p) echo '<th>' . $h($p['label']) . ' ok/fail</th>'; ?><th>local</th><th>blocked</th></tr>
<?php foreach (array_reverse($days, true) as $d => $v) { echo '<tr><td>' . $d . '</td>'; foreach ($cfg['providers'] as $p) { $x = $v[$p['id']] ?? []; echo '<td>' . (int)($x['ok'] ?? 0) . ' / ' . (int)($x['fail'] ?? 0) . '</td>'; } echo '<td>' . (int)($v['local']['calls'] ?? 0) . '</td><td>' . (int)($v['blocked']['calls'] ?? 0) . '</td></tr>'; } ?>
</table></div></div>

<h2>Class cave — what the public game opens with</h2>
<?php $cw = $cfg['class_world'] ?? ['mode' => 'fresh', 'world' => 'canonical', 'seed' => 1234]; ?>
<div class="card"><form method="post" id="cw-form"><input type="hidden" name="action" value="world"><input type="hidden" name="csrf" value="<?= $csrf ?>">
<div class="grid">
<div><label>Mode</label><select name="cw_mode" id="cw-mode"><option value="fresh" <?= $cw['mode'] === 'fresh' ? 'selected' : '' ?>>fresh — a new random cave on every load (students explore)</option><option value="pinned" <?= $cw['mode'] === 'pinned' ? 'selected' : '' ?>>pinned — everyone plays ONLY the cave chosen below; other caves and ?seed links are disabled for the public</option></select></div>
<div><label>World</label><select name="cw_world" id="cw-world"><?php foreach (['canonical' => 'Canonical (matches slide 5)', 'fork' => 'Fork', 'cruel' => 'Cruel', 'random' => 'Random (seeded)'] as $k => $l) echo '<option value="' . $k . '"' . ($cw['world'] === $k ? ' selected' : '') . '>' . $l . '</option>'; ?></select></div>
<div><label>Seed (for Random)</label><div class="row" style="margin:0;flex-wrap:nowrap"><input type="number" name="cw_seed" id="cw-seed" value="<?= (int)$cw['seed'] ?>" min="1"><button type="button" class="small" id="cw-dice" title="new random seed">🎲</button></div></div>
</div>
<div class="row"><button class="primary">Save class cave</button><span class="dim" id="cw-link"></span></div></form>
<div class="row" style="align-items:flex-start;margin-top:.8rem;gap:1.2rem">
  <div><div class="dim" style="font-size:.78rem;margin-bottom:.3rem">Preview — hidden contents of the selected cave (never shown to players)</div><div class="wgrid" id="cw-grid"></div></div>
  <div class="dim" style="font-size:.8rem;max-width:360px"><div><span class="wk">👹</span> Wumpus · <span class="wk">🕳️</span> pit · <span class="wk">💰</span> gold · <span class="wk">🚶</span> start</div><div>Small letters are what a player will sense on that square: <b>B</b> breeze, <b>S</b> stench. Squares are <code>[column,row]</code>, <code>[1,1]</code> bottom-left, as on the slide.</div><div style="margin-top:.4rem">Change the world or seed above and the preview updates before you save. In <b>pinned</b> mode the public start screen shows only this cave (no seed field, no other worlds, links with <code>?seed=</code>/<code>?world=</code> ignored). Your own lecturer session keeps the full picker.</div><div id="cw-fair" style="margin-top:.4rem"></div></div>
</div></div>
<script src="../wumpus-core.js?v=<?= (int)@filemtime(dirname(__DIR__) . '/wumpus-core.js') ?>"></script>
<script>
(function () {
  const W = window.WumpusCore; const $ = (s) => document.querySelector(s);
  function draw() {
    const id = $('#cw-world').value, seed = Number($('#cw-seed').value) || 1234;
    const w = W.getWorld(id, seed); const g = $('#cw-grid'); g.innerHTML = '';
    for (let r = 4; r >= 1; r--) for (let c = 1; c <= 4; c++) {
      const sq = [c, r]; const d = document.createElement('div'); d.className = 'wc';
      const ps = W.perceptsAt(sq, w).filter((p) => p !== 'glitter');
      let inner = '<span class="co">[' + c + ',' + r + ']</span>';
      if (W.eq(sq, w.wumpus)) inner += '👹'; else if (w.pits.some((p) => W.eq(p, sq))) inner += '🕳️'; else if (W.eq(sq, w.gold)) inner += '💰'; else if (W.eq(sq, w.start)) inner += '🚶';
      inner += '<span class="pp">' + ps.map((p) => p[0].toUpperCase()).join(' ') + '</span>';
      d.innerHTML = inner; g.appendChild(d);
    }
    $('#cw-seed').parentElement.parentElement.style.opacity = id === 'random' ? 1 : .5;
    const mode = $('#cw-mode').value;
    $('#cw-link').innerHTML = mode === 'pinned' ? 'share link: <code>https://kiranvk.me/ai/wumpus/' + (id === 'random' ? '?seed=' + seed : '?world=' + id) + '</code>' : '';
    $('#cw-fair').textContent = (id === 'random' ? 'Seed ' + seed + ': ' : w.name + ': ') + 'Wumpus at [' + w.wumpus + '], pits at ' + w.pits.map((p) => '[' + p + ']').join(', ') + ', gold at [' + w.gold + ']. Start square has no percepts and both its neighbours are safe (guaranteed by the generator).';
  }
  ['#cw-world', '#cw-seed', '#cw-mode'].forEach((s) => $(s).addEventListener('input', draw));
  $('#cw-dice').onclick = () => { $('#cw-seed').value = String(1000 + Math.floor(Math.random() * 899999)); $('#cw-world').value = 'random'; draw(); };
  draw();
})();
</script>

<h2>Access</h2>
<div class="card"><form method="post"><input type="hidden" name="action" value="access"><input type="hidden" name="csrf" value="<?= $csrf ?>">
<div class="grid">
<div><label>Who gets the AI coach</label><select name="access_mode">
<option value="byok" <?= $cfg['access_mode'] === 'byok' ? 'selected' : '' ?>>byok — students use their own NVIDIA key; server key only behind the lecturer login</option>
<option value="open" <?= $cfg['access_mode'] === 'open' ? 'selected' : '' ?>>open — server key for every player, within caps</option>
<option value="code" <?= $cfg['access_mode'] === 'code' ? 'selected' : '' ?>>code — only players who enter the lecturer code (class mode)</option>
<option value="off" <?= $cfg['access_mode'] === 'off' ? 'selected' : '' ?>>off — local rules only</option></select></div>
<div><label>Lecturer login: <a style="color:var(--accent2)" href="../lecturer/">/ai/wumpus/lecturer/</a> (same username + password as this dashboard) — or a code players type in ⚙ settings</label><input type="text" name="lecturer_code" value="<?= $h($cfg['lecturer_code']) ?>" autocomplete="off"></div>
<div><label>Per-IP requests per minute</label><input type="number" name="ip_per_minute" value="<?= (int)$cfg['ip_per_minute'] ?>" min="1" max="120"></div>
<div><label>Upstream timeout (seconds)</label><input type="number" name="timeout_s" value="<?= (int)$cfg['timeout_s'] ?>" min="5" max="60"></div>
<div><label>Default model for “bring your own OpenRouter key”</label><input type="text" name="byok_model" value="<?= $h($cfg['byok_model']) ?>"></div>
</div><div class="row"><button class="primary">Save access settings</button></div></form></div>

<h2>Providers (tried in this order; a failure or exhausted cap falls through to the next)</h2>
<?php foreach ($cfg['providers'] as $i => $p) { $t = wj_provider_today($u, $p['id']); ?>
<div class="card"><form method="post"><input type="hidden" name="action" value="provider"><input type="hidden" name="csrf" value="<?= $csrf ?>"><input type="hidden" name="id" value="<?= $h($p['id']) ?>">
<div class="row" style="margin-top:0;justify-content:space-between"><strong><?= $i + 1 ?>. <?= $h($p['label']) ?></strong>
<span class="dim">today <?= $t['calls'] ?>/<?= (int)$p['daily_cap'] ?> · ✓<?= $t['ok'] ?> ✗<?= $t['fail'] ?> · p50 <?= $t['lat'] ? wj_pctile($t['lat'], 50) . 'ms' : '—' ?> · key <code><?= $h(wj_mask_key((string)$p['key'])) ?></code></span></div>
<div class="grid">
<div><label>Label</label><input type="text" name="label" value="<?= $h($p['label']) ?>"></div>
<div><label>Base URL (OpenAI-compatible, ends in /v1)</label><input type="url" name="base_url" value="<?= $h($p['base_url']) ?>"></div>
<div><label>Model</label><input type="text" name="model" value="<?= $h($p['model']) ?>" list="models-<?= $h($p['id']) ?>"></div>
<div><label>Fallback models (comma-separated; OpenRouter only, server-side chain)</label><input type="text" name="fallback_models" value="<?= $h(implode(', ', $p['fallback_models'] ?? [])) ?>"></div>
<div><label>Daily cap (calls)</label><input type="number" name="daily_cap" value="<?= (int)$p['daily_cap'] ?>" min="0"></div>
<div><label>Per-minute cap</label><input type="number" name="minute_cap" value="<?= (int)$p['minute_cap'] ?>" min="1"></div>
<div><label>JSON mode</label><select name="json_mode"><?php foreach (['none' => 'none (prompt only)', 'json_object' => 'json_object', 'json_schema' => 'json_schema (strict)'] as $k => $l) echo '<option value="' . $k . '"' . ($p['json_mode'] === $k ? ' selected' : '') . '>' . $l . '</option>'; ?></select></div>
<div><label>max_tokens (reasoning models spend these on thinking)</label><input type="number" name="max_tokens" value="<?= (int)$p['max_tokens'] ?>" min="200"></div>
<div><label>temperature</label><input type="number" step="0.1" name="temperature" value="<?= $h($p['temperature']) ?>" min="0" max="1.5"></div>
<div><label>New API key (leave blank to keep)</label><input type="password" name="key" autocomplete="new-password" placeholder="paste to replace"></div>
</div>
<label>extra_body JSON (merged into the request, e.g. {"reasoning":{"effort":"low"}})</label><textarea name="extra_body"><?= $h(json_encode((object)($p['extra_body'] ?? []), JSON_UNESCAPED_SLASHES)) ?></textarea>
<div class="row"><label style="margin:0"><input type="checkbox" name="enabled" <?= !empty($p['enabled']) ? 'checked' : '' ?>> enabled</label><label style="margin:0"><input type="checkbox" name="clear_key"> clear key</label>
<button class="primary">Save</button></div></form>
<div class="row">
<form method="post" style="display:contents"><input type="hidden" name="action" value="move"><input type="hidden" name="csrf" value="<?= $csrf ?>"><input type="hidden" name="id" value="<?= $h($p['id']) ?>"><button class="small" name="dir" value="up" <?= $i === 0 ? 'disabled' : '' ?>>▲ earlier</button><button class="small" name="dir" value="down" <?= $i === count($cfg['providers']) - 1 ? 'disabled' : '' ?>>▼ later</button></form>
<form method="post" style="display:contents"><input type="hidden" name="action" value="models"><input type="hidden" name="csrf" value="<?= $csrf ?>"><input type="hidden" name="id" value="<?= $h($p['id']) ?>"><button class="small">List models</button></form>
<form method="post" style="display:flex;gap:.4rem;flex-wrap:wrap;align-items:center"><input type="hidden" name="action" value="test"><input type="hidden" name="csrf" value="<?= $csrf ?>"><input type="hidden" name="id" value="<?= $h($p['id']) ?>"><input type="text" name="model" placeholder="model override (optional)" style="width:220px"><button class="small primary">Test judge (1 call)</button></form>
</div>
<?php if ($modelList && $modelList['provider'] === $p['label']) { ?>
<details open><summary><?= count($modelList['rows']) ?> models (HTTP <?= (int)$modelList['http'] ?>)<?= $modelList['error'] ? ' — ' . $h($modelList['error']) : '' ?></summary><div class="scroll" style="max-height:260px;overflow:auto"><table><tr><th>id</th><th>free?</th><th>ctx</th></tr>
<?php foreach ($modelList['rows'] as $m) echo '<tr><td><code>' . $h($m['id']) . '</code></td><td>' . ($m['free'] === null ? '?' : ($m['free'] ? '<span class="ok">free</span>' : 'paid')) . '</td><td>' . $h($m['ctx'] ?? '') . '</td></tr>'; ?></table></div></details>
<datalist id="models-<?= $h($p['id']) ?>"><?php foreach ($modelList['rows'] as $m) echo '<option value="' . $h($m['id']) . '">'; ?></datalist>
<?php } ?>
<?php if ($testResult && $testResult['provider'] === $p['label']) { ?>
<div class="flash <?= $testResult['ok'] ? 'ok' : 'err' ?>"><strong><?= $testResult['ok'] ? '✓ verdict received' : '✗ failed' ?></strong> · <?= $h($testResult['model']) ?> · HTTP <?= (int)$testResult['http'] ?> · <?= (int)$testResult['ms'] ?> ms<?= $testResult['error'] ? ' · ' . $h($testResult['error']) : '' ?><br><span class="dim">expected: <?= $h($testResult['expect']) ?></span>
<pre><?= $h(json_encode($testResult['verdict'], JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)) ?></pre></div>
<?php } ?>
</div>
<?php } ?>

<h2>Recent upstream events (no student text is ever stored)</h2>
<div class="card scroll"><table><tr><th>time (IST)</th><th>provider</th><th>model</th><th>HTTP</th><th>ms</th><th>result</th></tr>
<?php foreach (array_reverse(array_slice($u['events'], -40)) as $e) echo '<tr><td>' . $h($e['t']) . '</td><td>' . $h($e['p']) . '</td><td><code>' . $h($e['model'] ?? '') . '</code></td><td>' . (int)$e['http'] . '</td><td>' . (int)$e['ms'] . '</td><td>' . ($e['ok'] ? '<span class="ok">✓ ok</span>' : '<span class="bad">✗ ' . $h($e['err']) . '</span>') . '</td></tr>'; if (!$u['events']) echo '<tr><td colspan="6" class="dim">nothing yet</td></tr>'; ?>
</table></div>

<h2>Maintainer login</h2>
<div class="card"><form method="post" class="row"><input type="hidden" name="action" value="password"><input type="hidden" name="csrf" value="<?= $csrf ?>"><input type="text" name="new_username" placeholder="username (now: <?= $h($cfg['admin_user']) ?>)" style="max-width:220px" autocomplete="off"><input type="password" name="new_password" placeholder="new password (10+ chars)" style="max-width:300px" autocomplete="new-password"><button>Update</button></form>
<form method="post" class="row"><input type="hidden" name="action" value="logout"><input type="hidden" name="csrf" value="<?= $csrf ?>"><button>Sign out</button></form>
<p class="dim" style="font-size:.78rem">Config: <code><?= $h(wj_config_dir()) ?>/config.json</code> (outside the web root, 0600). Keys never leave the server; the game page only ever receives verdicts.</p></div>
<?php endif; ?>
</div></body></html>
