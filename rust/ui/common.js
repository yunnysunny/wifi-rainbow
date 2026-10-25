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

function hexAlpha(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
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
function inkOn(fill, alpha = 1, bg = [11, 14, 20]) {
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
