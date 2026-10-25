// AP 变更追踪：逐轮扫描 diff，产出「新增 / 消失 / 掉信号 / 换信道 / 换带宽」事件。
//
// 纯数据模块，不碰 DOM：Inspector 每次扫完把整份 AP 列表 feed 进来；selftest 用构造的序列喂，
// 断言各类事件计数与阈值边界（恰好 -6 dB 不算掉、-7 dB 算）。
//
// 口径：
// - 「掉信号」比的是最近 SMOOTH 次采样的均值（只有一次采样时就是上一次的值），差值 <= -DROP_DB 才算
//   （-6 不算，-7 算），而且要**连续两轮**都低于基线才报（AX200 上同一 AP 两轮之间 -22/-39 来回跳是常态，
//   单轮低一下不是真掉）；报过一次后基线复位到当前值，持续走低不会连环报，同一 BSSID 60 秒内最多报一次
// - 「消失」要连续 GONE_AFTER 轮没扫到才报，一轮闪一下不算（轮询扫描常见 16/15 来回跳）；
//   这一轮的条数比上一轮少了四成以上就当作驱动给了半截列表（扫描进行中常见），不记缺席
// - 报过「消失」的 BSSID 从快照里删掉，再冒出来就是「新增」
// - 事件环形缓冲 MAX_EVENTS 条，界面只给最近 20 条

const Changes = (() => {
  const DROP_DB = 7;
  const GONE_AFTER = 2;
  const SMOOTH = 3;
  const DROP_COOLDOWN_MS = 60_000;
  const PARTIAL_RATIO = 0.6;
  const WARMUP_SCANS = 2; // 启动后前两轮驱动给的列表常常不全（7 → 11），这期间第一次看见的不算「新增」
  const MAX_EVENTS = 200;
  const KINDS = ['new', 'gone', 'drop', 'chan', 'width'];

  function create() {
    const snap = new Map(); // bssid -> { ssid, band, rssi, samples[], channel, width, missing }
    const events = [];
    let scans = 0;
    let lastCount = 0;

    function push(kind, ap, extra, now) {
      const ev = {
        t: now,
        scan: scans,
        kind,
        bssid: ap.bssid,
        ssid: ap.ssid ?? '',
        band: ap.band,
        channel: ap.channel ?? null,
        rssi: ap.rssi,
        ...extra,
      };
      events.push(ev);
      if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
      return ev;
    }

    /** 喂一轮扫描结果；返回这一轮产生的事件。 */
    function feed(aps, now = Date.now()) {
      scans++;
      const fresh = [];
      const seen = new Set();
      for (const ap of aps) {
        if (!ap || !ap.bssid || seen.has(ap.bssid)) continue;
        seen.add(ap.bssid);
        const prev = snap.get(ap.bssid);
        if (!prev) {
          // 预热期里的「第一次看见」不当成新增事件（否则启动就刷十几条）
          if (scans > WARMUP_SCANS) fresh.push(push('new', ap, {}, now));
        } else {
          const base = prev.pending ?? Math.round(prev.samples.reduce((a, b) => a + b, 0) / prev.samples.length);
          const delta = ap.rssi - base;
          if (delta <= -DROP_DB) {
            if (prev.pending !== null) {
              if (now - (prev.lastDrop ?? -Infinity) >= DROP_COOLDOWN_MS) {
                fresh.push(push('drop', ap, { delta, from: base }, now));
                prev.lastDrop = now;
              }
              prev.samples = []; // 基线复位到当前值
              prev.pending = null;
            } else {
              prev.pending = base; // 第一轮低：挂起，等下一轮确认；基线冻结
              prev.samples = prev.samples.length ? prev.samples : [base];
              prev.freeze = true;
            }
          } else {
            prev.pending = null;
          }
          if ((prev.channel ?? null) !== (ap.channel ?? null)) {
            fresh.push(push('chan', ap, { from: prev.channel ?? null, to: ap.channel ?? null }, now));
          }
          if (prev.width !== ap.width_mhz) {
            fresh.push(push('width', ap, { from: prev.width, to: ap.width_mhz }, now));
          }
        }
        const samples = prev?.freeze ? prev.samples : [...(prev?.samples ?? []), ap.rssi].slice(-SMOOTH);
        snap.set(ap.bssid, {
          ssid: ap.ssid ?? '',
          band: ap.band,
          rssi: ap.rssi,
          samples,
          pending: prev?.pending ?? null,
          lastDrop: prev?.lastDrop ?? null,
          freeze: false,
          channel: ap.channel ?? null,
          width: ap.width_mhz,
          missing: 0,
        });
      }
      const partial = scans > 1 && seen.size < lastCount * PARTIAL_RATIO;
      lastCount = Math.max(seen.size, partial ? lastCount : 0);
      for (const [bssid, s] of snap) {
        if (seen.has(bssid) || partial) continue;
        s.missing++;
        if (s.missing >= GONE_AFTER) {
          fresh.push(push('gone', { bssid, ssid: s.ssid, band: s.band, channel: s.channel, rssi: s.rssi }, {}, now));
          snap.delete(bssid);
        }
      }
      return fresh;
    }

    /** 最近 n 条，新的在前。 */
    function recent(n = 20) {
      return events.slice(-n).reverse();
    }

    /** 某个 BSSID 在 ttl 毫秒内的最新事件，按类型各取一条（表格行上打标用）。 */
    function flagsFor(bssid, now = Date.now(), ttl = 25_000) {
      const out = {};
      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i];
        if (now - ev.t > ttl) break;
        if (ev.bssid !== bssid || out[ev.kind]) continue;
        out[ev.kind] = ev;
      }
      return out;
    }

    function counts() {
      const c = Object.fromEntries(KINDS.map((k) => [k, 0]));
      for (const ev of events) c[ev.kind]++;
      return c;
    }

    function reset() {
      snap.clear();
      events.length = 0;
      scans = 0;
      lastCount = 0;
    }

    return { feed, recent, flagsFor, counts, reset, size: () => events.length, scans: () => scans, snapshot: () => snap };
  }

  return { create, DROP_DB, GONE_AFTER, SMOOTH, DROP_COOLDOWN_MS, WARMUP_SCANS, MAX_EVENTS, KINDS };
})();
