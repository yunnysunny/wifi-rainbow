// 烟雾测试：Inspector 实时扫描 + 信道/AP 详情 + 分组/变更/连接/视图状态/导出探针。
// 由 %LOCALAPPDATA%\WiFiRainbow\selftest 标记文件触发；文件内容可指定最后停在哪个视图：
// inspector / channels / detail / tip / max / settings / en / enset / nohidden / group / events / conn / export
// （工程文件 / 报告 / 对比 / Survey 相关用例已随功能移除，见 archive-ui/）

const SelfTest = (() => {
  const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const clickTab = (view) => document.querySelector(`.tab[data-view="${view}"]`)?.click();

  async function waitForAps(timeoutMs = 15000) {
    const t0 = Date.now();
    while (!Inspector.aps().length && Date.now() - t0 < timeoutMs) {
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!Inspector.aps().length) await Inspector.scanOnce();
    return Inspector.aps();
  }

  async function run(mode = 'channels') {
    const t0 = performance.now();

    // 启动一致性：还没动过任何设置时，顶栏开关 / 定时器必须已经等于已保存的设置
    try {
      const s = Settings.get();
      const groupCb = document.querySelector('#group')?.checked;
      const setCb = document.querySelector('#set-group')?.checked;
      const timer = Inspector.autoInterval();
      log(
        'info',
        `selftest startup: groupBy=${s.groupBy} barCheckbox=${groupCb} settingsCheckbox=${setCb} ok=${groupCb === (s.groupBy === 'ssid') && setCb === (s.groupBy === 'ssid')} ` +
          `scanSec=${s.scanSec} timer=${timer}ms ok=${timer === s.scanSec * 1000} grouped=${document.querySelectorAll('#ap tbody tr.grp-row').length > 0 || 'n/a'}`
      );
    } catch (e) {
      log('error', 'startup probe failed: ' + e);
    }
    let strongest = null;

    try {
      const aps = await waitForAps();
      const { rows, bands } = Channels.analyze(aps);
      const co = rows.reduce((n, r) => n + r.same.length, 0) / 2;
      const adj = rows.reduce((n, r) => n + r.adj.length, 0) / 2;
      const best = bands.filter((b) => b.best).map((b) => `${b.band}->ch${b.best.ch}`).join(',');

      clickTab('channels');
      await frames();
      const cv = document.querySelector('#ch-spec-24GHz').getBoundingClientRect();
      const body = document.querySelector('.ch-body');
      const tbl = document.querySelector('#ch-table').getBoundingClientRect();
      log(
        'info',
        `selftest channels: aps=${rows.length} coPairs=${Math.round(co)} adjPairs=${Math.round(adj)} best=${best} ` +
          `canvas=${Math.round(cv.width)}x${Math.round(cv.height)} ` +
          `body=${Math.round(body.clientHeight)}/${Math.round(body.scrollHeight)} ` +
          `table=${document.querySelectorAll('#ch-table tbody tr').length}rows@${Math.round(tbl.width)}x${Math.round(tbl.height)} ` +
          `labels=${['24GHz', '5GHz', '6GHz']
            .map((b) => {
              const s = document.querySelector(`#ch-spec-${b}`)._labelStats;
              return s ? `${s.labeled}/${s.bars}` : 'x';
            })
            .join(',')}`
      );

      strongest = [...aps].sort((a, b) => b.rssi - a.rssi)[0] || null;
      if (strongest) {
        const prof = Channels.profile(aps, strongest);
        log(
          'info',
          `selftest detail: ${strongest.ssid || '<hidden>'} ch${strongest.channel} cir=${prof.cir} ` +
            `same=${prof.same.length} adj=${prof.adj.length} dist=${prof.distance?.toFixed(1)}m vendor=${Detail.vendorOf(strongest.bssid)}`
        );
      }
    } catch (e) {
      log('error', 'channels probe failed: ' + e);
    }

    // 信道高亮：悬停评分标签 → 对应频谱里命中的条数 = 按 ±10 MHz 口径算出的 AP 数；表格高亮行数一致；离开后清空
    try {
      clickTab('channels');
      await frames();
      const out = [];
      for (const band of ['2.4 GHz', '5 GHz']) {
        const id = band.replace(/[^0-9a-z]/gi, '');
        const chip = document.querySelector(`#ch-score-${id} .ch-chip[data-ch]`);
        const cv = document.querySelector(`#ch-spec-${id}`);
        if (!chip || !cv) {
          out.push(`${band}:no-chip`);
          continue;
        }
        const ch = Number(chip.dataset.ch);
        chip.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
        await frames();
        // 两级高亮：主信道（hits / tr.hl）与只重叠（overlaps / tr.hl2）分开数；频谱最多画 8 条
        const expect = Inspector.aps().filter((a) => Channels.hlLevel(a, band, ch) === 2);
        const expectOv = Inspector.aps().filter((a) => Channels.hlLevel(a, band, ch) === 1);
        const hits = cv._hl?.hits?.length ?? -1;
        const ovs = cv._hl?.overlaps?.length ?? -1;
        const rows = document.querySelectorAll('#ch-table tbody tr.hl').length;
        const rows2 = document.querySelectorAll('#ch-table tbody tr.hl2').length;
        const chipOn = chip.classList.contains('hl');
        const drawnOk = hits + ovs <= 8 && hits <= expect.length && ovs <= expectOv.length;
        const rowsOk = rows === expect.length && rows2 === expectOv.length;
        if (!drawnOk || !rowsOk || !chipOn) log('error', `chhover ${band} ch${ch}: hits=${hits}/${expect.length} ov=${ovs}/${expectOv.length} rows=${rows}/${rows2} chip=${chipOn}`);
        chip.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
        await frames();
        const cleared = cv._hl === null && document.querySelectorAll('#ch-table tbody tr.hl, #ch-table tbody tr.hl2, .ch-chip.hl').length === 0;
        if (!cleared) log('error', `chhover ${band}: highlight not cleared`);
        // 画布悬停：在该信道中心位置造一次 mousemove，应该命中同一个信道
        const g = cv._geom;
        const b = cv._bandInfo;
        const x = g.xOf(Channels.freqOf(band, ch));
        const r = cv.getBoundingClientRect();
        cv.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: r.left + x, clientY: r.top + r.height / 2 }));
        await frames();
        const viaCanvas = Channels.hover()?.ch === ch && Channels.hover()?.band === band;
        cv.dispatchEvent(new MouseEvent('mouseleave'));
        await frames();
        if (!viaCanvas) log('error', `chhover ${band}: canvas mousemove did not land on ch${ch}`);
        out.push(`${band}:ch${ch} primary=${hits}/${expect.length} overlap=${ovs}/${expectOv.length} rows=${rows}+${rows2} chipOn=${chipOn} cleared=${cleared} canvasHover=${viaCanvas} bars=${b.aps.length}`);
      }
      log('info', `selftest chhover: ${out.join(' | ')}`);
    } catch (e) {
      log('error', 'chhover probe failed: ' + e);
    }

    // Inspector 布局（用来核对 300% 缩放机器上的实际视口）
    try {
      clickTab('inspector');
      await frames();
      const box = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return 'missing';
        const r = el.getBoundingClientRect();
        return `${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.left)},${Math.round(r.top)}`;
      };
      // 表头与首行单元格的左边界差，用来客观校验列对齐（截图里看不清时靠这个）
      const heads = [...document.querySelectorAll('#ap thead th')].map((th) => Math.round(th.getBoundingClientRect().left));
      const firstRow = document.querySelector('#ap tbody tr');
      const cells = firstRow ? [...firstRow.children].map((td) => Math.round(td.getBoundingClientRect().left)) : [];
      const deltas = heads.map((h, i) => (cells[i] == null ? 'x' : cells[i] - h));
      const rowH = firstRow ? Math.round(firstRow.getBoundingClientRect().height) : 0;
      log(
        'info',
        `selftest layout: vp=${innerWidth}x${innerHeight} dpr=${devicePixelRatio} bar=${box('.bar')} ` +
          `charts=${box('#charts')} history=${box('#history')} table=${box('.table-wrap')} footer=${box('#status')} ` +
          `rows=${document.querySelectorAll('#ap tbody tr').length} rowH=${rowH} colDelta=[${deltas.join(',')}]`
      );
    } catch (e) {
      log('error', 'layout probe failed: ' + e);
    }

    // 三频段图浮层定位：在每张图上造一次 mousemove，看 tip 是否落在同一张图里（不能跑到 2.4 GHz 那块）
    try {
      clickTab('inspector');
      await frames();
      const charts = [...document.querySelectorAll('#charts .chart')];
      const out = [];
      for (const chart of charts.slice(0, 2)) {
        const cv = chart.querySelector('canvas');
        const r = cv.getBoundingClientRect();
        const tip = document.querySelector('#tip');
        let found = null;
        for (let i = 1; i < 60 && !found; i++) {
          const x = r.left + (r.width * i) / 60;
          const y = r.top + r.height * 0.35;
          cv.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
          if (tip.style.display === 'block') found = true;
        }
        if (!found) {
          out.push(`${chart.dataset.band}:no-hit`);
          continue;
        }
        const t = tip.getBoundingClientRect();
        const inside = t.left >= r.left - 1 && t.right <= r.right + 1;
        out.push(`${chart.dataset.band}:${inside ? 'in-chart' : 'OUT(' + Math.round(t.left) + ' vs ' + Math.round(r.left) + ')'}`);
        tip.style.display = 'none';
      }
      log('info', `selftest tip: ${out.join(' ')}`);
    } catch (e) {
      log('error', 'tip probe failed: ' + e);
    }

    // 三频段图遮挡检查：同一频段里，哪些弧被更强的 AP 椭圆完全盖住（图上就看不见了）
    try {
      clickTab('inspector');
      await frames();
      const report = [];
      for (const band of ['2.4 GHz', '5 GHz', '6 GHz']) {
        const chart = document.querySelector(`#charts .chart[data-band="${band}"]`);
        const g = chart?._geom;
        if (!g) continue;
        const list = Inspector.aps()
          .filter((a) => a.band === band && a.freq_mhz)
          .map((a) => ({
            ssid: a.ssid || '<hidden>',
            cx: g.xOf(a.freq_mhz),
            rx: Math.max(3, (a.width_mhz / 2) * (g.plotW / (g.spec.max - g.spec.min))),
            ry: g.rOf(a.rssi),
            rssi: a.rssi,
          }));
        const hidden = [];
        for (const a of list) {
          const by = list.find(
            (b) => b !== a && b.ry >= a.ry - 0.5 && Math.abs(b.cx - a.cx) + b.rx >= a.rx - 0.5 && b.rssi > a.rssi
          );
          if (by) hidden.push(`${a.ssid}@${a.rssi}<-${by.ssid}@${by.rssi}`);
        }
        report.push(`${band}:${list.length}个${hidden.length ? ' 被盖:' + hidden.join(',') : ''}`);
      }
      log('info', `selftest arcs: ${report.join(' | ')}`);
    } catch (e) {
      log('error', 'arc probe failed: ' + e);
    }

    // 多语言：切英文 → 顶栏/表头/信道汇总/设置页不能有中文；切回中文要能回来
    try {
      const cjk = (s) => (s.match(/[\u4e00-\u9fa5]/g) || []).length;
      const chrome = () =>
        [
          ...document.querySelectorAll('.bar .tabs .tab, .bar .actions label span, #scan'),
          ...document.querySelectorAll('#ap thead th'),
          ...document.querySelectorAll('#history .hist-head span, #clear-hist'),
          ...document.querySelectorAll('#view-channels thead th'),
          ...document.querySelectorAll('#view-settings .set-card h4, #set-reset'),
        ]
          .map((e) => e.textContent.trim())
          .join(' ');

      clickTab('inspector');
      await frames();
      I18n.set('zh');
      await frames();
      const zhCjk = cjk(chrome());
      const zhTab = document.querySelector('.tab[data-view="channels"]').textContent;

      I18n.set('en');
      await frames();
      const enCjk = cjk(chrome());
      const enTab = document.querySelector('.tab[data-view="channels"]').textContent;
      const enTh = [...document.querySelectorAll('#ap thead th')].map((th) => th.textContent).join('/');
      const enLang = document.querySelector('#set-lang')?.value;
      const enSetText = document.querySelector('#view-settings .set-card h4').textContent;
      const brand = document.querySelector('.brand strong');
      const brandInfo = `${brand?.textContent}|key=${brand?.dataset.i18n}|t=${t('app.name')}|title=${document.title}`;

      clickTab('channels');
      await frames();
      const enSummary = document.querySelector('#ch-summary').textContent;
      const enSumCjk = cjk(enSummary);
      const iface = document.querySelector('#iface').textContent;
      const ifaceStuck = /正在读取网卡|Reading adapters/.test(iface);

      const stored = localStorage.getItem('wifisurvey.lang');
      I18n.set('zh');
      await frames();
      const backCjk = cjk(chrome());

      log(
        'info',
        `selftest lang: zh=${zhCjk}cjk tab=${zhTab} | en=${enCjk}cjk tab=${enTab} th=${enTh} ` +
          `setH4=${enSetText} select=${enLang} | chSummary=${enSumCjk}cjk "${enSummary.slice(0, 60)}" | ` +
          `brand=${brandInfo} | iface="${iface}" stuck=${ifaceStuck} | stored=${stored} back=${backCjk}cjk`
      );
    } catch (e) {
      log('error', 'lang probe failed: ' + e);
    }

    // 设置逐项验证：每个选项都要看「过滤结果 / 视图反应 / 持久化」
    try {
      clickTab('inspector');
      await frames();
      Settings.reset();
      await frames();
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const all = Inspector.apsAll();
      const out = [];

      // 1) 不显示隐藏 SSID（数据层现在把隐藏网络的 ssid 给成空字符串）
      const hiddenAps = all.filter((a) => !a.ssid);
      const namedAps = all.filter((a) => !!a.ssid);
      Settings.set({ hideHidden: true });
      await frames();
      const afterHide = Inspector.aps();
      const tableHidden = [...document.querySelectorAll('#ap tbody tr')].filter((tr) =>
        tr.textContent.includes(t('ch.hidden'))
      ).length;
      const synthHidden = Settings.accept({ ssid: '', rssi: -50, band: '2.4 GHz' });
      const synthNamed = Settings.accept({ ssid: 'X', rssi: -50, band: '2.4 GHz' });
      out.push(
        `hideHidden: 库内隐藏=${hiddenAps.length} 具名=${namedAps.length} 开关后可见=${afterHide.length}/${all.length} ` +
          `残留隐藏=${afterHide.filter((a) => !a.ssid).length} 表格残留=${tableHidden} ` +
          `合成隐藏可见=${synthHidden} 合成具名=${synthNamed}`
      );
      Settings.set({ hideHidden: false });

      // 2) 最低信号
      Settings.set({ minRssi: -40 });
      await frames();
      const weak = Inspector.aps();
      const expect = all.filter((a) => a.rssi >= -40).length;
      out.push(`minRssi=-40: 可见=${weak.length} 期望=${expect} 违规=${weak.filter((a) => a.rssi < -40).length}`);
      Settings.set({ minRssi: -100 });

      // 3) 频段开关（图表也要跟着空）
      Settings.set({ bands: { '5 GHz': false } });
      await frames();
      const no5 = Inspector.aps();
      const meta5 = document.querySelector('#charts .chart[data-band="5 GHz"] .meta')?.textContent;
      out.push(`bands(off 5G): 可见=${no5.length} 残留5G=${no5.filter((a) => a.band === '5 GHz').length} 图meta=${meta5}`);
      Settings.set({ bands: { '5 GHz': true } });

      // 4) 扫描间隔（数 6 秒内真实扫了几次）
      Settings.set({ scanSec: 2 });
      await sleep(300);
      const c0 = Inspector.scanCount();
      await sleep(6000);
      const c1 = Inspector.scanCount();
      out.push(`scanSec=2: 定时器=${Inspector.autoInterval()}ms 6s内扫描=${c1 - c0} 次`);
      Settings.set({ scanSec: 5 });

      // 5) 持久化 + UI 同步
      Settings.set({ hideHidden: true, minRssi: -70, bands: { '6 GHz': false }, scanSec: 7 });
      await frames();
      const saved = JSON.parse(localStorage.getItem('wifisurvey.settings.v1') || '{}');
      const uiSame =
        $('#set-hide-hidden').checked === true &&
        Number($('#set-scan-sec').value) === 7 &&
        document.querySelector('#set-bands input[data-band="6 GHz"]').checked === false &&
        $('#set-min-rssi-val').textContent.includes('-70');
      out.push(
        `persist+ui: stored=${saved.hideHidden}/${saved.minRssi}/${saved.bands?.['6 GHz']}/${saved.scanSec}s ui一致=${uiSame} 可见=${Inspector.aps().length}`
      );

      // 设置页几何：重置按钮不能捧到折线以下（之前 4 张卡片单列时就掉了）
      clickTab('settings');
      await frames();
      const rb = document.querySelector('#set-reset')?.getBoundingClientRect();
      const vw = document.querySelector('#view-settings');
      const wrap = document.querySelector('.set-wrap');
      out.push(
        `layout: cards=${document.querySelectorAll('#view-settings .set-card').length} ` +
          `cols=${getComputedStyle(wrap).gridTemplateColumns.split(' ').length} wrapW=${Math.round(wrap.getBoundingClientRect().width)} ` +
          `reset=${rb ? Math.round(rb.width) + 'x' + Math.round(rb.height) + '@bottom=' + Math.round(rb.bottom) : 'missing'} ` +
          `view=${Math.round(vw.clientHeight)}/${Math.round(vw.scrollHeight)}`
      );

      Settings.reset();
      await frames();
      out.push(`reset后: 可见=${Inspector.aps().length} scan=${Settings.get().scanSec}s`);
      log('info', `selftest settings: ${out.join(' | ')}`);
    } catch (e) {
      log('error', 'settings probe failed: ' + e);
    }

    // 分组：组数 + 各组成员数之和 + 单行数 必须等于过滤后可见 AP 数；展开/折叠后的 DOM 行数也要对得上；
    // 组行高度与列对齐（表头与组行单元格左边界差）一并盯住
    try {
      clickTab('inspector');
      await frames();
      const prevGroup = Settings.get().groupBy;
      const prevExpanded = Inspector.viewState().expanded;
      Settings.set({ groupBy: 'ssid' });
      Inspector.setFilter('');
      await frames();
      const st = Inspector.groupStats();
      const vis = Inspector.aps().length;
      const sumOk = st.memberSum + st.singles === vis;
      const items = Inspector.groupRows();
      for (const g of items) if (g.kind === 'group') Inspector.expand(g.key, false);
      await frames();
      const collapsedRows = document.querySelectorAll('#ap tbody tr').length;
      const collapsedOk = collapsedRows === st.groups + st.singles;
      for (const g of items) if (g.kind === 'group') Inspector.expand(g.key, true);
      await frames();
      const expandedRows = document.querySelectorAll('#ap tbody tr').length;
      const expandedOk = expandedRows === st.groups + st.memberSum + st.singles;
      const subRows = document.querySelectorAll('#ap tbody tr.ap-row.sub').length;
      const grpRow = document.querySelector('#ap tbody tr.grp-row');
      const heads = [...document.querySelectorAll('#ap thead th')].map((th) => Math.round(th.getBoundingClientRect().left));
      const cells = grpRow ? [...grpRow.children].map((td) => Math.round(td.getBoundingClientRect().left)) : [];
      const deltas = heads.map((h, i) => (cells[i] == null ? 'x' : cells[i] - h));
      const grpH = grpRow ? Math.round(grpRow.getBoundingClientRect().height) : 0;
      const sample = items
        .filter((g) => g.kind === 'group')
        .slice(0, 4)
        .map((g) => `${g.key || '<hidden>'}[${g.ssids.map((x) => x || '<hidden>').join('+')}]×${g.members.length}@ch${g.chans.join('/')}`)
        .join(',');
      // 点击组行能折叠（走真实事件）
      let clickOk = null;
      if (grpRow) {
        const key = grpRow.dataset.group;
        grpRow.click();
        await frames();
        clickOk = !Inspector.viewState().expanded.includes(key);
      }
      // 平铺模式回来后行数 = 可见 AP 数
      Settings.set({ groupBy: 'none' });
      await frames();
      const flatRows = document.querySelectorAll('#ap tbody tr').length;
      log(
        'info',
        `selftest group: vis=${vis} groups=${st.groups} multiSsidGroups=${st.multiSsid} memberSum=${st.memberSum} singles=${st.singles} hiddenGroup=${st.hiddenGroup} ` +
          `sumOk=${sumOk} collapsed=${collapsedRows} ok=${collapsedOk} expanded=${expandedRows} ok=${expandedOk} subRows=${subRows} ` +
          `grpRowH=${grpH} grpColDelta=[${deltas.join(',')}] clickCollapse=${clickOk} flat=${flatRows} flatOk=${flatRows === vis} sample=${sample}`
      );
      Settings.set({ groupBy: prevGroup });
      for (const g of items) if (g.kind === 'group') Inspector.expand(g.key, prevExpanded.includes(g.key));
    } catch (e) {
      log('error', 'group probe failed: ' + e);
    }

    // 变更追踪：用构造的 AP 序列喂一个独立 tracker，断言各类事件计数与阈值边界（-6 不算掉、-7 算）
    try {
      const c = Changes.create();
      const mk = (bssid, rssi, channel = 1, width = 20) => ({ bssid, ssid: 'T-' + bssid, band: '2.4 GHz', rssi, channel, width_mhz: width });
      let now = 1_000_000;
      const r1 = c.feed([mk('a', -50), mk('b', -60), mk('d', -40)], (now += 1000)).length; // 首轮不报
      const r2 = c.feed([mk('a', -56), mk('b', -67), mk('c', -70), mk('d', -40)], (now += 1000)); // a:-6 不算 b:-7 挂起 c:预热期不报新增
      const r3 = c.feed([mk('a', -56, 6), mk('b', -67, 1, 40), mk('d', -40)], (now += 1000)); // b 连续两轮低 → 掉；a 换信道 b 换带宽 c 缺 1 轮
      // 抖动：-22/-39 交替只在单轮低，永远不该报掉
      const cj = Changes.create();
      let jitter = 0;
      for (const r of [-22, -39, -22, -39, -22, -39, -22]) jitter += cj.feed([mk('j', r)], (now += 1000)).filter((e) => e.kind === 'drop').length;
      // 真掉：-50,-51,-50 → -58,-58 第二轮确认报一次，之后维持 -58 不再报
      const cs = Changes.create();
      let sustained = 0;
      for (const r of [-50, -51, -50, -58, -58, -58, -58]) sustained += cs.feed([mk('s', r)], (now += 1000)).filter((e) => e.kind === 'drop').length;
      const r4 = c.feed([mk('a', -56, 6), mk('b', -67, 1, 40), mk('d', -40)], (now += 1000)); // c 缺 2 轮 → 消失
      const r5 = c.feed([mk('a', -56, 6), mk('b', -67, 1, 40), mk('c', -70), mk('d', -40)], (now += 1000)); // c 回来 → 新增
      const k = (evs) => evs.map((e) => `${e.kind}:${e.bssid}`).sort().join(',');
      const cnt = c.counts();
      const expect = { new: 1, gone: 1, drop: 1, chan: 1, width: 1 };
      const countsOk = Object.entries(expect).every(([key, v]) => cnt[key] === v);
      const flagsNow = Object.keys(c.flagsFor('b', now, 25_000)).sort().join(',');
      const flagsLater = Object.keys(c.flagsFor('b', now + 30_000, 25_000)).length;
      const live = Inspector.changes();
      log(
        'info',
        `selftest changes: r1=${r1} r2=[${k(r2)}] r3=[${k(r3)}] r4=[${k(r4)}] r5=[${k(r5)}] counts=${JSON.stringify(cnt)} ok=${countsOk} ` +
          `flags(b)=${flagsNow} after30s=${flagsLater} recent=${c.recent(3).map((e) => e.kind).join('>')} jitterDrops=${jitter}(expect 0) sustainedDrops=${sustained}(expect 1) | live: scans=${live.scans()} events=${live.size()} ` +
          `${JSON.stringify(live.counts())}`
      );
      // 事件面板切换：曲线隐藏、列表显示，再切回来
      Inspector.setHistPanel('events');
      await frames();
      const shown = document.querySelectorAll('#events li[data-bssid]').length;
      const evVisible = getComputedStyle(document.querySelector('#events')).display !== 'none';
      const cvHidden = getComputedStyle(document.querySelector('#history canvas')).display === 'none';
      const btn = document.querySelector('#hist-mode')?.textContent;
      Inspector.setHistPanel('curve');
      await frames();
      const back = getComputedStyle(document.querySelector('#history canvas')).display !== 'none';
      log('info', `selftest events-panel: listShown=${evVisible} rows=${shown}/${live.size()} canvasHidden=${cvHidden} btn="${btn}" restored=${back}`);
    } catch (e) {
      log('error', 'changes probe failed: ' + e);
    }

    // 已连接 AP：current_connection 给的 BSSID 要在扫描列表里，表格对应行要打「已连接」标，详情抽屉要有连接块
    try {
      clickTab('inspector');
      await frames();
      const conns = Inspector.conn();
      const c = conns[0];
      let out = `conns=${conns.length}`;
      if (c) {
        const inList = Inspector.apsAll().some((a) => a.bssid === c.bssid);
        const prevGroup = Settings.get().groupBy;
        Settings.set({ groupBy: 'none' });
        await frames();
        const row = document.querySelector(`#ap tbody tr[data-bssid="${c.bssid}"]`);
        const rowMarked = !!row?.classList.contains('conn') && !!row.querySelector('.badge.conn');
        Settings.set({ groupBy: 'ssid' });
        await frames();
        const grpMarked = !!document.querySelector('#ap tbody tr.conn');
        Settings.set({ groupBy: prevGroup });
        const ap = Inspector.apsAll().find((a) => a.bssid === c.bssid);
        let drawer = 'n/a';
        if (ap) {
          Detail.show(ap);
          await frames();
          const txt = document.querySelector('#detail')?.textContent || '';
          drawer = `${txt.includes(c.auth) && txt.includes(c.cipher)} rate=${txt.includes(String(c.rx_mbps))}`;
          Detail.hide();
        }
        const iface = document.querySelector('#iface').textContent;
        out +=
          ` ssid=${c.ssid} bssid=${c.bssid} auth=${c.auth} cipher=${c.cipher} rx/tx=${c.rx_mbps}/${c.tx_mbps} q=${c.quality} phy=${c.phy} ` +
          `inList=${inList} rowMarked=${rowMarked} grpMarked=${grpMarked} drawer=${drawer} ifaceBarHasSsid=${iface.includes(c.ssid)}`;
      }
      log('info', `selftest conn: ${out}`);
    } catch (e) {
      log('error', 'conn probe failed: ' + e);
    }

    // 视图状态持久化：排序键/方向、过滤词、展开组、历史面板 → localStorage
    try {
      const before = Inspector.viewState();
      Inspector.setSort('channel', false);
      Inspector.setFilter('zz-selftest');
      Inspector.setHistPanel('events');
      await frames();
      const emptyShown = getComputedStyle(document.querySelector('#empty')).display !== 'none';
      const saved = JSON.parse(localStorage.getItem('wifisurvey.view.v1') || '{}');
      const ok = saved.sortKey === 'channel' && saved.sortDesc === false && saved.filter === 'zz-selftest' && saved.histPanel === 'events';
      const sortedTh = document.querySelector('#ap thead th.sorted')?.dataset.key;
      Inspector.setSort(before.sortKey, before.sortDesc);
      Inspector.setFilter(before.filter);
      Inspector.setHistPanel(before.histPanel);
      await frames();
      const restored = JSON.parse(localStorage.getItem('wifisurvey.view.v1') || '{}');
      log(
        'info',
        `selftest viewstate: stored=${saved.sortKey}/${saved.sortDesc}/${saved.filter}/${saved.histPanel} ok=${ok} thSorted=${sortedTh} ` +
          `emptyOnNoMatch=${emptyShown} restored=${restored.sortKey}/${restored.sortDesc}/"${restored.filter}"/${restored.histPanel}`
      );
    } catch (e) {
      log('error', 'viewstate probe failed: ' + e);
    }

    // 别名 + 关注：起别名后表格/图例用别名；加关注后自动挑曲线必须包含它的 BSSID；最后原样还原
    try {
      clickTab('inspector');
      await frames();
      // 挑一个默认不在自动 6 条里、但还在图例 14 个名额内的具名 AP（第 7 强）
      const named = [...Inspector.aps()].filter((a) => a.ssid).sort((a, b) => b.rssi - a.rssi);
      const target = named[Math.min(6, named.length - 1)];
      let out = 'no-named-ap';
      if (target) {
        const prevAlias = Settings.alias(target.ssid);
        const prevWatch = Settings.isWatched(target.ssid);
        const prevGroup = Settings.get().groupBy;
        Settings.set({ groupBy: 'none' });
        Settings.setAlias(target.ssid, 'selftest-alias');
        await frames();
        const row = document.querySelector(`#ap tbody tr[data-bssid="${target.bssid}"]`);
        const rowHasAlias = !!row && row.textContent.includes('selftest-alias') && row.textContent.includes(target.ssid);
        const stored = JSON.parse(localStorage.getItem('wifisurvey.settings.v1') || '{}').aliases?.[target.ssid];
        const filterHit = (() => {
          Inspector.setFilter('selftest-ali');
          const n = document.querySelectorAll('#ap tbody tr').length;
          Inspector.setFilter('');
          return n;
        })();
        const chipBefore = document.querySelector(`#legend .chip[data-bssid="${target.bssid}"]`)?.classList.contains('on') ?? null;
        if (!prevWatch) Settings.toggleWatch(target.ssid);
        // 关注列表在下一轮 pushHistory 时生效：要等到一轮真正完成的扫描（撞上进行中的那轮就再扫一次）
        const c0 = Inspector.scanCount();
        await Inspector.scanOnce();
        if (Inspector.scanCount() === c0) await Inspector.scanOnce();
        await frames();
        const chipAfter = document.querySelector(`#legend .chip[data-bssid="${target.bssid}"]`)?.classList.contains('on') ?? null;
        const legendTxt = document.querySelector(`#legend .chip[data-bssid="${target.bssid}"]`)?.textContent || '';
        const inWatch = Settings.watchList().includes(target.ssid);
        // 还原
        if (!prevWatch) Settings.toggleWatch(target.ssid);
        Settings.setAlias(target.ssid, prevAlias);
        Settings.set({ groupBy: prevGroup });
        await frames();
        const cleared = !Settings.alias(target.ssid) && !Settings.isWatched(target.ssid);
        out =
          `ssid=${target.ssid}@${target.rssi} rowHasAlias=${rowHasAlias} stored=${stored} filterByAlias=${filterHit} ` +
          `watched=${inWatch} chip=${chipBefore}->${chipAfter} legend="${legendTxt.trim().slice(0, 40)}" restored=${cleared}`;
      }
      log('info', `selftest alias+watch: ${out}`);
    } catch (e) {
      log('error', 'alias/watch probe failed: ' + e);
    }

    // 导出：CSV 行数 = 平铺行数 + 1，列数与表头一致；PNG 拼图尺寸非零。真正落盘只在 mode=export 时做
    try {
      clickTab('inspector');
      await frames();
      const csv = Inspector.csvText();
      const lines = csv.replace(/\r\n$/, '').split('\r\n');
      const cols = lines[0].split(',').length;
      const th = document.querySelectorAll('#ap thead th').length;
      const rows = Inspector.flatRows().length;
      const bom = csv.charCodeAt(0) === 0xfeff;
      const cv = Inspector.composePng();
      let files = '';
      if (mode === 'export') {
        const p1 = await Inspector.exportCsv();
        const p2 = await Inspector.exportPng();
        clickTab('channels');
        await frames();
        const p3 = await Inspector.exportPng();
        clickTab('inspector');
        files = ` files=[${p1} | ${p2} | ${p3}]`;
      }
      log(
        'info',
        `selftest export: csvLines=${lines.length} rows=${rows} ok=${lines.length === rows + 1} cols=${cols} th=${th}+6 bom=${bom} ` +
          `png=${cv ? cv.width + 'x' + cv.height : 'null'}${files}`
      );
    } catch (e) {
      log('error', 'export probe failed: ' + e);
    }

    // 图表放大预览：切到最大态后量一下实际高度，确认真的铺满了
    try {
      clickTab('inspector');
      await frames();
      const base = document.querySelector('#charts .chart[data-band="5 GHz"] canvas').getBoundingClientRect();
      Inspector.toggleMax('b1');
      await frames();
      await frames();
      const big = document.querySelector('#charts .chart[data-band="5 GHz"] canvas').getBoundingClientRect();
      const histH = document.querySelector('#history').getBoundingClientRect().height;
      Inspector.toggleMax(null);
      await frames();
      await frames();
      const back = document.querySelector('#charts .chart[data-band="5 GHz"] canvas').getBoundingClientRect();
      log(
        'info',
        `selftest max: base=${Math.round(base.width)}x${Math.round(base.height)} big=${Math.round(big.width)}x${Math.round(big.height)} ` +
          `histCollapsed=${Math.round(histH)} restored=${Math.round(back.width)}x${Math.round(back.height)}`
      );
    } catch (e) {
      log('error', 'max probe failed: ' + e);
    }

    log('info', `selftest: total=${Math.round(performance.now() - t0)}ms`);

    // 停在指定视图，方便截图
    try {
      if (mode === 'detail') {
        clickTab('inspector');
        await frames();
        if (strongest) Detail.show(strongest);
      } else if (mode === 'tip') {
        // 停在「鼠标悬在 5 GHz 图上」的状态，方便截图核对浮层位置
        clickTab('inspector');
        await frames();
        const chart = [...document.querySelectorAll('#charts .chart')][1];
        const cv = chart.querySelector('canvas');
        const r = cv.getBoundingClientRect();
        for (let i = 1; i < 60; i++) {
          cv.dispatchEvent(
            new MouseEvent('mousemove', { bubbles: true, clientX: r.left + (r.width * i) / 60, clientY: r.top + r.height * 0.35 })
          );
          if (document.querySelector('#tip').style.display === 'block') break;
        }
      } else if (mode === 'max') {
        clickTab('inspector');
        await frames();
        Inspector.toggleMax('b1');
      } else if (mode === 'settings') {
        clickTab('settings');
      } else if (mode === 'en') {
        // 停在英文界面，方便截图核对
        I18n.set('en');
        await frames();
        clickTab('inspector');
      } else if (mode === 'enset') {
        I18n.set('en');
        await frames();
        clickTab('settings');
      } else if (mode === 'nohidden') {
        // 停在「不显示隐藏 SSID」打开、Inspector 列表里已经没有 <hidden> 行的状态
        Settings.set({ hideHidden: true });
        await frames();
        clickTab('inspector');
      } else if (mode === 'group') {
        // 停在分组模式、第一组展开，方便截图核对组行
        Settings.set({ groupBy: 'ssid' });
        clickTab('inspector');
        await frames();
        const first = Inspector.groupRows().find((g) => g.kind === 'group');
        if (first) Inspector.expand(first.key, true);
      } else if (mode === 'events') {
        clickTab('inspector');
        await frames();
        Inspector.setHistPanel('events');
      } else if (mode === 'conn') {
        clickTab('inspector');
        await frames();
        const c = Inspector.conn()[0];
        const ap = c && Inspector.apsAll().find((a) => a.bssid === c.bssid);
        if (ap) Detail.show(ap);
      } else if (mode === 'persist') {
        // 留下一组非默认设置，下一次启动用 startup 探针核对它们真的被加载并同步到界面
        Settings.set({ scanSec: 7, groupBy: 'none' });
        clickTab('inspector');
      } else if (mode === 'export' || mode === 'inspector') {
        clickTab('inspector');
      } else {
        clickTab('channels');
      }
      await frames();
      log('info', `selftest: parked on ${mode}`);
    } catch (e) {
      log('error', 'park failed: ' + e);
    }
  }

  return { run };
})();
