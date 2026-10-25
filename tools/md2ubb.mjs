// Markdown → UBB（BBCode）。给论坛发帖用，只覆盖 docs/promo.zh-CN.md 用到的那部分语法：
// 标题、粗体、行内代码、图片、链接、无序/有序列表、引用、水平线、代码块。
// 用法：node tools/md2ubb.mjs docs/promo.zh-CN.md [out.ubb.txt]
//
// 不同论坛的 UBB 方言不完全一样，这里用最通用的一套：
//   [b] [i] [url=] [img] [size=] [quote] [code] [list] [list=1] [*] [hr]
// 行内代码论坛大多没有对应标签，直接去掉反引号保留文字。

import { readFileSync, writeFileSync } from 'node:fs';

const [, , inPath, outPath] = process.argv;
if (!inPath) {
  console.error('usage: node tools/md2ubb.mjs <in.md> [out.ubb.txt]');
  process.exit(1);
}

const HEADING_SIZE = { 1: 6, 2: 5, 3: 4 };

function inline(s) {
  // 顺序有讲究：先图片/链接（里面有 URL，不能再被当成裸链接处理），再粗体/斜体/行内代码
  const slots = [];
  const stash = (ubb) => {
    slots.push(ubb);
    return `\u0000${slots.length - 1}\u0000`;
  };
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, _alt, url) => stash(`[img]${url}[/img]`));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, url) => stash(`[url=${url}]${text}[/url]`));
  s = s.replace(/`([^`]+)`/g, (_, code) => stash(code));
  s = s.replace(/\*\*([^*]+)\*\*/g, '[b]$1[/b]');
  s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*(?!\*)/g, '$1[i]$2[/i]');
  // 裸 URL → [url]…[/url]；中文标点和右括号不算 URL 的一部分
  s = s.replace(/(^|[^\]=\w])(https?:\/\/[^\s<>　-〿＀-￯（）]+)/g, (_, pre, url) => `${pre}${stash(`[url]${url}[/url]`)}`);
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[Number(i)]);
}

function convert(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let list = null; // { ordered: boolean }
  let quote = [];
  let code = null;

  const closeList = () => {
    if (list) {
      out.push('[/list]', '');
      list = null;
    }
  };
  // 标题前保证有一行空行，源文件里紧贴着上一段也一样
  const blankBefore = () => {
    if (out.length && out[out.length - 1] !== '') out.push('');
  };
  const closeQuote = () => {
    if (quote.length) {
      out.push('[quote]' + quote.join('\n') + '[/quote]');
      quote = [];
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');

    if (code) {
      if (/^```/.test(line)) {
        out.push('[code]' + code.join('\n') + '[/code]');
        code = null;
      } else code.push(raw);
      continue;
    }
    if (/^```/.test(line)) {
      closeList();
      closeQuote();
      code = [];
      continue;
    }

    const q = line.match(/^>\s?(.*)$/);
    if (q) {
      closeList();
      quote.push(inline(q[1]));
      continue;
    }
    closeQuote();

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeList();
      const size = HEADING_SIZE[h[1].length] ?? 3;
      blankBefore();
      out.push(`[size=${size}][b]${inline(h[2])}[/b][/size]`);
      continue;
    }

    if (/^(-{3,}|\*{3,})$/.test(line)) {
      closeList();
      out.push('[hr]');
      continue;
    }

    const li = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
    if (li) {
      if (/\d/.test(li[2])) {
        // 有序项不用 [list=1]：Markdown 里「1. 一段 / 图片 / 2. 下一段」很常见，
        // 拆成两个 [list=1] 会从 1 重新编号，所以直接保留原编号写成普通段落
        closeList();
        out.push(`${li[2]} ${inline(li[3])}`);
        continue;
      }
      if (!list) {
        out.push('[list]');
        list = { ordered: false };
      }
      out.push(`[*]${inline(li[3])}`);
      continue;
    }

    // 列表里的空行不算结束；碰到非列表内容才关掉
    if (line === '') {
      if (!list) out.push('');
      continue;
    }
    closeList();
    out.push(inline(line));
  }
  closeList();
  closeQuote();
  if (code) out.push('[code]' + code.join('\n') + '[/code]');

  // 压掉连续空行
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

const ubb = convert(readFileSync(inPath, 'utf8'));
if (outPath) {
  writeFileSync(outPath, ubb, 'utf8');
  console.error(`wrote ${outPath} (${ubb.length} chars)`);
} else {
  process.stdout.write(ubb);
}
