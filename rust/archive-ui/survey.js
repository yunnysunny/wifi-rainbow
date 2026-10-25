// Survey 视图：平面图 + 标定 + 打点 + 热图。数据全部落在 Store 的「当前楼层 / 当前快照」上。
//
// ⚠ 2026-10-24：Survey 已从软件与计划中移除，本文件不再被 index.html 加载，只作为存档保留
// （缩放平移、AP 位置标注的实现在这里；要恢复 Survey 标签需要同时恢复 index.html 的视图块与脚本引用）。
//
// 坐标系：采样点与标定点存图像坐标（image px），渲染时再映射到画布坐标。

const Survey = (() => {
  const st = {
    mode: 'idle',       // idle | calib | sample
    calib: [],
    pending: null,
    geom: null,
    lastHeat: null,
    apHits: [],
    aps: [],
    apSig: '',
  };

  // 视图：z = 相对「适应窗口」的放大倍数，px/py = 在该基础上的平移量（画布 CSS px）
  const view = { z: 1, px: 0, py: 0 };
  const MIN_Z = 1;
  const MAX_Z = 16;
  let drag = null;
  let rafId = 0;
  let apMode = 'all'; // all | active | off

  const level = () => Store.level();
  const snap = () => Store.snapshot();

  function clampNum(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  // ------------------------------------------------------------ 视图变换

  function fitOf(cv, plan) {
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    const fit = Math.min(w / plan.w, h / plan.h);
    return { w, h, fit, fox: (w - plan.w * fit) / 2, foy: (h - plan.h * fit) / 2 };
  }

  /** 把 view 换成当前生效的 {scale, ox, oy}，顺便把平移量夹回合法范围。 */
  function currentView(cv, plan) {
    const f = fitOf(cv, plan);
    const scale = f.fit * view.z;
    const ow = plan.w * scale;
    const oh = plan.h * scale;
    let ox = f.fox + view.px;
    let oy = f.foy + view.py;
    // 画得比视口大：可以拖，但边缘不许跑到视口里；比视口小：居中
    ox = ow <= f.w ? (f.w - ow) / 2 : Math.min(0, Math.max(f.w - ow, ox));
    oy = oh <= f.h ? (f.h - oh) / 2 : Math.min(0, Math.max(f.h - oh, oy));
    view.px = ox - f.fox;
    view.py = oy - f.foy;
    return { scale, ox, oy, w: f.w, h: f.h, fit: f.fit, fox: f.fox, foy: f.foy };
  }

  function toImage(cx, cy) {
    const g = st.geom;
    return { x: (cx - g.ox) / g.scale, y: (cy - g.oy) / g.scale };
  }

  function scheduleRender() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      render();
    });
  }

  /** 以画布内某点为锚缩放（滚轮用）。 */
  function zoomAt(cx, cy, factor) {
    const l = level();
    const cv = $('#map');
    if (!l?.plan || !cv || !st.geom) return;
    const z2 = clampNum(view.z * factor, MIN_Z, MAX_Z);
    if (Math.abs(z2 - view.z) < 1e-4) return;
    const s2 = (st.geom.fitScale ?? st.geom.fit) * z2;
    const ix = (cx - st.geom.ox) / st.geom.scale;
    const iy = (cy - st.geom.oy) / st.geom.scale;
    view.z = z2;
    const f = fitOf(cv, l.plan);
    view.px = cx - ix * s2 - f.fox;
    view.py = cy - iy * s2 - f.foy;
    render();
  }

  function resetView() {
    view.z = 1;
    view.px = 0;
    view.py = 0;
    render();
  }

  function updateZoomUi() {
    const box = $('#map-zoom');
    if (!box) return;
    const has = !!level()?.plan;
    box.style.display = has ? 'flex' : 'none';
    $('#zoom-val').textContent = `${Math.round(view.z * 100)}%`;
    $('#zoom-out').disabled = view.z <= MIN_Z + 1e-4;
    $('#zoom-in').disabled = view.z >= MAX_Z - 1e-4;
    $('#zoom-fit').disabled = view.z === 1 && view.px === 0 && view.py === 0;
  }

  // ------------------------------------------------------------ 渲染

  function render() {
    const l = level();
    const s = snap();
    const cv = $('#map');
    if (!l) return;

    const aps = Apmap.estimate(s?.samples ?? [], { pxPerMeter: l.pxPerMeter });
    st.aps = aps;
    const markers = Apmap.pick(aps, apMode, Store.state.activeBssid);
    const v = l.plan ? currentView(cv, l.plan) : null;

    st.geom = Heat.render(cv, {
      plan: l.plan,
      samples: s?.samples ?? [],
      bssid: Store.state.activeBssid,
      opts: Store.state.opts,
      pxPerMeter: l.pxPerMeter,
      showPoints: true,
      valueLabels: true,
      view: v,
      apMarkers: markers,
      emptyText: '先载入一张平面图（PNG / JPG）',
    });
    st.apHits = st.geom?.apHits ?? [];
    st.lastHeat = st.geom?.heat ?? null;

    if (!l.plan) {
      $('#map-hint').style.display = 'flex';
      $('#map-hint').textContent = '先载入一张平面图（PNG / JPG）';
    } else {
      $('#map-hint').style.display = 'none';
    }

    updateZoomUi();
    drawOverlay(l);
    renderApList();
  }

  function drawOverlay(l) {
    const cv = $('#map');
    const g = st.geom;
    if (!cv || !g || !g.scale) return;
    const ctx = cv.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 标定线
    if (l.calib?.length) {
      const toC = (p) => ({ x: p.x * g.scale + g.ox, y: p.y * g.scale + g.oy });
      ctx.strokeStyle = '#4aa3ff';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      const a = toC(l.calib[0]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      if (l.calib[1]) {
        const b = toC(l.calib[1]);
        ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      for (const c of l.calib) {
        const p = toC(c);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = '#4aa3ff';
        ctx.fill();
      }
    }

    // 正在采集
    if (st.pending) {
      const c = { x: st.pending.x * g.scale + g.ox, y: st.pending.y * g.scale + g.oy };
      const t = (Date.now() % 1000) / 1000;
      ctx.beginPath();
      ctx.arc(c.x, c.y, 8 + 6 * t, 0, Math.PI * 2);
      ctx.strokeStyle = hexAlpha('#4aa3ff', 1 - t);
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // 顶部信息条
    const parts = [];
    if (st.mode === 'calib') parts.push(`标定：点击两点（已 ${st.calib.length}/2）`);
    if (st.mode === 'sample') parts.push('打点模式：点击地图记录采样');
    const s = snap();
    if (s && Store.state.activeBssid) {
      const stat = Store.statsFor(s, Store.state.activeBssid);
      const b = Store.allBssids([l]).find((x) => x.bssid === Store.state.activeBssid);
      if (stat.n) parts.push(`${b?.ssid || '<hidden>'} · ${stat.n} 点 · 均值 ${stat.avg} dBm · ≥-67 占 ${stat.coverage}%`);
    }
    if (st.lastHeat) parts.push(`插值 ${st.lastHeat.ms}ms / ${st.lastHeat.cells} 格`);
    if (st.aps.length) parts.push(`AP ${st.aps.length} 个`);
    if (view.z !== 1) parts.push(`缩放 ${Math.round(view.z * 100)}%`);
    $('#map-overlay').textContent = parts.join('   |   ');
  }

  // ------------------------------------------------------------ 交互

  /** 详情抽屉要完整字段：优先用实时扫描里的同 BSSID 记录，退而用采样里的快照补齐。 */
  function apForDetail(bssid, fallback) {
    const live = Inspector.aps().find((a) => a.bssid === bssid);
    if (live) return live;
    const rssi = fallback?.rssi ?? -100;
    return { ...fallback, bssid, quality: Math.max(0, Math.min(100, Math.round(2 * (rssi + 100)))) };
  }

  function onMapClick(ev) {
    const l = level();
    if (!l?.plan) return;
    const rect = $('#map').getBoundingClientRect();
    const ccx = ev.clientX - rect.left;
    const ccy = ev.clientY - rect.top;

    // 浏览模式下，点在 AP 图标上就开详情抽屉
    if (st.mode === 'idle') {
      const hit = st.apHits.find((h) => Math.hypot(ccx - h.cx, ccy - h.cy) <= h.r);
      if (hit) {
        Detail.show(apForDetail(hit.bssid, hit.ap));
        return;
      }
    }

    const img = toImage(ccx, ccy);
    if (img.x < 0 || img.y < 0 || img.x > l.plan.w || img.y > l.plan.h) return;

    if (st.mode === 'calib') {
      st.calib.push(img);
      if (st.calib.length === 2) {
        const m = Number($('#calib-m').value) || 0;
        const [a, b] = st.calib;
        const px = Math.hypot(b.x - a.x, b.y - a.y);
        if (m > 0 && px > 4) {
          l.pxPerMeter = px / m;
          l.calib = [...st.calib];
          log('info', `calibrated: ${px.toFixed(1)}px = ${m}m -> ${l.pxPerMeter.toFixed(2)} px/m`);
        }
        st.mode = 'idle';
        st.calib = [];
        Store.notify();
      }
      renderSidebar();
      render();
      return;
    }

    if (st.mode === 'sample') addSample(img.x, img.y);
  }

  async function addSample(ix, iy) {
    if (st.pending || !INVOKE) return;
    st.pending = { x: ix, y: iy };
    render();
    setStatus('正在采集该点的信号…');
    try {
      const aps = await INVOKE('scan_now', { waitMs: 2200 });
      const sample = {
        id: Date.now() + Math.floor(Math.random() * 1000),
        x: ix,
        y: iy,
        t: Date.now(),
        aps: aps.map((a) => ({
          bssid: a.bssid, ssid: a.ssid, rssi: a.rssi, channel: a.channel, band: a.band,
        })),
        best: aps.reduce((m, a) => (m === null || a.rssi > m.rssi ? a : m), null),
      };
      Store.addSample(sample);
      if (!Store.state.activeBssid && sample.best) Store.state.activeBssid = sample.best.bssid;
      log('info', `sample aps=${sample.aps.length} best=${sample.best?.ssid} ${sample.best?.rssi}`);
      setStatus(`已采样 ${snap()?.samples.length ?? 0} 个点`);
    } catch (e) {
      setStatus('采集失败：' + e);
    } finally {
      st.pending = null;
      render();
      renderSidebar();
    }
  }

  function setMode(mode) {
    st.mode = mode;
    if (mode !== 'calib') st.calib = [];
    $$('#view-survey .seg button[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    refreshCursor();
    render();
  }

  function refreshCursor() {
    const cv = $('#map');
    if (!cv) return;
    cv.style.cursor = st.mode === 'calib' ? 'crosshair' : st.mode === 'sample' ? 'copy' : 'grab';
  }

  // ------------------------------------------------------------ 指针：拖拽平移 + 点击

  function onPointerDown(ev) {
    const l = level();
    if (!l?.plan) return;
    if (ev.button !== 0 && ev.button !== 1) return;
    drag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, panning: false, forced: ev.button === 1 };
    try {
      $('#map').setPointerCapture?.(ev.pointerId);
    } catch (e) {
      /* 合成的 PointerEvent 没有真实 pointerId，忽略即可 */
    }
  }

  function onPointerMove(ev) {
    const cv = $('#map');
    if (!drag || ev.pointerId !== drag.id) {
      // 悬停在 AP 图标上给个可点的提示
      if (!drag && st.mode === 'idle' && st.apHits.length && cv) {
        const rect = cv.getBoundingClientRect();
        const hx = ev.clientX - rect.left;
        const hy = ev.clientY - rect.top;
        const over = st.apHits.some((h) => Math.hypot(hx - h.cx, hy - h.cy) <= h.r);
        cv.style.cursor = over ? 'pointer' : 'grab';
      }
      return;
    }
    const dx = ev.clientX - drag.x;
    const dy = ev.clientY - drag.y;
    if (!drag.panning) {
      if (!drag.forced && Math.hypot(dx, dy) < 4) return;
      drag.panning = true;
      cv?.classList.add('panning');
    }
    view.px += dx;
    view.py += dy;
    drag.x = ev.clientX;
    drag.y = ev.clientY;
    scheduleRender();
  }

  function onPointerUp(ev) {
    if (!drag || ev.pointerId !== drag.id) return;
    const wasPan = drag.panning;
    drag = null;
    $('#map').classList.remove('panning');
    refreshCursor();
    if (!wasPan) {
      onMapClick(ev);
    } else {
      render();
    }
  }

  function onWheel(ev) {
    const l = level();
    if (!l?.plan) return;
    ev.preventDefault();
    const rect = $('#map').getBoundingClientRect();
    const factor = Math.exp(-ev.deltaY * (ev.deltaMode === 1 ? 0.05 : 0.0018));
    zoomAt(ev.clientX - rect.left, ev.clientY - rect.top, factor);
  }

  // ------------------------------------------------------------ AP 位置列表

  function renderApList() {
    const list = $('#ap-list');
    const em = $('#ap-count');
    if (!list) return;
    const l = level();
    const aps = st.aps;
    // 平移/缩放时每帧都会进来，数据没变就不重建 DOM
    const sig = `${apMode}|${Store.state.activeBssid}|` + aps.map((a) => `${a.bssid}:${a.rssi}:${Math.round(a.x)}:${Math.round(a.y)}`).join(';');
    if (sig === st.apSig) return;
    st.apSig = sig;
    if (em) em.textContent = aps.length ? `${aps.length} 个` : '';
    if (!aps.length) {
      list.innerHTML = '<div class="hint">打几个采样点就能估出 AP 在平面图上的位置</div>';
      return;
    }
    const shown = Apmap.pick(aps, apMode === 'off' ? 'all' : apMode, Store.state.activeBssid);
    list.innerHTML = shown.map((a) => {
      const pos = l?.pxPerMeter
        ? `${(a.x / l.pxPerMeter).toFixed(1)}, ${(a.y / l.pxPerMeter).toFixed(1)} m`
        : `${Math.round(a.x)}, ${Math.round(a.y)} px`;
      const spread = a.spreadM != null ? ` ±${a.spreadM.toFixed(1)}m` : '';
      const dim = apMode === 'off' ? ' style="opacity:.55"' : '';
      return `<div class="ap-row" data-ap="${a.bssid}"${dim} title="点开详情">
        <span class="dot" style="background:${rssiColor(a.rssi)}"></span>
        <span class="nm">${esc(a.ssid || '<隐藏>')}</span>
        <span class="pos">${pos}${spread}</span>
        <span class="rssi ${rssiClass(a.rssi)}">${a.rssi}</span>
      </div>`;
    }).join('');
    $$('#ap-list .ap-row').forEach((row) => {
      row.addEventListener('click', () => {
        const a = aps.find((x) => x.bssid === row.dataset.ap);
        if (a) Detail.show(apForDetail(a.bssid, a.ap));
      });
    });
  }

  // ------------------------------------------------------------ 侧栏

  function renderSidebar() {
    const l = level();
    const s = snap();
    const bssids = Store.allBssids(l ? [l] : undefined);

    // 楼层
    $('#project-name').value = Store.state.project.name;
    $('#level-list').innerHTML = Store.state.project.levels.map((lv, i) =>
      `<button class="chip lv${i === Store.state.project.activeLevel ? ' on' : ''}" data-level="${i}"
        style="--c:#4aa3ff">${esc(lv.name)}<span>${lv.snapshots.reduce((n, k) => n + k.samples.length, 0)}</span></button>`
    ).join('');

    // 快照
    $('#snap-select').innerHTML = (l?.snapshots ?? []).map((k, i) =>
      `<option value="${i}"${i === l.activeSnapshot ? ' selected' : ''}>${esc(k.name)} · ${k.samples.length} 点</option>`
    ).join('');

    // 平面图 / 标定
    $('#plan-info').textContent = l?.plan
      ? `${Store.state.project.name} / ${l.name} · ${l.plan.w}×${l.plan.h} px`
      : '未载入';
    $('#calib-info').textContent = l?.pxPerMeter
      ? `${l.pxPerMeter.toFixed(2)} px/m · ${(1 / l.pxPerMeter).toFixed(3)} m/px`
      : '未标定';

    // 热图网络
    const sel = $('#heat-bssid');
    sel.innerHTML = '<option value="">（每个点取最强信号）</option>' + bssids.map((b) =>
      `<option value="${b.bssid}"${b.bssid === Store.state.activeBssid ? ' selected' : ''}>
        ${esc(b.ssid || '<hidden>')} · ch${b.channel ?? '?'} · ${b.avg} dBm · ${b.n} 点
      </option>`).join('');
    if (Store.state.activeBssid && !bssids.some((b) => b.bssid === Store.state.activeBssid)) {
      Store.state.activeBssid = bssids[0]?.bssid ?? '';
      sel.value = Store.state.activeBssid;
    }

    // 采样点列表
    const samples = s?.samples ?? [];
    $('#sample-info').textContent = `${samples.length} 个采样点`;
    $('#sample-count').textContent = samples.length || '';
    const byId = [...samples].sort((a, b) => b.t - a.t);
    $('#sample-list').innerHTML = byId.map((p) => {
      const ap = Store.state.activeBssid
        ? p.aps.find((a) => a.bssid === Store.state.activeBssid)
        : p.best;
      const rssi = ap?.rssi ?? '—';
      const coord = l?.pxPerMeter
        ? `${(p.x / l.pxPerMeter).toFixed(1)}, ${(p.y / l.pxPerMeter).toFixed(1)} m`
        : `${Math.round(p.x)}, ${Math.round(p.y)} px`;
      return `<div class="sample-row">
        <span class="coord">${coord}</span>
        <span class="rssi ${rssiClass(Number(rssi))}">${rssi}</span>
        <span class="time">${new Date(p.t).toLocaleTimeString()}</span>
        <button class="del" data-del="${p.id}" title="删除">×</button>
      </div>`;
    }).join('');

    $$('#level-list .chip').forEach((c) => c.addEventListener('click', () => Store.selectLevel(Number(c.dataset.level))));
    $$('#sample-list [data-del]').forEach((b) => b.addEventListener('click', () => Store.removeSample(Number(b.dataset.del))));
  }

  // ------------------------------------------------------------ 初始化

  function init() {
    $('#plan-pick').addEventListener('click', () => $('#plan-file').click());
    $('#plan-file').addEventListener('change', (e) => {
      const f = e.target.files?.[0];
      e.target.value = '';
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const l = level();
          l.plan = { img, w: img.naturalWidth, h: img.naturalHeight, dataUrl: reader.result };
          l.calib = [];
          l.pxPerMeter = null;
          view.z = 1;
          view.px = 0;
          view.py = 0;
          log('info', `plan loaded ${f.name} ${img.naturalWidth}x${img.naturalHeight}`);
          Store.notify();
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(f);
    });

    $('#calib-start').addEventListener('click', () => {
      if (!level()?.plan) return;
      st.calib = [];
      setMode('calib');
      $('#map-overlay').textContent = '点击平面图上两点';
    });

    $$('#view-survey .seg button[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
    $('#sample-clear').addEventListener('click', () => Store.clearSamples());

    $('#heat-bssid').addEventListener('change', (e) => {
      Store.state.activeBssid = e.target.value;
      Store.notify();
    });

    const bindSlider = (id, apply, fmt) => {
      const el = $(id);
      const em = el.parentElement.querySelector('em');
      const sync = () => {
        apply(Number(el.value));
        if (em) em.textContent = fmt(Number(el.value));
        render();
      };
      el.addEventListener('input', sync);
      sync();
    };
    bindSlider('#heat-power', (v) => (Store.state.opts.power = v), (v) => v.toFixed(1));
    bindSlider('#heat-radius', (v) => (Store.state.opts.radiusM = v), (v) => `${v} m`);
    bindSlider('#heat-alpha', (v) => (Store.state.opts.alpha = v), (v) => `${Math.round(v * 100)}%`);

    // 楼层 / 快照
    $('#level-add').addEventListener('click', () => Store.addLevel());
    $('#level-remove').addEventListener('click', () => Store.removeLevel());
    $('#snap-add').addEventListener('click', () => Store.addSnapshot());
    $('#snap-remove').addEventListener('click', () => Store.removeSnapshot());
    $('#snap-select').addEventListener('change', (e) => Store.selectSnapshot(Number(e.target.value)));
    $('#project-name').addEventListener('change', (e) => {
      Store.state.project.name = e.target.value.trim() || '未命名工程';
      Store.notify();
    });

    // 缩放平移
    $('#zoom-in').addEventListener('click', () => {
      const g = st.geom;
      if (g) zoomAt(g.w / 2, g.h / 2, 1.35);
    });
    $('#zoom-out').addEventListener('click', () => {
      const g = st.geom;
      if (g) zoomAt(g.w / 2, g.h / 2, 1 / 1.35);
    });
    $('#zoom-fit').addEventListener('click', resetView);
    $$('#ap-show button').forEach((b) => b.addEventListener('click', () => {
      apMode = b.dataset.ap;
      $$('#ap-show button').forEach((x) => x.classList.toggle('active', x === b));
      Store.notify();
    }));

    $('#map').addEventListener('pointerdown', onPointerDown);
    $('#map').addEventListener('pointermove', onPointerMove);
    $('#map').addEventListener('pointerup', onPointerUp);
    $('#map').addEventListener('pointercancel', onPointerUp);
    $('#map').addEventListener('wheel', onWheel, { passive: false });
    $('#map').addEventListener('dblclick', (ev) => {
      const g = st.geom;
      if (!g) return;
      const rect = $('#map').getBoundingClientRect();
      zoomAt(ev.clientX - rect.left, ev.clientY - rect.top, view.z >= MAX_Z - 1e-4 ? 1 / view.z : 1.6);
    });
    $('#map').addEventListener('contextmenu', (ev) => {
      if (level()?.plan) {
        ev.preventDefault();
        resetView();
      }
    });

    window.addEventListener('resize', () => {
      if (document.body.dataset.view === 'survey') render();
    });
    window.addEventListener('keydown', (e) => {
      if (document.body.dataset.view !== 'survey') return;
      if (e.key === 'Escape') setMode('idle');
      if (e.key === '0') resetView();
      else if (e.key === '+' || e.key === '=') {
        const g = st.geom;
        if (g) zoomAt(g.w / 2, g.h / 2, 1.25);
      } else if (e.key === '-') {
        const g = st.geom;
        if (g) zoomAt(g.w / 2, g.h / 2, 1 / 1.25);
      }
    });

    Store.subscribe(() => {
      if (document.body.dataset.view === 'survey') {
        renderSidebar();
        render();
      } else {
        renderSidebar();
      }
    });

    // 采集中的点要动起来
    setInterval(() => {
      if (st.pending && document.body.dataset.view === 'survey') render();
    }, 250);

    renderSidebar();
  }

  function activate() {
    renderSidebar();
    refreshCursor();
    render();
  }

  return { init, activate, render, state: st, addSample, view, zoomAt, resetView };
})();
