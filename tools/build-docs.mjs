// 把 docs/ 下的 Markdown 手册和一个产品首页拼成静态站点（部署到 Cloudflare Pages：
// 构建命令 npm ci && npm run docs，输出目录 site）。
//
//   npm install          # 一次，装 marked
//   node tools/build-docs.mjs [--out site]
//
// 输出：
//   site/index.html                  首页（英文）
//   site/zh-CN/index.html            首页（中文）
//   site/manual/index.html           英文手册（docs/manual.en.md）
//   site/zh-CN/manual/index.html     中文手册（docs/manual.zh-CN.md）
//   site/code-signing.html           签名策略（docs/CODE_SIGNING_POLICY.md）
//   site/images/*                    手册截图 + 图标
// 所有页面共用一条导航菜单（首页 / 手册 / 签名策略 / 下载 / GitHub / 语言切换），不引用任何外部资源。

import { marked } from 'marked';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docs = path.join(root, 'docs');
const outArg = process.argv.indexOf('--out');
const out = path.resolve(root, outArg > 0 ? process.argv[outArg + 1] : 'site');

const REPO = 'https://github.com/yunnysunny/wifi-rainbow';
const RELEASES = `${REPO}/releases`;

// ---------------------------------------------------------------- 文案

const T = {
  en: {
    name: 'WiFi Rainbow',
    nav: { home: 'Home', manual: 'Manual', signing: 'Code signing', download: 'Download', github: 'GitHub', lang: '中文' },
    hero: {
      kicker: 'Wi-Fi analyzer for Windows',
      title: 'See what is in the air around you.',
      lead: 'WiFi Rainbow scans the access points nearby and shows, in one window, where they sit on the spectrum, how strong they are, how they interfere with each other, which channel is the quietest, and what your own adapter actually negotiated.',
      download: 'Download for Windows',
      manual: 'Read the manual',
      facts: ['Free & open source (MIT)', 'Windows 10 / 11 x64', 'No network access, no telemetry', 'Per-user install, no admin'],
    },
    features: {
      title: 'What it shows',
      items: [
        ['charts', 'Three-band signal charts', 'One half-ellipse per access point on 2.4, 5 and 6 GHz: width is the channel width, height is the signal. Arcs hidden behind a stronger AP turn dashed so nothing disappears.'],
        ['channels', 'Channel analysis', 'Co-channel and adjacent-channel overlap, carrier-to-interference ratio for every AP, the main interferers, and a scored recommendation per band that avoids DFS on 5 GHz.'],
        ['events', 'Change tracking', 'Three minutes of history per BSSID plus an event log: networks that appeared or vanished, signal drops confirmed over two scans, channel and width changes.'],
        ['conn', 'Your connection, for real', 'The AP you are on is marked everywhere, with the authentication and cipher that were actually negotiated, link rate and quality, not just what the router advertises.'],
        ['group', 'Grouping, aliases, watch list', 'Multi-radio routers fold into one row. Name an SSID "Home router", star the ones you care about and they get history curves by default.'],
        ['export', 'Export', 'The current table as CSV with the same columns you see, or the current view as one PNG. Written to your Downloads folder.'],
      ],
    },
    screens: {
      title: 'Screens',
      note: 'Screenshots come from the built-in demo mode with synthetic networks.',
      tabs: [
        ['inspector', 'Inspector', 'Band charts, signal history and the AP table with grouping.'],
        ['channels', 'Channels', 'Channel scores, spectrum occupancy and the interference table.'],
        ['detail', 'Details', 'The drawer for the connected AP: negotiated security, link rate, interference profile, radio fields.'],
        ['events', 'Events', 'What changed between scans, with the thresholds tuned for noisy Windows adapters.'],
      ],
    },
    how: {
      title: 'How it works',
      items: [
        ['Native Wifi API', 'Everything comes from the Windows Native Wifi API (wlanapi.dll) through zero-dependency Rust FFI: scan results, BSS lists and the current connection.'],
        ['IE parsing in Rust', 'Channel width, WPA2 / WPA3 / OWE, AKM, cipher and BSS Load are not API fields. They are parsed from the beacon information elements (HT / VHT / HE / RSN / WPA).'],
        ['Honest about limits', 'Windows has no monitor mode, so this is polling at about one scan every two seconds. The interference model sums overlapping power; it is a ranking, not a throughput prediction.'],
      ],
    },
    install: {
      title: 'Install',
      steps: [
        `Download <code>WiFi-Rainbow_&lt;version&gt;_x64-setup.exe</code> from <a href="${RELEASES}" target="_blank" rel="noopener">GitHub Releases</a>.`,
        'Run it. It installs for the current user only and adds a Start menu entry. No administrator rights are needed.',
        'Start WiFi Rainbow. The first scan runs by itself and the window fills up after about two seconds.',
      ],
      note: 'Release builds are signed through SignPath; see the <a href="{signing}">code signing policy</a>. A very new release may still trigger SmartScreen until it has built up reputation: choose <em>More info → Run anyway</em>.',
      req: 'Requires a wireless adapter and the WebView2 runtime (preinstalled on Windows 11).',
    },
    footer: 'WiFi Rainbow · MIT License · Free code signing provided by SignPath.io, certificate by SignPath Foundation.',
    manualTitle: 'WiFi Rainbow Manual',
    signingTitle: 'Code Signing Policy',
  },
  zh: {
    name: 'WiFi 彩虹',
    nav: { home: '首页', manual: '使用手册', signing: '代码签名', download: '下载', github: 'GitHub', lang: 'English' },
    hero: {
      kicker: 'Windows 上的 Wi-Fi 分析工具',
      title: '看清你周围的空气里有什么。',
      lead: 'WiFi 彩虹扫描附近的接入点，在一个窗口里告诉你：它们在频谱上的位置和强弱、彼此怎么干扰、哪个信道最干净、你自己的网卡实际协商出了什么。',
      download: '下载 Windows 版',
      manual: '阅读使用手册',
      facts: ['免费开源（MIT）', 'Windows 10 / 11 x64', '不联网，不收集数据', '按用户安装，不要管理员'],
    },
    features: {
      title: '它能看到什么',
      items: [
        ['charts', '三频段信号图', '2.4 / 5 / 6 GHz 每个接入点一个半椭圆：宽度是信道带宽，高度是信号强度。被更强 AP 盖住的弧改成虚线，不会消失。'],
        ['channels', '信道分析', '同频 / 邻频重叠、每个 AP 的载干比、主要干扰源，每个频段打分并给出建议信道（5 GHz 避开 DFS）。'],
        ['events', '变化追踪', '每个 BSSID 三分钟历史，外加事件记录：新出现的、消失的、连续两轮确认的掉信号、换信道、换带宽。'],
        ['conn', '你真正连的是什么', '你连着的 AP 在各处都有标记，并显示实际协商的认证方式和加密、链路速率和质量，而不只是路由器宣告的。'],
        ['group', '分组、别名、关注列表', '多射频的路由折成一行。给 SSID 起名「家里的路由」，给在意的网络打星，它们默认就有历史曲线。'],
        ['export', '导出', '当前表格导出为 CSV（列和界面一致），当前视图导出为一张 PNG，写到「下载」文件夹。'],
      ],
    },
    screens: {
      title: '界面',
      note: '截图来自内置演示模式，用的是合成的网络数据。',
      tabs: [
        ['inspector', 'Inspector', '三频段图、信号历史、带分组的 AP 表格。'],
        ['channels', '信道', '信道评分、频谱占用和干扰表。'],
        ['detail', '详情', '已连接 AP 的抽屉：协商出的安全方式、链路速率、干扰画像、射频字段。'],
        ['events', '事件', '两次扫描之间的变化，阈值按 Windows 网卡的抖动调过。'],
      ],
    },
    how: {
      title: '它是怎么做到的',
      items: [
        ['Native Wifi API', '所有数据来自 Windows 自带的 Native Wifi API（wlanapi.dll），用零依赖的 Rust FFI 直接调用：扫描结果、BSS 列表、当前连接。'],
        ['Rust 里解析 IE', '信道带宽、WPA2 / WPA3 / OWE、AKM、加密套件、BSS Load 都不是 API 字段，是从 Beacon 的信息元素里解析出来的（HT / VHT / HE / RSN / WPA）。'],
        ['对边界说实话', 'Windows 没有 monitor 模式，所以是轮询，最快约两秒一轮。干扰模型只把重叠功率加起来，是排名，不是吞吐量预测。'],
      ],
    },
    install: {
      title: '安装',
      steps: [
        `从 <a href="${RELEASES}" target="_blank" rel="noopener">GitHub Releases</a> 下载 <code>WiFi-Rainbow_&lt;版本&gt;_x64-setup.exe</code>。`,
        '运行它。只给当前用户安装，建开始菜单项，不要管理员权限。',
        '启动 WiFi 彩虹。第一次扫描自动进行，两秒左右窗口就有内容。',
      ],
      note: '正式版通过 SignPath 签名，见 <a href="{signing}">代码签名策略</a>。刚发布的新版本在积累信誉之前仍可能触发 SmartScreen，点「更多信息 → 仍要运行」即可。',
      req: '需要一块无线网卡和 WebView2 运行时（Windows 11 自带）。',
    },
    footer: 'WiFi 彩虹 · MIT 许可证 · 代码签名由 SignPath.io 免费提供，证书来自 SignPath Foundation。',
    manualTitle: 'WiFi 彩虹使用手册',
    signingTitle: '代码签名策略',
  },
};

// 图标：简单的内联 SVG（stroke 风格），不依赖字体
const ICONS = {
  charts: '<path d="M3 20h18M5 20c0-6 3-10 7-10s7 4 7 10M8 20c0-3 1.5-5 4-5s4 2 4 5"/>',
  channels: '<path d="M4 18V6M9 18v-7M14 18v-4M19 18V9M2 21h20"/>',
  events: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
  conn: '<path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 19.5h.01M2 9a14 14 0 0 1 20 0"/>',
  group: '<path d="M4 6h16M4 12h10M4 18h7M18 12v6M15 15h6"/>',
  export: '<path d="M12 3v12M8 11l4 4 4-4M4 17v3h16v-3"/>',
};
const icon = (k) => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[k]}</svg>`;

// ---------------------------------------------------------------- 样式

const CSS = `
:root{--bg:#10131a;--panel:#161b25;--panel-2:#1c2230;--line:#2a3243;--fg:#dfe6f3;--muted:#8b96ab;--accent:#4aa3ff;--good:#4ade80;--code:#1c2230;--max:1120px}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.65 "Segoe UI","Microsoft YaHei UI",system-ui,sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
img{max-width:100%;height:auto}
code{background:var(--code);padding:1px 5px;border-radius:4px;font-family:Consolas,"Cascadia Mono",monospace;font-size:13px}

/* 导航 */
.nav{position:sticky;top:0;z-index:10;background:rgba(16,19,26,.92);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
.nav .in{max-width:var(--max);margin:0 auto;padding:0 20px;height:56px;display:flex;align-items:center;gap:6px}
.nav .brand{display:flex;align-items:center;gap:9px;font-weight:700;font-size:16px;color:var(--fg);margin-right:14px;white-space:nowrap}
.nav .brand:hover{text-decoration:none}
.nav .brand img{width:26px;height:26px;border-radius:6px}
.nav a.item{color:var(--muted);padding:6px 11px;border-radius:7px;font-size:14px;white-space:nowrap}
.nav a.item:hover{color:var(--fg);background:var(--panel-2);text-decoration:none}
.nav a.item.on{color:var(--fg);background:var(--panel-2)}
.nav .sp{flex:1}
.nav a.cta{background:var(--accent);color:#06101d;font-weight:600;padding:7px 14px;border-radius:7px;font-size:14px;white-space:nowrap}
.nav a.cta:hover{text-decoration:none;filter:brightness(1.08)}
.nav a.lang{color:var(--muted);border:1px solid var(--line);padding:5px 10px;border-radius:7px;font-size:13px;margin-left:4px;white-space:nowrap}
.nav a.lang:hover{color:var(--fg);text-decoration:none}
@media(max-width:760px){.nav .in{height:auto;flex-wrap:wrap;padding:8px 14px;row-gap:4px}.nav a.item{font-size:13px;padding:5px 8px}.nav .brand{margin-right:4px}}

/* 首页 */
.hero{max-width:var(--max);margin:0 auto;padding:56px 20px 30px;display:grid;grid-template-columns:minmax(0,5fr) minmax(0,7fr);gap:40px;align-items:center}
.hero .kicker{color:var(--accent);font-size:13px;letter-spacing:.08em;text-transform:uppercase;font-weight:600}
.hero h1{font-size:40px;line-height:1.15;margin:8px 0 14px;letter-spacing:-.01em}
.hero p.lead{color:var(--muted);font-size:16.5px;margin:0 0 22px}
.btns{display:flex;flex-wrap:wrap;gap:10px}
.btn{display:inline-block;padding:11px 20px;border-radius:9px;font-weight:600;font-size:15px;border:1px solid var(--line);color:var(--fg);background:var(--panel)}
.btn:hover{text-decoration:none;border-color:var(--accent)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#06101d}
.facts{list-style:none;margin:22px 0 0;padding:0;display:flex;flex-wrap:wrap;gap:8px 18px;color:var(--muted);font-size:13px}
.facts li::before{content:"✓ ";color:var(--good)}
.shot{border:1px solid var(--line);border-radius:12px;box-shadow:0 24px 60px rgba(0,0,0,.5);background:#000;display:block}
@media(max-width:900px){.hero{grid-template-columns:1fr;padding-top:36px}.hero h1{font-size:32px}}

section.block{max-width:var(--max);margin:0 auto;padding:44px 20px 10px}
section.block h2{font-size:24px;margin:0 0 18px}
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}
@media(max-width:900px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:560px){.grid{grid-template-columns:1fr}}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px 18px 16px}
.card .ic{width:38px;height:38px;border-radius:9px;background:#14304d;color:var(--accent);display:flex;align-items:center;justify-content:center;margin-bottom:12px}
.card h3{margin:0 0 6px;font-size:16px}
.card p{margin:0;color:var(--muted);font-size:14px}
.card.step .ic{font-weight:700;font-size:16px;background:var(--panel-2);color:var(--fg)}

.tabs{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
.tabs label{padding:7px 14px;border-radius:8px;border:1px solid var(--line);color:var(--muted);cursor:pointer;font-size:14px;background:var(--panel)}
.tabs label:hover{color:var(--fg)}
.gal input{display:none}
.gal .pane{display:none}
.gal .pane p{color:var(--muted);font-size:13.5px;margin:10px 2px 0}
#t-inspector:checked~.tabs label[for=t-inspector],#t-channels:checked~.tabs label[for=t-channels],#t-detail:checked~.tabs label[for=t-detail],#t-events:checked~.tabs label[for=t-events]{color:var(--fg);border-color:var(--accent);background:#14304d}
#t-inspector:checked~.pane.inspector,#t-channels:checked~.pane.channels,#t-detail:checked~.pane.detail,#t-events:checked~.pane.events{display:block}
.note{color:var(--muted);font-size:13px;margin:8px 0 0}

ol.steps{margin:0;padding-left:0;list-style:none;counter-reset:s;display:grid;gap:10px}
ol.steps li{counter-increment:s;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 16px 12px 52px;position:relative}
ol.steps li::before{content:counter(s);position:absolute;left:14px;top:11px;width:26px;height:26px;border-radius:50%;background:var(--accent);color:#06101d;font-weight:700;display:flex;align-items:center;justify-content:center;font-size:13px}
.callout{margin:14px 0 0;padding:12px 16px;border-left:3px solid var(--accent);background:var(--panel);border-radius:0 8px 8px 0;color:var(--muted);font-size:14px}

footer{color:var(--muted);font-size:12.5px;text-align:center;padding:36px 20px 40px;border-top:1px solid var(--line);margin-top:50px}

/* 文档页 */
.wrap{display:grid;grid-template-columns:240px minmax(0,1fr);gap:32px;max-width:var(--max);margin:0 auto;padding:24px 20px 60px}
nav.toc{position:sticky;top:70px;align-self:start;max-height:calc(100vh - 90px);overflow:auto;font-size:13px;border-right:1px solid var(--line);padding-right:12px}
nav.toc a{display:block;color:var(--muted);padding:3px 0}nav.toc a.l3{padding-left:14px;font-size:12.5px}nav.toc a:hover{color:var(--fg)}
main.doc h1{font-size:28px;margin:0 0 6px}main.doc h2{font-size:21px;margin:40px 0 10px;padding-top:12px;border-top:1px solid var(--line)}main.doc h3{font-size:16.5px;margin:26px 0 6px}
main.doc img{border:1px solid var(--line);border-radius:8px;display:block;margin:10px 0 4px;background:#000}
main.doc table{border-collapse:collapse;width:100%;font-size:14px;margin:10px 0}main.doc th,main.doc td{border:1px solid var(--line);padding:6px 10px;text-align:left;vertical-align:top}main.doc th{background:var(--panel);color:var(--muted);font-weight:500}
main.doc pre{background:var(--code);padding:12px 14px;border-radius:8px;overflow:auto;border:1px solid var(--line)}main.doc pre code{background:none;padding:0}
main.doc blockquote{margin:12px 0;padding:8px 14px;border-left:3px solid var(--accent);background:var(--panel);color:var(--muted)}
main.doc kbd{background:var(--code);border:1px solid var(--line);border-radius:4px;padding:0 5px;font-size:12.5px}
main.doc li{margin:3px 0}main.doc hr{border:0;border-top:1px solid var(--line);margin:28px 0}
@media(max-width:860px){.wrap{grid-template-columns:1fr}nav.toc{position:static;border:0;padding:0;max-height:none;border-bottom:1px solid var(--line);margin-bottom:16px;padding-bottom:10px}}
`;

// ---------------------------------------------------------------- 页面骨架

/** 站内各页相对站点根的路径 */
function paths(lang) {
  const base = lang === 'zh' ? 'zh-CN/' : '';
  return { home: base, manual: base + 'manual/', signing: 'code-signing.html' };
}

function nav(lang, rel, active) {
  const t = T[lang];
  const p = paths(lang);
  const other = paths(lang === 'zh' ? 'en' : 'zh');
  const otherHref = active === 'manual' ? other.manual : other.home;
  const item = (key, href) => `<a class="item${active === key ? ' on' : ''}" href="${rel}${href}">${t.nav[key]}</a>`;
  return `<header class="nav"><div class="in">
<a class="brand" href="${rel}${p.home}"><img src="${rel}images/icon.png" alt="">${t.name}</a>
${item('home', p.home)}${item('manual', p.manual)}${item('signing', p.signing)}
<a class="item" href="${REPO}" target="_blank" rel="noopener">${t.nav.github}</a>
<span class="sp"></span>
<a class="cta" href="${RELEASES}" target="_blank" rel="noopener">${t.nav.download}</a>
<a class="lang" href="${rel}${otherHref}">${t.nav.lang}</a>
</div></header>`;
}

function shell({ lang, rel, title, active, body, desc }) {
  return `<!doctype html>
<html lang="${lang === 'zh' ? 'zh-CN' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${desc || 'WiFi Rainbow: Wi-Fi analyzer for Windows (Rust + Tauri 2)'}">
<link rel="icon" href="${rel}images/icon.png">
<style>${CSS}</style>
</head>
<body>
${nav(lang, rel, active)}
${body}
<footer>${T[lang].footer}</footer>
</body>
</html>
`;
}

// ---------------------------------------------------------------- 首页

function landing(lang, rel) {
  const t = T[lang];
  const p = paths(lang);
  const img = (name) => `${rel}images/${lang}-${name}.png`;
  const features = t.features.items
    .map(([k, h, d]) => `<div class="card"><div class="ic">${icon(k)}</div><h3>${h}</h3><p>${d}</p></div>`)
    .join('');
  const inputs = t.screens.tabs.map(([k], i) => `<input type="radio" name="t" id="t-${k}"${i === 0 ? ' checked' : ''}>`).join('');
  const tabs = t.screens.tabs.map(([k, label]) => `<label for="t-${k}">${label}</label>`).join('');
  const panes = t.screens.tabs
    .map(([k, label, d]) => `<div class="pane ${k}"><img class="shot" src="${img(k)}" alt="${label}" loading="lazy"><p>${d}</p></div>`)
    .join('');
  const how = t.how.items.map(([h, d], i) => `<div class="card step"><div class="ic">${i + 1}</div><h3>${h}</h3><p>${d}</p></div>`).join('');
  const steps = t.install.steps.map((s) => `<li>${s}</li>`).join('');
  const body = `
<section class="hero">
  <div>
    <div class="kicker">${t.hero.kicker}</div>
    <h1>${t.hero.title}</h1>
    <p class="lead">${t.hero.lead}</p>
    <div class="btns">
      <a class="btn primary" href="${RELEASES}" target="_blank" rel="noopener">${t.hero.download}</a>
      <a class="btn" href="${rel}${p.manual}">${t.hero.manual}</a>
    </div>
    <ul class="facts">${t.hero.facts.map((f) => `<li>${f}</li>`).join('')}</ul>
  </div>
  <a href="${rel}${p.manual}"><img class="shot" src="${img('inspector')}" alt="${t.name}"></a>
</section>

<section class="block" id="features">
  <h2>${t.features.title}</h2>
  <div class="grid">${features}</div>
</section>

<section class="block" id="screens">
  <h2>${t.screens.title}</h2>
  <div class="gal">${inputs}<div class="tabs">${tabs}</div>${panes}</div>
  <p class="note">${t.screens.note}</p>
</section>

<section class="block" id="how">
  <h2>${t.how.title}</h2>
  <div class="grid">${how}</div>
</section>

<section class="block" id="install">
  <h2>${t.install.title}</h2>
  <ol class="steps">${steps}</ol>
  <div class="callout">${t.install.note.replace('{signing}', rel + p.signing)} ${t.install.req}</div>
</section>`;
  return shell({ lang, rel, title: `${t.name} · ${t.hero.kicker}`, active: 'home', body });
}

// ---------------------------------------------------------------- Markdown 页

function slug(text, used) {
  let s = text.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-');
  if (!s) s = 'section';
  let v = s;
  for (let i = 2; used.has(v); i++) v = `${s}-${i}`;
  used.add(v);
  return v;
}

function markdownPage({ src, lang, rel, title, active }) {
  const md = fs.readFileSync(path.join(docs, src), 'utf8');
  const used = new Set();
  const toc = [];
  const renderer = new marked.Renderer();
  renderer.heading = function ({ tokens, depth }) {
    const text = this.parser.parseInline(tokens);
    const id = slug(text, used);
    if (depth === 2 || depth === 3) toc.push({ id, text, depth });
    return `<h${depth} id="${id}">${text}</h${depth}>\n`;
  };
  renderer.link = function ({ href, title: tt, tokens }) {
    const text = this.parser.parseInline(tokens);
    let h = href;
    if (/CODE_SIGNING_POLICY\.md$/.test(h)) h = rel + 'code-signing.html';
    else if (/manual\.en\.md$/.test(h)) h = rel + paths('en').manual;
    else if (/manual\.zh-CN\.md$/.test(h)) h = rel + paths('zh').manual;
    else if (/^\.\.\/README\.md$/.test(h) || /^README\.zh-CN\.md$/.test(h)) h = `${REPO}#readme`;
    else if (/^\.\.\//.test(h)) h = `${REPO}/blob/main/` + h.replace(/^\.\.\//, '');
    const ext = /^https?:/.test(h) ? ' target="_blank" rel="noopener"' : '';
    return `<a href="${h}"${tt ? ` title="${tt}"` : ''}${ext}>${text}</a>`;
  };
  renderer.image = function ({ href, title: tt, text }) {
    const h = href.replace(/^images\//, rel + 'images/');
    return `<img src="${h}" alt="${text || ''}"${tt ? ` title="${tt}"` : ''} loading="lazy">`;
  };
  marked.use({ renderer, gfm: true });
  const html = marked.parse(md);
  const tocHtml = toc.map((x) => `<a class="l${x.depth}" href="#${x.id}">${x.text}</a>`).join('');
  const body = `<div class="wrap"><nav class="toc">${tocHtml}</nav><main class="doc">${html}</main></div>`;
  return shell({ lang, rel, title, active, body });
}

// ---------------------------------------------------------------- 输出

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const write = (file, html) => {
  const dest = path.join(out, file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, html);
  console.log('wrote', path.relative(root, dest));
};

write('index.html', landing('en', ''));
write('zh-CN/index.html', landing('zh', '../'));
write('manual/index.html', markdownPage({ src: 'manual.en.md', lang: 'en', rel: '../', title: T.en.manualTitle, active: 'manual' }));
write('zh-CN/manual/index.html', markdownPage({ src: 'manual.zh-CN.md', lang: 'zh', rel: '../../', title: T.zh.manualTitle, active: 'manual' }));
write('code-signing.html', markdownPage({ src: 'CODE_SIGNING_POLICY.md', lang: 'en', rel: '', title: T.en.signingTitle, active: 'signing' }));

const imgSrc = path.join(docs, 'images');
if (fs.existsSync(imgSrc)) {
  fs.cpSync(imgSrc, path.join(out, 'images'), { recursive: true });
  console.log('copied', fs.readdirSync(imgSrc).length, 'images');
}
fs.copyFileSync(path.join(root, 'rust', 'src-tauri', 'icons', 'icon.png'), path.join(out, 'images', 'icon.png'));
console.log('done ->', path.relative(root, out));
