// 工程存取与导出：.wsproj（ZIP + SQLite）、CSV、自包含 HTML 报告。

const Project = (() => {
  async function save() {
    if (!INVOKE) return;
    const payload = Store.toPayload();
    try {
      const path = await INVOKE('save_project', { payload, path: Store.state.path });
      Store.state.path = path;
      renderPath();
      setStatus(`已保存：${path}`);
      log('info', `project saved: ${path} (${payload.levels.length} levels)`);
    } catch (e) {
      setStatus('保存失败：' + e);
      log('error', 'save failed: ' + e);
    }
  }

  async function saveAs() {
    Store.state.path = null;
    return save();
  }

  async function open() {
    if (!INVOKE) return;
    try {
      const res = await INVOKE('open_project');
      if (!res) return;
      await Store.fromPayload(res.project);
      Store.state.path = res.path;
      renderPath();
      setStatus(`已打开：${res.path}`);
      log('info', `project opened: ${res.path} levels=${res.project.levels.length}`);
      Store.notify();
    } catch (e) {
      setStatus('打开失败：' + e);
      log('error', 'open failed: ' + e);
    }
  }

  function renderPath() {
    const el = $('#project-path');
    if (!el) return;
    el.textContent = Store.state.path ? Store.state.path : '未保存';
    el.title = Store.state.path || '';
  }

  // ------------------------------------------------------------ CSV

  function buildCsv() {
    const rows = [['level', 'snapshot', 'x_m', 'y_m', 'time', 'ssid', 'bssid', 'rssi_dbm', 'channel', 'band']];
    for (const l of Store.state.project.levels) {
      for (const s of l.snapshots) {
        for (const p of s.samples) {
          const x = l.pxPerMeter ? (p.x / l.pxPerMeter).toFixed(2) : p.x.toFixed(0);
          const y = l.pxPerMeter ? (p.y / l.pxPerMeter).toFixed(2) : p.y.toFixed(0);
          for (const ap of p.aps) {
            rows.push([l.name, s.name, x, y, new Date(p.t).toISOString(), ap.ssid, ap.bssid,
              ap.rssi, ap.channel ?? '', ap.band]);
          }
        }
      }
    }
    return rows.map((r) => r.map((v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(',')).join('\r\n');
  }

  async function exportCsv() {
    if (!INVOKE) return;
    try {
      const path = await INVOKE('export_text_file', {
        content: '\ufeff' + buildCsv(),
        defaultName: `${Store.state.project.name}-samples`,
        filterName: 'CSV',
        ext: 'csv',
        openAfter: false,
      });
      setStatus(`CSV 已导出：${path}`);
    } catch (e) {
      setStatus('导出失败：' + e);
    }
  }

  // ------------------------------------------------------------ HTML 报告

  function esc2(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function renderSnapshotPng(level, snapshot, bssid) {
    const cv = document.createElement('canvas');
    const W = 1100;
    const H = Math.max(320, Math.round((W * level.plan.h) / level.plan.w));
    Heat.render(cv, {
      plan: level.plan,
      samples: snapshot.samples,
      bssid,
      opts: Store.state.opts,
      pxPerMeter: level.pxPerMeter,
      showPoints: true,
      valueLabels: true,
      apMarkers: Apmap.estimate(snapshot.samples, { pxPerMeter: level.pxPerMeter }),
      width: W,
      height: H,
      emptyText: '无平面图',
    });
    return cv.toDataURL('image/png');
  }

  function buildReportHtml() {
    const p = Store.state.project;
    const now = new Date();
    const bssids = Store.allBssids();
    const primary = Store.state.activeBssid || bssids[0]?.bssid || '';
    const css = `
      body{font:13px/1.6 "Segoe UI","Microsoft YaHei UI",sans-serif;color:#1a2230;margin:0;padding:34px 40px;background:#fff}
      h1{font-size:24px;margin:0 0 4px}
      h2{font-size:17px;margin:34px 0 10px;padding-bottom:6px;border-bottom:2px solid #dde4ee}
      h3{font-size:14px;margin:22px 0 8px;color:#3c4a5e}
      .meta{color:#6b7a90;font-size:12px;margin-bottom:18px}
      table{border-collapse:collapse;width:100%;margin:8px 0 16px;font-size:12px}
      th,td{border:1px solid #e2e8f1;padding:6px 9px;text-align:left}
      th{background:#f5f8fc;font-weight:600;color:#41506a}
      td.num{text-align:right;font-variant-numeric:tabular-nums}
      img{width:100%;border:1px solid #e2e8f1;border-radius:6px;display:block;margin:8px 0 4px}
      .cap{color:#6b7a90;font-size:11.5px;margin-bottom:14px}
      .pill{display:inline-block;background:#eef4ff;color:#2358a8;border-radius:999px;padding:1px 9px;font-size:11px;margin-right:6px}
      @media print{ body{padding:12mm} h2{page-break-before:always} }
    `;

    const levelSections = p.levels.map((l) => {
      const snaps = l.snapshots.map((s) => {
        const stat = Store.statsFor(s, primary);
        const area = Store.surveyedArea(s, l.pxPerMeter);
        const img = l.plan ? `<img src="${renderSnapshotPng(l, s, primary)}" alt="${esc2(s.name)}">
          <div class="cap">图：${esc2(l.name)} / ${esc2(s.name)}，${esc2(bssids.find((b) => b.bssid === primary)?.ssid || '最强信号')} 的热图</div>`
          : '<div class="cap">该楼层没有平面图</div>';
        const rows = bssids.map((b) => {
          const st2 = Store.statsFor(s, b.bssid);
          if (!st2.n) return '';
          return `<tr><td>${esc2(b.ssid || '<hidden>')}</td><td class="num">${b.channel ?? '—'}</td>
            <td class="num">${b.band}</td><td class="num">${st2.n}</td>
            <td class="num">${st2.avg}</td><td class="num">${st2.min}</td><td class="num">${st2.coverage}%</td></tr>`;
        }).join('');
        return `<h3>${esc2(s.name)} <span class="pill">${s.samples.length} 采样点</span>
            ${area != null ? `<span class="pill">${area.toFixed(1)} m²</span>` : ''}
            ${stat.n ? `<span class="pill">均值 ${stat.avg} dBm</span><span class="pill">达标 ${stat.coverage}%</span>` : ''}</h3>
          ${img}
          ${rows ? `<table><thead><tr><th>网络</th><th>信道</th><th>频段</th><th>采样</th><th>均值 dBm</th><th>最差 dBm</th><th>≥-67 占比</th></tr></thead><tbody>${rows}</tbody></table>` : ''}`;
      }).join('');

      return `<h2>${esc2(l.name)}</h2>
        <div class="cap">平面图 ${l.plan ? `${l.plan.w}×${l.plan.h} px` : '未载入'} · 比例尺 ${l.pxPerMeter ? l.pxPerMeter.toFixed(2) + ' px/m' : '未标定'} · ${l.snapshots.length} 个快照</div>
        ${snaps}`;
    }).join('');

    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
      <title>${esc2(p.name)} — 无线勘测报告</title><style>${css}</style></head><body>
      <h1>${esc2(p.name)} — 无线勘测报告</h1>
      <div class="meta">生成时间 ${now.toLocaleString()} · 楼层 ${p.levels.length} 个 · 快照 ${p.levels.reduce((n, l) => n + l.snapshots.length, 0)} 个 ·
      采样点 ${p.levels.reduce((n, l) => n + l.snapshots.reduce((m, s) => m + s.samples.length, 0), 0)} 个 · WiFi Survey</div>
      ${levelSections}
      <h2>说明</h2>
      <div class="cap">热图为反距离加权（IDW）插值，幂 ${Store.state.opts.power.toFixed(1)}、影响半径 ${Store.state.opts.radiusM} m；
      达标率指采样点中 RSSI ≥ -67 dBm 的比例；勘测面积为采样点凸包面积。<br>
      浏览器里按 Ctrl+P 可直接另存为 PDF。</div>
      </body></html>`;
  }

  async function exportReport() {
    if (!INVOKE) return;
    try {
      setStatus('正在生成报告…');
      const html = buildReportHtml();
      const path = await INVOKE('export_text_file', {
        content: html,
        defaultName: `${Store.state.project.name}-report`,
        filterName: 'HTML 报告',
        ext: 'html',
        openAfter: true,
      });
      setStatus(`报告已导出：${path}`);
      log('info', `report exported: ${path} ${Math.round(html.length / 1024)}KB`);
    } catch (e) {
      setStatus('导出失败：' + e);
      log('error', 'report failed: ' + e);
    }
  }

  function init() {
    // Survey 视图已移除，它侧栏里的「另存为 / 导出 CSV」跟着没了；按钮不在就跳过，别让整串绑定挂掉
    const on = (sel, fn) => $(sel)?.addEventListener('click', fn);
    on('#btn-save', save);
    on('#btn-save-as', saveAs);
    on('#btn-open', open);
    on('#btn-csv', exportCsv);
    on('#btn-report', exportReport);
    renderPath();
    Store.subscribe(renderPath);
  }

  return { init, save, open, exportCsv, exportReport, buildReportHtml, buildCsv };
})();
