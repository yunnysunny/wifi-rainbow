// AP 位置估算：把「每个 BSSID 在哪些采样点最强」折算成平面图上的一个点。
//
// 做法：先取该 BSSID 的最强采样点，再在「最强点 -8 dB」窗口内做功率加权质心
// （权重 = 10^(dBm/10)，即线性功率）。比直接吸附最强点稳——单点抖动 2~3 dB 很常见，
// 质心会把邻近等强点的位置一起算进去。窗口大小就是 PEAK_WINDOW_DB。
//
// 输出里同时给：
//   rssi/peak —— 最强那一点的 dBm 与坐标（图上画的就是质心，不是它）
//   spreadPx/spreadM —— 功率加权 RMS 半径，用来画不确定范围
//   used/n —— 参与估位的点数 / 该 BSSID 出现过的采样点数

const Apmap = (() => {
  const PEAK_WINDOW_DB = 8;

  function estimate(samples, opts = {}) {
    const groups = new Map();
    for (const s of samples ?? []) {
      if (s.x == null || s.y == null) continue;
      for (const a of s.aps ?? []) {
        if (!a?.bssid) continue;
        let g = groups.get(a.bssid);
        if (!g) groups.set(a.bssid, (g = { bssid: a.bssid, ssid: a.ssid, ap: a, pts: [] }));
        if (!g.ssid && a.ssid) g.ssid = a.ssid;
        // 保留最近一次出现时该 AP 的快照，供详情抽屉使用
        g.ap = a;
        g.pts.push({ x: s.x, y: s.y, rssi: a.rssi, t: s.t });
      }
    }

    const out = [];
    for (const g of groups.values()) {
      if (!g.pts.length) continue;
      const peak = g.pts.reduce((m, p) => (p.rssi > m.rssi ? p : m), g.pts[0]);
      const cluster = g.pts.filter((p) => p.rssi >= peak.rssi - PEAK_WINDOW_DB);
      let sw = 0;
      let sx = 0;
      let sy = 0;
      for (const p of cluster) {
        const w = Math.pow(10, p.rssi / 10);
        sw += w;
        sx += w * p.x;
        sy += w * p.y;
      }
      const x = sx / sw;
      const y = sy / sw;
      let dev = 0;
      for (const p of cluster) {
        const w = Math.pow(10, p.rssi / 10);
        dev += w * ((p.x - x) ** 2 + (p.y - y) ** 2);
      }
      const spreadPx = Math.sqrt(dev / sw);
      out.push({
        bssid: g.bssid,
        ssid: g.ssid,
        ap: g.ap,
        rssi: peak.rssi,
        x,
        y,
        peakX: peak.x,
        peakY: peak.y,
        spreadPx,
        spreadM: opts.pxPerMeter ? spreadPx / opts.pxPerMeter : null,
        used: cluster.length,
        n: g.pts.length,
      });
    }
    return out.sort((a, b) => b.rssi - a.rssi);
  }

  /** 过滤：'all' 全部 / 'active' 只看当前网络 / 'off' 不画。 */
  function pick(list, mode, activeBssid) {
    if (mode === 'off') return [];
    if (mode === 'active') return list.filter((a) => a.bssid === activeBssid);
    return list;
  }

  return { estimate, pick, PEAK_WINDOW_DB };
})();
