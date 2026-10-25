// 把 docs/ 下的 Markdown 手册转成静态站点（部署到 Cloudflare Pages：构建命令 npm ci && npm run docs，输出目录 site）。
//
//   npm install          # 一次，装 marked
//   node tools/build-docs.mjs [--out site]
//
// 输出：
//   site/index.html            英文手册（docs/manual.en.md）
//   site/zh-CN/index.html      中文手册（docs/manual.zh-CN.md）
//   site/code-signing.html     签名策略（docs/CODE_SIGNING_POLICY.md）
//   site/images/*              手册截图原样拷贝
// 页面自带目录、中英切换、深色样式，不引用任何外部资源。

import { marked } from 'marked';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docs = path.join(root, 'docs');
const outArg = process.argv.indexOf('--out');
const out = path.resolve(root, outArg > 0 ? process.argv[outArg + 1] : 'site');

const PAGES = [
  { src: 'manual.en.md', dest: 'index.html', lang: 'en', title: 'WiFi-Rainbow Manual', other: { href: 'zh-CN/', label: '中文' }, rel: '' },
  { src: 'manual.zh-CN.md', dest: 'zh-CN/index.html', lang: 'zh-CN', title: 'WiFi-Rainbow 使用手册', other: { href: '../', label: 'English' }, rel: '../' },
  { src: 'CODE_SIGNING_POLICY.md', dest: 'code-signing.html', lang: 'en', title: 'Code Signing Policy', other: { href: 'zh-CN/', label: '中文' }, rel: '' },
];

const CSS = `
:root{--bg:#10131a;--panel:#161b25;--line:#2a3243;--fg:#dfe6f3;--muted:#8b96ab;--accent:#4aa3ff;--code:#1c2230}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.65 "Segoe UI","Microsoft YaHei UI",system-ui,sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.top{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:14px;padding:10px 20px;background:var(--panel);border-bottom:1px solid var(--line)}
.top b{font-size:16px}.top .sp{flex:1}.top a{font-size:13px;color:var(--muted)}.top a:hover{color:var(--fg)}
.wrap{display:grid;grid-template-columns:240px minmax(0,1fr);gap:32px;max-width:1180px;margin:0 auto;padding:24px 20px 80px}
nav.toc{position:sticky;top:60px;align-self:start;max-height:calc(100vh - 80px);overflow:auto;font-size:13px;border-right:1px solid var(--line);padding-right:12px}
nav.toc a{display:block;color:var(--muted);padding:3px 0}nav.toc a.l3{padding-left:14px;font-size:12.5px}nav.toc a:hover{color:var(--fg)}
main h1{font-size:28px;margin:0 0 6px}main h2{font-size:21px;margin:40px 0 10px;padding-top:12px;border-top:1px solid var(--line)}main h3{font-size:16.5px;margin:26px 0 6px}
main img{max-width:100%;height:auto;border:1px solid var(--line);border-radius:8px;display:block;margin:10px 0 4px;background:#000}
main table{border-collapse:collapse;width:100%;font-size:14px;margin:10px 0}main th,main td{border:1px solid var(--line);padding:6px 10px;text-align:left;vertical-align:top}main th{background:var(--panel);color:var(--muted);font-weight:500}
main code{background:var(--code);padding:1px 5px;border-radius:4px;font-family:Consolas,"Cascadia Mono",monospace;font-size:13px}
main pre{background:var(--code);padding:12px 14px;border-radius:8px;overflow:auto;border:1px solid var(--line)}main pre code{background:none;padding:0}
main blockquote{margin:12px 0;padding:8px 14px;border-left:3px solid var(--accent);background:var(--panel);color:var(--muted)}
main kbd{background:var(--code);border:1px solid var(--line);border-radius:4px;padding:0 5px;font-size:12.5px}
main li{margin:3px 0}main hr{border:0;border-top:1px solid var(--line);margin:28px 0}
footer{color:var(--muted);font-size:12.5px;text-align:center;padding:30px 0 0;border-top:1px solid var(--line);margin-top:50px}
@media(max-width:860px){.wrap{grid-template-columns:1fr}nav.toc{position:static;border:0;padding:0;max-height:none;border-bottom:1px solid var(--line);margin-bottom:16px;padding-bottom:10px}}
`;

function slug(text, used) {
  let s = text.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-');
  if (!s) s = 'section';
  let v = s;
  for (let i = 2; used.has(v); i++) v = `${s}-${i}`;
  used.add(v);
  return v;
}

function render(page) {
  const md = fs.readFileSync(path.join(docs, page.src), 'utf8');
  const used = new Set();
  const toc = [];
  const renderer = new marked.Renderer();
  renderer.heading = function ({ tokens, depth }) {
    const text = this.parser.parseInline(tokens);
    const id = slug(text, used);
    if (depth === 2 || depth === 3) toc.push({ id, text, depth });
    return `<h${depth} id="${id}">${text}</h${depth}>\n`;
  };
  renderer.link = function ({ href, title, tokens }) {
    const text = this.parser.parseInline(tokens);
    let h = href;
    // 仓库内的 .md 链接换成站点内的 html；其余 docs 内相对链接原样
    if (/CODE_SIGNING_POLICY\.md$/.test(h)) h = page.rel + 'code-signing.html';
    else if (/manual\.en\.md$/.test(h)) h = page.rel + 'index.html';
    else if (/manual\.zh-CN\.md$/.test(h)) h = page.rel + 'zh-CN/index.html';
    else if (/^\.\.\/README\.md$/.test(h) || /^README\.zh-CN\.md$/.test(h)) h = 'https://github.com/yunnysunny/wifi-rainbow#readme';
    else if (/^\.\.\/LICENSE$/.test(h)) h = 'https://github.com/yunnysunny/wifi-rainbow/blob/main/LICENSE';
    else if (/^\.\.\//.test(h)) h = 'https://github.com/yunnysunny/wifi-rainbow/blob/main/' + h.replace(/^\.\.\//, '');
    const t = title ? ` title="${title}"` : '';
    const ext = /^https?:/.test(h) ? ' target="_blank" rel="noopener"' : '';
    return `<a href="${h}"${t}${ext}>${text}</a>`;
  };
  renderer.image = function ({ href, title, text }) {
    const h = href.replace(/^images\//, page.rel + 'images/');
    return `<img src="${h}" alt="${text || ''}"${title ? ` title="${title}"` : ''} loading="lazy">`;
  };
  marked.use({ renderer, gfm: true });
  const body = marked.parse(md);
  const tocHtml = toc.map((t) => `<a class="l${t.depth}" href="#${t.id}">${t.text}</a>`).join('');
  return `<!doctype html>
<html lang="${page.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${page.title}</title>
<meta name="description" content="WiFi-Rainbow: Wi-Fi analyzer for Windows (Rust + Tauri 2)">
<style>${CSS}</style>
</head>
<body>
<div class="top"><b>WiFi-Rainbow</b><a href="${page.rel}index.html">Manual</a><a href="${page.rel}code-signing.html">Code signing</a><span class="sp"></span><a href="${page.other.href}">${page.other.label}</a><a href="https://github.com/yunnysunny/wifi-rainbow" target="_blank" rel="noopener">GitHub</a><a href="https://github.com/yunnysunny/wifi-rainbow/releases" target="_blank" rel="noopener">Download</a></div>
<div class="wrap">
<nav class="toc">${tocHtml}</nav>
<main>
${body}
<footer>WiFi-Rainbow · MIT License · built ${new Date().toISOString().slice(0, 10)}</footer>
</main>
</div>
</body>
</html>
`;
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const page of PAGES) {
  const dest = path.join(out, page.dest);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, render(page));
  console.log('wrote', path.relative(root, dest));
}
const imgSrc = path.join(docs, 'images');
if (fs.existsSync(imgSrc)) {
  fs.cpSync(imgSrc, path.join(out, 'images'), { recursive: true });
  console.log('copied', fs.readdirSync(imgSrc).length, 'images');
}
console.log('done ->', path.relative(root, out));
