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
      title: 'See the Wi-Fi around you.',
      lead: 'WiFi Rainbow scans every access point your adapter can hear and answers, in one window: which networks are nearby, how strong each one is, how much they crowd each other, which channel would be quieter, and which encryption your own connection is really using.',
      download: 'Download for Windows',
      manual: 'Read the manual',
      facts: ['Free & open source (MIT)', 'Windows 10 / 11 (64-bit)', 'Fully offline, collects nothing', 'Per-user install, no admin rights'],
    },
    features: {
      title: 'What it shows',
      items: [
        ['charts', 'Three-band signal charts', 'One chart each for 2.4, 5 and 6 GHz. Every access point is an arc: the wider the arc, the wider the channel it occupies; the taller, the stronger the signal. A weak arc hidden behind a strong one turns dashed instead of disappearing.'],
        ['channels', 'Channel analysis', 'Works out how much each access point overlaps its neighbours, scores every channel for crowding, and recommends the quietest one (on 5 GHz it avoids the radar-detection DFS channels).'],
        ['events', 'Change tracking', 'Keeps three minutes of signal history per access point and turns the differences between scans into events: who appeared, who vanished, whose signal clearly dropped, who changed channel or width.'],
        ['conn', 'Your connection, for real', 'The access point you are connected to is marked on the charts and in the list, together with the authentication and cipher the system actually negotiated, the current link rate and quality. A router "supporting WPA3" and you "actually using WPA3" are two different things; this shows the latter.'],
        ['group', 'Grouping, aliases, watch list', 'The 2.4, 5 and 6 GHz radios of one router fold into a single row, so the list stays short. Give a network your own name, such as "Home router"; star the ones you check often and their curves are drawn by default.'],
        ['export', 'Export', 'Save the current list as a CSV table with the same columns as on screen, or the current view as a PNG image. Both go to your Downloads folder.'],
      ],
    },
    screens: {
      title: 'A look at the screens',
      note: 'The screenshots come from the built-in demo mode; all network names are fictional.',
      tabs: [
        ['inspector', 'Inspector', 'The main view. Three band charts on top, the last three minutes of signal history in the middle, the access point list at the bottom. "Group by SSID" is on in the screenshot, so the radios of one router are folded into a single row; click it to expand.'],
        ['channels', 'Channels', 'One row per band: the crowding score of each channel (more green is quieter) with the recommended channel, then a spectrum view where each access point is a bar as wide as the channel it uses. Below that, the interference table: how many co-channel and adjacent-channel neighbours each access point has, its carrier-to-interference ratio, and who interferes most. Hover a channel number and the access points on that channel light up while the rest dim.'],
        ['detail', 'Details', 'Click any access point in the list or on a chart and its details slide in from the right. The screenshot shows the connected one, so it has an extra "Current connection" block: negotiated authentication and cipher, link rate, link quality, time connected. Below are a three-minute sparkline, the interference profile and the radio parameters.'],
        ['events', 'Events', 'Press the "Events" button at the top right of the signal history panel and the panel switches from curves to a list of changes. Each row is one change, left to right: time, type badge, network name, BSSID, description. The screenshot shows four: Pixel-Hotspot appeared; Library-Open was missing for two scans and is reported gone; Oak-Street dropped 12 dB; Cafe-Guest_5G moved from channel 149 to 36. Click a row to open the details of that access point.'],
      ],
    },
    how: {
      title: 'Where the data comes from, and how far to trust it',
      items: [
        ['Only the built-in Windows API', 'Everything comes from the wireless API that ships with Windows (Native Wifi). No driver to install, no special adapter needed; an ordinary laptop card is fine. The program calls that API directly from Rust, with no third-party dependencies.'],
        ['The details are parsed from the beacons', 'Channel width, WPA2 versus WPA3, the cipher in use, how many devices are connected: the system API does not hand these over. The program reads them field by field from the beacon frames that routers broadcast.'],
        ['Clear about the limits', 'Windows has no monitor mode, so the data comes from a scan roughly every two seconds; momentary fluctuations are invisible. The channel score adds up the strength of overlapping signals and compares them. That is enough to tell which channel is quieter, but it is not a measurement of actual speed.'],
      ],
    },
    install: {
      title: 'Install',
      steps: [
        `Download <code>WiFi-Rainbow_&lt;version&gt;_x64-setup.exe</code> from <a href="${RELEASES}" target="_blank" rel="noopener">GitHub Releases</a>.`,
        'Double-click it. It installs for the current user only, adds a Start menu entry and a desktop shortcut, and needs no administrator rights.',
        'Start WiFi Rainbow. It begins scanning on its own and the window fills up after about two seconds.',
      ],
      note: 'Current releases are not code-signed yet: the project has applied to the SignPath Foundation\'s free signing program for open-source software (see the <a href="{signing}">code signing policy</a>). Until then Windows shows a SmartScreen prompt on first run: choose <em>More info</em> → <em>Run anyway</em>.',
      req: 'Your PC needs a wireless adapter and the WebView2 runtime (preinstalled on Windows 11).',
    },
    footer: 'WiFi Rainbow · MIT License · Code signing: application to the SignPath Foundation pending.',
    manualTitle: 'WiFi Rainbow Manual',
    signingTitle: 'Code Signing Policy',
  },
  zh: {
    name: 'WiFi 彩虹',
    nav: { home: '首页', manual: '使用手册', signing: '代码签名', download: '下载', github: 'GitHub', lang: 'English' },
    hero: {
      kicker: 'Windows 上的 Wi-Fi 分析工具',
      title: '看清你身边的 Wi-Fi 环境。',
      lead: '打开 WiFi 彩虹，它会扫描周围所有能收到的 Wi-Fi 接入点，并在一个窗口里回答几个问题：附近有哪些网络、各自有多强、它们之间挤不挤、换到哪个信道会更清净、我自己连的这个网络到底在用什么加密方式。',
      download: '下载 Windows 版',
      manual: '阅读使用手册',
      facts: ['免费开源（MIT）', '支持 Windows 10 / 11（64 位）', '完全离线，不收集任何数据', '安装到当前用户目录，不需要管理员权限'],
    },
    features: {
      title: '它能看到什么',
      items: [
        ['charts', '三频段信号图', '2.4 GHz、5 GHz、6 GHz 各一张图，每个接入点画成一道弧：弧越宽，说明它占的信道越宽；弧越高，说明信号越强。弱信号被强信号的弧盖住时会改成虚线，不会看不见。'],
        ['channels', '信道分析', '算出每个接入点和邻居之间的频谱重叠程度，给每个信道打一个拥挤评分，并推荐一个最清净的信道（5 GHz 会自动避开需要雷达检测的 DFS 信道）。'],
        ['events', '变化追踪', '记录最近 3 分钟每个接入点的信号曲线，并把两次扫描之间的变化记成一条条事件：谁新出现了、谁不见了、谁的信号明显掉了、谁换了信道或带宽。'],
        ['conn', '你真正连的是什么', '你当前连接的接入点会在图上和列表里都标出来，并显示系统实际协商出来的认证方式和加密算法、当前链路速率和质量。路由器「支持 WPA3」和你「真的在用 WPA3」是两回事，这里看的是后者。'],
        ['group', '分组、别名、关注列表', '同一台路由器的 2.4 GHz、5 GHz、6 GHz 几个信号会折叠成一行，列表不再被撑得老长。可以给网络起个自己的名字，比如「家里的路由」；给常看的网络打个星，它们的曲线就会默认画出来。'],
        ['export', '导出', '当前列表可以导出成 CSV 表格（列和界面上一样），当前画面可以导出成一张 PNG 图片，都保存到「下载」文件夹。'],
      ],
    },
    screens: {
      title: '界面一览',
      note: '下面的截图来自程序内置的演示模式，网络名称都是虚构的。',
      tabs: [
        ['inspector', '概览', '主界面。上面是三张频段信号图，中间是最近 3 分钟的信号历史曲线，下面是接入点列表。截图里开着「按 SSID 分组」，所以同一台路由器的几个信号折成了一行，点一下可以展开。'],
        ['channels', '信道', '每个频段一行：先是各个信道的拥挤评分（绿色越多越清净）和推荐信道，再是一张频谱占用图，每个接入点一条横条，横条的长度就是它占的带宽。最下面是干扰明细表：每个接入点有几个同频邻居、几个邻频邻居、载干比是多少、主要被谁干扰。鼠标悬在某个信道号上，这个信道上的接入点会高亮，其余变暗。'],
        ['detail', '详情', '在列表或图上点任意一个接入点，右侧会滑出它的详情面板。截图里点的是当前连接的那个，所以多了「当前连接」一块：实际协商的认证方式和加密算法、收发速率、链路质量、已连接时长。往下是最近 3 分钟的小曲线、干扰画像和射频参数。'],
        ['events', '事件', '点信号历史右上角的「事件」按钮，中间这一栏就从曲线切换成事件列表。每行一条变化，从左到右是：发生时间、类型标签、网络名、BSSID、具体说明。截图里能看到四条：Pixel-Hotspot 新出现了；Library-Open 连续两轮没扫到，判定为消失；Oak-Street 信号掉了 12 dB；Cafe-Guest_5G 从 149 信道换到了 36 信道。点任意一行会打开那个接入点的详情。'],
      ],
    },
    how: {
      title: '数据从哪来，准到什么程度',
      items: [
        ['只用系统自带的接口', '所有数据都来自 Windows 自带的无线网卡接口（Native Wifi API）。不用装驱动，不需要特殊网卡，普通笔记本的网卡就行。程序用 Rust 直接调用这个接口，没有任何第三方依赖。'],
        ['自己解析信号里的信息', '信道带宽、WPA2 还是 WPA3、用什么加密算法、连了多少设备，这些系统接口不直接给。程序会从路由器定时广播的 Beacon 帧里，一个字段一个字段地把它们解析出来。'],
        ['边界说清楚', 'Windows 不支持监听模式，所以数据靠每两秒左右扫描一次得到，瞬间的波动看不到。信道评分是把互相重叠的信号强度加起来比较得出的，用来判断「哪个信道更清净」够用，但它不等于实际网速。'],
      ],
    },
    install: {
      title: '安装',
      steps: [
        `从 <a href="${RELEASES}" target="_blank" rel="noopener">GitHub Releases</a> 下载 <code>WiFi-Rainbow_&lt;版本&gt;_x64-setup.exe</code>。`,
        '双击运行。程序只安装给当前用户，会创建开始菜单项和桌面快捷方式，不需要管理员权限。',
        '启动 WiFi 彩虹。它会自动开始第一次扫描，大约两秒后窗口里就有内容了。',
      ],
      note: '目前的发布版本还没有代码签名：项目已向 SignPath Foundation 申请面向开源软件的免费签名，正在等待批准（见 <a href="{signing}">代码签名策略</a>）。在此之前首次运行会弹 SmartScreen 提示，点「更多信息」→「仍要运行」即可。',
      req: '需要电脑有无线网卡，并已安装 WebView2 运行时（Windows 11 自带）。',
    },
    footer: 'WiFi 彩虹 · MIT 许可证 · 代码签名：已向 SignPath Foundation 申请，等待批准。',
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
