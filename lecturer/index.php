<?php
// Wumpus Justify — lecturer gate. Same username/password as the maintainer dashboard.
// Signing in sets a 12-hour cookie for /ai/wumpus/ so the game uses the server's embedded AI key in this browser only.
declare(strict_types=1);
require dirname(__DIR__) . '/lib.php';
wj_lecturer_session_start();
header('X-Frame-Options: DENY'); header('Cache-Control: no-store'); header('Referrer-Policy: no-referrer');
$cfg = wj_load_config();
$h = fn($s) => htmlspecialchars((string)$s, ENT_QUOTES, 'UTF-8');
$err = '';
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    if (($_POST['action'] ?? '') === 'logout') { $_SESSION = []; session_destroy(); header('Location: ./'); exit; }
    $ipk = wj_ip_hash();
    $blocked = wj_with_usage(function (&$u) use ($ipk) { $b = $u['login_fail'][$ipk] ?? ['t' => time(), 'n' => 0]; return $b['n'] >= 8 && $b['t'] > time() - 900; });
    if ($blocked) $err = 'Too many failed logins. Wait 15 minutes.';
    elseif ($cfg['admin_hash'] !== '' && hash_equals((string)$cfg['admin_user'], trim((string)($_POST['username'] ?? ''))) && password_verify((string)($_POST['password'] ?? ''), $cfg['admin_hash'])) {
        session_regenerate_id(true); $_SESSION['lect'] = hash('sha256', $cfg['admin_hash']);
        wj_with_usage(function (&$u) use ($ipk) { unset($u['login_fail'][$ipk]); return true; });
        header('Location: /ai/wumpus/?lecturer=1'); exit;
    } else {
        wj_with_usage(function (&$u) use ($ipk) { $b = $u['login_fail'][$ipk] ?? ['t' => time(), 'n' => 0]; if ($b['t'] < time() - 900) $b = ['t' => time(), 'n' => 0]; $b['n']++; $b['t'] = time(); $u['login_fail'][$ipk] = $b; return true; });
        $err = 'Wrong username or password.';
    }
}
$signed = wj_is_lecturer($cfg);
?><!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Wumpus Justify — lecturer sign-in</title>
<style>
:root{--bg:#1a1a2e;--bg2:#16213e;--bg3:#0f3460;--accent:#d4a853;--accent2:#e8c77b;--text:#e8e8e8;--text-dim:#a0a0b0;--danger:#e74c3c;--success:#2ecc71;--line:#2b3a5e;--font:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
*{box-sizing:border-box}body{margin:0;font-family:var(--font);background:var(--bg);color:var(--text);line-height:1.5;padding:0 16px 3rem;display:flex;flex-direction:column;align-items:center}
.card{background:var(--bg2);border:1px solid var(--accent);border-radius:12px;padding:1.2rem 1.3rem;max-width:400px;width:100%;margin-top:3rem}
h1{font-size:1.2rem;color:var(--accent);margin:0 0 .3rem}p{color:var(--text-dim);font-size:.9rem}
label{display:block;font-size:.78rem;color:var(--text-dim);margin-top:.6rem}input{width:100%;font:inherit;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:.5rem .6rem}
button{font:inherit;cursor:pointer;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:#1a1a2e;font-weight:700;padding:.5rem .9rem;margin-top:.9rem}button.ghost{background:var(--bg3);color:var(--text);font-weight:400}
.err{color:var(--danger);font-size:.9rem;margin-top:.5rem}.ok{color:var(--success)}a{color:var(--accent2)}
</style></head><body>
<!-- ═══ wrap:v2-bar ═══ -->
<!-- v2-bar.html — slim v2-styled top bar injected into deep-linked game apps
     so they feel continuous with the new site. Loads its own font/color
     tokens so it works even on pages with no shared CSS. -->
<style id="v2-bar-style">
  :root { --v2b-ink:#1a1614; --v2b-paper:#f5f0e6; --v2b-accent:#c14a2b; --v2b-line:#e4dbcb; }
  #v2-bar { position: fixed; top: 0; left: 0; right: 0; z-index: 9999;
    display: flex; align-items: center; gap: 14px; padding: 10px 18px;
    background: rgba(245,240,230,.92); backdrop-filter: blur(8px);
    border-bottom: 1px solid var(--v2b-line);
    font-family: 'Instrument Serif', Georgia, serif; color: var(--v2b-ink);
    font-size: 16px; letter-spacing: -.005em;
  }
  #v2-bar .wm { font-weight: 400; font-size: 18px; text-decoration: none; color: var(--v2b-ink); }
  #v2-bar .wm span { color: var(--v2b-accent); }
  #v2-bar .sep { color: #b6a892; margin: 0 2px; }
  #v2-bar a.up { text-decoration: none; color: var(--v2b-ink); border-bottom: 1px dashed transparent; padding: 2px 0; transition: border-color .15s; }
  #v2-bar a.up:hover { border-bottom-color: var(--v2b-accent); }
  #v2-bar .spacer { flex: 1; }
  #v2-bar .search-link { font-family: 'JetBrains Mono', monospace; font-size: 12px; letter-spacing: .05em; text-transform: uppercase; color: var(--v2b-ink); text-decoration: none; padding: 4px 10px; border: 1px solid var(--v2b-line); border-radius: 999px; }
  #v2-bar .search-link:hover { border-color: var(--v2b-accent); color: var(--v2b-accent); }
  body { padding-top: 46px !important; }
  @media (max-width: 500px) { #v2-bar { font-size: 14px; padding: 8px 12px; } #v2-bar .search-link { display: none; } }
  @media print { #v2-bar { display: none; } body { padding-top: 0 !important; } }
</style>
<div id="v2-bar" role="banner">
  <a class="wm" href="/">kvk<span>.</span></a>
  <span class="sep">/</span>
  <a class="up" href="/games">Games</a>
  <div class="spacer"></div>
  <a class="search-link" href="/search">Search ⌘K</a>
</div>

<!-- ═══ wrap:v2-theme ═══ -->
<!-- v2-theme.html — full UX takeover for deep-linked apps. Overrides the
     app's own theme tokens (--bg, --text, fonts) with v2's paper aesthetic,
     while preserving game logic and DOM. Uses CSS custom-property re-declare
     so ANY selector using var(--bg) etc. now paints in paper tones.
     Safe: reduced-motion respected, print-safe, mobile-safe. -->
<style id="v2-theme-style">
  :root {
    /* --- v2 palette (paper + brick + ink) overrides whatever the app declared --- */
    --bg:  #f5f0e6 !important;
    --bg2: #ede4d0 !important;
    --bg3: #e4d8bf !important;
    --text:     #1a1614 !important;
    --text-dim: #5a4f42 !important;
    --line:     #d9cbb0 !important;
    --accent:   #c14a2b !important;
    --accent2:  #a83a1e !important;

    /* Wumpus-specific cell tokens (override game.html's dark navy) */
    --cell-unvisited: #ede4d0 !important;
    --cell-visited:   #f5eeda !important;
    --cell-current:   #fdf3d6 !important;
    --flag-safe: #3a7d3a !important;
    --flag-pit:  #c14a2b !important;
    --flag-w:    #7c3aed !important;

    /* fonts */
    --font: 'Instrument Serif', Georgia, 'Times New Roman', serif !important;
    --mono: 'JetBrains Mono', 'Courier New', monospace !important;
  }

  /* Belt-and-braces: some apps hardcode colors instead of using vars */
  html, body {
    background: #f5f0e6 !important;
    color: #1a1614 !important;
    font-family: 'Instrument Serif', Georgia, serif !important;
  }
  body * {
    /* Only kill hard-coded dark-navy backgrounds; leave whites, warms, and canvas alone */
  }

  /* Common dark-theme culprits from the AI games */
  header, .card, .world, pre.rules, section, article, aside, nav, main, footer,
  input[type=text], input[type=password], input[type=number], textarea, select {
    background: var(--bg) !important;
    color: var(--text) !important;
    border-color: var(--line) !important;
  }
  header {
    background: linear-gradient(180deg, #f5f0e6, #ede4d0) !important;
    border-bottom: 1px solid var(--accent) !important;
  }
  .card {
    background: #fdf9ef !important;
    border: 1px solid var(--line) !important;
  }
  pre, code, kbd, samp, .mono {
    font-family: var(--mono) !important;
    background: #fdf9ef !important;
    color: #2a2320 !important;
  }
  button, .btn {
    background: var(--bg2) !important;
    color: var(--text) !important;
    border: 1px solid var(--accent) !important;
    font-family: var(--font) !important;
  }
  button.primary, button.accent {
    background: var(--accent) !important;
    color: #fdf9ef !important;
    border-color: var(--accent2) !important;
    font-weight: 700 !important;
  }
  button:hover { background: var(--accent) !important; color: #fdf9ef !important; }
  .badge, .tag, .chip {
    background: rgba(193, 74, 43, 0.08) !important;
    color: var(--accent) !important;
    border: 1px solid rgba(193, 74, 43, 0.3) !important;
  }
  a { color: var(--accent) !important; }
  a:hover { color: var(--accent2) !important; }

  /* Wumpus grid — pixel-precise tile overrides (bypass --cell-* vars entirely) */
  #board .cell { background: #ede4d0 !important; color: #1a1614 !important; border-color: #d9cbb0 !important; }
  #board .cell.visited { background: #f5eeda !important; }
  #board .cell.current { background: #fdf3d6 !important; border-color: #c14a2b !important; }
  #board .cell .coord { color: #5a4f42 !important; }
  #board .cell .p span { background: rgba(193,74,43,0.10) !important; color: #a83a1e !important; }
  #board.board, #board { background: #d9cbb0 !important; }
  .world { background: #f5f0e6 !important; border-color: #d9cbb0 !important; }
  .world b { color: #c14a2b !important; }

  /* Preserve canvas/svg/img rendering — don't touch game-content pixels */
  canvas, svg, img, video { background: transparent !important; }

  /* Type scale nudge toward v2 */
  h1, h2, h3 { font-family: 'Instrument Serif', Georgia, serif !important; font-weight: 400 !important; letter-spacing: -0.01em !important; }
  h1 { color: var(--text) !important; }

  @media (prefers-reduced-motion: reduce) {
    * { animation-duration: 0.001s !important; transition-duration: 0.001s !important; }
  }
</style>

<div class="card">
<h1>🐲 Wumpus Justify — lecturer</h1>
<?php if ($signed): ?>
<p class="ok">Signed in. This browser now uses the embedded AI coach key for every move.</p>
<p><a href="../">→ Open the game</a></p>
<form method="post"><input type="hidden" name="action" value="logout"><button class="ghost">Sign out</button></form>
<?php elseif ($cfg['admin_hash'] === ''): ?>
<p class="err">Not configured: set the maintainer password first (admin/setup.php).</p>
<?php else: ?>
<p>Sign in with the maintainer credentials. Students don't need this: they add their own NVIDIA key in the game's ⚙ settings.</p>
<form method="post"><label>Username</label><input type="text" name="username" autocomplete="username" autocapitalize="off" autofocus><label>Password</label><input type="password" name="password" autocomplete="current-password"><button>Sign in</button></form>
<?php if ($err) echo '<div class="err">' . $h($err) . '</div>'; ?>
<p style="margin-top:1rem"><a href="../">← back to the game</a></p>
<?php endif; ?>
</div><!-- ═══ delight:lecturer-title-nudge BEGIN ═══ -->
<style>
/* kind:nudge trigger:hover target:.lecturer-header h1 */
@keyframes lift-nudge { 0%, 100% { transform: translateY(0); letter-spacing: 0; } 50% { transform: translateY(-2px); letter-spacing: 0.02em; } } .lecturer-header h1:hover { animation: lift-nudge 300ms ease-in-out; } @media (prefers-reduced-motion: reduce) { .lecturer-header h1:hover { animation: none; } }
</style>

<!-- ═══ delight:lecturer-title-nudge END ═══ -->
</body></html>
