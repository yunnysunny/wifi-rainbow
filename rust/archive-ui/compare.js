// 对比视图：任选两个「楼层 / 快照」，并排比热图，或把两张热图做差分叠加。
//
// ⚠ 2026-10-24：对比标签已从软件移除，本文件不再被 index.html 加载，仅作存档
// （差分用的是 heat.js 的 imageField / resample，要恢复需同时加回视图块与脚本引用）。

const Compare = (() => {
  let pairs = [];      // [{label, level, snapshot}]
  let selA = 0;
  let selB = 1;
  let mode = 'side';   // side | diff
  let lastDiff = null;

  function collect() {
    pairs = [];
    for (const l of Store.state.project.levels) {
      for (const s of l.snapshots) {
        pairs.push({ label: `${l.name} / ${s.name}`, level: l, snapshot: s });
      }
    }
    selA = Math.min(selA, Math.max(0, pairs.length - 1));
    selB = Math.min(Math.max(selB, 1), Math.max(0, pairs.length - 1));
    if (pairs.length === 1) selB = 0;
  }

  function renderSelects() {
    const opts = pairs.map((p, i) => `<option value="${i}">${esc(p.label)} · ${p.snapshot.samples.length} 点</option>`).join('');
    const a = $('#cmp-a-sel');
    const b = $('#cmp-b-sel');
    a.innerHTML = opts;
    b.innerHTML = opts;
    a.value = String(selA);
    b.value = String(selB);

    const bssids = Store.allBssids();
    const sel = $('#cmp-bssid');
    const keep = Store.state.activeBssid || bssids[0]?.bssid || '';
    sel.innerHTML = '<option value="">（每点最强信号）</option>' + bssids.map((x) =>
      `<option value="${x.bssid}"${x.bssid === keep ? ' selected' : ''}>${esc(x.ssid || '<hidden>')} · ${x.band} ch${x.channel ?? '?'} · ${x.avg} dBm</option>`
    ).join('');
    if (!Store.state.activeBssid && bssids.length) Store.state.activeBssid = bssids[0].bssid;
  }

  function setMode(next) {
    mode = next;
    document.body.dataset.cmpMode = mode;
    render();
  }

  function renderStatsSide(A, B) {
    const d = (x, y) => (x.n && y.n ? (y.avg - x.avg >= 0 ? '+' : '') + (Math.round((y.avg - x.avg) * 10) / 10) : '—');
    const rows = [
      ['采样点', A.samples, B.samples],
      ['平均 RSSI', A.stat.avg ?? '—', B.stat.avg ?? '—'],
      ['最差 RSSI', A.stat.min ?? '—', B.stat.min ?? '—'],
      ['达标率 (≥-67 dBm)', A.stat.coverage != null ? A.stat.coverage + '%' : '—', B.stat.coverage != null ? B.stat.coverage + '%' : '—'],
      ['勘测面积', A.area != null ? A.area.toFixed(1) + ' m²' : '—', B.area != null ? B.area.toFixed(1) + ' m²' : '—'],
      ['差值 (B−A)', '', d(A.stat, B.stat) + ' dB'],
    ];
    $('#cmp-table').innerHTML = `
      <thead><tr><th>指标</th><th>${esc(A.pair.label)}</th><th>${esc(B.pair.label)}</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td>${r[0]}</td><td class="num">${r[1]}</td><td class="num">${r[2]}</td></tr>`).join('')}</tbody>`;
  }

  function renderDiff(pairA, pairB, bssid) {
    const canvas = $('#cmp-diff');
    const legend = $('#cmp-diff-legend');
    const stats = Heat.renderDiff(canvas, {
      planA: pairA.level.plan,
      planB: pairB.level.plan,
      samplesA: pairA.snapshot.samples,
      samplesB: pairB.snapshot.samples,
      bssid,
      opts: Store.state.opts,
      pxA: pairA.level.pxPerMeter,
      pxB: pairB.level.pxPerMeter,
    });

    const pct = (n) => (stats.cells ? Math.round((n / stats.cells) * 100) : 0);
    lastDiff = stats;
    const fmt = (v) => (v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(1) + ' dB');
    const rows = [
      ['可比格数', stats.cells ? `${stats.cells}（${stats.resampled ? '平面图已按比例对齐' : '同尺寸' }）` : '—'],
      ['平均差值', fmt(stats.meanDelta)],
      ['改善格数', stats.cells ? `${stats.improved}（${pct(stats.improved)}%）` : '—'],
      ['恶化格数', stats.cells ? `${stats.worse}（${pct(stats.worse)}%）` : '—'],
      ['基本持平(±1 dB)', stats.cells ? `${stats.flat}（${pct(stats.flat)}%）` : '—'],
      ['最大改善', fmt(stats.maxUp?.d)],
      [stats.maxDown?.d > 0 ? '最小改善' : '最大恶化', fmt(stats.maxDown?.d)],
      ['耗时', stats.ms ? `${stats.ms} ms` : '—'],
    ];
    $('#cmp-table').innerHTML = `
      <thead><tr><th>差分 (B − A)</th><th>${esc(pairB.label)} 相对 ${esc(pairA.label)}</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td>${r[0]}</td><td class="num">${r[1]}</td></tr>`).join('')}</tbody>`;

    legend.innerHTML = `
      <span class="dg"><i class="sw" style="background:#f87171"></i>变差</span>
      <span class="grad-bar"></span>
      <span class="dg"><i class="sw" style="background:#4ade80"></i>变好</span>
      <em>色深 = 差值大小（±1 dB 内不显示）</em>`;
  }

  function render() {
    collect();
    renderSelects();
    $$('#cmp-mode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));

    const bssid = Store.state.activeBssid || '';
    const pairA = pairs[selA];
    const pairB = pairs[selB];

    if (mode === 'diff') {
      if (!pairA || !pairB) {
        $('#cmp-table').innerHTML = '<tbody><tr><td class="hint">还需要两个快照才能做差分。</td></tr></tbody>';
        return;
      }
      $('#cmp-diff-label').textContent = `B − A：${pairB.label} 相对 ${pairA.label}${bssid ? '' : '（每点最强信号）'}`;
      renderDiff(pairA, pairB, bssid);
      return;
    }

    const panes = [
      { canvas: $('#cmp-a'), pair: pairA, label: $('#cmp-a-label') },
      { canvas: $('#cmp-b'), pair: pairB, label: $('#cmp-b-label') },
    ];

    const stats = [];
    for (const pane of panes) {
      if (!pane.pair) {
        pane.label.textContent = '没有可对比的快照';
        continue;
      }
      const { level, snapshot } = pane.pair;
      const info = Heat.render(pane.canvas, {
        plan: level.plan,
        samples: snapshot.samples,
        bssid,
        opts: Store.state.opts,
        pxPerMeter: level.pxPerMeter,
        showPoints: true,
        valueLabels: false,
        emptyText: '这个楼层还没有平面图',
      });
      const stat = Store.statsFor(snapshot, bssid);
      const area = Store.surveyedArea(snapshot, level.pxPerMeter);
      pane.label.textContent = `${pane.pair.label} · ${snapshot.samples.length} 点${info?.heat ? ` · 插值 ${info.heat.ms}ms` : ''}`;
      stats.push({ pair: pane.pair, stat, area, samples: snapshot.samples.length });
    }

    if (stats.length === 2) renderStatsSide(stats[0], stats[1]);
    else $('#cmp-table').innerHTML = '<tbody><tr><td class="hint">选一个具体网络，才能比覆盖率。</td></tr></tbody>';
  }

  function init() {
    $('#cmp-a-sel').addEventListener('change', (e) => {
      selA = Number(e.target.value);
      render();
    });
    $('#cmp-b-sel').addEventListener('change', (e) => {
      selB = Number(e.target.value);
      render();
    });
    $('#cmp-bssid').addEventListener('change', (e) => {
      Store.state.activeBssid = e.target.value;
      render();
    });
    $('#cmp-swap').addEventListener('click', () => {
      const t = selA;
      selA = selB;
      selB = t;
      render();
    });
    $$('#cmp-mode button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
    window.addEventListener('resize', () => {
      if (document.body.dataset.view === 'compare') render();
    });
    Store.subscribe(() => {
      if (document.body.dataset.view === 'compare') render();
    });
  }

  function activate() {
    render();
  }

  return { init, activate, render, setMode, mode: () => mode, diffStats: () => lastDiff };
})();
