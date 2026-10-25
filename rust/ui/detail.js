// AP 详情抽屉：Inspector 表格 / 弧形图 / 信道表点一行，右侧滑出这一个 AP 的全貌。

const Detail = (() => {
  // 只放常见厂商前缀，够用来判断"这是不是邻居家的运营商光猫"
  const OUI = {
    '00:1D:0F': 'TP-Link', '50:64:2B': 'TP-Link', 'A4:2B:B0': 'TP-Link', 'F4:EC:38': 'TP-Link',
    '00:0C:43': 'MediaTek', '1C:BF:CE': 'Xiaomi', '64:09:80': 'Xiaomi', '78:11:DC': 'Xiaomi',
    'F8:32:E4': 'ASUS', '2C:FD:A1': 'ASUS', '04:D4:C4': 'ASUS',
    '00:1F:3F': 'Huawei', '48:46:FB': 'Huawei', 'E0:24:7F': 'Huawei',
    '00:26:5A': 'D-Link', '00:1E:58': 'D-Link',
    'C8:3A:35': 'Tenda', 'C4:E9:84': 'Tenda',
    '34:96:72': 'Netgear', 'A0:40:A0': 'Netgear',
    '00:24:B2': 'Netgear', '3C:37:86': 'Apple', 'F0:18:98': 'Apple', 'AC:BC:32': 'Apple',
    '04:5D:4B': 'Intel', '34:13:E8': 'Intel', '7C:B2:7D': 'Intel', 'B4:6B:FC': 'Intel',
    '90:F9:70': 'Compex', '00:11:22': '示例设备',
  };

  let current = null;

  function vendorOf(bssid) {
    const key = String(bssid || '').slice(0, 8).toUpperCase().replace(/-/g, ':');
    return OUI[key] || t('dt.unknown');
  }

  function drawSpark(cv, pts) {
    const fitted = fitCanvas(cv);
    if (!fitted) return;
    const { ctx, w, h } = fitted;
    ctx.fillStyle = '#0d121b';
    ctx.fillRect(0, 0, w, h);
    if (!pts || pts.length < 2) {
      ctx.fillStyle = '#4b5566';
      ctx.font = '11px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(t('dt.nohist'), w / 2, h / 2 + 4);
      return;
    }
    const t0 = pts[0].t;
    const t1 = Math.max(pts[pts.length - 1].t, t0 + 1000);
    const min = Math.min(...pts.map((p) => p.rssi)) - 3;
    const max = Math.max(...pts.map((p) => p.rssi)) + 3;
    const xOf = (t) => 3 + ((t - t0) / (t1 - t0)) * (w - 6);
    const yOf = (v) => 4 + ((max - v) / Math.max(1, max - min)) * (h - 8);

    ctx.strokeStyle = '#1b2230';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = (h / 4) * i;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = xOf(p.t);
      const y = yOf(p.rssi);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.strokeStyle = rssiColor(pts[pts.length - 1].rssi);
    ctx.lineWidth = 1.8;
    ctx.stroke();
  }

  function bar(label, value, max, cls) {
    const pct = Math.max(0, Math.min(100, max ? (value / max) * 100 : 0));
    return `<div class="dt-row"><span>${label}</span>
      <i class="dt-bar ${cls || ''}" style="--p:${pct.toFixed(0)}%"></i>
      <em>${value == null ? '—' : value + '%'}</em></div>`;
  }

  function render() {
    const host = $('#detail');
    if (!host) return;
    if (!current) {
      host.dataset.open = '';
      return;
    }
    const ap = current;
    const aps = Inspector.aps();
    const prof = Channels.profile(aps, ap);
    const dist = Channels.distanceOf(ap.rssi);
    const hist = Inspector.hist().get(ap.bssid);
    const srcs = prof.same.concat(prof.adj).slice(0, 4);
    const cirText = prof.cir === null ? t('dt.inf') : `${prof.cir} dB`;
    const cirCls = prof.cir === null || prof.cir >= 25 ? 'good' : prof.cir >= 12 ? 'ok' : prof.cir >= 5 ? 'warn' : 'bad';
    const conn = Inspector.connFor(ap.bssid);
    const alias = Settings.alias(ap.ssid);
    const watched = Settings.isWatched(ap.ssid);
    const since = conn ? Inspector.connSince(ap.bssid) : null;

    host.innerHTML = `
      <div class="dt-head">
        <div class="dt-title">
          <b>${esc(alias || ap.ssid || t('dt.hidden'))}${conn ? ` <i class="badge conn">${t('tag.conn')}</i>` : ''}</b>
          <span class="mono">${alias ? esc(ap.ssid || t('dt.hidden')) + ' · ' : ''}${ap.bssid}</span>
        </div>
        <button class="dt-star${watched ? ' on' : ''}" id="dt-watch" title="${watched ? t('watch.off') : t('watch.on')}">${watched ? '★' : '☆'}</button>
        <button class="dt-close" id="dt-close" title="${t('dt.close')}">✕</button>
      </div>
      <div class="dt-body">
        <label class="dt-alias">
          <span>${t('dt.alias')}</span>
          <input id="dt-alias" type="text" maxlength="32" placeholder="${t('dt.alias.ph')}" value="${esc(alias)}" ${ap.ssid ? '' : 'disabled'} />
        </label>
        ${
          conn
            ? `<h4>${t('dt.conn')} <em class="dt-pill good">${esc(conn.auth)} · ${esc(conn.cipher)}</em></h4>
        <div class="dt-grid">
          <div><span>${t('dt.conn.auth')}</span><b>${esc(conn.auth)}</b></div>
          <div><span>${t('dt.conn.cipher')}</span><b>${esc(conn.cipher)}${conn.one_x ? ' · 802.1X' : ''}</b></div>
          <div><span>${t('dt.conn.rate')}</span><b>${conn.rx_mbps} / ${conn.tx_mbps}</b></div>
          <div><span>${t('dt.conn.quality')}</span><b>${conn.quality}%</b></div>
          <div><span>${t('dt.conn.since')}</span><b>${since ? durationText(Date.now() - since) : '—'}</b></div>
          <div><span>${t('dt.conn.profile')}</span><b title="${esc(conn.iface)}">${esc(conn.profile || '—')}</b></div>
        </div>`
            : ''
        }
        <div class="dt-kv">
          <div><span>${t('dt.signal')}</span><b class="${rssiClass(ap.rssi)}">${ap.rssi} dBm</b></div>
          <div><span>${t('dt.quality')}</span><b>${ap.quality}%</b></div>
          <div><span>${t('dt.dist')}</span><b>${dist ? dist.toFixed(1) + ' m' : '—'}</b></div>
          <div><span>${t('dt.vendor')}</span><b>${esc(vendorOf(ap.bssid))}</b></div>
        </div>

        <h4>${t('dt.hist')} <em class="dt-pill ${(hist?.pts.length ?? 0) > 2 ? 'ok' : 'warn'}">${t('dt.points', { n: hist?.pts.length ?? 0 })}</em></h4>
        <canvas id="dt-spark" class="dt-spark"></canvas>

        <h4>${t('dt.interf')} <em class="dt-pill ${cirCls}">CIR ${cirText}</em></h4>
        <div class="dt-kv">
          <div><span>${t('dt.same', { n: prof.same.length })}</span><b>${prof.sameDbm ?? t('ch.none')} ${prof.sameDbm != null ? 'dBm' : ''}</b></div>
          <div><span>${t('dt.adj', { n: prof.adj.length })}</span><b>${prof.adjDbm ?? t('ch.none')} ${prof.adjDbm != null ? 'dBm' : ''}</b></div>
        </div>
        ${
          srcs.length
            ? `<ul class="dt-src">${srcs
                .map(
                  (s) => `<li><span>${esc(truncate(s.ap.ssid || t('ch.hidden'), 14))}</span>
                    <em class="mono">ch${s.ap.channel ?? '?'} · ${s.ap.rssi}</em>
                    <b>${Math.round(s.ratio * 100)}%${s.co ? t('ch.co') : ''}</b></li>`
                )
                .join('')}</ul>`
            : `<div class="dt-empty">${t('dt.nooverlap')}</div>`
        }

        <h4>${t('dt.rf')}</h4>
        <div class="dt-grid">
          <div><span>${t('dt.band')}</span><b>${ap.band}</b></div>
          <div><span>${t('dt.channel')}</span><b>${ap.channel ?? '—'}</b></div>
          <div><span>${t('dt.freq')}</span><b>${ap.freq_mhz} MHz</b></div>
          <div><span>${t('dt.width')}</span><b>${ap.width_mhz} MHz</b></div>
          <div><span>PHY</span><b>${ap.phy}</b></div>
          <div><span>${t('dt.ie')}</span><b>${ap.ie_bytes} B</b></div>
          <div><span>${t('dt.security')}</span><b>${ap.security}</b></div>
          <div><span>AKM</span><b>${esc(ap.akm || '—')}</b></div>
          <div><span>Cipher</span><b>${esc(ap.cipher || '—')}</b></div>
          <div><span>${t('dt.stations')}</span><b>${ap.stations ?? '—'}</b></div>
        </div>

        <h4>${t('dt.air')}</h4>
        ${bar(t('dt.util'), ap.utilization ?? null, 100, (ap.utilization ?? 0) > 60 ? 'bad' : (ap.utilization ?? 0) > 35 ? 'warn' : 'good')}
      </div>
      <div class="dt-foot">
        <button id="dt-copy" class="ghost">${t('dt.copy')}</button>
      </div>`;

    host.dataset.open = '1';
    drawSpark($('#dt-spark'), hist?.pts);

    $('#dt-close').addEventListener('click', hide);
    $('#dt-watch').addEventListener('click', () => {
      if (!ap.ssid) return;
      Settings.toggleWatch(ap.ssid);
      render();
    });
    const aliasInput = $('#dt-alias');
    const commitAlias = () => {
      if (aliasInput.value.trim() === Settings.alias(ap.ssid)) return;
      Settings.setAlias(ap.ssid, aliasInput.value);
      setStatus(t('dt.alias.saved', { ssid: ap.ssid }));
      render();
    };
    aliasInput.addEventListener('change', commitAlias);
    aliasInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitAlias();
        aliasInput.blur();
      } else if (e.key === 'Escape') {
        aliasInput.value = Settings.alias(ap.ssid);
        aliasInput.blur();
      }
    });
    $('#dt-copy').addEventListener('click', () => {
      navigator.clipboard?.writeText(ap.bssid);
      setStatus(t('dt.copied'));
    });
  }

  function show(ap) {
    current = ap;
    render();
    $$('#ap tbody tr').forEach((tr) => tr.classList.remove('sel'));
    document.querySelector(`#ap tbody tr[data-bssid="${ap.bssid}"]`)?.classList.add('sel');
  }

  /** 连接时长：「3 分 12 秒」这种，超过一小时按小时。 */
  function durationText(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return t('dur.s', { s });
    if (s < 3600) return t('dur.m', { m: Math.floor(s / 60), s: s % 60 });
    return t('dur.h', { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60) });
  }

  function hide() {
    current = null;
    $$('#ap tbody tr').forEach((tr) => tr.classList.remove('sel'));
    const host = $('#detail');
    if (host) {
      host.dataset.open = '';
      host.innerHTML = '';
    }
  }

  function currentBssid() {
    return current?.bssid ?? null;
  }

  /** 数据刷新后如果抽屉还开着，跟着更新。别名输入框正在编辑时不重画，免得把半截字吞掉。 */
  function refresh() {
    if (!current) return;
    const fresh = Inspector.aps().find((a) => a.bssid === current.bssid);
    if (!fresh) {
      hide();
      return;
    }
    current = fresh;
    if (document.activeElement && document.activeElement.id === 'dt-alias') return;
    render();
  }

  return { show, hide, refresh, currentBssid, vendorOf };
})();
