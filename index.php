<?php
// Cache-bust wrapper for Wumpus Justify (same pattern as /ai/8queens and /ai/vacuum)
header('Cache-Control: no-cache, must-revalidate');
header('Content-Type: text/html; charset=UTF-8');
$v = max((int)@filemtime(__DIR__ . '/wumpus-core.js'), (int)@filemtime(__DIR__ . '/wumpus-logic.js')) ?: time();
$prompt = @file_get_contents(__DIR__ . '/judge-prompt.txt') ?: '';
require_once __DIR__ . '/lib.php';
$cfgw = wj_load_config();
wj_lecturer_session_start();
$classWorld = json_encode(['class_world' => $cfgw['class_world'] ?? ['mode' => 'fresh'], 'lecturer' => wj_is_lecturer($cfgw)], JSON_UNESCAPED_SLASHES);
echo str_replace(['{{V}}', '{{PROMPT}}', '{{CLASS_WORLD}}'], [(string)$v, str_replace('</script', '', trim($prompt)), str_replace('</script', '', $classWorld)], (string)file_get_contents(__DIR__ . '/game.html'));
