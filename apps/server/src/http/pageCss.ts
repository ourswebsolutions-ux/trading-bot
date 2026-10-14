export const PAGE_CSS = `
:root{--bg:#f6f5f2;--panel:#fff;--ink:#1c1d1f;--muted:#6b6e74;--line:#e3e1dc;--line-strong:#cfccc5;--accent:#1f4e79;--accent-ink:#fff;
--ok:#1d6b46;--ok-bg:#e8f3ec;--bad:#9b2c2c;--bad-bg:#f8e9e7;--warn:#8a5a00;--warn-bg:#fbf1dc;--mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#141517;--panel:#1b1c1f;--ink:#e6e6e3;--muted:#9a9ca1;--line:#2b2d31;--line-strong:#3a3c41;--accent:#7fb2e5;--accent-ink:#0d1520;
--ok:#6fcf9b;--ok-bg:#16291f;--bad:#f09a8f;--bad-bg:#2e1a18;--warn:#e9c271;--warn-bg:#2c2412}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 -apple-system,"Segoe UI",system-ui,sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
header.top{display:flex;align-items:center;gap:24px;padding:0 24px;height:52px;border-bottom:1px solid var(--line);background:var(--panel)}
header.top .brand{font-weight:650;letter-spacing:.02em}header.top .brand span{color:var(--muted);font-weight:400}
header.top nav{display:flex;gap:4px;flex:1}header.top nav a{padding:6px 10px;border-radius:6px;color:var(--muted)}
header.top nav a.on{color:var(--ink);background:var(--bg)}header.top .who{color:var(--muted);font-size:13px;display:flex;gap:12px;align-items:center}
main{max-width:1180px;margin:0 auto;padding:28px 24px 64px}
h1{font-size:20px;margin:0 0 4px;font-weight:620}h2{font-size:15px;margin:0 0 12px;font-weight:620}
.sub{color:var(--muted);margin:0 0 24px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:20px;margin-bottom:20px}
table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;font-weight:560;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em;padding:8px 10px;border-bottom:1px solid var(--line-strong)}
td{padding:10px;border-bottom:1px solid var(--line);vertical-align:top}tr:last-child td{border-bottom:0}
.mono{font-family:var(--mono);font-size:12.5px}.muted{color:var(--muted)}.right{text-align:right}
.tabs{display:flex;gap:6px;margin-bottom:16px;flex-wrap:wrap}.tabs a{padding:6px 12px;border:1px solid var(--line);border-radius:999px;color:var(--muted);background:var(--panel)}
.tabs a.on{border-color:var(--ink);color:var(--ink)}
.badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:560;border:1px solid transparent}
.badge.pending{background:var(--warn-bg);color:var(--warn)}.badge.approved,.badge.sent{background:var(--ok-bg);color:var(--ok)}
.badge.cancelled,.badge.failed{background:var(--bad-bg);color:var(--bad)}.badge.skipped,.badge.stored,.badge.queued{border-color:var(--line-strong);color:var(--muted)}
.grid{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:20px}@media (max-width:880px){.grid{grid-template-columns:1fr}}
dl.kv{display:grid;grid-template-columns:150px 1fr;gap:8px 16px;margin:0}dl.kv dt{color:var(--muted)}dl.kv dd{margin:0;word-break:break-word}
.evidence{display:block;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:repeating-conic-gradient(var(--line) 0 25%,transparent 0 50%) 0 0/16px 16px}
.evidence img{display:block;max-width:100%;height:auto;margin:0 auto}
form.stack{display:grid;gap:12px}label{display:grid;gap:4px;font-weight:540;font-size:13px}
input[type=text],input[type=email],input[type=password],textarea{font:inherit;padding:8px 10px;border:1px solid var(--line-strong);border-radius:6px;background:var(--panel);color:var(--ink);width:100%}
textarea{min-height:96px;resize:vertical}input:focus,textarea:focus{outline:2px solid var(--accent);outline-offset:1px}
.check{display:flex;gap:8px;align-items:flex-start;font-weight:400}.check input{margin-top:3px}
button{font:inherit;font-weight:560;padding:8px 14px;border-radius:6px;border:1px solid var(--line-strong);background:var(--panel);color:var(--ink);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}button.ok{background:var(--ok);border-color:var(--ok);color:#fff}
button.danger{background:transparent;border-color:var(--bad);color:var(--bad)}button.link{border:0;background:none;color:var(--muted);padding:0}
.notice{padding:10px 14px;border-radius:8px;margin-bottom:20px;border:1px solid}.notice.ok{background:var(--ok-bg);color:var(--ok);border-color:transparent}
.notice.bad{background:var(--bad-bg);color:var(--bad);border-color:transparent}.notice.warn{background:var(--warn-bg);color:var(--warn);border-color:transparent}
.login{max-width:380px;margin:12vh auto;padding:0 16px}.login .panel{padding:28px}
.stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:20px}.stat{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.stat b{display:block;font-size:22px;font-weight:620;font-variant-numeric:tabular-nums}.stat span{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
pre.instructions{white-space:pre-wrap;font:inherit;margin:0}
.pager{display:flex;gap:12px;justify-content:flex-end;margin-top:12px}
`

export const REVIEW_EXTRA_CSS = `
.review{max-width:1080px;margin:0 auto}
.review-head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:6px}
.brandline{font-weight:650;letter-spacing:.02em;color:var(--muted);font-size:13px;margin-bottom:18px}
.action-panel.confirm{border-color:var(--ok)}.action-panel.cancel{border-color:var(--bad)}
.lock-note{font-size:12.5px;color:var(--muted)}
`
