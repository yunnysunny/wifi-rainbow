// Inspector 视图：实时扫描表（可按 SSID 分组）+ 三频段弧形图 + 信号历史曲线 / 变更事件。

const BANDS = {
  '2.4 GHz': { min: 2395, max: 2495, channels: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14] },
  '5 GHz': {
    min: 5140, max: 5900,
    channels: [36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128,
      132, 136, 140, 144, 149, 153, 157, 161, 165],
  },
  '6 GHz': {
    min: 5920, max: 7130,
    channels: [1, 5, 9, 13, 17, 21, 25, 29, 33, 37, 41, 45, 49, 53, 57, 61, 65, 69, 73, 77,
      81, 85, 89, 93, 97, 101, 105, 109, 113, 117, 121, 125, 129, 133, 137, 141, 145, 149,
      153, 157, 161, 165, 169, 173, 177, 181, 185, 189, 193, 197, 201, 205, 209, 213, 217, 221, 225, 229, 233],
  },
};

const HISTORY_WINDOW_MS = 180_000;
const MAX_POINTS = 240;
const AUTO_SERIES = 6;
const BADGE_TTL_MS = 25_000;
const EVENTS_SHOWN = 20;
const PALETTE = ['#4aa3ff', '#4ade80', '#fbbf24', '#f87171', '#a78bfa', '#22d3ee',
                 '#fb923c', '#34d399', '#f472b6', '#93c5fd'];

const Inspector = (() => {
  const VIEW_KEY = 'wifisurvey.view.v1';

  const state = {
    aps: [],
    sortKey: 'rssi',
    sortDesc: true,
    filter: '',
    expanded: new Set(),       // 分组模式下展开的 SSID 组
    histPanel: 'curve',        // curve / events
    scanning: false,
    timer: null,
    lastScan: null,
    scans: 0,
    ifaces: null,
    ifaceErr: null,
    conn: [],                  // current_connection 结果
    connSince: new Map(),      // bssid -> 第一次观察到「已连接」的时间
    history: new Map(),
    selected: new Set(),
    userPicked: false,         // 用户动过图例就不再自动挑曲线
    colors: new Map(),
    colorSeq: 0,
    changes: Changes.create(),
    fails: 0,                  // 连续扫描失败次数（指数退避用）
    nextRetryAt: 0,
    lastError: null,
    lastErrorAt: null,
  };

  // ------------------------------------------------------------ 视图状态持久化

  function loadViewState() {
    try {
      const raw = localStorage.getItem(VIEW_KEY);
      if (!raw) return;
      const v = JSON.parse(raw);
      if (typeof v.sortKey === 'string') state.sortKey = v.sortKey;
      if (typeof v.sortDesc === 'boolean') state.sortDesc = v.sortDesc;
      if (typeof v.filter === 'string') state.filter = v.filter;
      if (Array.isArray(v.expanded)) state.expanded = new Set(v.expanded.filter((s) => typeof s === 'string'));
      if (v.histPanel === 'events' || v.histPanel === 'curve') state.histPanel = v.histPanel;
    } catch (e) {
      log('error', 'view state load failed: ' + e);
    }
  }

  function saveViewState() {
    try {
      localStorage.setItem(
        VIEW_KEY,
        JSON.stringify({
          sortKey: state.sortKey,
          sortDesc: state.sortDesc,
          filter: state.filter,
          expanded: [...state.expanded],
          histPanel: state.histPanel,
        })
      );
    } catch (e) {
      log('error', 'view state save failed: ' + e);
    }
  }

  function channelToFreq(band, ch) {
    if (band === '2.4 GHz') return ch === 14 ? 2484 : 2407 + 5 * ch;
    if (band === '5 GHz') return 5000 + 5 * ch;
    return 5950 + 5 * ch;
  }

  function colorFor(bssid) {
    if (!state.colors.has(bssid)) {
      state.colors.set(bssid, PALETTE[state.colorSeq++ % PALETTE.length]);
    }
    return state.colors.get(bssid);
  }

  function connFor(bssid) {
    return state.conn.find((c) => c.bssid === bssid) || null;
  }

  // ------------------------------------------------------------ 三频段图

  function visible() {
    return state.aps.filter((a) => Settings.accept(a));
  }

  function drawBand(container) {
    const band = container.dataset.band;
    const spec = BANDS[band];
    const canvas = container.querySelector('canvas');
    const meta = container.querySelector('.meta');
    const list = visible().filter((a) => a.band === band && a.freq_mhz);
    meta.textContent = list.length
      ? t('chart.meta', { n: list.length, rssi: Math.max(...list.map((a) => a.rssi)) })
      : t('chart.nodata');

    const fitted = fitCanvas(canvas);
    if (!fitted) return;
    const { ctx, w, h } = fitted;

    const padL = 30, padR = 10, padT = 10, padB = 16;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;
    const baseline = padT + plotH;
    const xOf = (freq) => padL + ((freq - spec.min) / (spec.max - spec.min)) * plotW;
    const rOf = (rssi) => Math.max(3, Math.min(plotH, ((rssi + 95) / 70) * plotH));
    container._geom = { band, spec, xOf, rOf, padL, padR, padT, w, h, baseline, plotW };

    ctx.strokeStyle = '#232b3a';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#6b768c';
    ctx.font = '9px Consolas, monospace';
    ctx.textAlign = 'center';
    const labelEvery = spec.channels.length > 26 ? 8 : 1;
    spec.channels.forEach((ch, idx) => {
      const x = xOf(channelToFreq(band, ch));
      if (x < padL - 1 || x > w - padR + 1) return;
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, baseline);
      ctx.stroke();
      if (idx % labelEvery === 0) ctx.fillText(String(ch), x, h - 4);
    });

    ctx.textAlign = 'right';
    for (const level of [-30, -50, -70, -90]) {
      const y = baseline - rOf(level);
      if (y < padT - 1) continue;
      ctx.strokeStyle = '#1b2230';
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();
      ctx.fillStyle = '#5b6579';
      ctx.fillText(String(level), padL - 4, y + 3);
    }

    // 先铺所有填充，再统一描边：否则后画的强信号填充会把先画的弱信号轮廓压淡，
    // 同信道上一强一弱两个 AP（比如 ch40 的 -39 和 -42）就只剩一道弧看得见。
    const ordered = [...list].sort((a, b) => a.rssi - b.rssi).map((ap) => ({
      ap,
      cx: xOf(ap.freq_mhz),
      rx: Math.max(3, (ap.width_mhz / 2) * (plotW / (spec.max - spec.min))),
      ry: rOf(ap.rssi),
      color: rssiColor(ap.rssi),
    }));

    for (const it of ordered) {
      ctx.beginPath();
      ctx.ellipse(it.cx, baseline, it.rx, it.ry, 0, Math.PI, Math.PI * 2);
      ctx.fillStyle = hexAlpha(it.color, 0.14);
      ctx.fill();
    }

    for (const it of [...ordered].reverse()) {
      // 被更强 AP 的弧完全盖住的，改用虚线，否则套在里面根本分辨不出来
      const covered = ordered.some(
        (o) =>
          o !== it &&
          o.ap.rssi > it.ap.rssi &&
          o.ry >= it.ry - 0.5 &&
          Math.abs(o.cx - it.cx) + o.rx >= it.rx - 0.5
      );
      ctx.beginPath();
      ctx.ellipse(it.cx, baseline, it.rx, it.ry, 0, Math.PI, Math.PI * 2);
      ctx.setLineDash(covered ? [4, 3] : []);
      ctx.strokeStyle = hexAlpha(it.color, 0.95);
      ctx.lineWidth = covered ? 1.1 : 1.3;
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // 已连接的 AP：弧顶画一个小圆点，一眼能找到「我连的是哪个」
    for (const it of ordered) {
      if (!connFor(it.ap.bssid)) continue;
      ctx.beginPath();
      ctx.arc(it.cx, baseline - it.ry, 3.2, 0, Math.PI * 2);
      ctx.fillStyle = '#eef4fc';
      ctx.fill();
      ctx.strokeStyle = it.color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    if (!container._hoverBound) {
      container._hoverBound = true;
      canvas.addEventListener('mousemove', (ev) => showBandTip(container, ev));
      canvas.addEventListener('mouseleave', () => ($('#tip').style.display = 'none'));
      canvas.addEventListener('click', (ev) => {
        const hit = hitTest(container, ev);
        if (hit) Detail.show(hit);
        $('#tip').style.display = 'none';
      });
    }
  }

  /** 弧形命中判定：椭圆的上半部区域。 */
  function hitTest(container, ev) {
    const g = container._geom;
    if (!g) return null;
    const rect = container.querySelector('canvas').getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const my = ev.clientY - rect.top;

    let hit = null;
    for (const ap of visible()) {
      if (ap.band !== g.band) continue;
      const cx = g.xOf(ap.freq_mhz);
      const rx = Math.max(3, (ap.width_mhz / 2) * (g.plotW / (g.spec.max - g.spec.min)));
      const ry = g.rOf(ap.rssi);
      const dx = (mx - cx) / rx;
      if (Math.abs(dx) > 1.05) continue;
      const span = ry * Math.sqrt(Math.max(0, 1 - dx * dx));
      if (my < g.baseline - span - 2 || my > g.baseline + 2) continue;
      if (!hit || ap.rssi > hit.rssi) hit = ap;
    }
    return hit;
  }

  function showBandTip(container, ev) {
    const g = container._geom;
    const tip = $('#tip');
    if (!g) return;
    const hit = hitTest(container, ev);
    if (!hit) {
      tip.style.display = 'none';
      return;
    }

    const alias = Settings.alias(hit.ssid);
    tip.innerHTML = `<b>${esc(Settings.displayName(hit.ssid))}${connFor(hit.bssid) ? ` <i class="badge conn">${t('tag.conn')}</i>` : ''}</b>
      ${alias ? `<span>${esc(ssidLabel(hit.ssid))}</span>` : ''}
      <span class="mono">${hit.bssid}</span>
      <span>${hit.rssi} dBm · ${hit.quality}%</span>
      <span>ch ${hit.channel ?? '—'} · ${hit.width_mhz} MHz · ${hit.phy}</span>
      <span>${hit.security}${hit.akm ? ' / ' + esc(hit.akm) : ''}</span>`;

    // tip 是绝对定位在 #charts（三张图的大容器）里的，坐标就得相对容器算。
    tip.style.display = 'block';
    const host = $('#charts').getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let x = ev.clientX - host.left + 14;
    let y = ev.clientY - host.top - 10;
    if (x + tw > host.width - 4) x = ev.clientX - host.left - tw - 14;
    if (x < 4) x = 4;
    if (y < 4) y = 4;
    if (y + th > host.height - 4) y = Math.max(4, host.height - th - 4);
    tip.style.left = `${Math.round(x)}px`;
    tip.style.top = `${Math.round(y)}px`;
  }

  // ------------------------------------------------------------ 历史曲线

  /** 自动挑曲线：关注列表里的 SSID 优先（它们的每个 BSSID 都画），余下名额按最强补齐。 */
  function autoPick() {
    const vis = [...visible()].sort((a, b) => b.rssi - a.rssi);
    const picked = new Set();
    for (const a of vis) if (Settings.isWatched(a.ssid)) picked.add(a.bssid);
    for (const a of vis) {
      if (picked.size >= AUTO_SERIES) break;
      picked.add(a.bssid);
    }
    state.selected = picked;
  }

  function pushHistory(now) {
    for (const ap of state.aps) {
      let h = state.history.get(ap.bssid);
      if (!h) {
        h = { ssid: ap.ssid, band: ap.band, pts: [] };
        state.history.set(ap.bssid, h);
      }
      h.ssid = ap.ssid;
      h.band = ap.band;
      h.pts.push({ t: now, rssi: ap.rssi });
      while (h.pts.length && now - h.pts[0].t > HISTORY_WINDOW_MS) h.pts.shift();
      if (h.pts.length > MAX_POINTS) h.pts.splice(0, h.pts.length - MAX_POINTS);
    }
    for (const [bssid, h] of state.history) {
      const last = h.pts[h.pts.length - 1];
      if (!last || now - last.t > HISTORY_WINDOW_MS * 2) {
        state.history.delete(bssid);
        state.selected.delete(bssid);
      }
    }
    // 被过滤掉的 AP（隐藏 SSID / 低于阀值 / 关掉的频段）不再占用曲线名额
    const visSet = new Set(visible().map((a) => a.bssid));
    for (const bssid of [...state.selected]) if (!visSet.has(bssid)) state.selected.delete(bssid);

    // 用户没手动挑过曲线：默认集合每轮按「关注列表 + 最强」重算，关注的 AP 一冒出来就进图
    if (!state.userPicked || state.selected.size === 0) autoPick();
  }

  function drawHistory() {
    const canvas = $('#history canvas');
    if (state.histPanel === 'events') {
      renderEvents();
      renderLegend();
      return;
    }
    const fitted = fitCanvas(canvas);
    if (!fitted) return;
    const { ctx, w, h } = fitted;

    const padL = 34, padR = 74, padT = 10, padB = 16;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;
    const bottom = padT + plotH;
    const now = Date.now();
    const t0 = now - HISTORY_WINDOW_MS;

    const xOf = (t) => padL + ((t - t0) / HISTORY_WINDOW_MS) * plotW;
    const yOf = (rssi) => padT + ((rssi + 20) / -80) * plotH;

    ctx.font = '9px Consolas, monospace';
    ctx.textAlign = 'right';
    for (const level of [-30, -40, -50, -60, -70, -80, -90]) {
      const y = yOf(level);
      if (y < padT || y > bottom) continue;
      ctx.strokeStyle = level === -60 ? '#243044' : '#1a2130';
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      ctx.fillStyle = '#5b6579';
      ctx.fillText(String(level), padL - 4, y + 3);
    }

    ctx.textAlign = 'center';
    for (let s = 0; s <= 180; s += 30) {
      const x = xOf(t0 + s * 1000);
      if (x < padL - 1) continue;
      ctx.strokeStyle = '#1a2130';
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, bottom);
      ctx.stroke();
      ctx.fillStyle = '#5b6579';
      ctx.fillText(s === 180 ? t('chart.now') : `-${180 - s}s`, Math.min(x, w - padR + 26), h - 4);
    }

    const visSet = new Set(visible().map((a) => a.bssid));
    const selected = [...state.selected]
      .map((bssid) => [bssid, state.history.get(bssid)])
      .filter(([bssid, hist]) => hist && hist.pts.length && visSet.has(bssid));

    if (!selected.length) {
      ctx.fillStyle = '#5b6579';
      ctx.textAlign = 'center';
      ctx.font = '12px "Segoe UI", sans-serif';
      ctx.fillText(t('chart.waiting'), padL + plotW / 2, padT + plotH / 2);
      renderLegend();
      return;
    }

    selected.sort((a, b) => {
      const ra = a[1].pts[a[1].pts.length - 1].rssi;
      const rb = b[1].pts[b[1].pts.length - 1].rssi;
      return ra - rb;
    });
    const placed = [];
    for (const [bssid, hist] of selected) {
      const color = colorFor(bssid);
      ctx.beginPath();
      hist.pts.forEach((p, i) => {
        const x = xOf(p.t);
        const y = yOf(p.rssi);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6;
      ctx.stroke();

      const last = hist.pts[hist.pts.length - 1];
      const lx = xOf(last.t);
      const ly = yOf(last.rssi);
      ctx.beginPath();
      ctx.arc(lx, ly, 2.4, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();

      ctx.fillStyle = color;
      ctx.textAlign = 'left';
      ctx.font = '10px Consolas, monospace';
      // 末端标签避让：位置挤在一起就往上错一行，彻底错不开就只画线不画字
      const want = Math.min(bottom - 2, Math.max(padT + 8, ly + 3));
      let ty = want;
      while (placed.some((p) => Math.abs(p - ty) < 11) && ty > padT + 8) ty -= 11;
      if (placed.some((p) => Math.abs(p - ty) < 11)) continue;
      placed.push(ty);
      ctx.fillText(`${truncate(Settings.displayName(hist.ssid), 10)} ${last.rssi}`, padL + plotW + 6, ty);
    }

    renderLegend();
  }

  function renderLegend() {
    const legend = $('#legend');
    const visSet = new Set(visible().map((a) => a.bssid));
    const entries = [...state.history.entries()]
      .filter(([bssid]) => visSet.has(bssid))
      .map(([bssid, h]) => ({ bssid, ssid: h.ssid, last: h.pts[h.pts.length - 1]?.rssi }))
      .sort((a, b) => (b.last ?? -999) - (a.last ?? -999))
      .slice(0, 14);

    const sig = entries.map((e) => `${e.bssid}:${e.last}:${state.selected.has(e.bssid) ? 1 : 0}:${Settings.displayName(e.ssid)}`).join('|');
    if (sig === renderLegend._sig) return;
    renderLegend._sig = sig;

    legend.innerHTML = entries
      .map((e) => {
        const on = state.selected.has(e.bssid);
        const color = on ? colorFor(e.bssid) : '#3b4457';
        const star = Settings.isWatched(e.ssid) ? '★ ' : '';
        return `<button class="chip${on ? ' on' : ''}" data-bssid="${e.bssid}" style="--c:${color}">
          <i></i>${star}${esc(truncate(Settings.displayName(e.ssid), 14))}<span>${e.last ?? '—'}</span>
        </button>`;
      })
      .join('');

    legend.querySelectorAll('.chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const bssid = chip.dataset.bssid;
        if (state.selected.has(bssid)) state.selected.delete(bssid);
        else state.selected.add(bssid);
        state.userPicked = true;
        renderLegend._sig = null;
        drawHistory();
        renderTable();
      });
    });
  }

  // ------------------------------------------------------------ 变更事件面板

  function eventText(ev) {
    switch (ev.kind) {
      case 'new': return t('ev.new', { ch: ev.channel ?? '—', rssi: ev.rssi });
      case 'gone': return t('ev.gone', { ch: ev.channel ?? '—', rssi: ev.rssi });
      case 'drop': return t('ev.drop', { d: Math.abs(ev.delta), from: ev.from, to: ev.rssi });
      case 'chan': return t('ev.chan', { from: ev.from ?? '—', to: ev.to ?? '—' });
      case 'width': return t('ev.width', { from: ev.from, to: ev.to });
      default: return ev.kind;
    }
  }

  function badgeText(kind, ev) {
    switch (kind) {
      case 'new': return t('tag.new');
      case 'gone': return t('tag.gone');
      case 'drop': return `↓${Math.abs(ev.delta)}`;
      case 'chan': return `ch${ev.from ?? '?'}→${ev.to ?? '?'}`;
      case 'width': return `${ev.from}→${ev.to}M`;
      default: return kind;
    }
  }

  function badgesFor(bssid, now) {
    const flags = state.changes.flagsFor(bssid, now, BADGE_TTL_MS);
    // 「消失」后又「新出现」：只留较新的那个，两个一起挂着没法读
    if (flags.new && flags.gone) delete flags[flags.new.t >= flags.gone.t ? 'gone' : 'new'];
    return Object.entries(flags)
      .map(([kind, ev]) => `<i class="badge ${kind}" title="${esc(eventText(ev))}">${esc(badgeText(kind, ev))}</i>`)
      .join('');
  }

  function renderEvents() {
    const host = $('#events');
    if (!host) return;
    const list = state.changes
      .recent(EVENTS_SHOWN * 3)
      .filter((ev) => Settings.accept({ ssid: ev.ssid, rssi: ev.rssi, band: ev.band }))
      .slice(0, EVENTS_SHOWN);
    const sig = list.map((e) => `${e.t}:${e.kind}:${e.bssid}`).join('|') + I18n.get();
    if (sig === renderEvents._sig) return;
    renderEvents._sig = sig;
    host.innerHTML = list.length
      ? list
          .map(
            (ev) => `<li data-bssid="${ev.bssid}">
              <time>${new Date(ev.t).toLocaleTimeString()}</time>
              <i class="badge ${ev.kind}">${esc(badgeText(ev.kind, ev))}</i>
              <b>${esc(Settings.displayName(ev.ssid))}</b>
              <span class="mono">${ev.bssid}</span>
              <span>${esc(eventText(ev))}</span>
            </li>`
          )
          .join('')
      : `<li class="ev-empty">${t('ev.empty')}</li>`;
  }

  function setHistPanel(mode) {
    state.histPanel = mode === 'events' ? 'events' : 'curve';
    $('#history').dataset.panel = state.histPanel;
    const btn = $('#hist-mode');
    if (btn) btn.textContent = state.histPanel === 'events' ? t('hist.curve') : t('hist.events', { n: state.changes.size() });
    saveViewState();
    renderEvents._sig = null;
    drawHistory();
  }

  function refreshHistModeLabel() {
    const btn = $('#hist-mode');
    if (btn && state.histPanel !== 'events') btn.textContent = t('hist.events', { n: state.changes.size() });
    else if (btn) btn.textContent = t('hist.curve');
  }

  function trendOf(bssid) {
    const h = state.history.get(bssid);
    if (!h || h.pts.length < 3) return null;
    const recent = h.pts.slice(-Math.min(5, h.pts.length));
    const older = h.pts.slice(-Math.min(15, h.pts.length), -Math.min(5, h.pts.length));
    if (!older.length) return null;
    const avg = (arr) => arr.reduce((s, p) => s + p.rssi, 0) / arr.length;
    return Math.round(avg(recent) - avg(older));
  }

  // ------------------------------------------------------------ 表格

  const SORT_DESC_DEFAULT = ['rssi', 'quality', 'stations', 'utilization', 'trend', 'bssid'];

  function matchesFilter(a, filter) {
    if (!filter) return true;
    return (
      a.ssid.toLowerCase().includes(filter) ||
      a.bssid.toLowerCase().includes(filter) ||
      Settings.alias(a.ssid).toLowerCase().includes(filter)
    );
  }

  /** 当前过滤 + 排序后的平铺行（CSV 导出和非分组模式共用）。 */
  function flatRows() {
    const filter = state.filter.trim().toLowerCase();
    const rows = visible().filter((a) => matchesFilter(a, filter));
    return sortBy(rows, (a) => sortValue(a));
  }

  function sortValue(a) {
    const key = state.sortKey;
    if (key === 'trend') return trendOf(a.bssid);
    if (key === 'ssid') return Settings.displayName(a.ssid);
    return a[key];
  }

  function sortBy(rows, valueOf) {
    return rows.sort((a, b) => {
      const va = valueOf(a);
      const vb = valueOf(b);
      const na = va === null || va === undefined ? -Infinity : va;
      const nb = vb === null || vb === undefined ? -Infinity : vb;
      const cmp = typeof na === 'number' && typeof nb === 'number' ? na - nb : String(na).localeCompare(String(nb));
      return state.sortDesc ? -cmp : cmp;
    });
  }

  /** 去掉 SSID 末尾的频段后缀：sgreat-5g / sunnywifi_5G / Home 2.4GHz → sgreat / sunnywifi / Home。 */
  function baseSsid(ssid) {
    return String(ssid)
      .replace(/[\s_\-]*(?:2\.4\s*g(?:hz)?|2g(?:hz)?|5\s*g(?:hz)?|6\s*g(?:hz)?|6e)$/i, '')
      .trim()
      .toLowerCase();
  }

  /**
   * 分组：同一台路由器的几个 BSSID 折成一行。两个 AP 归到一组的条件（取并集）：
   *   1. 去掉频段后缀后 SSID 相同（sgreat / sgreat-5g；sunnywifi / sunnywifi_5G）
   *   2. BSSID 前 5 个字节相同（88:c3:97:e9:8c:ba / :bb 这种同一块板子的双频）
   * 组名取成员里最短的 SSID。隐藏 SSID 单独成一组（哪怕只有一个）；具名的只有 ≥2 个成员才成组。
   */
  function groupRows() {
    const filter = state.filter.trim().toLowerCase();
    const list = visible().filter((a) => matchesFilter(a, filter));
    const parent = new Map(list.map((a) => [a.bssid, a.bssid]));
    const find = (x) => {
      while (parent.get(x) !== x) {
        parent.set(x, parent.get(parent.get(x)));
        x = parent.get(x);
      }
      return x;
    };
    const union = (a, b) => parent.set(find(a), find(b));
    const buckets = new Map();
    const bucket = (k, a) => {
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(a);
    };
    for (const a of list) {
      if (!a.ssid) {
        bucket('hidden', a);
        continue;
      }
      bucket('ssid:' + baseSsid(a.ssid), a);
      bucket('mac:' + a.bssid.slice(0, 14).toLowerCase(), a);
    }
    for (const members of buckets.values()) for (let i = 1; i < members.length; i++) union(members[0].bssid, members[i].bssid);

    const byRoot = new Map();
    for (const a of list) {
      const r = find(a.bssid);
      if (!byRoot.has(r)) byRoot.set(r, []);
      byRoot.get(r).push(a);
    }
    const items = [];
    for (const members of byRoot.values()) {
      const named = members.filter((a) => a.ssid).map((a) => a.ssid);
      const key = named.length ? [...new Set(named)].sort((x, y) => x.length - y.length || x.localeCompare(y))[0] : '';
      const sorted = sortBy([...members], (a) => sortValue(a));
      if (members.length === 1 && key !== '') {
        items.push({ kind: 'ap', ap: sorted[0] });
        continue;
      }
      const strongest = [...members].sort((a, b) => b.rssi - a.rssi)[0];
      const weakest = [...members].sort((a, b) => a.rssi - b.rssi)[0];
      const uniq = (f) => [...new Set(members.map(f).filter((v) => v !== null && v !== undefined))];
      const chans = uniq((a) => a.channel).sort((a, b) => a - b);
      const bands = ['2.4 GHz', '5 GHz', '6 GHz'].filter((b) => members.some((a) => a.band === b));
      const stations = members.some((a) => a.stations != null) ? members.reduce((s, a) => s + (a.stations ?? 0), 0) : null;
      const utils = members.map((a) => a.utilization).filter((u) => u != null);
      items.push({
        kind: 'group',
        key,
        ssids: [...new Set(members.map((a) => a.ssid))],
        members: sorted,
        strongest,
        weakest,
        chans,
        bands,
        widths: uniq((a) => a.width_mhz).sort((a, b) => a - b),
        phys: uniq((a) => a.phy),
        secs: uniq((a) => a.security),
        akms: uniq((a) => a.akm).filter(Boolean),
        stations,
        util: utils.length ? Math.max(...utils) : null,
      });
    }
    // 组与平铺行一起排：组用聚合值参与排序
    const key = state.sortKey;
    const groupValue = (g) => {
      switch (key) {
        case 'ssid': return Settings.displayName(g.key);
        case 'bssid': return g.members.length;
        case 'rssi': return g.strongest.rssi;
        case 'quality': return g.strongest.quality;
        case 'channel': return g.chans[0] ?? null;
        case 'band': return g.bands[0] ?? '';
        case 'width_mhz': return g.widths[g.widths.length - 1] ?? null;
        case 'phy': return g.phys.join(',');
        case 'security': return g.secs.join(',');
        case 'akm': return g.akms.join(',');
        case 'stations': return g.stations;
        case 'utilization': return g.util;
        case 'trend': return trendOf(g.strongest.bssid);
        default: return null;
      }
    };
    return sortBy(items, (it) => (it.kind === 'group' ? groupValue(it) : sortValue(it.ap)));
  }

  function trendCell(bssid) {
    const trend = trendOf(bssid);
    const text = trend === null ? '—' : trend > 1 ? `↑ ${trend}` : trend < -1 ? `↓ ${Math.abs(trend)}` : '→ 0';
    const cls = trend === null ? '' : trend > 1 ? 'rssi-strong' : trend < -1 ? 'rssi-bad' : '';
    return `<td class="num ${cls}">${text}</td>`;
  }

  function apRowHtml(a, now, sub) {
    const barW = Math.max(2, Math.round(((a.rssi + 95) / 65) * 44));
    const tracked = state.selected.has(a.bssid) ? `style="color:${colorFor(a.bssid)}"` : '';
    const conn = connFor(a.bssid);
    const alias = Settings.alias(a.ssid);
    const name = sub
      ? `<span class="sub-mark">└</span> <span class="muted">${esc(ssidLabel(a.ssid))}</span>`
      : `${esc(Settings.displayName(a.ssid))}${alias ? ` <span class="muted">${esc(ssidLabel(a.ssid))}</span>` : ''}`;
    const star = !sub && Settings.isWatched(a.ssid) ? `<i class="star on" data-star="${esc(a.ssid)}" title="${t('watch.off')}">★</i>` : '';
    return `<tr data-bssid="${a.bssid}" class="ap-row${sub ? ' sub' : ''}${conn ? ' conn' : ''}">
      <td ${tracked}>${star}${name}${conn ? ` <i class="badge conn">${t('tag.conn')}</i>` : ''}${badgesFor(a.bssid, now)}</td>
      <td class="mono">${a.bssid}</td>
      <td class="num ${rssiClass(a.rssi)}"><span class="bar-cell" style="width:${barW}px"></span> ${a.rssi}</td>
      <td class="num">${a.quality}</td>
      <td class="num">${a.channel ?? '—'}</td>
      <td>${a.band}</td>
      <td class="num">${a.width_mhz}</td>
      <td>${a.phy}</td>
      <td>${a.security}</td>
      <td class="mono">${a.akm || '—'}</td>
      <td class="num">${a.stations ?? '—'}</td>
      <td class="num">${a.utilization != null ? a.utilization + '%' : '—'}</td>
      ${trendCell(a.bssid)}
    </tr>`;
  }

  function groupRowHtml(g, now) {
    const open = state.expanded.has(g.key);
    const barW = Math.max(2, Math.round(((g.strongest.rssi + 95) / 65) * 44));
    const alias = Settings.alias(g.key) || g.ssids.map((s) => Settings.alias(s)).find(Boolean) || '';
    const conn = g.members.find((a) => connFor(a.bssid));
    const tracked = g.members.some((a) => state.selected.has(a.bssid));
    const watched = g.ssids.some((s) => Settings.isWatched(s));
    const badges = [...new Set(g.members.flatMap((a) => Object.keys(state.changes.flagsFor(a.bssid, now, BADGE_TTL_MS))))]
      .map((kind) => `<i class="badge ${kind}">${esc(kind === 'drop' ? '↓' : badgeText(kind, {}))}</i>`)
      .join('');
    const range = g.strongest.rssi === g.weakest.rssi ? `${g.strongest.rssi}` : `${g.strongest.rssi} … ${g.weakest.rssi}`;
    return `<tr data-group="${esc(g.key)}" class="grp-row${open ? ' open' : ''}${conn ? ' conn' : ''}">
      <td class="${tracked ? 'tracked' : ''}"><span class="caret">${open ? '▾' : '▸'}</span>
        <i class="star${watched ? ' on' : ''}" data-star="${esc(g.key)}" title="${watched ? t('watch.off') : t('watch.on')}">${watched ? '★' : '☆'}</i>
        <b>${esc(alias || ssidLabel(g.key))}</b>${alias ? ` <span class="muted">${esc(ssidLabel(g.key))}</span>` : ''}
        <span class="cnt">×${g.members.length}</span>${conn ? ` <i class="badge conn">${t('tag.conn')}</i>` : ''}${badges}</td>
      <td class="mono muted">${t('grp.bssids', { n: g.members.length })}</td>
      <td class="num ${rssiClass(g.strongest.rssi)}"><span class="bar-cell" style="width:${barW}px"></span> ${range}</td>
      <td class="num">${g.strongest.quality}</td>
      <td class="num">${g.chans.length ? g.chans.join(' / ') : '—'}</td>
      <td>${g.bands.map((b) => b.replace(' GHz', '')).join(' / ')}</td>
      <td class="num">${g.widths.join(' / ')}</td>
      <td>${g.phys.map((p) => p.replace('802.11', '')).join(' / ')}</td>
      <td>${g.secs.join(' / ')}</td>
      <td class="mono">${g.akms.length === 1 ? g.akms[0] : g.akms.length ? t('grp.mixed') : '—'}</td>
      <td class="num">${g.stations ?? '—'}</td>
      <td class="num">${g.util != null ? g.util + '%' : '—'}</td>
      ${trendCell(g.strongest.bssid)}
    </tr>`;
  }

  function renderTable() {
    const tbody = $('#ap tbody');
    const now = Date.now();
    const grouped = Settings.get().groupBy === 'ssid';
    let html = '';
    let count = 0;
    if (grouped) {
      for (const it of groupRows()) {
        if (it.kind === 'ap') {
          html += apRowHtml(it.ap, now, false);
          count++;
        } else {
          html += groupRowHtml(it, now);
          count += it.members.length;
          if (state.expanded.has(it.key)) for (const a of it.members) html += apRowHtml(a, now, true);
        }
      }
    } else {
      for (const a of flatRows()) {
        html += apRowHtml(a, now, false);
        count++;
      }
    }
    tbody.innerHTML = html;
    $('#empty').style.display = count ? 'none' : 'block';
    $$('#ap thead th').forEach((th) => {
      th.classList.toggle('sorted', th.dataset.key === state.sortKey);
      th.classList.toggle('desc', th.dataset.key === state.sortKey && state.sortDesc);
    });
    const sel = Detail.currentBssid?.();
    if (sel) tbody.querySelector(`tr[data-bssid="${sel}"]`)?.classList.add('sel');
  }

  /** 分组表格的结构统计（selftest 用）：组数、各组成员数之和、展开数、单行数。 */
  function groupStats() {
    const items = groupRows();
    const groups = items.filter((i) => i.kind === 'group');
    return {
      groups: groups.length,
      multiSsid: groups.filter((g) => g.ssids.filter(Boolean).length > 1).length,
      memberSum: groups.reduce((s, g) => s + g.members.length, 0),
      singles: items.filter((i) => i.kind === 'ap').length,
      expanded: groups.filter((g) => state.expanded.has(g.key)).length,
      hiddenGroup: groups.some((g) => g.key === ''),
    };
  }

  function renderAll() {
    $$('.chart').forEach(drawBand);
    drawHistory();
    renderTable();
    refreshHistModeLabel();
  }

  // ------------------------------------------------------------ 数据

  // 网卡栏文案自己管：切语言时不能用静态 data-i18n 盖回「正在读取…」
  function ifaceText() {
    if (!INVOKE) return t('status.notauri');
    if (state.ifaceErr) return t('status.ifacefail', { e: state.ifaceErr });
    if (!state.ifaces) return t('bar.iface.loading');
    if (!state.ifaces.length) return t('status.noiface');
    const want = Settings.get().iface;
    return state.ifaces
      .map((i) => {
        const c = state.conn.find((x) => x.iface_guid === i.guid);
        const picked = want && want === i.guid ? '▶ ' : '';
        return `${picked}${i.description} [${c ? `${Settings.displayName(c.ssid)} · ${c.rx_mbps} Mbps` : i.state}]`;
      })
      .join(' · ');
  }

  function renderIface() {
    const el = $('#iface');
    if (el) el.textContent = ifaceText();
  }

  async function loadInterfaces() {
    if (!INVOKE) {
      renderIface();
      return;
    }
    try {
      state.ifaces = await INVOKE('list_interfaces');
      state.ifaceErr = null;
    } catch (e) {
      state.ifaceErr = e;
    }
    renderIface();
    Settings.renderIfaceSelect?.();
  }

  async function loadConnection() {
    if (!INVOKE) return;
    try {
      const conn = await INVOKE('current_connection');
      const now = Date.now();
      const live = new Set(conn.map((c) => c.bssid));
      for (const c of conn) if (!state.connSince.has(c.bssid)) state.connSince.set(c.bssid, now);
      for (const b of [...state.connSince.keys()]) if (!live.has(b)) state.connSince.delete(b);
      state.conn = conn;
    } catch (e) {
      log('error', 'current_connection failed: ' + e);
      state.conn = [];
    }
  }

  function backoffMs(fails) {
    return Math.min(60_000, 2000 * Math.pow(2, Math.max(0, fails - 1)));
  }

  function renderStatusError() {
    const el = $('#status');
    if (!el) return;
    el.classList.toggle('err', !!state.lastError);
    const box = $('#errbox');
    if (box && !state.lastError) box.style.display = 'none';
  }

  function toggleErrorBox() {
    const box = $('#errbox');
    if (!box) return;
    if (!state.lastError) {
      box.style.display = 'none';
      return;
    }
    const open = box.style.display !== 'block';
    if (open) {
      box.innerHTML = `<b>${t('err.title', { n: state.fails })}</b>
        <span>${esc(state.lastErrorAt ? state.lastErrorAt.toLocaleTimeString() : '')}</span>
        <pre>${esc(state.lastError)}</pre>
        <span>${t('err.hint', { s: Math.round(Math.max(0, state.nextRetryAt - Date.now()) / 1000) })}</span>`;
    }
    box.style.display = open ? 'block' : 'none';
  }

  /** 扫一次。已经在扫就等那一轮结束（手动点「扫描一次」撞上自动刷新时不会丢请求，也不会并发两次）。 */
  function scanOnce() {
    if (!INVOKE || state.frozen) return Promise.resolve(state.aps);
    if (state.inflight) return state.inflight;
    state.inflight = doScan().finally(() => {
      state.inflight = null;
    });
    return state.inflight;
  }

  async function doScan() {
    state.scanning = true;
    const btn = $('#scan');
    if (btn) btn.disabled = true;
    setStatus(t('status.scanning'));
    try {
      const [aps] = await Promise.all([
        INVOKE('scan_now', { waitMs: 2200, iface: Settings.get().iface || null }),
        loadConnection(),
      ]);
      state.aps = aps;
      state.lastScan = new Date();
      state.scans++;
      state.fails = 0;
      state.nextRetryAt = 0;
      state.lastError = null;
      renderStatusError();
      const now = Date.now();
      const fresh = state.changes.feed(aps, now);
      pushHistory(now);
      renderEvents._sig = null;
      renderAll();
      renderIface();
      Detail.refresh();
      if (document.body.dataset.view === 'channels') Channels.render();
      setStatus(
        t('status.summary', {
          time: state.lastScan.toLocaleTimeString(),
          n: aps.length,
          rssi: aps.length ? Math.max(...aps.map((a) => a.rssi)) : '—',
        })
      );
      log(
        'info',
        `scan ok: ${aps.length} bss, tracked ${state.selected.size}, history ${state.history.size}` +
          (fresh.length ? `, events +${fresh.length} [${fresh.map((e) => `${e.kind}:${e.ssid || '<hidden>'}`).join(' ')}]` : '') +
          (state.conn.length ? `, conn ${state.conn.map((c) => `${c.ssid}@${c.bssid} ${c.auth}/${c.cipher}`).join(';')}` : '')
      );
    } catch (e) {
      state.fails++;
      state.lastError = String(e?.message || e);
      state.lastErrorAt = new Date();
      const wait = backoffMs(state.fails);
      state.nextRetryAt = Date.now() + wait;
      renderStatusError();
      setStatus(t('status.scanfail.retry', { e: truncate(state.lastError, 60), n: state.fails, s: Math.round(wait / 1000) }));
      log('error', `scan failed (#${state.fails}, retry in ${wait}ms): ${state.lastError}`);
    } finally {
      state.scanning = false;
      if (btn) btn.disabled = false;
    }
    return state.aps;
  }

  /**
   * 演示 / 测试用：不扫真机，直接塞一轮数据（可带过去的时间戳，用来一次性填满历史窗口）。
   * 走的是和 doScan 一样的后半段：变更追踪、历史、重画、详情刷新。
   */
  function inject(aps, conn, at = Date.now()) {
    state.frozen = true; // 之后的真机扫描一律不落地，演示数据不会被盖掉
    state.aps = aps;
    state.conn = conn || [];
    for (const c of state.conn) if (!state.connSince.has(c.bssid)) state.connSince.set(c.bssid, at);
    state.lastScan = new Date(at);
    state.scans++;
    state.changes.feed(aps, at);
    pushHistory(at);
    renderEvents._sig = null;
    renderLegend._sig = null;
    renderAll();
    renderIface();
    Detail.refresh();
    if (document.body.dataset.view === 'channels') Channels.render();
    setStatus(t('status.summary', { time: state.lastScan.toLocaleTimeString(), n: aps.length, rssi: aps.length ? Math.max(...aps.map((a) => a.rssi)) : '—' }));
  }

  function resetHistory() {
    state.history.clear();
    state.selected.clear();
    state.userPicked = false;
    state.changes.reset();
    state.connSince.clear();
    renderLegend._sig = null;
    renderEvents._sig = null;
  }

  function setAuto(on) {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    state.autoOn = !!on;
    const cb = $('#auto');
    if (cb && cb.checked !== state.autoOn) cb.checked = state.autoOn;
    state.autoMs = Math.max(1, Settings.get().scanSec) * 1000;
    if (on) state.timer = setInterval(() => {
      if (document.body.dataset.view !== 'inspector') return;
      // 连续失败时按指数退避：没到重试时刻的 tick 直接跳过
      if (state.fails && Date.now() < state.nextRetryAt) return;
      scanOnce();
    }, state.autoMs);
  }

  /** 设置里改了刷新间隔就叫这个：按当前开关状态重建定时器。 */
  function restartAuto() {
    setAuto(state.autoOn ?? $('#auto')?.checked ?? true);
  }

  /**
   * 图表放大预览：b0/b1/b2 把三频段里的一张铺满整个视图区（顺带吃掉历史图和表格），
   * hist 把信号历史铺满。再点一次或按 Esc 还原。
   */
  function toggleMax(key) {
    state.max = state.max === key ? null : key;
    if (state.max) document.body.dataset.max = state.max;
    else delete document.body.dataset.max;
    $$('.max-btn').forEach((b) => {
      const on = b.dataset.max === state.max;
      b.classList.toggle('on', on);
      b.textContent = on ? '⤡' : '⛶';
      b.title = on ? t('chart.max.on') : t('chart.max');
    });
    // 尺寸变了要重画：next frame 里量到的 clientWidth/Height 才是新布局的
    requestAnimationFrame(() => {
      renderAll();
      log('info', `chart max: ${state.max || 'off'}`);
    });
  }

  // ------------------------------------------------------------ 导出

  function csvCell(v) {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  /** 当前表格（过滤 + 排序后，平铺不分组）→ CSV 文本。表头跟界面一致，另加别名/连接/厂商三列。 */
  function csvText() {
    const heads = $$('#ap thead th').map((th) => th.textContent.trim());
    const extra = [t('csv.alias'), t('csv.conn'), t('csv.vendor'), t('csv.freq'), 'Cipher', t('csv.time')];
    const stamp = (state.lastScan || new Date()).toISOString();
    const lines = [[...heads, ...extra].map(csvCell).join(',')];
    for (const a of flatRows()) {
      const tr = trendOf(a.bssid);
      lines.push(
        [
          ssidLabel(a.ssid), a.bssid, a.rssi, a.quality, a.channel ?? '', a.band, a.width_mhz, a.phy, a.security,
          a.akm || '', a.stations ?? '', a.utilization ?? '', tr ?? '',
          Settings.alias(a.ssid), connFor(a.bssid) ? 1 : 0, Detail.vendorOf(a.bssid), a.freq_mhz, a.cipher || '', stamp,
        ].map(csvCell).join(',')
      );
    }
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  function fileStamp() {
    const d = state.lastScan || new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  /** 导出成功：状态栏 + 右上角提示，提示里带「打开所在文件夹」 */
  function exportDone(kind, path) {
    setStatus(t('export.ok', { path }));
    Toast.show({
      kind: 'ok',
      title: t(kind === 'csv' ? 'export.saved.csv' : 'export.saved.png'),
      detail: path,
      action: INVOKE ? { label: t('export.reveal'), run: () => INVOKE('reveal_file', { path }) } : null,
    });
  }

  function exportFailed(kind, e) {
    setStatus(t('export.fail', { e }));
    Toast.show({ kind: 'err', title: t('export.failed'), detail: String(e) });
    log('error', `export ${kind} failed: ${e}`);
  }

  async function exportCsv() {
    if (!INVOKE) return setStatus(t('status.notauri'));
    try {
      const path = await INVOKE('export_file', { name: `wifi-${fileStamp()}.csv`, data: csvText(), encoding: null });
      exportDone('csv', path);
      log('info', `export csv: ${path} (${flatRows().length} rows)`);
      return path;
    } catch (e) {
      exportFailed('csv', e);
    }
  }

  /** 把当前视图的画布拼成一张 PNG：Inspector 是三频段 + 历史曲线；信道视图是三张频谱。 */
  function composePng() {
    const view = document.body.dataset.view;
    const sources =
      view === 'channels'
        ? ['#ch-spec-24GHz', '#ch-spec-5GHz', '#ch-spec-6GHz'].map((s) => ({ cv: $(s), label: $(s)?.closest('.ch-band')?.querySelector('b')?.textContent }))
        : [...$$('#charts .chart').map((c) => ({ cv: c.querySelector('canvas'), label: `${c.dataset.band} · ${c.querySelector('.meta')?.textContent || ''}` })),
           { cv: $('#history canvas'), label: `${t('hist.title')} · ${t('hist.window')}`, wide: true }];
    const list = sources.filter((s) => s.cv && s.cv.width > 0 && s.cv.height > 0);
    if (!list.length) return null;
    const dpr = window.devicePixelRatio || 1;
    const gap = Math.round(10 * dpr);
    const titleH = Math.round(26 * dpr);
    const labelH = Math.round(18 * dpr);
    const pad = Math.round(12 * dpr);
    const rowItems = list.filter((s) => !s.wide);
    const wide = list.filter((s) => s.wide);
    const rowW = rowItems.reduce((w, s) => w + s.cv.width, 0) + gap * Math.max(0, rowItems.length - 1);
    const rowH = Math.max(...rowItems.map((s) => s.cv.height), 0);
    const wideW = Math.max(...wide.map((s) => s.cv.width), 0);
    const stacked = view === 'channels';
    const W = (stacked ? Math.max(...rowItems.map((s) => s.cv.width), 0) : Math.max(rowW, wideW)) + pad * 2;
    const H = pad * 2 + titleH + (stacked
      ? rowItems.reduce((h, s) => h + labelH + s.cv.height + gap, 0)
      : labelH + rowH + gap + wide.reduce((h, s) => h + labelH + s.cv.height, 0));
    const out = document.createElement('canvas');
    out.width = W;
    out.height = H;
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#10131a';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#dfe6f3';
    ctx.font = `${Math.round(13 * dpr)}px "Segoe UI", "Microsoft YaHei UI", sans-serif`;
    ctx.textBaseline = 'middle';
    const title = `${t('app.name')} · ${view === 'channels' ? t('tab.channels') : t('tab.inspector')} · ${(state.lastScan || new Date()).toLocaleString()} · ${ifaceText()}`;
    ctx.fillText(title, pad, pad + titleH / 2);
    let y = pad + titleH;
    const drawOne = (s, x) => {
      ctx.fillStyle = '#8b96ab';
      ctx.font = `${Math.round(11 * dpr)}px "Segoe UI", "Microsoft YaHei UI", sans-serif`;
      ctx.fillText(s.label || '', x, y + labelH / 2);
      ctx.fillStyle = '#161b25';
      ctx.fillRect(x, y + labelH, s.cv.width, s.cv.height);
      ctx.drawImage(s.cv, x, y + labelH);
    };
    if (stacked) {
      for (const s of rowItems) {
        drawOne(s, pad);
        y += labelH + s.cv.height + gap;
      }
    } else {
      let x = pad;
      for (const s of rowItems) {
        drawOne(s, x);
        x += s.cv.width + gap;
      }
      y += labelH + rowH + gap;
      for (const s of wide) {
        drawOne(s, pad);
        y += labelH + s.cv.height;
      }
    }
    return out;
  }

  /**
   * 导出 PNG。mode = 'canvas'：当前视图的画布拼成一张图（默认）；
   * mode = 'window'：后端 PrintWindow 截整个窗口（含标题栏），所见即所得。
   */
  async function exportPng(mode = 'canvas') {
    if (!INVOKE) return setStatus(t('status.notauri'));
    const view = document.body.dataset.view;
    try {
      if (mode === 'window') {
        // 等菜单收起、按钮态复原，再截，不然菜单会被截进去；上一次导出的提示框也先藏起来
        const toasts = $('#toasts');
        if (toasts) toasts.style.visibility = 'hidden';
        try {
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          const path = await INVOKE('capture_window', { name: `wifi-${view}-window-${fileStamp()}.png` });
          if (toasts) toasts.style.visibility = '';
          exportDone('png', path);
          log('info', `export png (window): ${path}`);
          return path;
        } finally {
          if (toasts) toasts.style.visibility = '';
        }
      }
      const cv = composePng();
      if (!cv) throw new Error(t('export.nocanvas'));
      const data = cv.toDataURL('image/png').split(',')[1];
      const path = await INVOKE('export_file', { name: `wifi-${view}-${fileStamp()}.png`, data, encoding: 'base64' });
      exportDone('png', path);
      log('info', `export png: ${path} (${cv.width}x${cv.height}, ${Math.round(data.length * 0.75 / 1024)} KB)`);
      return path;
    } catch (e) {
      exportFailed('png', e);
    }
  }

  // PNG 按钮弹菜单：图表拼图 / 整个窗口。设置页没有画布，拼图项禁用。
  function pngMenuOpen(open) {
    const menu = $('#png-menu');
    const btn = $('#export-png');
    if (!menu || !btn) return;
    if (open) {
      const hasCanvas = document.body.dataset.view !== 'settings';
      const canvasItem = menu.querySelector('[data-mode="canvas"]');
      if (canvasItem) canvasItem.disabled = !hasCanvas;
    }
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open) (menu.querySelector('button:not(:disabled)') || menu).focus?.();
  }

  function pngMenuInit() {
    const menu = $('#png-menu');
    const btn = $('#export-png');
    if (!menu || !btn) return;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      pngMenuOpen(menu.hidden);
    });
    menu.addEventListener('click', (e) => {
      const item = e.target.closest('[data-mode]');
      if (!item || item.disabled) return;
      e.stopPropagation();
      pngMenuOpen(false);
      exportPng(item.dataset.mode);
    });
    document.addEventListener('click', (e) => {
      if (!menu.hidden && !menu.contains(e.target) && e.target !== btn) pngMenuOpen(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !menu.hidden) {
        pngMenuOpen(false);
        btn.focus();
      }
    });
  }

  // ------------------------------------------------------------ 初始化

  function init() {
    loadViewState();
    $('#filter').value = state.filter;
    $('#history').dataset.panel = state.histPanel;

    $('#scan').addEventListener('click', () => scanOnce());
    $('#auto').addEventListener('change', (e) => setAuto(e.target.checked));
    $('#filter').addEventListener('input', (e) => {
      state.filter = e.target.value;
      saveViewState();
      renderTable();
    });
    $('#group')?.addEventListener('change', (e) => Settings.set({ groupBy: e.target.checked ? 'ssid' : 'none' }));
    $('#clear-hist').addEventListener('click', () => {
      resetHistory();
      drawHistory();
      renderTable();
      refreshHistModeLabel();
    });
    $('#hist-mode')?.addEventListener('click', () => setHistPanel(state.histPanel === 'events' ? 'curve' : 'events'));
    $('#events')?.addEventListener('click', (ev) => {
      const li = ev.target.closest('li[data-bssid]');
      if (!li) return;
      const ap = state.aps.find((a) => a.bssid === li.dataset.bssid);
      if (ap) Detail.show(ap);
    });
    $('#export-csv')?.addEventListener('click', exportCsv);
    pngMenuInit();
    $('#status')?.addEventListener('click', toggleErrorBox);

    $$('#ap thead th').forEach((th) => {
      th.addEventListener('click', () => {
        const key = th.dataset.key;
        if (state.sortKey === key) state.sortDesc = !state.sortDesc;
        else {
          state.sortKey = key;
          state.sortDesc = SORT_DESC_DEFAULT.includes(key);
        }
        saveViewState();
        renderTable();
      });
    });
    window.addEventListener('resize', renderAll);
    $$('.max-btn').forEach((b) => b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      toggleMax(b.dataset.max);
    }));
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.max) toggleMax(null);
    });
    $('#ap tbody').addEventListener('click', (ev) => {
      const star = ev.target.closest('[data-star]');
      if (star) {
        ev.stopPropagation();
        Settings.toggleWatch(star.dataset.star);
        return;
      }
      const grp = ev.target.closest('tr[data-group]');
      if (grp) {
        const key = grp.dataset.group;
        if (state.expanded.has(key)) state.expanded.delete(key);
        else state.expanded.add(key);
        saveViewState();
        renderTable();
        return;
      }
      const tr = ev.target.closest('tr[data-bssid]');
      if (!tr) return;
      const ap = state.aps.find((a) => a.bssid === tr.dataset.bssid);
      if (ap) Detail.show(ap);
    });
    setInterval(() => {
      drawHistory();
      // 行上的变更标记有 25 秒寿命，到点要自己褪掉
      if (document.body.dataset.view === 'inspector' && state.changes.size()) renderTable();
    }, 1000);
    loadInterfaces().then(() => scanOnce());
    setAuto($('#auto').checked);
  }

  return {
    init,
    renderAll,
    renderTable,
    scanOnce,
    restartAuto,
    toggleMax,
    setHistPanel,
    exportCsv,
    exportPng, pngMenuOpen,
    csvText,
    composePng,
    groupStats,
    groupRows,
    flatRows,
    expand: (key, on) => {
      if (on) state.expanded.add(key);
      else state.expanded.delete(key);
      saveViewState();
      renderTable();
    },
    setSort: (key, desc) => {
      state.sortKey = key;
      state.sortDesc = !!desc;
      saveViewState();
      renderTable();
    },
    setFilter: (text) => {
      state.filter = text;
      $('#filter').value = text;
      saveViewState();
      renderTable();
    },
    viewState: () => ({ sortKey: state.sortKey, sortDesc: state.sortDesc, filter: state.filter, expanded: [...state.expanded], histPanel: state.histPanel }),
    aps: () => visible(),
    apsAll: () => state.aps,
    ifaces: () => state.ifaces || [],
    conn: () => state.conn,
    connFor,
    connSince: (bssid) => state.connSince.get(bssid) ?? null,
    changes: () => state.changes,
    refreshIface: () => renderIface(),
    scanCount: () => state.scans,
    failCount: () => state.fails,
    autoInterval: () => (state.timer ? state.autoMs : null),
    hist: () => state.history,
    colorFor,
    inject,
    resetHistory,
    setAuto,
  };
})();
