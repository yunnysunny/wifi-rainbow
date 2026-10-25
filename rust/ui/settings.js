// 设置：显示过滤、扫描节奏、分组/别名/关注列表、扫描网卡。存在 localStorage，下次启动沿用。
//
// 过滤在这里集中定义（Settings.accept），Inspector.aps() 出口统一套用，
// 所以表格、三频段图、历史图例、信道分析、详情抽屉看到的是同一份过滤后的数据集。
//
// 别名（aliases）与关注列表（watch）按 SSID 存——同一个 SSID 的几个 BSSID 共用。

const Settings = (() => {
  const KEY = 'wifisurvey.settings.v1';
  const BANDS = ['2.4 GHz', '5 GHz', '6 GHz'];
  const GROUP_MODES = ['none', 'ssid'];

  const DEFAULTS = {
    hideHidden: false,          // 不显示隐藏 SSID（ssid 为空）
    minRssi: -100,              // 低于这个 dBm 不显示；-100 视为不限
    bands: { '2.4 GHz': true, '5 GHz': true, '6 GHz': true },
    scanSec: 5,                 // 自动刷新间隔（秒）
    groupBy: 'ssid',            // 表格按 SSID 分组（none / ssid）
    aliases: {},                // ssid -> 别名
    watch: [],                  // 关注的 SSID：历史曲线默认勾选
    iface: '',                  // 扫描哪块网卡（GUID），空 = 全部
  };

  const cur = structuredCloneSafe(DEFAULTS);
  const subs = [];

  function structuredCloneSafe(o) {
    return JSON.parse(JSON.stringify(o));
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (typeof saved.hideHidden === 'boolean') cur.hideHidden = saved.hideHidden;
      if (Number.isFinite(saved.minRssi)) cur.minRssi = saved.minRssi;
      if (saved.bands) for (const b of BANDS) if (typeof saved.bands[b] === 'boolean') cur.bands[b] = saved.bands[b];
      if (Number.isFinite(saved.scanSec)) cur.scanSec = Math.min(60, Math.max(1, saved.scanSec));
      if (GROUP_MODES.includes(saved.groupBy)) cur.groupBy = saved.groupBy;
      if (saved.aliases && typeof saved.aliases === 'object') {
        for (const [k, v] of Object.entries(saved.aliases)) if (typeof v === 'string' && v.trim()) cur.aliases[k] = v.trim();
      }
      if (Array.isArray(saved.watch)) cur.watch = saved.watch.filter((s) => typeof s === 'string');
      if (typeof saved.iface === 'string') cur.iface = saved.iface;
    } catch (e) {
      log('error', 'settings load failed: ' + e);
    }
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(cur));
    } catch (e) {
      log('error', 'settings save failed: ' + e);
    }
  }

  /** 一条 AP 能不能显示。所有视图共用这一个判断。 */
  function accept(ap) {
    if (!ap) return false;
    if (cur.hideHidden && !ap.ssid) return false;
    if (ap.rssi < cur.minRssi) return false;
    if (ap.band && !cur.bands[ap.band]) return false;
    return true;
  }

  function subscribe(fn) {
    subs.push(fn);
  }

  function changed() {
    save();
    for (const fn of subs) {
      try {
        fn(cur);
      } catch (e) {
        log('error', 'settings subscriber failed: ' + e);
      }
    }
  }

  function set(patch) {
    if (typeof patch.hideHidden === 'boolean') cur.hideHidden = patch.hideHidden;
    if (Number.isFinite(patch.minRssi)) cur.minRssi = Math.max(-100, Math.min(-40, patch.minRssi));
    if (patch.bands) for (const b of BANDS) if (typeof patch.bands[b] === 'boolean') cur.bands[b] = patch.bands[b];
    if (Number.isFinite(patch.scanSec)) cur.scanSec = Math.min(60, Math.max(1, patch.scanSec));
    if (GROUP_MODES.includes(patch.groupBy)) cur.groupBy = patch.groupBy;
    if (typeof patch.iface === 'string') cur.iface = patch.iface;
    changed();
    render();
    log('info', `settings: ${summary()}`);
  }

  function reset() {
    // 别名和关注列表是用户辛苦标的，「恢复默认设置」不清它们
    const keep = { aliases: cur.aliases, watch: cur.watch };
    Object.assign(cur, structuredCloneSafe(DEFAULTS), keep);
    changed();
    render();
    log('info', 'settings: reset to defaults');
  }

  // ------------------------------------------------------------ 别名 / 关注

  function alias(ssid) {
    return cur.aliases[ssid] || '';
  }

  function setAlias(ssid, name) {
    const v = String(name || '').trim();
    if (v) cur.aliases[ssid] = v;
    else delete cur.aliases[ssid];
    changed();
    log('info', `alias: "${ssid}" -> "${v}"`);
  }

  /** 列表/图例/浮层里显示的名字：有别名用别名，没有就是 SSID（隐藏网络按语言占位）。 */
  function displayName(ssid) {
    return alias(ssid) || ssidLabel(ssid);
  }

  function isWatched(ssid) {
    return cur.watch.includes(ssid);
  }

  function toggleWatch(ssid) {
    if (isWatched(ssid)) cur.watch = cur.watch.filter((s) => s !== ssid);
    else cur.watch = [...cur.watch, ssid];
    changed();
    log('info', `watch: ${cur.watch.length ? cur.watch.map((s) => JSON.stringify(s)).join(',') : '(empty)'}`);
    return isWatched(ssid);
  }

  function summary() {
    const off = BANDS.filter((b) => !cur.bands[b]);
    return [
      `hideHidden=${cur.hideHidden}`,
      `minRssi=${cur.minRssi}`,
      off.length ? `off=${off.join('/')}` : 'bands=all',
      `scan=${cur.scanSec}s`,
      `group=${cur.groupBy}`,
      `aliases=${Object.keys(cur.aliases).length}`,
      `watch=${cur.watch.length}`,
      `iface=${cur.iface || 'all'}`,
    ].join(' ');
  }

  // ------------------------------------------------------------ 设置视图

  function renderIfaceSelect() {
    const sel = $('#set-iface');
    if (!sel) return;
    const ifaces = Inspector.ifaces?.() || [];
    const opts = [`<option value="">${t('set.iface.all')}</option>`].concat(
      ifaces.map((i) => `<option value="${esc(i.guid)}">${esc(i.description)} [${esc(i.state)}]</option>`)
    );
    // 设置里记着一块现在不在的网卡（拔掉的 USB 卡）：也列出来，让用户看得见为什么扫描退回了全部
    if (cur.iface && !ifaces.some((i) => i.guid === cur.iface)) {
      opts.push(`<option value="${esc(cur.iface)}">${esc(cur.iface)} [${t('set.iface.missing')}]</option>`);
    }
    const html = opts.join('');
    if (sel.innerHTML !== html) sel.innerHTML = html;
    sel.value = cur.iface;
    sel.disabled = ifaces.length <= 1 && !cur.iface;
  }

  function render() {
    const el = $('#view-settings');
    if (!el) return;
    $('#set-hide-hidden').checked = cur.hideHidden;
    $('#set-min-rssi').value = String(cur.minRssi);
    $('#set-min-rssi-val').textContent = cur.minRssi <= -100 ? t('set.any') : `${cur.minRssi} dBm`;
    $$('#set-bands input[data-band]').forEach((cb) => {
      cb.checked = !!cur.bands[cb.dataset.band];
    });
    $('#set-scan-sec').value = String(cur.scanSec);
    const grp = $('#set-group');
    if (grp) grp.checked = cur.groupBy === 'ssid';
    const bar = $('#group');
    if (bar) bar.checked = cur.groupBy === 'ssid';
    renderIfaceSelect();
    const langSel = $('#set-lang');
    if (langSel) langSel.value = I18n.get();
    const filtered = document.querySelector('#set-filtered');
    if (filtered) {
      const total = Inspector.apsAll().length;
      const shown = Inspector.aps().length;
      filtered.textContent = total ? t('set.summary', { total, shown }) : t('set.nodata');
    }
    const wl = $('#set-watch');
    if (wl) {
      wl.innerHTML = cur.watch.length
        ? cur.watch
            .map(
              (s) => `<button class="chip on" data-watch="${esc(s)}" title="${t('set.watch.remove')}">
                <i></i>${esc(displayName(s))}<span>✕</span></button>`
            )
            .join('')
        : `<em class="hint">${t('set.watch.empty')}</em>`;
      wl.querySelectorAll('[data-watch]').forEach((b) => b.addEventListener('click', () => toggleWatch(b.dataset.watch)));
    }
    const al = $('#set-aliases');
    if (al) {
      const entries = Object.entries(cur.aliases);
      al.innerHTML = entries.length
        ? entries
            .map(
              ([ssid, name]) => `<button class="chip" data-alias="${esc(ssid)}" title="${t('set.alias.remove')}">
                ${esc(name)} <span>= ${esc(ssid)}</span><span>✕</span></button>`
            )
            .join('')
        : `<em class="hint">${t('set.alias.empty')}</em>`;
      al.querySelectorAll('[data-alias]').forEach((b) => b.addEventListener('click', () => setAlias(b.dataset.alias, '')));
    }
  }

  function init() {
    load();
    // 启动时就把设置页和顶栏开关同步成已保存的值；之前只在打开设置页或改动时同步，
    // 结果「按 SSID 分组」默认开着，顶栏复选框却显示没勾
    render();

    $('#set-hide-hidden').addEventListener('change', (e) => set({ hideHidden: e.target.checked }));
    $('#set-min-rssi').addEventListener('input', (e) => set({ minRssi: Number(e.target.value) }));
    $$('#set-bands input[data-band]').forEach((cb) =>
      cb.addEventListener('change', () => {
        const bands = { ...cur.bands };
        bands[cb.dataset.band] = cb.checked;
        set({ bands });
      })
    );
    $('#set-scan-sec').addEventListener('change', (e) => set({ scanSec: Number(e.target.value) || 5 }));
    $('#set-group')?.addEventListener('change', (e) => set({ groupBy: e.target.checked ? 'ssid' : 'none' }));
    $('#set-iface')?.addEventListener('change', (e) => set({ iface: e.target.value }));
    $('#set-reset').addEventListener('click', reset);

    const langSel = $('#set-lang');
    if (langSel) {
      langSel.innerHTML = I18n.langs.map((l) => `<option value="${l.id}">${l.label}</option>`).join('');
      langSel.value = I18n.get();
      langSel.addEventListener('change', (e) => I18n.set(e.target.value));
    }

    // 设置变了就让两个视图重新出图
    subscribe(() => {
      Inspector.renderAll();
      Inspector.restartAuto();
      if (document.body.dataset.view === 'channels') Channels.render();
      if (document.body.dataset.view === 'settings') render();
    });
  }

  function activate() {
    render();
  }

  return {
    init, activate, render, renderIfaceSelect,
    get: () => cur, set, reset, accept, subscribe, summary,
    alias, setAlias, displayName, isWatched, toggleWatch, watchList: () => [...cur.watch],
    BANDS, DEFAULTS,
  };
})();
