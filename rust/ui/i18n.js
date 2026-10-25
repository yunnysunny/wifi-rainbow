/* WiFi 彩虹（WiFi Rainbow）· 界面文案（中 / 英）
 *
 * 用法：
 *   t('insp.scan')                      取当前语言文案
 *   t('insp.summary', { n: 3, rssi: -42 })   占位符 {n} 会被替换
 *   <span data-i18n="tab.channels">       静态节点，I18n.apply() 时按 key 填 textContent
 *   <button data-i18n-title="chart.max">  只换 title 属性
 *   <input data-i18n-ph="bar.filter">     只换 placeholder
 *
 * 约定：频段名（2.4 GHz）、单位（dBm / MHz / s / m）、信道号（ch36）、BSSID、SSID
 * 这类行业写法不进字典，两种语言下都一样。SSID 为空的网络按各自语言显示 <hidden>。
 * 开发者日志（ui.log）不进字典，保持中文，方便排查。
 */
const I18n = (() => {
  const KEY = 'wifisurvey.lang';
  const LANGS = [
    { id: 'zh', label: '中文' },
    { id: 'en', label: 'English' },
  ];

  const DICT = {
    zh: {
      'app.name': 'WiFi 彩虹',
      'tab.inspector': 'Inspector',
      'tab.channels': '信道',
      'tab.settings': '设置',

      'bar.iface.loading': '正在读取网卡…',
      'bar.filter': '过滤 SSID / BSSID / 别名',
      'bar.group': '按 SSID 分组',
      'bar.auto': '自动刷新',
      'bar.scan': '扫描一次',

      'tag.conn': '已连接',
      'tag.new': '新',
      'tag.gone': '消失',
      'grp.bssids': '{n} 个 BSSID',
      'grp.mixed': '混合',
      'watch.on': '加入关注列表（历史曲线默认画它）',
      'watch.off': '移出关注列表',

      'hist.curve': '曲线',
      'hist.events': '事件 {n}',
      'ev.empty': '还没有变化。新冒出来的 BSSID、消失、掉 7 dB 以上、换信道、换带宽都会记在这里。',
      'ev.new': '新出现 · ch{ch} · {rssi} dBm',
      'ev.gone': '连续两轮没扫到 · 上次 ch{ch} · {rssi} dBm',
      'ev.drop': '掉了 {d} dB · {from} → {to} dBm',
      'ev.chan': '换信道 · ch{from} → ch{to}',
      'ev.width': '换带宽 · {from} → {to} MHz',

      'export.csv': '导出当前列表为 CSV（存到「下载」）',
      'export.png': '导出当前视图为 PNG（存到「下载」）',
      'export.ok': '已导出：{path}',
      'export.fail': '导出失败：{e}',
      'export.nocanvas': '当前视图没有可导出的图',
      'csv.alias': '别名',
      'csv.conn': '已连接',
      'csv.vendor': '厂商',
      'csv.freq': '频率 MHz',
      'csv.time': '扫描时间',

      'err.title': '扫描连续失败 {n} 次',
      'err.hint': '自动刷新按指数退避重试（2s/4s/8s…最多 60s），{s} 秒后下一次；点「扫描一次」可立即重试。再点状态栏收起。',
      'dur.s': '{s} 秒',
      'dur.m': '{m} 分 {s} 秒',
      'dur.h': '{h} 小时 {m} 分',

      'chart.max': '放大预览（Esc 还原）',
      'chart.max.on': '还原（Esc）',
      'chart.nodata': '无数据',
      'chart.meta': '{n} 个 BSS · 最强 {rssi} dBm',
      'chart.waiting': '采集一会儿就有曲线了',
      'chart.now': '现在',

      'hist.title': '信号历史',
      'hist.window': '最近 3 分钟',
      'hist.clear': '清空历史',

      'table.empty': '还没有数据，点「扫描一次」。',
      'th.ssid': 'SSID',
      'th.bssid': 'BSSID',
      'th.dbm': 'dBm',
      'th.quality': 'Q%',
      'th.channel': '信道',
      'th.band': '频段',
      'th.width': '带宽',
      'th.phy': 'PHY',
      'th.security': '安全',
      'th.akm': 'AKM',
      'th.stations': '客户端',
      'th.util': '空口',
      'th.trend': '趋势',

      'status.ready': '就绪',
      'status.scanning': '正在扫描…',
      'status.summary': '{time} · {n} 个 BSS · 最强 {rssi} dBm · 历史窗口 3 分钟',
      'status.noiface': '没有可用无线网卡',
      'status.notauri': '未连上 Tauri 后端（直接用浏览器打开了？）',
      'status.ifacefail': '读取网卡失败：{e}',
      'status.scanfail': '扫描失败：{e}',
      'status.scanfail.retry': '扫描失败（第 {n} 次）：{e} · {s} 秒后重试 · 点此看详情',

      'ch.summary': '{n} 个 AP · 同频干扰对 {co} · 邻频重叠对 {adj} · CIR<12 dB 的 {bad} 个',
      'ch.summary.best': '{list}',
      'ch.refresh': '重新分析',
      'ch.noap': '该频段没有 AP',
      'ch.hidden': '<隐藏>',
      'ch.more': '另有 {n} 个未画（见下表）',
      'ch.best': '建议 ch{ch}',
      'ch.best.dfs': '建议 ch{ch}（DFS）',
      'ch.best.none': '该频段无 AP',
      'ch.chip': 'ch{ch} · {n} 个 AP · 干扰 {if} dBm',
      'ch.ifdbm': '干扰 {v} dBm',
      'ch.ifnone': '无干扰',
      'ch.none': '无',
      'ch.co': ' · 同频',
      'ch.adj': ' · 邻频',
      'ch.th.ssid': '网络',
      'ch.th.bssid': 'BSSID',
      'ch.th.band': '频段',
      'ch.th.channel': '信道',
      'ch.th.width': '带宽',
      'ch.th.dbm': 'dBm',
      'ch.th.same': '同频',
      'ch.th.adj': '邻频',
      'ch.th.sameInt': '同频干扰',
      'ch.th.adjInt': '邻频干扰',
      'ch.th.cir': 'CIR',
      'ch.th.dist': '距离',
      'ch.th.src': '主要干扰源',

      'dt.close': '关闭',
      'dt.unknown': '未知厂商',
      'dt.nohist': '历史不足，等下一次扫描',
      'dt.inf': '∞（无干扰）',
      'dt.hidden': '<隐藏 SSID>',
      'dt.signal': '信号',
      'dt.quality': '质量',
      'dt.dist': '估算距离',
      'dt.vendor': '厂商',
      'dt.hist': '最近 3 分钟',
      'dt.points': '{n} 点',
      'dt.interf': '干扰画像',
      'dt.same': '同频 {n} 个',
      'dt.adj': '邻频 {n} 个',
      'dt.nooverlap': '这个频段上没有别的 AP 跟它重叠。',
      'dt.rf': '射频',
      'dt.band': '频段',
      'dt.channel': '信道',
      'dt.freq': '频率',
      'dt.width': '带宽',
      'dt.ie': 'IE 长度',
      'dt.security': '安全',
      'dt.stations': '客户端',
      'dt.air': '空口占用',
      'dt.util': '信道利用率',
      'dt.copy': '复制 BSSID',
      'dt.copied': 'BSSID 已复制',
      'dt.alias': '别名',
      'dt.alias.ph': '比如「我家」「客厅路由」，回车保存',
      'dt.alias.saved': '别名已保存：{ssid}',
      'dt.conn': '当前连接',
      'dt.conn.auth': '实际认证',
      'dt.conn.cipher': '实际加密',
      'dt.conn.rate': '收 / 发 Mbps',
      'dt.conn.quality': '链路质量',
      'dt.conn.since': '已连接',
      'dt.conn.profile': '配置文件',

      'set.display': '显示',
      'set.nodata': '还没扫到数据',
      'set.summary': '当前扫描 {total} 个 BSS，显示 {shown} 个',
      'set.hidehidden': '不显示隐藏 SSID 的网络',
      'set.hidehidden.hint': 'ssid 为空的 BSS，列表里现在显示为 <hidden>',
      'set.minrssi': '最低信号',
      'set.minrssi.hint': '弱于这个值的 AP 不出现在列表、曲线和信道分析里',
      'set.any': '不限',
      'set.bands': '频段',
      'set.bands.hint': '关掉的频段一律不参与',
      'set.scan': '扫描',
      'set.scansec': '自动刷新间隔',
      'set.scansec.hint': '顶栏那个「自动刷新」开着时才生效，只在 Inspector 视图扫描',
      'set.sec': '秒',
      'set.iface': '扫描网卡',
      'set.iface.hint': '多块无线网卡时选一块；选中的网卡拔掉后自动退回全部',
      'set.iface.all': '全部网卡',
      'set.iface.missing': '当前不在',
      'set.list': '列表',
      'set.group': '按 SSID 分组',
      'set.group.hint': '同名的多个 BSSID 折成一行，点开看成员；只有一个 BSSID 的 SSID 不成组',
      'set.watch': '关注列表',
      'set.watch.hint': '历史曲线默认画它们；在列表或详情里点 ☆ 加入',
      'set.watch.empty': '还没有关注的网络',
      'set.watch.remove': '移出关注列表',
      'set.alias': '别名',
      'set.alias.hint': '在详情抽屉里给 SSID 起名；点一下这里的标签就删掉',
      'set.alias.empty': '还没起过别名',
      'set.alias.remove': '删除这个别名',
      'set.lang': '界面语言',
      'set.interface': '界面',
      'set.lang.hint': '切换后立即生效，存在本机',
      'set.about': '关于',
      'set.about.text': '数据全部来自本机 wlanapi，不联网；设置存在 localStorage，换机器不会跟着走。',
      'set.reset': '恢复默认设置',
    },

    en: {
      'app.name': 'WiFi Rainbow',
      'tab.inspector': 'Inspector',
      'tab.channels': 'Channels',
      'tab.settings': 'Settings',

      'bar.iface.loading': 'Reading adapters…',
      'bar.filter': 'Filter SSID / BSSID / alias',
      'bar.group': 'Group by SSID',
      'bar.auto': 'Auto refresh',
      'bar.scan': 'Scan now',

      'tag.conn': 'connected',
      'tag.new': 'new',
      'tag.gone': 'gone',
      'grp.bssids': '{n} BSSIDs',
      'grp.mixed': 'mixed',
      'watch.on': 'Add to watch list (history curve picks it by default)',
      'watch.off': 'Remove from watch list',

      'hist.curve': 'Curves',
      'hist.events': 'Events {n}',
      'ev.empty': 'No changes yet. New BSSIDs, disappearances, drops of 7 dB or more, channel and width changes land here.',
      'ev.new': 'appeared · ch{ch} · {rssi} dBm',
      'ev.gone': 'missing for two scans · last ch{ch} · {rssi} dBm',
      'ev.drop': 'dropped {d} dB · {from} → {to} dBm',
      'ev.chan': 'channel change · ch{from} → ch{to}',
      'ev.width': 'width change · {from} → {to} MHz',

      'export.csv': 'Export the current list as CSV (to Downloads)',
      'export.png': 'Export the current view as PNG (to Downloads)',
      'export.ok': 'Exported: {path}',
      'export.fail': 'Export failed: {e}',
      'export.nocanvas': 'Nothing to export in this view',
      'csv.alias': 'Alias',
      'csv.conn': 'Connected',
      'csv.vendor': 'Vendor',
      'csv.freq': 'Freq MHz',
      'csv.time': 'Scan time',

      'err.title': 'Scan failed {n} times in a row',
      'err.hint': 'Auto refresh retries with exponential backoff (2s/4s/8s… up to 60s); next try in {s}s. "Scan now" retries immediately. Click the status bar again to close.',
      'dur.s': '{s}s',
      'dur.m': '{m}m {s}s',
      'dur.h': '{h}h {m}m',

      'chart.max': 'Maximize (Esc restores)',
      'chart.max.on': 'Restore (Esc)',
      'chart.nodata': 'no data',
      'chart.meta': '{n} BSS · peak {rssi} dBm',
      'chart.waiting': 'Collecting — the curve appears in a moment',
      'chart.now': 'now',

      'hist.title': 'Signal history',
      'hist.window': 'last 3 minutes',
      'hist.clear': 'Clear',

      'table.empty': 'No data yet — hit "Scan now".',
      'th.ssid': 'SSID',
      'th.bssid': 'BSSID',
      'th.dbm': 'dBm',
      'th.quality': 'Q%',
      'th.channel': 'Channel',
      'th.band': 'Band',
      'th.width': 'Width',
      'th.phy': 'PHY',
      'th.security': 'Security',
      'th.akm': 'AKM',
      'th.stations': 'Clients',
      'th.util': 'Air time',
      'th.trend': 'Trend',

      'status.ready': 'Ready',
      'status.scanning': 'Scanning…',
      'status.summary': '{time} · {n} BSS · peak {rssi} dBm · 3 min window',
      'status.noiface': 'No wireless adapter found',
      'status.notauri': 'Tauri backend not connected — opened in a browser?',
      'status.ifacefail': 'Failed to read adapters: {e}',
      'status.scanfail': 'Scan failed: {e}',
      'status.scanfail.retry': 'Scan failed (#{n}): {e} · retry in {s}s · click for details',

      'ch.summary': '{n} AP · {co} co-channel pairs · {adj} adjacent overlaps · {bad} with CIR<12 dB',
      'ch.summary.best': '{list}',
      'ch.refresh': 'Re-analyze',
      'ch.noap': 'No AP on this band',
      'ch.hidden': '<hidden>',
      'ch.more': '{n} more not drawn (see table)',
      'ch.best': 'best ch{ch}',
      'ch.best.dfs': 'best ch{ch} (DFS)',
      'ch.best.none': 'no AP on this band',
      'ch.chip': 'ch{ch} · {n} AP · interference {if} dBm',
      'ch.ifdbm': 'interference {v} dBm',
      'ch.ifnone': 'no interference',
      'ch.none': 'none',
      'ch.co': ' · co-channel',
      'ch.adj': ' · adjacent',
      'ch.th.ssid': 'Network',
      'ch.th.bssid': 'BSSID',
      'ch.th.band': 'Band',
      'ch.th.channel': 'Channel',
      'ch.th.width': 'Width',
      'ch.th.dbm': 'dBm',
      'ch.th.same': 'Same ch',
      'ch.th.adj': 'Adj ch',
      'ch.th.sameInt': 'Co-ch. intf',
      'ch.th.adjInt': 'Adj-ch. intf',
      'ch.th.cir': 'CIR',
      'ch.th.dist': 'Distance',
      'ch.th.src': 'Main interferer',

      'dt.close': 'Close',
      'dt.unknown': 'Unknown vendor',
      'dt.nohist': 'Not enough history — waiting for the next scan',
      'dt.inf': '∞ (no interference)',
      'dt.hidden': '<hidden SSID>',
      'dt.signal': 'Signal',
      'dt.quality': 'Quality',
      'dt.dist': 'Est. distance',
      'dt.vendor': 'Vendor',
      'dt.hist': 'last 3 minutes',
      'dt.points': '{n} pts',
      'dt.interf': 'Interference',
      'dt.same': '{n} co-channel',
      'dt.adj': '{n} adjacent',
      'dt.nooverlap': 'No other AP overlaps this one on this band.',
      'dt.rf': 'Radio',
      'dt.band': 'Band',
      'dt.channel': 'Channel',
      'dt.freq': 'Frequency',
      'dt.width': 'Width',
      'dt.ie': 'IE length',
      'dt.security': 'Security',
      'dt.stations': 'Clients',
      'dt.air': 'Air time',
      'dt.util': 'Channel utilization',
      'dt.copy': 'Copy BSSID',
      'dt.copied': 'BSSID copied',
      'dt.alias': 'Alias',
      'dt.alias.ph': 'e.g. "home", "living room" — Enter saves',
      'dt.alias.saved': 'Alias saved: {ssid}',
      'dt.conn': 'Current connection',
      'dt.conn.auth': 'Negotiated auth',
      'dt.conn.cipher': 'Negotiated cipher',
      'dt.conn.rate': 'Rx / Tx Mbps',
      'dt.conn.quality': 'Link quality',
      'dt.conn.since': 'Connected for',
      'dt.conn.profile': 'Profile',

      'set.display': 'Display',
      'set.nodata': 'No scan yet',
      'set.summary': '{total} BSS scanned, {shown} shown',
      'set.hidehidden': 'Hide networks with a hidden SSID',
      'set.hidehidden.hint': 'BSS with an empty ssid — shown as <hidden> in the list',
      'set.minrssi': 'Minimum signal',
      'set.minrssi.hint': 'APs weaker than this disappear from the list, charts and channel analysis',
      'set.any': 'any',
      'set.bands': 'Bands',
      'set.bands.hint': 'A band that is off takes no part anywhere',
      'set.scan': 'Scanning',
      'set.scansec': 'Auto refresh interval',
      'set.scansec.hint': 'Only applies while "Auto refresh" in the top bar is on, and only scans in the Inspector view',
      'set.sec': 's',
      'set.iface': 'Scan adapter',
      'set.iface.hint': 'Pick one when there are several wireless adapters; falls back to all if it goes away',
      'set.iface.all': 'All adapters',
      'set.iface.missing': 'not present',
      'set.list': 'List',
      'set.group': 'Group by SSID',
      'set.group.hint': 'Folds BSSIDs sharing an SSID into one row; click to expand. SSIDs with a single BSSID stay flat',
      'set.watch': 'Watch list',
      'set.watch.hint': 'History curves pick these by default; click ☆ in the list or the detail drawer to add',
      'set.watch.empty': 'Nothing watched yet',
      'set.watch.remove': 'Remove from watch list',
      'set.alias': 'Aliases',
      'set.alias.hint': 'Name an SSID in the detail drawer; click a tag here to delete it',
      'set.alias.empty': 'No aliases yet',
      'set.alias.remove': 'Delete this alias',
      'set.lang': 'Language',
      'set.interface': 'Interface',
      'set.lang.hint': 'Applies immediately, stored on this machine',
      'set.about': 'About',
      'set.about.text':
        'All data comes from the local wlanapi — nothing leaves this machine. Settings live in localStorage, so they do not travel with the machine.',
      'set.reset': 'Reset to defaults',
    },
  };

  let lang = 'zh';
  const subs = [];

  function pick(id) {
    return DICT[id] ? id : 'zh';
  }

  function t(key, vars) {
    const d = DICT[lang] || DICT.zh;
    let s = d[key];
    if (s === undefined) s = DICT.zh[key];
    if (s === undefined) return key;
    if (vars) for (const k in vars) s = s.split(`{${k}}`).join(String(vars[k]));
    return s;
  }

  function apply(root = document) {
    root.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.dataset.i18n);
    });
    root.querySelectorAll('[data-i18n-title]').forEach((el) => {
      el.title = t(el.dataset.i18nTitle);
    });
    root.querySelectorAll('[data-i18n-ph]').forEach((el) => {
      el.placeholder = t(el.dataset.i18nPh);
    });
  }

  function emit() {
    subs.forEach((fn) => {
      try {
        fn(lang);
      } catch (e) {
        if (typeof log === 'function') log('error', 'i18n subscriber failed: ' + e);
      }
    });
  }

  /** 原生窗口标题跟着语言走（浏览器里打开时没有 __TAURI__，静默跳过）。 */
  function syncWindowTitle() {
    try {
      const w = window.__TAURI__?.window?.getCurrentWindow?.();
      const p = w?.setTitle?.(t('app.name'));
      if (p && p.catch) p.catch(() => {});
    } catch {}
  }

  function set(next) {
    const id = pick(next);
    if (id === lang) return;
    lang = id;
    try {
      localStorage.setItem(KEY, id);
    } catch {}
    document.documentElement.lang = id === 'zh' ? 'zh-CN' : 'en';
    document.title = t('app.name');
    apply();
    syncWindowTitle();
    emit();
  }

  function init() {
    let saved = null;
    try {
      saved = localStorage.getItem(KEY);
    } catch {}
    lang = pick(saved || (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en');
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    document.title = t('app.name');
    apply();
    syncWindowTitle();
  }

  return {
    init,
    t,
    apply,
    set,
    get: () => lang,
    langs: LANGS,
    subscribe: (fn) => subs.push(fn),
  };
})();

/** 短别名，模块里直接写 t('key') */
const t = (key, vars) => I18n.t(key, vars);
