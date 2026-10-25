// 平面图 + 热图渲染（IDW）。Survey / 对比 / 报告共用这一套。
// 栅格场（field）是与颜色无关的数值层：value=插值后的 dBm，sigma=1 表示该格有信号。
// 差分叠加就是两张 field 相减，所以插值必须能脱离画布坐标，在「图像坐标」里算。

const Heat = (() => {
  const CELL = 4;      // 画布坐标下的栅格步长（CSS px）
  const IMG_CELL = 4;  // 图像坐标下的栅格步长（平面图像素）

  /** 通用栅格插值。pts: [{cx, cy, rssi}]，坐标单位与 cell 一致。 */
  function computeField(gw, gh, cell, pts, radiusPx, power) {
    const sigma = new Float32Array(gw * gh);
    const value = new Float32Array(gw * gh);
    const r2 = radiusPx * radiusPx;
    const t0 = performance.now();

    for (let gy = 0; gy < gh; gy++) {
      const cy = (gy + 0.5) * cell;
      for (let gx = 0; gx < gw; gx++) {
        const cx = (gx + 0.5) * cell;
        let sw = 0;
        let sr = 0;
        let nearD2 = Infinity;
        let nearRssi = null;
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i];
          const dx = cx - p.cx;
          const dy = cy - p.cy;
          const d2 = dx * dx + dy * dy;
          if (d2 > r2) {
            if (d2 < nearD2) {
              nearD2 = d2;
              nearRssi = p.rssi;
            }
            continue;
          }
          const w = 1 / (Math.pow(d2, power / 2) + 1e-4);
          sw += w;
          sr += w * p.rssi;
        }
        const idx = gy * gw + gx;
        let rssi = null;
        if (sw > 0) rssi = sr / sw;
        else if (nearRssi !== null && nearD2 < r2 * 4) rssi = nearRssi;
        if (rssi === null) continue;
        sigma[idx] = 1;
        value[idx] = rssi;
      }
    }
    return { gw, gh, cell, sigma, value, ms: Math.round(performance.now() - t0), cells: gw * gh };
  }

  /** field → 离屏 canvas（按 rssi 色阶上色）。 */
  function paintField(field, colorOf) {
    const off = document.createElement('canvas');
    off.width = field.gw;
    off.height = field.gh;
    const octx = off.getContext('2d');
    const img = octx.createImageData(field.gw, field.gh);
    const buf = img.data;
    for (let i = 0; i < field.gw * field.gh; i++) {
      if (!field.sigma[i]) continue;
      const [r, g, b, a] = colorOf(field.value[i]);
      const idx = i * 4;
      buf[idx] = r;
      buf[idx + 1] = g;
      buf[idx + 2] = b;
      buf[idx + 3] = a == null ? 255 : a;
    }
    octx.putImageData(img, 0, 0);
    return off;
  }

  function computeHeatCanvas(gw, gh, pts, radiusPx, power) {
    const field = computeField(gw, gh, CELL, pts, radiusPx, power);
    const canvas = paintField(field, (v) => rssiRgb(v));
    return { canvas, ms: field.ms, cells: field.cells };
  }

  /** 在「平面图像素坐标」里算插值场，供差分、跨楼层对齐使用。 */
  function imageField(plan, samples, bssid, opts, pxPerMeter) {
    if (!plan) return null;
    const gw = Math.max(1, Math.ceil(plan.w / IMG_CELL));
    const gh = Math.max(1, Math.ceil(plan.h / IMG_CELL));
    const pts = [];
    for (const s of samples ?? []) {
      const ap = bssid ? s.aps.find((a) => a.bssid === bssid) : s.best;
      if (!ap) continue;
      pts.push({ cx: s.x, cy: s.y, rssi: ap.rssi });
    }
    const radius = (opts?.radiusM ?? 8) * (pxPerMeter || 40);
    const field = computeField(gw, gh, IMG_CELL, pts, radius, opts?.power ?? 2.2);
    return { ...field, imgW: plan.w, imgH: plan.h, pts: pts.length };
  }

  /** 把一张场重采样到另一套栅格（不同尺寸平面图时按比例对齐）。 */
  function resample(field, gw, gh) {
    const out = {
      gw, gh, cell: field.cell, ms: 0, cells: gw * gh,
      sigma: new Float32Array(gw * gh),
      value: new Float32Array(gw * gh),
    };
    for (let gy = 0; gy < gh; gy++) {
      const sy = Math.min(field.gh - 1, Math.floor(((gy + 0.5) / gh) * field.gh));
      for (let gx = 0; gx < gw; gx++) {
        const sx = Math.min(field.gw - 1, Math.floor(((gx + 0.5) / gw) * field.gw));
        const si = sy * field.gw + sx;
        const di = gy * gw + gx;
        out.sigma[di] = field.sigma[si];
        out.value[di] = field.value[si];
      }
    }
    return out;
  }

  /** 差分上色：改善（B 比 A 强）走绿，恶化走红，±1 dB 内几乎透明。 */
  function diffRgba(delta) {
    const a = Math.abs(delta);
    if (a < 1) return [120, 140, 165, 0];
    const k = Math.min(1, (a - 1) / 11);
    const alpha = Math.round(40 + 190 * k);
    if (delta > 0) return [74, 222, 128, alpha];
    return [248, 113, 113, alpha];
  }

  function canvasFor(cv, optW, optH) {
    if (optW && optH) {
      if (cv.width !== optW || cv.height !== optH) {
        cv.width = optW;
        cv.height = optH;
      }
      const ctx = cv.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, optW, optH);
      return { ctx, w: optW, h: optH };
    }
    return fitCanvas(cv);
  }

  /**
   * @param cv 目标 canvas
   * @param opt {
   *   plan: {img, w, h} | null, samples, bssid, opts:{power,radiusM,alpha},
   *   pxPerMeter, showPoints, width, height, emptyText
   * }
   * @returns 几何信息 {type:'fit', scale, ox, oy, w, h, heat}
   */
  function render(cv, opt) {
    const fitted = canvasFor(cv, opt.width, opt.height);
    if (!fitted) return null;
    const { ctx, w, h } = fitted;
    const plan = opt.plan;
    const info = { w, h, plan, heat: null };

    if (!plan || !plan.img) {
      ctx.fillStyle = '#4b5566';
      ctx.font = '13px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(opt.emptyText || '没有平面图', w / 2, h / 2);
      return info;
    }

    const fitScale = Math.min(w / plan.w, h / plan.h);
    const fitOx = (w - plan.w * fitScale) / 2;
    const fitOy = (h - plan.h * fitScale) / 2;
    // 传了 view 就用它（缩放平移），否则适应窗口
    const scale = opt.view?.scale ?? fitScale;
    const ox = opt.view?.ox ?? fitOx;
    const oy = opt.view?.oy ?? fitOy;
    info.scale = scale;
    info.ox = ox;
    info.oy = oy;
    info.fitScale = fitScale;
    info.fitOx = fitOx;
    info.fitOy = fitOy;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(plan.img, ox, oy, plan.w * scale, plan.h * scale);

    const toC = (ix, iy) => ({ cx: ix * scale + ox, cy: iy * scale + oy });
    const pts = [];
    const samples = opt.samples ?? [];
    for (const s of samples) {
      const ap = opt.bssid ? s.aps.find((a) => a.bssid === opt.bssid) : s.best;
      if (!ap) continue;
      const c = toC(s.x, s.y);
      pts.push({ ...c, rssi: ap.rssi, sample: s, ap });
    }

    // 热图
    if (pts.length >= 2) {
      const base = opt.pxPerMeter ? opt.pxPerMeter * scale : 40 * scale;
      const radiusPx = (opt.opts?.radiusM ?? 8) * base;
      const gridW = Math.max(1, Math.ceil(w / CELL));
      const gridH = Math.max(1, Math.ceil(h / CELL));
      const heat = computeHeatCanvas(gridW, gridH, pts, radiusPx, opt.opts?.power ?? 2.2);
      ctx.save();
      ctx.globalAlpha = opt.opts?.alpha ?? 0.62;
      ctx.drawImage(heat.canvas, 0, 0, w, h);
      ctx.restore();
      info.heat = { ms: heat.ms, cells: heat.cells };
    }

    // 采样点
    if (opt.showPoints !== false) {
      for (const p of pts) {
        ctx.beginPath();
        ctx.arc(p.cx, p.cy, 5.5, 0, Math.PI * 2);
        ctx.fillStyle = hexAlpha(rssiColor(p.rssi), 0.92);
        ctx.fill();
        ctx.lineWidth = 1.4;
        ctx.strokeStyle = 'rgba(6,12,20,.85)';
        ctx.stroke();
        if (opt.valueLabels) {
          ctx.fillStyle = '#eef3fa';
          ctx.font = '10px Consolas, monospace';
          ctx.textAlign = 'center';
          ctx.fillText(String(p.rssi), p.cx, p.cy + 19);
        }
      }
    }

    // AP 位置标注（图像坐标 → 画布坐标）
    if (opt.apMarkers?.length) {
      info.apHits = drawApMarkers(ctx, opt.apMarkers, info, w, h, opt.pxPerMeter);
    }

    // 比例尺
    if (opt.pxPerMeter) {
      const meters = niceMeters(90 / (opt.pxPerMeter * scale));
      const px = meters * opt.pxPerMeter * scale;
      const x0 = w - px - 18;
      const y0 = h - 20;
      ctx.strokeStyle = 'rgba(226,234,246,.9)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x0 + px, y0);
      ctx.moveTo(x0, y0 - 5);
      ctx.lineTo(x0, y0 + 5);
      ctx.moveTo(x0 + px, y0 - 5);
      ctx.lineTo(x0 + px, y0 + 5);
      ctx.stroke();
      ctx.fillStyle = 'rgba(226,234,246,.9)';
      ctx.font = '11px Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`${meters} m`, x0 + px / 2, y0 - 9);
    }

    return info;
  }

  /**
   * 差分叠加：B 的信号场减去 A，绿=改善、红=恶化。
   * 两张平面图尺寸不同时按比例重采样，并在返回值里标出来。
   */
  function renderDiff(cv, opt) {
    const fitted = canvasFor(cv);
    if (!fitted) return null;
    const { ctx, w, h } = fitted;
    const plan = opt.planA?.img ? opt.planA : opt.planB;
    const stat = {
      cells: 0, improved: 0, worse: 0, flat: 0, meanDelta: null,
      maxUp: null, maxDown: null, resampled: false, ms: 0,
    };

    if (!plan || !plan.img) {
      ctx.fillStyle = '#4b5566';
      ctx.font = '13px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('差分需要至少一层有平面图', w / 2, h / 2);
      return stat;
    }

    const scale = Math.min(w / plan.w, h / plan.h);
    const ox = (w - plan.w * scale) / 2;
    const oy = (h - plan.h * scale) / 2;
    const t0 = performance.now();

    // 底图压暗，突出差分色块
    ctx.save();
    ctx.globalAlpha = 0.3;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(plan.img, ox, oy, plan.w * scale, plan.h * scale);
    ctx.restore();

    const fa = imageField(opt.planA, opt.samplesA, opt.bssid, opt.opts, opt.pxA);
    const fb0 = imageField(opt.planB, opt.samplesB, opt.bssid, opt.opts, opt.pxB);
    if (!fa || !fb0) return stat;
    const fb = fa.gw === fb0.gw && fa.gh === fb0.gh ? fb0 : resample(fb0, fa.gw, fa.gh);
    stat.resampled = fb !== fb0;

    const off = document.createElement('canvas');
    off.width = fa.gw;
    off.height = fa.gh;
    const octx = off.getContext('2d');
    const img = octx.createImageData(fa.gw, fa.gh);
    const buf = img.data;
    let sum = 0;
    for (let i = 0; i < fa.gw * fa.gh; i++) {
      if (!fa.sigma[i] || !fb.sigma[i]) continue;
      const d = fb.value[i] - fa.value[i];
      stat.cells++;
      sum += d;
      if (d >= 1) stat.improved++;
      else if (d <= -1) stat.worse++;
      else stat.flat++;
      if (stat.maxUp === null || d > stat.maxUp.d) stat.maxUp = { d, i };
      if (stat.maxDown === null || d < stat.maxDown.d) stat.maxDown = { d, i };
      const [r, g, b, a] = diffRgba(d);
      if (!a) continue;
      const idx = i * 4;
      buf[idx] = r;
      buf[idx + 1] = g;
      buf[idx + 2] = b;
      buf[idx + 3] = a;
    }
    octx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, ox, oy, plan.w * scale, plan.h * scale);

    // 采样点（只画 B，位置给参照）
    for (const s of opt.samplesB ?? []) {
      const cx = s.x * scale + ox;
      const cy = s.y * scale + oy;
      ctx.beginPath();
      ctx.arc(cx, cy, 3.2, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(226,234,246,.75)';
      ctx.fill();
    }

    stat.meanDelta = stat.cells ? sum / stat.cells : null;
    stat.ms = Math.round(performance.now() - t0);
    return stat;
  }

  /**
   * 在画布上画 AP 位置：圆点 + 名称药丸。标签按右/左/下/上依次尝试，都被占了就不画标签
   * （图标仍在），避免密集环境里叠字。
   * @returns [{bssid, cx, cy, r, ap}] 命中区，供点击开详情用
   */
  function drawApMarkers(ctx, list, view, w, h, pxPerMeter) {
    const { scale, ox, oy } = view;
    const hits = [];
    const boxes = [];
    const pxPerM = (pxPerMeter || 0) * scale;

    for (const ap of list) {
      const cx = ap.x * scale + ox;
      const cy = ap.y * scale + oy;
      if (cx < -14 || cy < -14 || cx > w + 14 || cy > h + 14) continue;
      const color = rssiColor(ap.rssi);

      // 不确定范围
      const spread = ap.spreadM && pxPerM ? ap.spreadM * pxPerM : ap.spreadPx || 0;
      if (spread > 9) {
        ctx.beginPath();
        ctx.arc(cx, cy, Math.min(140, spread), 0, Math.PI * 2);
        ctx.fillStyle = hexAlpha(color, 0.1);
        ctx.fill();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = hexAlpha(color, 0.5);
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // 图标
      ctx.beginPath();
      ctx.arc(cx, cy, 9, 0, Math.PI * 2);
      ctx.fillStyle = hexAlpha(color, 0.95);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(6,12,20,.9)';
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, 3.2, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(8,14,24,.95)';
      ctx.fill();

      hits.push({ bssid: ap.bssid, cx, cy, r: 12, ap, labeled: false });

      // 名称药丸 + 避让
      const label = `${truncate(ap.ssid || '<隐藏>', 16)}  ${ap.rssi}`;
      ctx.font = '600 10.5px "Segoe UI", "Microsoft YaHei UI", sans-serif';
      const tw = ctx.measureText(label).width;
      const padX = 5;
      const bh = 16;
      const bw = tw + padX * 2;
      const cand = [
        { x: cx + 14, y: cy - bh / 2 },
        { x: cx - 14 - bw, y: cy - bh / 2 },
        { x: cx - bw / 2, y: cy + 14 },
        { x: cx - bw / 2, y: cy - 14 - bh },
      ];
      let box = null;
      for (const c of cand) {
        const r = { x0: c.x - 3, y0: c.y - 2, x1: c.x + bw + 3, y1: c.y + bh + 2 };
        if (r.x0 < 2 || r.y0 < 2 || r.x1 > w - 2 || r.y1 > h - 2) continue;
        if (boxes.some((b) => !(r.x1 < b.x0 || r.x0 > b.x1 || r.y1 < b.y0 || r.y0 > b.y1))) continue;
        box = { x: c.x, y: c.y, ...r };
        break;
      }
      if (!box) continue;
      boxes.push(box);
      hits[hits.length - 1].labeled = true;

      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(box.x, box.y, bw, bh, 4);
      else ctx.rect(box.x, box.y, bw, bh);
      ctx.fillStyle = 'rgba(9,15,26,.86)';
      ctx.fill();
      ctx.strokeStyle = hexAlpha(color, 0.8);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#eaf1fb';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, box.x + padX, box.y + bh / 2 + 0.5);
    }

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    return hits;
  }

  function niceMeters(raw) {
    const cand = [0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100];
    return cand.reduce((best, c) => (Math.abs(c - raw) < Math.abs(best - raw) ? c : best), cand[0]);
  }

  return { render, renderDiff, drawApMarkers, computeHeatCanvas, computeField, imageField, resample, diffRgba, CELL, IMG_CELL };
})();
