// 信道重叠与干扰分析。
// 模型：把每个 AP 的 dBm 换成线性功率 mW，按频谱重叠比例把干扰功率累加到被干扰方，
// 再算载干比 CIR = 10log10(P_self / I_other)。同频重叠 ≥80% 记同频，其余记邻频。

const Channels = (() => {
  const POWER_AT_1M = -40; // 1 m 处参考功率（dBm）
  const PATH_LOSS_N = 2.7; // 室内路径损耗指数
  const CO_CHANNEL_RATIO = 0.8;

  const BAND_SPEC = {
    '2.4 GHz': { min: 2392, max: 2484, chans: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13] },
    '5 GHz': {
      min: 5150, max: 5850,
      chans: [36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128,
        132, 136, 140, 144, 149, 153, 157, 161, 165],
      dfs: [52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 144],
    },
    '6 GHz': {
      min: 5945, max: 7125,
      chans: [1, 5, 9, 13, 17, 21, 25, 29, 33, 37, 41, 45, 49, 53, 57, 61, 65, 69, 73, 77,
        81, 85, 89, 93, 97, 101, 105, 109, 113, 117, 121, 125, 129, 133, 137, 141, 145, 149,
        153, 157, 161, 165, 169, 173, 177, 181, 185, 189, 193, 197, 201, 205, 209, 213, 217, 221, 225, 229],
      psc: [5, 21, 37, 53, 69, 85, 101, 117, 133, 149, 165, 181, 197, 213, 229],
    },
  };

  // ------------------------------------------------------------ 基础换算

  function freqOf(band, ch) {
    if (!ch) return null;
    if (band === '2.4 GHz') return ch === 14 ? 2484 : 2407 + 5 * ch;
    if (band === '5 GHz') return 5000 + 5 * ch;
    return 5950 + 5 * ch;
  }

  function spanOf(ap) {
    const f = ap.freq_mhz || freqOf(ap.band, ap.channel) || 0;
    const w = ap.width_mhz || 20;
    return { f, w, lo: f - w / 2, hi: f + w / 2 };
  }

  /** 两个 AP 的频谱重叠比例（0..1，相对较窄一方带宽）。 */
  function overlapRatio(a, b) {
    const sa = spanOf(a);
    const sb = spanOf(b);
    if (!sa.f || !sb.f) return 0;
    const ov = Math.min(sa.hi, sb.hi) - Math.max(sa.lo, sb.lo);
    if (ov <= 0) return 0;
    return Math.min(1, ov / Math.min(sa.w, sb.w));
  }

  const mw = (rssi) => Math.pow(10, rssi / 10);
  const toDbm = (p) => (p > 0 ? Math.round(10 * Math.log10(p)) : null);

  /** 对数距离路径损耗反推距离（米）。 */
  function distanceOf(rssi) {
    if (rssi == null) return null;
    return Math.pow(10, (POWER_AT_1M - rssi) / (10 * PATH_LOSS_N));
  }

  // ------------------------------------------------------------ 单 AP 干扰画像

  function profile(aps, target) {
    const self = mw(target.rssi);
    let iSame = 0;
    let iAdj = 0;
    const sources = [];
    for (const other of aps) {
      if (other.bssid === target.bssid || other.band !== target.band) continue;
      const r = overlapRatio(target, other);
      if (r <= 0) continue;
      const p = mw(other.rssi) * r;
      const co = r >= CO_CHANNEL_RATIO;
      if (co) iSame += p;
      else iAdj += p;
      sources.push({ ap: other, ratio: r, co, dbm: toDbm(p) });
    }
    sources.sort((a, b) => (b.dbm ?? -999) - (a.dbm ?? -999));
    const total = iSame + iAdj;
    const cir = total > 0 ? Math.round(10 * Math.log10(self / total) * 10) / 10 : null;
    return {
      same: sources.filter((s) => s.co),
      adj: sources.filter((s) => !s.co),
      interference: toDbm(total),
      sameDbm: toDbm(iSame),
      adjDbm: toDbm(iAdj),
      cir,
      distance: distanceOf(target.rssi),
    };
  }

  // ------------------------------------------------------------ 整段频谱

  function analyze(aps) {
    const rows = aps
      .filter((a) => a.rssi != null)
      .map((ap) => ({ ap, ...profile(aps, ap) }))
      .sort((a, b) => (a.ap.band.localeCompare(b.ap.band)) || (a.ap.freq_mhz || 0) - (b.ap.freq_mhz || 0));

    const bands = [];
    for (const band of ['2.4 GHz', '5 GHz', '6 GHz']) {
      const spec = BAND_SPEC[band];
      const list = aps.filter((a) => a.band === band && a.rssi != null);
      const scored = spec.chans.map((ch) => {
        const center = freqOf(band, ch);
        const lo = center - 10;
        const hi = center + 10;
        let p = 0;
        let count = 0;
        let strongest = -999;
        for (const a of list) {
          const s = spanOf(a);
          const ov = Math.min(hi, s.hi) - Math.max(lo, s.lo);
          if (ov <= 0) continue;
          count++;
          p += mw(a.rssi) * (ov / 20);
          strongest = Math.max(strongest, a.rssi);
        }
        return { ch, center, count, strongest, power: p, dfs: (spec.dfs || []).includes(ch) };
      });
      const worst = scored.reduce((m, s) => Math.max(m, s.power), 0);
      for (const s of scored) {
        s.score = worst > 0 ? Math.max(0, Math.round(100 * (1 - s.power / worst))) : 100;
        s.ifDbm = toDbm(s.power);
      }
      const ranked = [...scored].sort((a, b) => a.power - b.power || a.ch - b.ch);
      const clean = ranked.filter((s) => !s.dfs);
      bands.push({
        band,
        spec,
        aps: list,
        scored,
        best: (clean.length ? clean : ranked)[0] || null,
        psc: spec.psc || null,
      });
    }

    return { rows, bands };
  }

  // ------------------------------------------------------------ 渲染

  function scoreClass(score) {
    if (score >= 80) return 'ok';
    if (score >= 45) return 'warn';
    return 'bad';
  }

  // 当前高亮的信道：鼠标悬在评分标签上，或悬在频谱图里某个信道的位置
  let hover = null; // { band, ch }
  let lastBands = []; // 上一次 render 的 analyze 结果，重画单个频段时用

  /** 一个 AP 算不算「在这个信道上」：和打分同一口径——频谱跟信道中心 ±10 MHz 有重叠 */
  function onChannel(ap, band, ch) {
    const center = freqOf(band, ch);
    if (!center) return false;
    const s = spanOf(ap);
    return Math.min(center + 10, s.hi) - Math.max(center - 10, s.lo) > 0;
  }

  /**
   * 悬停某个信道时一个 AP 的高亮等级：
   *   2 = 主信道就是这个信道（蓝）
   *   1 = 主信道不是它，但频谱重叠、会干扰这个信道（琥珀）
   *   0 = 无关（压暗）
   * 2.4 GHz 信道间隔只有 5 MHz，一个 20 MHz 的 AP 实际压着相邻 ±4 个信道，
   * 只按重叠判定会让「悬停 ch3」把 ch1 上的 AP 全点亮，所以要把「在这个信道上」和「会干扰这个信道」分开。
   */
  function hlLevel(ap, band, ch) {
    if (ap.band !== band) return 0;
    if (ap.channel === ch) return 2;
    return onChannel(ap, band, ch) ? 1 : 0;
  }

  const HL_PRIMARY = () => Theme.c('hl'); // 和悬停竖带 / 评分标签同一个蓝；跟主题走所以是函数
  const HL_OVERLAP = '#fbbf24';

  function drawSpectrum(cv, bandInfo) {
    const { spec } = bandInfo;
    const hl = hover && hover.band === bandInfo.band ? hover.ch : null;
    cv._bandInfo = bandInfo;
    // 同频 AP 太多时行高会撑不住，只画最强的 8 个（完整清单在下表）
    const all = bandInfo.aps;
    const MAX_ROWS = 8;
    const aps = [...all].sort((a, b) => b.rssi - a.rssi).slice(0, MAX_ROWS);
    const hidden = all.length - aps.length;
    let labeled = 0;
    cv.style.height = `${aps.length ? Math.max(84, Math.min(132, 26 + aps.length * 13)) : 54}px`;
    const fitted = fitCanvas(cv);
    if (!fitted) return;
    const { ctx, w, h } = fitted;
    const padL = 8, padR = 8, padT = 6, padB = 18;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;
    const baseline = padT + plotH;
    const xOf = (f) => padL + ((f - spec.min) / (spec.max - spec.min)) * plotW;

    // 高亮信道：先铺一条浅色竖带（信道中心 ±10 MHz），再画刻度
    cv._geom = { xOf, padL, padR, padT, baseline, w, h, plotW };
    if (hl != null) {
      const c = freqOf(bandInfo.band, hl);
      ctx.fillStyle = Theme.c('hl-band');
      ctx.fillRect(xOf(c - 10), padT - 2, xOf(c + 10) - xOf(c - 10), baseline - padT + 2);
    }

    // 底：候选信道的浅色刻度
    ctx.strokeStyle = Theme.c('grid');
    ctx.lineWidth = 1;
    ctx.fillStyle = Theme.c('axis');
    ctx.font = '9px Consolas, monospace';
    ctx.textAlign = 'center';
    const labelEvery = spec.chans.length > 26 ? 6 : 2;
    spec.chans.forEach((ch, i) => {
      const x = xOf(freqOf(bandInfo.band, ch));
      ctx.strokeStyle = ch === hl ? Theme.c('hl') : Theme.c('grid');
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, baseline);
      ctx.stroke();
      if (i % labelEvery === 0 || ch === hl) {
        ctx.fillStyle = ch === hl ? Theme.c('hl-text') : Theme.c('axis');
        ctx.font = ch === hl ? 'bold 9px Consolas, monospace' : '9px Consolas, monospace';
        ctx.fillText(String(ch), x, h - 5);
      }
    });
    ctx.font = '9px Consolas, monospace';

    if (!aps.length) {
      cv._hl = null;
      ctx.fillStyle = Theme.c('dim');
      ctx.font = '12px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(t('ch.noap'), padL + plotW / 2, padT + plotH / 2);
      return;
    }

    // 每个 AP 一行，块宽 = 信道带宽，颜色 = 信号强度
    const rowH = Math.max(11, Math.min(22, plotH / Math.max(1, aps.length)));
    const ordered = [...aps].sort((a, b) => (a.freq_mhz || 0) - (b.freq_mhz || 0) || b.rssi - a.rssi);
    const jobs = [];
    ordered.forEach((ap, i) => {
      const s = spanOf(ap);
      const x0 = xOf(s.lo);
      const x1 = xOf(s.hi);
      const y = padT + i * rowH;
      const bh = Math.max(5, rowH - 3);
      const color = rssiColor(ap.rssi);
      // 高亮态：主信道命中的条变蓝 + 亮边，只是频谱重叠的变琥珀，其余保留信号色但压暗
      const level = hl == null ? -1 : hlLevel(ap, bandInfo.band, hl);
      const hit = level === 2;
      const dim = level === 0;
      const fillHex = level === 2 ? HL_PRIMARY() : level === 1 ? HL_OVERLAP : color;
      const fillA = level === 2 ? 0.92 : level === 1 ? 0.85 : dim ? 0.18 : 0.75;
      ctx.fillStyle = hexAlpha(fillHex, fillA);
      ctx.beginPath();
      const r = Math.min(3, bh / 2);
      ctx.roundRect ? ctx.roundRect(x0, y, Math.max(3, x1 - x0), bh, r) : ctx.rect(x0, y, Math.max(3, x1 - x0), bh);
      ctx.fill();
      ctx.strokeStyle = level === 2 ? Theme.c('hl-stroke') : level === 1 ? HL_OVERLAP : hexAlpha(color, dim ? 0.3 : 0.95);
      ctx.lineWidth = hit ? 1.5 : 1;
      ctx.stroke();
      jobs.push({ x0, x1, y, bh, color, ap, hit, dim, level, fillHex, fillA });
    });

    // 第二遍才写标签：块够宽写在块里（字色按块色算），不够宽贴到块外并垫一块深色底衬。
    // 之前边画边写，窄块回退成「块内深色字」，而字其实落在块外的深色背景上——等于隐形。
    const chipBg = (x, cy, tw, fs) => {
      ctx.fillStyle = Theme.c('chip-bg');
      const hh = fs + 4;
      if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(x - 3, cy - hh / 2, tw + 6, hh, 3);
        ctx.fill();
      } else {
        ctx.fillRect(x - 3, cy - hh / 2, tw + 6, hh);
      }
    };

    jobs.forEach(({ x0, x1, y, bh, ap, dim, fillHex, fillA }) => {
      const label = `${truncate(ap.ssid || t('ch.hidden'), 14)} · ch${ap.channel ?? '?'} · ${ap.rssi}`;
      ctx.globalAlpha = dim ? 0.35 : 1;
      const fs = rowH >= 14 ? 10 : 9;
      ctx.font = `${fs}px "Segoe UI", "Microsoft YaHei UI", sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const ty = y + bh / 2;
      const bw = Math.max(3, x1 - x0);
      const fullW = ctx.measureText(label).width;
      const roomIn = bw - 10;
      const roomRight = w - padR - 4 - (x1 + 6);
      const roomLeft = x0 - 6 - padL;
      // 优先级：完整文字写在块内 > 完整文字贴块外（带底衬） > 截断后写在块内 > 截断贴块外
      let text = label;
      let inside = fullW <= roomIn;
      let outsideRoom = Math.max(roomRight, roomLeft);
      if (!inside && fullW <= outsideRoom) {
        inside = false;
      } else if (!inside) {
        // 完整文字哪里都放不下：能用块内就块内截断，否则贴块外截断
        const inRoom = Math.max(roomIn, outsideRoom);
        inside = roomIn >= outsideRoom;
        while (text.length > 4 && ctx.measureText(text).width > inRoom) text = text.slice(0, -1);
      }
      if (text !== label) text = text + '…';
      const tw = ctx.measureText(text).width;
      if (inside) {
        ctx.fillStyle = inkOn(fillHex, fillA);
        ctx.fillText(text, x0 + 5, ty);
      } else {
        let lx = x1 + 6;
        if (lx + tw > w - padR - 2) lx = x0 - 6 - tw;
        if (lx < padL || lx + tw > w - padR - 2) lx = Math.max(padL, Math.min(x1 + 6, w - padR - 3 - tw));
        chipBg(lx, ty, tw, fs);
        ctx.fillStyle = Theme.c('chip-text');
        ctx.fillText(text, lx, ty);
      }
      labeled++;
      ctx.textBaseline = 'alphabetic';
      ctx.globalAlpha = 1;
    });

    cv._labelStats = { bars: aps.length, labeled };
    cv._hl =
      hl == null
        ? null
        : {
            ch: hl,
            hits: jobs.filter((j) => j.level === 2).map((j) => j.ap.bssid),
            overlaps: jobs.filter((j) => j.level === 1).map((j) => j.ap.bssid),
          };

    // 高亮时在右上角写一行「chN · k 个 AP · m 个重叠 · 干扰 x dBm」
    if (hl != null) {
      const n = all.filter((a) => hlLevel(a, bandInfo.band, hl) === 2).length;
      const ov = all.filter((a) => hlLevel(a, bandInfo.band, hl) === 1).length;
      const sc = bandInfo.scored.find((s) => s.ch === hl);
      const txt = t('ch.hover', { ch: hl, n, ov, if: sc?.ifDbm ?? t('ch.none') });
      ctx.font = '10px "Segoe UI", "Microsoft YaHei UI", sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'alphabetic';
      const tw = ctx.measureText(txt).width;
      chipBg(w - padR - 2 - tw, padT + 7, tw, 10);
      ctx.fillStyle = Theme.c('hl-text');
      ctx.fillText(txt, w - padR - 2, padT + 11);
    }

    if (hidden > 0) {
      ctx.fillStyle = Theme.c('note');
      ctx.font = '10px "Segoe UI", "Microsoft YaHei UI", sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(t('ch.more', { n: hidden }), w - padR - 2, h - 4);
    }
  }

  const bandId = (band) => band.replace(/[^0-9a-z]/gi, '');

  /** 设置 / 清除高亮：只重画受影响的频段，并同步评分标签与表格行的高亮类 */
  function highlight(band, ch) {
    const next = band && ch != null ? { band, ch } : null;
    if ((hover?.band ?? null) === (next?.band ?? null) && (hover?.ch ?? null) === (next?.ch ?? null)) return;
    const prevBand = hover?.band;
    hover = next;
    for (const b of lastBands) {
      if (b.band !== prevBand && b.band !== next?.band) continue;
      const cv = document.querySelector(`#ch-spec-${bandId(b.band)}`);
      if (cv) drawSpectrum(cv, b);
    }
    document.querySelectorAll('.ch-chip.hl').forEach((el) => el.classList.remove('hl'));
    document.querySelectorAll('#ch-table tbody tr.hl, #ch-table tbody tr.hl2').forEach((el) => el.classList.remove('hl', 'hl2'));
    if (!next) return;
    document.querySelector(`#ch-score-${bandId(next.band)} .ch-chip[data-ch="${next.ch}"]`)?.classList.add('hl');
    markRows(document.querySelectorAll('#ch-table tbody tr'), Inspector.aps(), next);
  }

  /** 表格行跟频谱同一套等级：主信道行 .hl（蓝），重叠行 .hl2（琥珀） */
  function markRows(trs, aps, hv) {
    const level = new Map(aps.map((a) => [a.bssid, hlLevel(a, hv.band, hv.ch)]));
    trs.forEach((tr) => {
      const l = level.get(tr.dataset.bssid) ?? 0;
      tr.classList.toggle('hl', l === 2);
      tr.classList.toggle('hl2', l === 1);
    });
  }

  /** 频谱图上鼠标位置对应的信道：取中心频率最近、且在 ±10 MHz 内的候选信道 */
  function channelAt(cv, ev) {
    const g = cv._geom;
    const b = cv._bandInfo;
    if (!g || !b) return null;
    const rect = cv.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    if (x < g.padL || x > g.w - g.padR) return null;
    const freq = b.spec.min + ((x - g.padL) / g.plotW) * (b.spec.max - b.spec.min);
    let best = null;
    for (const ch of b.spec.chans) {
      const d = Math.abs(freqOf(b.band, ch) - freq);
      if (d <= 10 && (!best || d < best.d)) best = { ch, d };
    }
    return best ? best.ch : null;
  }

  function bindHover(cv, band) {
    if (cv._hoverBound) return;
    cv._hoverBound = true;
    cv.addEventListener('mousemove', (ev) => highlight(band, channelAt(cv, ev)));
    cv.addEventListener('mouseleave', () => highlight(null));
  }

  function render() {
    const aps = Inspector.aps();
    const { rows, bands } = analyze(aps);
    lastBands = bands;

    // 频段：频谱 + 信道评分
    for (const b of bands) {
      const cv = document.querySelector(`#ch-spec-${bandId(b.band)}`);
      if (cv) {
        drawSpectrum(cv, b);
        bindHover(cv, b.band);
      }
      const host = document.querySelector(`#ch-score-${bandId(b.band)}`);
      if (!host) continue;
      const top = [...b.scored].sort((a, c) => c.score - a.score || a.ch - c.ch).slice(0, 12);
      host.innerHTML = top
        .map(
          (s) => `<span class="ch-chip ${scoreClass(s.score)}${hover?.band === b.band && hover.ch === s.ch ? ' hl' : ''}" data-ch="${s.ch}" title="${t('ch.chip', { ch: s.ch, n: s.count, if: s.ifDbm ?? '—' })}">
            <b>${s.ch}</b><em>${s.score}</em></span>`
        )
        .join('') +
        (b.best
          ? `<span class="ch-best">${t(b.best.dfs ? 'ch.best.dfs' : 'ch.best', { ch: b.best.ch })} · ${b.best.ifDbm != null ? t('ch.ifdbm', { v: b.best.ifDbm }) : t('ch.ifnone')}</span>`
          : `<span class="ch-best">${t('ch.best.none')}</span>`);
      host.querySelectorAll('.ch-chip[data-ch]').forEach((chip) => {
        chip.addEventListener('mouseenter', () => highlight(b.band, Number(chip.dataset.ch)));
        chip.addEventListener('mouseleave', () => highlight(null));
      });
    }

    // 表格
    const tbody = document.querySelector('#ch-table tbody');
    if (tbody) {
      tbody.innerHTML = rows
        .map((r) => {
          const a = r.ap;
          const cirText = r.cir === null ? '∞' : `${r.cir}`;
          const cirCls = r.cir === null ? 'rssi-strong' : r.cir >= 25 ? 'rssi-strong' : r.cir >= 12 ? 'rssi-ok' : r.cir >= 5 ? 'rssi-weak' : 'rssi-bad';
          const top = r.same.concat(r.adj).slice(0, 2);
          const srcText = top.length
            ? top.map((s) => `${truncate(s.ap.ssid || t('ch.hidden'), 10)}${s.co ? '' : ` (${t('ch.th.adj')})`}`).join(', ')
            : '—';
          return `<tr data-bssid="${a.bssid}">
            <td>${esc(a.ssid || t('ch.hidden'))}</td>
            <td class="mono">${a.bssid}</td>
            <td>${a.band}</td>
            <td class="num">${a.channel ?? '—'}</td>
            <td class="num">${a.width_mhz}</td>
            <td class="num ${rssiClass(a.rssi)}">${a.rssi}</td>
            <td class="num">${r.same.length}</td>
            <td class="num">${r.adj.length}</td>
            <td class="num">${r.sameDbm ?? '—'}</td>
            <td class="num">${r.adjDbm ?? '—'}</td>
            <td class="num ${cirCls}">${cirText}</td>
            <td class="num">${r.distance ? r.distance.toFixed(1) + ' m' : '—'}</td>
            <td class="hint">${esc(srcText)}</td>
          </tr>`;
        })
        .join('');
      if (hover) markRows(tbody.querySelectorAll('tr'), aps, hover);
      tbody.querySelectorAll('tr').forEach((tr) => {
        tr.addEventListener('click', () => {
          const ap = Inspector.aps().find((a) => a.bssid === tr.dataset.bssid);
          if (ap) Detail.show(ap);
        });
      });
    }

    const summary = document.querySelector('#ch-summary');
    if (summary) {
      const co = rows.reduce((n, r) => n + r.same.length, 0) / 2;
      const adj = rows.reduce((n, r) => n + r.adj.length, 0) / 2;
      const bad = rows.filter((r) => r.cir !== null && r.cir < 12).length;
      const best = bands.filter((b) => b.best).map((b) => `${b.band} → ch${b.best.ch}`);
      summary.textContent = t('ch.summary', {
        n: rows.length,
        co: Math.round(co),
        adj: Math.round(adj),
        bad,
      }) + (best.length ? ` · ${best.join(langSep())}` : '');
    }
  }

  function langSep() {
    return I18n.get() === 'zh' ? '，' : ', ';
  }

  function init() {
    document.querySelector('#ch-refresh')?.addEventListener('click', render);
    window.addEventListener('resize', () => {
      if (document.body.dataset.view === 'channels') render();
    });
  }

  function activate() {
    render();
  }

  return { init, activate, render, analyze, profile, distanceOf, freqOf, spanOf, overlapRatio, highlight, onChannel, hlLevel, hover: () => hover };
})();
