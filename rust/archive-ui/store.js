// 工程数据模型：多层 / 多快照 / 采样点。所有视图共用，改动后 notify() 通知订阅者。

const Store = (() => {
  const listeners = new Set();
  let seq = 1;

  const st = {
    project: {
      name: '未命名工程',
      levels: [],
      activeLevel: 0,
    },
    activeBssid: '',
    opts: { power: 2.2, radiusM: 8, alpha: 0.62 },
    path: null,
  };

  function newSnapshot(name) {
    return { id: seq++, name, createdAt: Date.now(), samples: [] };
  }

  function newLevel(name) {
    return {
      id: seq++,
      name,
      plan: null,          // { img, w, h, dataUrl }
      pxPerMeter: null,
      calib: [],
      snapshots: [newSnapshot('快照 1')],
      activeSnapshot: 0,
    };
  }

  function init() {
    if (!st.project.levels.length) st.project.levels.push(newLevel('1 层'));
  }

  // ------------------------------------------------------------ 访问器

  const level = () => st.project.levels[st.project.activeLevel] ?? null;
  const snapshot = () => {
    const l = level();
    return l ? l.snapshots[l.activeSnapshot] ?? null : null;
  };

  function setLevelName(name) {
    const l = level();
    if (l) {
      l.name = name || l.name;
      notify();
    }
  }

  function addLevel() {
    const names = new Set(st.project.levels.map((l) => l.name));
    let i = st.project.levels.length + 1;
    while (names.has(`${i} 层`)) i++;
    st.project.levels.push(newLevel(`${i} 层`));
    st.project.activeLevel = st.project.levels.length - 1;
    notify();
  }

  function removeLevel() {
    if (st.project.levels.length <= 1) return;
    st.project.levels.splice(st.project.activeLevel, 1);
    st.project.activeLevel = Math.max(0, st.project.activeLevel - 1);
    notify();
  }

  function selectLevel(i) {
    st.project.activeLevel = Math.min(Math.max(0, i), st.project.levels.length - 1);
    notify();
  }

  function addSnapshot(name) {
    const l = level();
    if (!l) return;
    l.snapshots.push(newSnapshot(name || `快照 ${l.snapshots.length + 1}`));
    l.activeSnapshot = l.snapshots.length - 1;
    notify();
  }

  function removeSnapshot() {
    const l = level();
    if (!l || l.snapshots.length <= 1) return;
    l.snapshots.splice(l.activeSnapshot, 1);
    l.activeSnapshot = Math.max(0, l.activeSnapshot - 1);
    notify();
  }

  function selectSnapshot(i) {
    const l = level();
    if (!l) return;
    l.activeSnapshot = Math.min(Math.max(0, i), l.snapshots.length - 1);
    notify();
  }

  function renameSnapshot(name) {
    const s = snapshot();
    if (s) {
      s.name = name || s.name;
      notify();
    }
  }

  // ------------------------------------------------------------ 采样点

  function addSample(sample) {
    const s = snapshot();
    if (!s) return;
    s.samples.push(sample);
    notify();
  }

  function removeSample(id) {
    const s = snapshot();
    if (s) {
      s.samples = s.samples.filter((x) => x.id !== id);
      notify();
    }
  }

  function clearSamples() {
    const s = snapshot();
    if (s) {
      s.samples = [];
      notify();
    }
  }

  // ------------------------------------------------------------ 统计

  /** 一个快照里某个 BSSID 的统计；bssid 为空时用每个点的最强信号。 */
  function statsFor(snap, bssid) {
    const pts = [];
    for (const s of snap.samples) {
      const ap = bssid ? s.aps.find((a) => a.bssid === bssid) : s.best;
      if (ap) pts.push({ x: s.x, y: s.y, rssi: ap.rssi });
    }
    if (!pts.length) return { n: 0, pts };
    const rs = pts.map((p) => p.rssi);
    const avg = rs.reduce((a, b) => a + b, 0) / rs.length;
    const cover = rs.filter((r) => r >= -67).length / rs.length;
    return {
      n: pts.length,
      pts,
      avg: Math.round(avg * 10) / 10,
      min: Math.min(...rs),
      max: Math.max(...rs),
      coverage: Math.round(cover * 1000) / 10,
    };
  }

  /** 所有楼层、所有快照里出现过的 BSSID，按平均信号排序。 */
  function allBssids(levels = st.project.levels) {
    const map = new Map();
    for (const l of levels) {
      for (const snap of l.snapshots) {
        for (const s of snap.samples) {
          for (const ap of s.aps) {
            let e = map.get(ap.bssid);
            if (!e) {
              e = { bssid: ap.bssid, ssid: ap.ssid, channel: ap.channel, band: ap.band, n: 0, sum: 0 };
              map.set(ap.bssid, e);
            }
            e.n += 1;
            e.sum += ap.rssi;
            if (!e.ssid && ap.ssid) e.ssid = ap.ssid;
          }
        }
      }
    }
    return [...map.values()]
      .map((e) => ({ ...e, avg: Math.round(e.sum / e.n) }))
      .sort((a, b) => b.avg - a.avg);
  }

  /** 勘测面积（凸包），单位 m²；没标定就返回 null。 */
  function surveyedArea(snap, pxPerMeter) {
    if (!pxPerMeter || snap.samples.length < 3) return null;
    const pts = snap.samples.map((s) => [s.x, s.y]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (const p of [...pts].reverse()) {
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
    let area = 0;
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i];
      const b = hull[(i + 1) % hull.length];
      area += a[0] * b[1] - b[0] * a[1];
    }
    return Math.abs(area / 2) / (pxPerMeter * pxPerMeter);
  }

  // ------------------------------------------------------------ 序列化

  function toPayload() {
    return {
      name: st.project.name,
      activeLevel: st.project.activeLevel,
      activeBssid: st.activeBssid || null,
      levels: st.project.levels.map((l) => ({
        name: l.name,
        planPng: l.plan ? l.plan.dataUrl.replace(/^data:image\/[a-z]+;base64,/, '') : null,
        planW: l.plan?.w ?? 0,
        planH: l.plan?.h ?? 0,
        pxPerMeter: l.pxPerMeter,
        snapshots: l.snapshots.map((s) => ({
          name: s.name,
          createdAt: s.createdAt,
          samples: s.samples.map((p) => ({
            x: p.x,
            y: p.y,
            t: p.t,
            aps: p.aps.map((a) => ({
              bssid: a.bssid, ssid: a.ssid, channel: a.channel, band: a.band, rssi: a.rssi,
            })),
          })),
        })),
      })),
    };
  }

  /** payload → 内存模型；平面图异步解码，返回 Promise。 */
  async function fromPayload(p) {
    const levels = [];
    for (const lp of p.levels ?? []) {
      const level = {
        id: seq++,
        name: lp.name,
        plan: null,
        pxPerMeter: lp.pxPerMeter ?? null,
        calib: [],
        snapshots: (lp.snapshots ?? []).map((sp) => ({
          id: seq++,
          name: sp.name,
          createdAt: sp.createdAt,
          samples: (sp.samples ?? []).map((s) => ({
            id: seq++,
            x: s.x,
            y: s.y,
            t: s.t,
            aps: s.aps ?? [],
            best: (s.aps ?? []).reduce((m, a) => (m === null || a.rssi > m.rssi ? a : m), null),
          })),
        })),
        activeSnapshot: 0,
      };
      if (!level.snapshots.length) level.snapshots.push(newSnapshot('快照 1'));
      if (lp.planPng) {
        const dataUrl = `data:image/png;base64,${lp.planPng}`;
        level.plan = await loadImage(dataUrl, lp.planW, lp.planH);
      }
      levels.push(level);
    }
    if (!levels.length) levels.push(newLevel('1 层'));

    st.project = {
      name: p.name || '未命名工程',
      levels,
      activeLevel: Math.min(p.activeLevel ?? 0, levels.length - 1),
    };
    st.activeBssid = p.activeBssid ?? '';
    notify();
  }

  function loadImage(dataUrl, w, h) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ img, w: w || img.naturalWidth, h: h || img.naturalHeight, dataUrl });
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  }

  // ------------------------------------------------------------ 订阅

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function notify() {
    for (const fn of listeners) {
      try {
        fn();
      } catch (e) {
        log('error', 'store listener: ' + e);
      }
    }
  }

  init();

  return {
    state: st,
    level,
    snapshot,
    addLevel,
    removeLevel,
    selectLevel,
    setLevelName,
    addSnapshot,
    removeSnapshot,
    selectSnapshot,
    renameSnapshot,
    addSample,
    removeSample,
    clearSamples,
    statsFor,
    allBssids,
    surveyedArea,
    toPayload,
    fromPayload,
    subscribe,
    notify,
  };
})();
