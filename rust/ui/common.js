// 公共工具：Tauri invoke 封装、日志、颜色与画布辅助。所有视图共用。

const INVOKE = window.__TAURI__?.core?.invoke ?? null;

function log(level, message) {
  try {
    INVOKE?.('ui_log', { level, message: String(message) });
  } catch {
    /* 日志不能拖垮 UI */
  }
}

window.addEventListener('error', (e) => log('error', `${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => log('error', `unhandled: ${e.reason}`));

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

/**
 * 主题：dark / light / system。<html data-theme="dark|light"> 是实际生效的那个，样式表按它换变量；
 * 画布代码拿不到 CSS 变量，统一走 Theme.c('grid') 读 --cv-* 变量（按主题缓存，切主题时清）。
 *   Theme.apply('system')   设置项变了 / 启动时调；跟随系统时监听 prefers-color-scheme
 *   Theme.c('axis')         画布颜色字符串，对应 --cv-axis
 *   Theme.subscribe(fn)     实际明暗变了（含系统自己切换）时重画
 * index.html 头部有一段内联脚本在样式表加载前就按 localStorage 把 data-theme 设好，避免启动闪一下深色。
 */
const Theme = (() => {
  const MODES = ['dark', 'light', 'system'];
  const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  let mode = 'dark';
  let resolved = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  let booted = false;
  let cache = {};
  const subs = [];

  const resolve = (m) => (m === 'system' ? (mq && !mq.matches ? 'light' : 'dark') : m);

  function c(name) {
    if (!(name in cache)) {
      const v = getComputedStyle(document.documentElement).getPropertyValue(`--cv-${name}`).trim();
      cache[name] = v || '#808080';
    }
    return cache[name];
  }

  function rgb(name) {
    return hexRgb(c(name));
  }

  /** 原生标题栏跟着走：固定主题就定死，跟随系统就交还系统（null）。浏览器里打开时没有 __TAURI__，静默跳过。 */
  function syncNative() {
    try {
      const w = window.__TAURI__?.window?.getCurrentWindow?.();
      const p = w?.setTheme?.(mode === 'system' ? null : resolved);
      if (p && p.catch) p.catch(() => {});
    } catch {}
  }

  function commit(force) {
    const next = resolve(mode);
    const changed = next !== resolved || document.documentElement.dataset.theme !== next;
    if (!changed && !force) return;
    resolved = next;
    cache = {};
    document.documentElement.dataset.theme = next;
    syncNative();
    if (!changed) return;
    for (const fn of subs) {
      try {
        fn(next);
      } catch (e) {
        log('error', 'theme subscriber failed: ' + e);
      }
    }
  }

  if (mq && mq.addEventListener) {
    mq.addEventListener('change', () => {
      if (mode === 'system') commit(false);
    });
  }

  function apply(m) {
    mode = MODES.includes(m) ? m : 'dark';
    // 第一次总要把原生标题栏同步一遍，哪怕 data-theme 已经被内联脚本设对了
    commit(!booted);
    booted = true;
  }

  return { apply, c, rgb, subscribe: (fn) => subs.push(fn), get: () => mode, resolved: () => resolved, MODES };
})();

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function truncate(s, n) {
  const str = String(s);
  return str.length <= n ? str : str.slice(0, n - 1) + '…';
}

/** SSID 的展示文案：数据层把隐藏网络的 SSID 给成空字符串（不再是 "<hidden>" 字面量），
 *  所以展示时按当前语言补一个占位。过滤「隐藏 SSID」靠的就是这个空字符串。 */
function ssidLabel(ssid) {
  return ssid ? String(ssid) : t('ch.hidden');
}

/** 任意颜色加透明度。rssiColor() 对中间值给的是 rgb(...)，之前只按 #rrggbb 切片，
 *  得到 rgba(NaN…) 被 canvas 忽略，弧和条就沿用上一笔的灰色。 */
function hexAlpha(color, alpha) {
  const [r, g, b] = hexRgb(color);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// 信号→颜色：与表格、曲线保持一致的四段色阶
const RSSI_STOPS = [
  [-95, [127, 29, 29]],
  [-85, [239, 68, 68]],
  [-76, [251, 146, 60]],
  [-68, [251, 191, 36]],
  [-60, [163, 230, 53]],
  [-50, [74, 222, 128]],
  [-30, [0, 230, 118]],
];

function rssiColor(rssi) {
  if (rssi <= RSSI_STOPS[0][0]) return '#7f1d1d';
  if (rssi >= RSSI_STOPS[RSSI_STOPS.length - 1][0]) return '#00e676';
  for (let i = 1; i < RSSI_STOPS.length; i++) {
    const [hi, chi] = RSSI_STOPS[i];
    const [lo, clo] = RSSI_STOPS[i - 1];
    if (rssi <= hi) {
      const t = (rssi - lo) / (hi - lo);
      const c = clo.map((v, k) => Math.round(v + (chi[k] - v) * t));
      return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
    }
  }
  return '#00e676';
}

function rssiRgb(rssi) {
  return hexRgb(rssiColor(rssi));
}

/** 十六进制 / rgb() → [r,g,b]。注意 '#00e676' 这种带字母的颜色不能拿正则抽数字。 */
function hexRgb(color) {
  const s = String(color).trim();
  if (s.startsWith('#')) {
    const h = s.slice(1);
    const n = h.length === 3 ? h.split('').map((x) => x + x).join('') : h;
    return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)];
  }
  const m = s.match(/\d+/g);
  return m ? m.slice(0, 3).map(Number) : [255, 255, 255];
}

/**
 * 色块上的文字该用深色还是浅色：把填充色按 alpha 混到背景上，
 * 再拿两个候选字色分别算 WCAG 对比度，取高的那个。
 */
function inkOn(fill, alpha = 1, bg = Theme.rgb('bg')) {
  const rel = ([r, g, b]) => {
    const f = (c) => {
      const x = c / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const [r, g, b] = hexRgb(fill);
  const mix = (c, i) => c * alpha + bg[i] * (1 - alpha);
  const L = rel([mix(r, 0), mix(g, 1), mix(b, 2)]);
  const DARK = [8, 17, 28];
  const LIGHT = [238, 244, 252];
  const cDark = (L + 0.05) / (rel(DARK) + 0.05);
  const cLight = (rel(LIGHT) + 0.05) / (L + 0.05);
  return cDark >= cLight ? '#08111c' : '#eef4fc';
}

function rssiClass(rssi) {
  if (rssi >= -55) return 'rssi-strong';
  if (rssi >= -67) return 'rssi-ok';
  if (rssi >= -78) return 'rssi-weak';
  return 'rssi-bad';
}

function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return null;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h, dpr };
}

function setStatus(text) {
  const el = $('#status');
  if (el) el.textContent = text;
}

/**
 * 右上角提示框。状态栏那一行太不起眼，导出完了用户看不见，所以成功 / 失败都弹一个。
 *   Toast.show({ kind: 'ok'|'err', title, detail, action: { label, run } })
 * ok 6 秒后自动收起，err 10 秒；鼠标悬着不收。返回元素，测试要查。
 */
const Toast = (() => {
  const LIFE = { ok: 6000, err: 10000 };

  function show({ kind = 'ok', title = '', detail = '', action = null }) {
    const host = $('#toasts');
    if (!host) return null;
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.setAttribute('role', kind === 'err' ? 'alert' : 'status');
    el.innerHTML =
      `<span class="ico">${kind === 'err' ? '⚠' : '✓'}</span>` +
      `<b></b>` +
      `<button class="x" title="${esc(t('toast.close'))}">✕</button>` +
      (detail ? `<span class="path"></span>` : '') +
      (action ? `<button class="act"></button>` : '');
    el.querySelector('b').textContent = title;
    if (detail) el.querySelector('.path').textContent = detail;
    let timer = null;
    const close = () => {
      if (!el.isConnected) return;
      clearTimeout(timer);
      el.classList.add('leaving');
      el.addEventListener('animationend', () => el.remove(), { once: true });
      setTimeout(() => el.remove(), 400); // 动画被禁用时兜底
    };
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(close, LIFE[kind] ?? LIFE.ok);
    };
    el.querySelector('.x').addEventListener('click', close);
    if (action) {
      const btn = el.querySelector('.act');
      btn.textContent = action.label;
      btn.addEventListener('click', async () => {
        try {
          await action.run();
        } catch (e) {
          log('error', 'toast action failed: ' + e);
        }
        close();
      });
    }
    el.addEventListener('mouseenter', () => clearTimeout(timer));
    el.addEventListener('mouseleave', arm);
    // 同时最多留 3 条，旧的先走
    while (host.children.length >= 3) host.firstElementChild.remove();
    host.appendChild(el);
    arm();
    el._close = close;
    return el;
  }

  function clear() {
    $$('#toasts .toast').forEach((el) => el.remove());
  }

  return { show, clear };
})();
