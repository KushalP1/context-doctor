/**
 * `context-doctor dashboard` — a local savings dashboard.
 *
 * Serves one self-contained page on localhost from data already on this
 * machine: the activity ledger, recent session profiles, and the proxy's
 * /stats when it is running. No network calls, no accounts, no telemetry —
 * the server reads local files and answers only the loopback interface.
 */
import http from "node:http";
import { readLedger } from "./ledger.js";
import { listSessions, parseSessionFile } from "./session.js";
import { parseConversation } from "./parse.js";
import { profileConversation } from "./profile.js";
import { inputCostUsd, pricingFor } from "./pricing.js";
import { checkBudget, loadConfig } from "./config.js";
/** Sessions bigger than this are skipped so the page stays responsive. */
const MAX_SESSION_BYTES = 30 * 1024 * 1024;
async function fetchProxyStats(port) {
    try {
        const res = await fetch(`http://127.0.0.1:${port}/stats`, { signal: AbortSignal.timeout(400) });
        if (!res.ok)
            return null;
        return (await res.json());
    }
    catch {
        return null;
    }
}
export async function collectDashboardData(proxyPort = 8787) {
    const ledger = readLedger();
    const checks = ledger.filter((e) => e.ev === "check" || e.ev === undefined);
    const optimizes = ledger.filter((e) => e.ev === "optimize");
    // Observed shrinkage: a session getting SMALLER between two deep checks is a
    // real reduction, so it counts alongside explicit optimize runs.
    const perSession = new Map();
    for (const c of checks) {
        if (!c.sid || typeof c.tok !== "number")
            continue;
        perSession.set(c.sid, [...(perSession.get(c.sid) ?? []), c.tok]);
    }
    let shrinkage = 0;
    for (const toks of perSession.values()) {
        for (let i = 1; i < toks.length; i++)
            if (toks[i] < toks[i - 1])
                shrinkage += toks[i - 1] - toks[i];
    }
    const optimizeSaved = optimizes.reduce((s, e) => s + (e.saved ?? 0), 0);
    let usdSaved = 0;
    for (const e of optimizes) {
        const pricing = pricingFor(e.model);
        if (pricing && e.saved)
            usdSaved += inputCostUsd(e.saved, pricing);
    }
    // Daily series: optimize savings bucketed by local date.
    const byDay = new Map();
    for (const e of optimizes) {
        if (!e.saved)
            continue;
        const day = new Date(e.ts).toISOString().slice(0, 10);
        byDay.set(day, (byDay.get(day) ?? 0) + e.saved);
    }
    const daily = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, saved]) => ({ date, saved }));
    const sessions = [];
    for (const s of listSessions(8)) {
        if (s.sizeBytes > MAX_SESSION_BYTES)
            continue;
        try {
            const parsed = parseSessionFile(s.path);
            if (parsed.messageCount === 0)
                continue;
            const p = profileConversation(parseConversation(parsed.conversationJson), parsed.model);
            sessions.push({
                title: parsed.title ?? (s.path.split("/").pop() ?? "session").slice(0, 24),
                tokens: p.totalTokens,
                waste: p.totalEstSavings,
                model: parsed.model,
            });
        }
        catch {
            /* unreadable session — skip */
        }
    }
    const proxy = await fetchProxyStats(proxyPort);
    const loaded = loadConfig();
    let budget = null;
    if (loaded.path && loaded.config.budget && sessions.length > 0) {
        const biggest = sessions.reduce((a, b) => (b.tokens > a.tokens ? b : a));
        const verdict = checkBudget(loaded.config.budget, { totalTokens: biggest.tokens });
        budget = { path: loaded.path, overBudget: verdict.overBudget, breaches: verdict.breaches };
    }
    return {
        generatedAt: new Date().toISOString(),
        totals: {
            tokensSaved: optimizeSaved + shrinkage + (proxy?.tokensSaved ?? 0),
            usdSaved: usdSaved + (proxy?.estUsdSaved ?? 0),
            checks: checks.length,
            warnings: checks.filter((c) => c.warn).length,
            optimizeRuns: optimizes.length,
        },
        daily,
        sessions,
        proxy,
        budget,
    };
}
export function startDashboard(opts = {}) {
    const port = opts.port ?? 8790;
    const server = http.createServer(async (req, res) => {
        try {
            if ((req.url ?? "").startsWith("/api/data")) {
                const data = await collectDashboardData(opts.proxyPort);
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify(data));
                return;
            }
            res.setHeader("content-type", "text/html; charset=utf-8");
            res.end(PAGE);
        }
        catch (e) {
            res.statusCode = 500;
            res.end(`dashboard error: ${e.message}`);
        }
    });
    // Loopback only: this page exposes local usage data.
    server.listen(port, "127.0.0.1", () => {
        console.error(`context-doctor dashboard on http://127.0.0.1:${port}`);
    });
    return server;
}
/**
 * The page. Self-contained (no external requests), renders inline SVG from
 * /api/data. Palette, mark specs and interaction follow the house data-viz
 * rules: fixed-order categorical slots, thin marks with 4px rounded data-ends,
 * 2px surface gaps, legend + direct labels for the two-series chart, hover
 * tooltips, a table view, and dark steps selected for the dark surface.
 */
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>context-doctor dashboard</title>
<style>
  :root {
    color-scheme: light;
    --surface-1: #fcfcfb;
    --surface-2: #f4f3f0;
    --border: #e2e1dc;
    --text-primary: #0b0b0b;
    --text-secondary: #52514e;
    --text-muted: #75746f;
    --series-1: #2a78d6;
    --series-2: #eb6834;
    --good: #0ca30c;
    --critical: #d03b3b;
  }
  @media (prefers-color-scheme: dark) {
    :root:where(:not([data-theme="light"])) {
      color-scheme: dark;
      --surface-1: #1a1a19;
      --surface-2: #232322;
      --border: #383835;
      --text-primary: #ffffff;
      --text-secondary: #c3c2b7;
      --text-muted: #9b9a92;
      --series-1: #3987e5;
      --series-2: #d95926;
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --surface-1: #1a1a19;
    --surface-2: #232322;
    --border: #383835;
    --text-primary: #ffffff;
    --text-secondary: #c3c2b7;
    --text-muted: #9b9a92;
    --series-1: #3987e5;
    --series-2: #d95926;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px 24px 64px;
    background: var(--surface-1); color: var(--text-primary);
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .wrap { max-width: 940px; margin: 0 auto; }
  header { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
  h1 { font-size: 20px; margin: 0; letter-spacing: -0.01em; }
  .sub { color: var(--text-muted); font-size: 13px; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin: 24px 0 8px; }
  .tile { background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
  .tile .label { font-size: 12px; color: var(--text-secondary); }
  .tile .value { font-size: 26px; font-weight: 600; letter-spacing: -0.02em; margin-top: 2px; font-variant-numeric: tabular-nums; }
  .tile .note { font-size: 12px; color: var(--text-muted); margin-top: 2px; }
  section { margin-top: 28px; }
  h2 { font-size: 14px; font-weight: 600; margin: 0 0 2px; }
  .caption { font-size: 12.5px; color: var(--text-secondary); margin: 0 0 12px; }
  .legend { display: flex; gap: 14px; font-size: 12.5px; color: var(--text-secondary); margin-bottom: 8px; }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  .swatch { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
  .empty { color: var(--text-muted); font-size: 13px; background: var(--surface-2); border: 1px dashed var(--border); border-radius: 10px; padding: 16px; }
  svg { display: block; width: 100%; height: auto; overflow: visible; }
  .grid-line { stroke: var(--border); stroke-width: 1; }
  .axis-text { fill: var(--text-muted); font-size: 11px; }
  .label-text { fill: var(--text-secondary); font-size: 12px; }
  .value-text { fill: var(--text-primary); font-size: 12px; font-variant-numeric: tabular-nums; }
  .tip {
    position: fixed; pointer-events: none; opacity: 0; transition: opacity .1s;
    background: var(--surface-1); color: var(--text-primary);
    border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px;
    font-size: 12.5px; box-shadow: 0 6px 20px rgba(0,0,0,.12); z-index: 10; white-space: nowrap;
  }
  table { border-collapse: collapse; width: 100%; font-size: 13px; margin-top: 10px; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--border); }
  th { color: var(--text-secondary); font-weight: 600; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  details summary { cursor: pointer; font-size: 12.5px; color: var(--text-secondary); margin-top: 10px; }
  .banner { border-radius: 10px; padding: 12px 14px; font-size: 13px; margin-top: 18px; border: 1px solid; }
  .banner.ok { border-color: var(--good); color: var(--text-primary); }
  .banner.over { border-color: var(--critical); color: var(--text-primary); }
  footer { margin-top: 36px; color: var(--text-muted); font-size: 12px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>context-doctor</h1>
      <div class="sub" id="generated">loading local data…</div>
    </div>
    <div class="sub">everything on this page is read from your machine</div>
  </header>

  <div class="tiles" id="tiles"></div>
  <div id="budget"></div>

  <section>
    <h2>Tokens saved per day</h2>
    <p class="caption">Optimizations applied through the CLI and in-chat tools.</p>
    <div id="daily"></div>
  </section>

  <section>
    <h2>Recent sessions: context in use and still recoverable</h2>
    <p class="caption">Each bar is one session. The second segment is what optimization would still reclaim today.</p>
    <div class="legend">
      <span><i class="swatch" style="background: var(--series-1)"></i>In use</span>
      <span><i class="swatch" style="background: var(--series-2)"></i>Recoverable</span>
    </div>
    <div id="sessions"></div>
    <details>
      <summary>Table view</summary>
      <div id="sessionsTable"></div>
    </details>
  </section>

  <footer id="proxyNote"></footer>
</div>
<div class="tip" id="tip"></div>

<script>
const tip = document.getElementById('tip');
const fmtTokens = (n) => n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e4 ? Math.round(n/1e3)+'k' : n >= 1e3 ? (n/1e3).toFixed(1)+'k' : String(Math.round(n));
const fmtUsd = (n) => n >= 1 ? '$'+n.toFixed(2) : n >= 0.01 ? '$'+n.toFixed(3) : '$'+n.toFixed(4);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

function bindTip(el, html) {
  el.addEventListener('pointerenter', (e) => { tip.innerHTML = html; tip.style.opacity = '1'; move(e); });
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerleave', () => { tip.style.opacity = '0'; });
  function move(e) { tip.style.left = (e.clientX + 14) + 'px'; tip.style.top = (e.clientY - 12) + 'px'; }
}

function renderTiles(d) {
  const t = d.totals;
  const tiles = [
    { label: 'Tokens saved', value: fmtTokens(t.tokensSaved), note: t.optimizeRuns + ' optimization run(s)' },
    { label: 'Estimated cost saved', value: t.usdSaved > 0 ? fmtUsd(t.usdSaved) : '—', note: t.usdSaved > 0 ? 'input tokens, priced per model' : 'no priced runs yet (model not recorded)' },
    { label: 'Context checks', value: String(t.checks), note: t.warnings + ' warning(s) delivered' },
    { label: 'Sessions tracked', value: String(d.sessions.length), note: 'most recent on this machine' },
  ];
  document.getElementById('tiles').innerHTML = tiles.map((x) =>
    '<div class="tile"><div class="label">' + esc(x.label) + '</div><div class="value">' + esc(x.value) +
    '</div><div class="note">' + esc(x.note) + '</div></div>').join('');
}

function renderDaily(rows) {
  const host = document.getElementById('daily');
  if (!rows.length) {
    host.innerHTML = '<div class="empty">No optimizations recorded yet. Run <code>context-doctor optimize</code>, or ask Claude to optimize a conversation, and this fills in.</div>';
    return;
  }
  const W = 900, H = 220, padL = 52, padR = 12, padB = 34, padT = 10;
  const max = Math.max(...rows.map((r) => r.saved));
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const slot = innerW / rows.length;
  const barW = Math.max(6, Math.min(48, slot - 8)); // 2px+ surface gap between bars
  const ticks = [0, max / 2, max];
  let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Tokens saved per day">';
  for (const tk of ticks) {
    const y = padT + innerH - (tk / max) * innerH;
    svg += '<line class="grid-line" x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '"/>';
    svg += '<text class="axis-text" x="' + (padL - 8) + '" y="' + (y + 4) + '" text-anchor="end">' + fmtTokens(tk) + '</text>';
  }
  rows.forEach((r, i) => {
    const h = Math.max(2, (r.saved / max) * innerH);
    const x = padL + i * slot + (slot - barW) / 2;
    const y = padT + innerH - h;
    // 4px rounded data-end, square foot on the baseline.
    const rad = Math.min(4, h);
    svg += '<path data-i="' + i + '" fill="var(--series-1)" d="M' + x + ' ' + (y + rad) +
      ' a' + rad + ' ' + rad + ' 0 0 1 ' + rad + ' -' + rad +
      ' h' + (barW - 2 * rad) +
      ' a' + rad + ' ' + rad + ' 0 0 1 ' + rad + ' ' + rad +
      ' v' + (h - rad) + ' h-' + barW + ' z"/>';
    if (rows.length <= 10) {
      svg += '<text class="axis-text" x="' + (x + barW / 2) + '" y="' + (H - padB + 18) + '" text-anchor="middle">' + esc(r.date.slice(5)) + '</text>';
    }
  });
  svg += '<line class="grid-line" x1="' + padL + '" y1="' + (padT + innerH) + '" x2="' + (W - padR) + '" y2="' + (padT + innerH) + '"/>';
  svg += '</svg>';
  host.innerHTML = svg;
  host.querySelectorAll('path[data-i]').forEach((el) => {
    const r = rows[Number(el.getAttribute('data-i'))];
    bindTip(el, '<strong>' + esc(r.date) + '</strong><br>' + fmtTokens(r.saved) + ' tokens saved');
  });
}

function renderSessions(rows) {
  const host = document.getElementById('sessions');
  if (!rows.length) {
    host.innerHTML = '<div class="empty">No session transcripts found on this machine yet.</div>';
    return;
  }
  const W = 900, rowH = 34, padL = 200, padR = 96, padT = 6;
  const H = padT + rows.length * rowH + 8;
  const max = Math.max(...rows.map((r) => r.tokens));
  const innerW = W - padL - padR;
  let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Recent sessions by context size">';
  rows.forEach((r, i) => {
    const y = padT + i * rowH + 7;
    const barH = 16, rad = 4;
    const usedTok = Math.max(0, r.tokens - r.waste);
    const totalW = (r.tokens / max) * innerW;
    const usedW = Math.max(rad, (usedTok / max) * innerW);
    const wasteW = Math.max(0, totalW - usedW - 2); // 2px surface gap between segments
    svg += '<text class="label-text" x="0" y="' + (y + 12) + '">' + esc(r.title.slice(0, 30)) + '</text>';
    svg += '<rect data-u="' + i + '" x="' + padL + '" y="' + y + '" width="' + usedW + '" height="' + barH + '" rx="' + rad + '" fill="var(--series-1)"/>';
    if (wasteW > 1) {
      svg += '<rect data-w="' + i + '" x="' + (padL + usedW + 2) + '" y="' + y + '" width="' + wasteW + '" height="' + barH + '" rx="' + rad + '" fill="var(--series-2)"/>';
    }
    svg += '<text class="value-text" x="' + (W - padR + 8) + '" y="' + (y + 12) + '">' + fmtTokens(r.tokens) + '</text>';
  });
  svg += '</svg>';
  host.innerHTML = svg;
  host.querySelectorAll('rect[data-u]').forEach((el) => {
    const r = rows[Number(el.getAttribute('data-u'))];
    bindTip(el, '<strong>' + esc(r.title) + '</strong><br>' + fmtTokens(r.tokens - r.waste) + ' tokens in use' + (r.model ? '<br>' + esc(r.model) : ''));
  });
  host.querySelectorAll('rect[data-w]').forEach((el) => {
    const r = rows[Number(el.getAttribute('data-w'))];
    bindTip(el, '<strong>' + esc(r.title) + '</strong><br>' + fmtTokens(r.waste) + ' tokens recoverable');
  });
  document.getElementById('sessionsTable').innerHTML =
    '<table><thead><tr><th>Session</th><th class="num">Total</th><th class="num">In use</th><th class="num">Recoverable</th></tr></thead><tbody>' +
    rows.map((r) => '<tr><td>' + esc(r.title) + '</td><td class="num">' + fmtTokens(r.tokens) + '</td><td class="num">' +
      fmtTokens(r.tokens - r.waste) + '</td><td class="num">' + fmtTokens(r.waste) + '</td></tr>').join('') +
    '</tbody></table>';
}

function renderBudget(b) {
  const host = document.getElementById('budget');
  if (!b) { host.innerHTML = ''; return; }
  host.innerHTML = b.overBudget
    ? '<div class="banner over"><strong>Over budget</strong> (' + esc(b.path) + '): ' + esc(b.breaches.join('; ')) + '</div>'
    : '<div class="banner ok"><strong>Within budget</strong> (' + esc(b.path) + ')</div>';
}

fetch('/api/data').then((r) => r.json()).then((d) => {
  document.getElementById('generated').textContent = 'generated ' + new Date(d.generatedAt).toLocaleString();
  renderTiles(d);
  renderBudget(d.budget);
  renderDaily(d.daily);
  renderSessions(d.sessions);
  document.getElementById('proxyNote').textContent = d.proxy
    ? 'Proxy running: ' + d.proxy.optimizedRequests + ' of ' + d.proxy.requests + ' requests optimized, ' + fmtTokens(d.proxy.tokensSaved) + ' tokens saved this run.'
    : 'Proxy not running — start it with "context-doctor proxy" to add exact per-request savings here.';
}).catch((e) => {
  document.getElementById('generated').textContent = 'could not load local data: ' + e.message;
});
</script>
</body>
</html>`;
