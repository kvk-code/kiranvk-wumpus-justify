<?php
// CLI only: set/reset the maintainer password and (optionally) provider keys without touching the web UI.
//   php admin/setup.php --password 'NewPass'                # set dashboard password
//   php admin/setup.php --user kiran                       # set dashboard username
//   php admin/setup.php --set-key nvidia 'nvapi-...' --enable nvidia --model nvidia <model-id>
//   php admin/setup.php --show                              # print config (keys masked)
declare(strict_types=1);
if (PHP_SAPI !== 'cli') { http_response_code(403); exit('cli only'); }
require dirname(__DIR__) . '/lib.php';
$cfg = wj_load_config();
$argv = $_SERVER['argv'];
for ($i = 1; $i < count($argv); $i++) {
    switch ($argv[$i]) {
        case '--password': $cfg['admin_hash'] = password_hash($argv[++$i], PASSWORD_DEFAULT); echo "password set\n"; break;
        case '--user': $cfg['admin_user'] = $argv[++$i]; echo "username set\n"; break;
        case '--model': $id = $argv[++$i]; $m = $argv[++$i]; foreach ($cfg['providers'] as &$p) if ($p['id'] === $id) $p['model'] = $m; unset($p); echo "model set for $id\n"; break;
        case '--extra': $id = $argv[++$i]; $j = json_decode($argv[++$i], true); foreach ($cfg['providers'] as &$p) if ($p['id'] === $id) $p['extra_body'] = is_array($j) ? $j : new stdClass(); unset($p); echo "extra_body set for $id\n"; break;
        case '--max-tokens': $id = $argv[++$i]; $n = (int)$argv[++$i]; foreach ($cfg['providers'] as &$p) if ($p['id'] === $id) $p['max_tokens'] = $n; unset($p); echo "max_tokens set for $id\n"; break;
        case '--cap': $id = $argv[++$i]; $n = (int)$argv[++$i]; foreach ($cfg['providers'] as &$p) if ($p['id'] === $id) $p['daily_cap'] = $n; unset($p); echo "daily_cap set for $id\n"; break;
        case '--disable': $id = $argv[++$i]; foreach ($cfg['providers'] as &$p) if ($p['id'] === $id) $p['enabled'] = false; unset($p); echo "disabled $id\n"; break;
        case '--set-key': $id = $argv[++$i]; $k = $argv[++$i]; $found = false;
            foreach ($cfg['providers'] as &$p) if ($p['id'] === $id) { $p['key'] = $k; $found = true; } unset($p);
            echo $found ? "key set for $id\n" : "unknown provider $id\n"; break;
        case '--enable': $id = $argv[++$i]; foreach ($cfg['providers'] as &$p) if ($p['id'] === $id) $p['enabled'] = true; unset($p); echo "enabled $id\n"; break;
        case '--mode': $cfg['access_mode'] = in_array($argv[$i + 1], ['off', 'code', 'open', 'byok'], true) ? $argv[++$i] : $cfg['access_mode']; echo "mode {$cfg['access_mode']}\n"; break;
        case '--code': $cfg['lecturer_code'] = $argv[++$i]; echo "lecturer code set\n"; break;
        case '--show': $c = $cfg; $c['admin_hash'] = $c['admin_hash'] ? '(set)' : '(none)'; foreach ($c['providers'] as &$p) $p['key'] = wj_mask_key((string)$p['key']); unset($p);
            echo json_encode($c, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), "\n"; echo "config dir: ", wj_config_dir(), "\n"; break;
    }
}
wj_save_config($cfg);
echo "saved to ", wj_config_dir(), "/config.json\n";
