// 演示模式：用一份合成的 AP 数据集驱动整个界面，不扫真机。
//
// 用途：给手册截干净的图（不含真实邻居的 SSID / BSSID），以及在没有无线网卡的机器上看界面。
// 触发：%LOCALAPPDATA%\WiFiRainbow\selftest 里写 `demo:<view>`，view 同 selftest 的停靠视图，
// 前面可加 `en-` 切英文：demo:inspector / demo:group / demo:events / demo:detail / demo:tip /
// demo:channels / demo:settings / demo:max / demo:en-inspector …
// `demo:cleanup` 只清掉演示写进 localStorage 的别名 / 关注，不停靠。
//
// 数据集 30 轮、每 6 秒一轮、倒推 3 分钟喂进去，所以历史曲线一开始就是满的；
// 中间安排了几次脚本化的变化（新出现 / 消失 / 掉信号 / 换信道），事件面板也有东西看。

const Demo = (() => {
  const ROUNDS = 30;
  const STEP_MS = 6000;
  const DEMO_ALIAS = { ssid: 'Maple-Home', zh: '家里的路由', en: 'Home router' };
  const DEMO_WATCH = ['Maple-Home', 'Studio-Mesh'];

  // 2.4 / 5 / 6 GHz 各几个，带两组同一台路由的多 BSSID（Maple-Home ×3、Studio-Mesh ×3）和一个隐藏网络
  const BASE = [
    ap('Maple-Home',      '3c:84:6a:1f:20:a0', -38, '2.4 GHz',   6,  40, '802.11ax', 'WPA2/WPA3', 'PSK,SAE', 'CCMP', 3, 18),
    ap('Maple-Home-5G',   '3c:84:6a:1f:20:a1', -42, '5 GHz',    36,  80, '802.11ax', 'WPA3',      'SAE',     'CCMP', 5, 11),
    ap('Maple-Home-6G',   '3c:84:6a:1f:20:a2', -47, '6 GHz',    37, 160, '802.11ax', 'WPA3',      'SAE',     'CCMP', 1,  4),
    ap('',                '3e:84:6a:2f:20:a0', -58, '2.4 GHz',   6,  40, '802.11ax', 'WPA2',      'PSK',     'CCMP', 0,  2),
    ap('Studio-Mesh',     'e8:9f:80:c1:50:11', -52, '2.4 GHz',   1,  20, '802.11ax', 'WPA2/WPA3', 'PSK,SAE', 'CCMP', 2, 31),
    ap('Studio-Mesh',     'e8:9f:80:c1:50:10', -55, '5 GHz',    44,  80, '802.11ax', 'WPA2/WPA3', 'PSK,SAE', 'CCMP', 7, 27),
    ap('Studio-Mesh',     'e8:9f:80:c1:50:12', -63, '5 GHz',   157,  80, '802.11ax', 'WPA2/WPA3', 'PSK,SAE', 'CCMP', 1,  9),
    ap('Cafe-Guest',      '74:ac:b9:02:11:50', -61, '2.4 GHz',   1,  20, '802.11n',  'WPA2',      'PSK',     'CCMP', 9, 44),
    ap('Cafe-Guest_5G',   '74:ac:b9:02:11:51', -66, '5 GHz',   149,  80, '802.11ac', 'WPA2',      'PSK',     'CCMP', 4, 16),
    ap('Oak-Street',      'b0:95:75:7a:03:3d', -64, '5 GHz',    40,  80, '802.11ac', 'WPA2',      'PSK',     'CCMP', null, null),
    ap('Oak-Street-24',   'b0:95:75:7a:03:3c', -72, '2.4 GHz',  11,  20, '802.11n',  'WPA2',      'PSK',     'CCMP', null, null),
    ap('Loft-6E',         'd4:5d:64:70:00:01', -60, '6 GHz',    69,  80, '802.11ax', 'WPA3',      'SAE',     'CCMP', 2,  6),
    ap('Printer-Direct',  'a2:11:22:33:44:55', -75, '2.4 GHz',   6,  20, '802.11n',  'WPA2',      'PSK',     'CCMP', 0,  0),
    ap('Library-Open',    '00:1d:0f:aa:bb:01', -80, '2.4 GHz',   1,  20, '802.11g',  'OPEN',      '',        null, null, null),
    ap('Pixel-Hotspot',   '9a:e2:1c:aa:00:7f', -69, '2.4 GHz',   6,  20, '802.11ax', 'WPA2',      'PSK',     'CCMP', 1,  3),
  ];

  function ap(ssid, bssid, rssi, band, channel, width_mhz, phy, security, akm, cipher, stations, utilization) {
    const freq_mhz = band === '2.4 GHz' ? 2407 + 5 * channel : band === '5 GHz' ? 5000 + 5 * channel : 5950 + 5 * channel;
    return { ssid, bssid, rssi, band, channel, width_mhz, phy, security, akm, cipher, stations, utilization, freq_mhz, ie_bytes: 180 + (bssid.charCodeAt(16) % 90) * 2 };
  }

  // 可复现的伪随机：每次演示的曲线长一样
  function rng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  /** 第 r 轮（0 起）的数据：抖动 ±2 dB + 脚本化事件 */
  function round(r, rand) {
    const list = [];
    for (const base of BASE) {
      if (base.ssid === 'Pixel-Hotspot' && r < 12) continue; // 第 12 轮才冒出来 → 新出现
      if (base.ssid === 'Library-Open' && r >= 20) continue; // 第 20 轮起没了 → 消失
      const a = { ...base };
      a.rssi = base.rssi + Math.round(rand() * 4 - 2);
      if (base.ssid === 'Oak-Street' && r >= 24) a.rssi -= 12; // 掉信号
      if (base.ssid === 'Cafe-Guest_5G' && r >= 26) {
        a.channel = 36; // 换信道
        a.freq_mhz = 5000 + 5 * 36;
      }
      a.quality = Math.max(0, Math.min(99, Math.round((a.rssi + 100) * 1.6)));
      list.push(a);
    }
    return list.sort((x, y) => y.rssi - x.rssi);
  }

  function connection() {
    const iface = Inspector.ifaces()[0];
    return [{
      iface_guid: iface?.guid || 'demo',
      iface: iface?.description || 'Demo wireless adapter',
      profile: 'Maple-Home-5G',
      ssid: 'Maple-Home-5G',
      bssid: '3c:84:6a:1f:20:a1',
      phy: '802.11ax',
      quality: 96,
      rx_mbps: 1200.9,
      tx_mbps: 1200.9,
      auth: 'WPA3-Personal',
      cipher: 'CCMP',
      one_x: false,
    }];
  }

  const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const clickTab = (view) => document.querySelector(`.tab[data-view="${view}"]`)?.click();

  function cleanup() {
    Settings.setAlias(DEMO_ALIAS.ssid, '');
    for (const s of DEMO_WATCH) if (Settings.isWatched(s)) Settings.toggleWatch(s);
    log('info', 'demo: cleanup done');
  }

  async function run(spec) {
    let view = String(spec || 'inspector');
    if (view === 'cleanup') return cleanup();
    let lang = 'zh';
    if (view.startsWith('en-')) {
      lang = 'en';
      view = view.slice(3);
    }
    I18n.set(lang);
    Inspector.setAuto(false);
    // 启动时那次真机扫描可能还在路上：等它落地再注入，否则演示数据会被它盖掉
    const t0 = Date.now();
    while (Inspector.scanCount() === 0 && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 200));
    Settings.set({ groupBy: 'ssid', hideHidden: false, minRssi: -100, bands: { '2.4 GHz': true, '5 GHz': true, '6 GHz': true } });
    Settings.setAlias(DEMO_ALIAS.ssid, DEMO_ALIAS[lang]);
    for (const s of DEMO_WATCH) if (!Settings.isWatched(s)) Settings.toggleWatch(s);
    Inspector.setFilter('');
    Inspector.setSort('rssi', true);
    Inspector.setHistPanel('curve');
    Inspector.resetHistory();

    const rand = rng(20261025);
    const now = Date.now();
    const conn = connection();
    for (let r = 0; r < ROUNDS; r++) {
      Inspector.inject(round(r, rand), conn, now - (ROUNDS - 1 - r) * STEP_MS);
    }
    await frames();
    clickTab('inspector');
    await frames();
    const groups = Inspector.groupRows().filter((g) => g.kind === 'group');
    for (const g of groups) Inspector.expand(g.key, false);
    const maple = groups.find((g) => g.key === 'Maple-Home');

    if (view === 'group' && maple) {
      Inspector.expand(maple.key, true);
    } else if (view === 'events') {
      Inspector.setHistPanel('events');
    } else if (view === 'detail') {
      if (maple) Inspector.expand(maple.key, true);
      await frames();
      const ap = Inspector.apsAll().find((a) => a.bssid === '3c:84:6a:1f:20:a1');
      if (ap) Detail.show(ap);
    } else if (view === 'tip') {
      const chart = [...document.querySelectorAll('#charts .chart')][1];
      const cv = chart.querySelector('canvas');
      const r = cv.getBoundingClientRect();
      for (let i = 1; i < 80; i++) {
        cv.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: r.left + (r.width * i) / 80, clientY: r.top + r.height * 0.3 }));
        if (document.querySelector('#tip').style.display === 'block') break;
      }
    } else if (view === 'max') {
      Inspector.toggleMax('b1');
    } else if (view === 'channels') {
      clickTab('channels');
    } else if (view === 'chhover') {
      clickTab('channels');
      await frames();
      Channels.highlight('2.4 GHz', 1);
    } else if (view === 'settings') {
      clickTab('settings');
    }
    await frames();
    log('info', `demo: parked on ${lang}/${view}, aps=${Inspector.apsAll().length}, events=${Inspector.changes().size()}`);
  }

  return { run, cleanup, BASE };
})();
