// 变更追踪模块的单元测试：纯 Node，不依赖浏览器。
// 用法：node tests/changes.test.js
//
// 覆盖：首轮 / 预热期不报新增、-6 dB 不算掉 / -7 dB 算、连续两轮确认、换信道、换带宽、
// 连续两轮缺席才算消失、再出现算新增、标记寿命、抖动不报、持续走低只报一次、半截列表不记缺席。

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'rust', 'ui', 'changes.js'), 'utf8');
const Changes = new Function(src + '; return Changes;')();

let failures = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`ok   ${name}`);
  } else {
    failures++;
    console.log(`FAIL ${name}: got ${a}, expected ${e}`);
  }
}

const ap = (bssid, rssi, channel = 1, width = 20, ssid = 'T-' + bssid) => ({ bssid, ssid, band: '2.4 GHz', rssi, channel, width_mhz: width });
const kinds = (evs) => evs.map((e) => `${e.kind}:${e.bssid}`).sort();

// ---- 基本序列
{
  const c = Changes.create();
  let t = 1000;
  check('first scan reports nothing', c.feed([ap('a', -50), ap('b', -60), ap('d', -40)], (t += 1000)).length, 0);
  // 预热期（第 2 轮）：c 第一次看见不报新增；a 只掉 6 不算；b 掉 7 挂起等确认
  check('warm-up scan: -6 no drop, -7 pending, no new', kinds(c.feed([ap('a', -56), ap('b', -67), ap('c', -70), ap('d', -40)], (t += 1000))), []);
  // 第 3 轮：b 连续两轮低 → 掉；a 换信道；b 换带宽；c 缺席 1 轮
  check('drop confirmed + chan + width', kinds(c.feed([ap('a', -56, 6), ap('b', -67, 1, 40), ap('d', -40)], (t += 1000))), ['chan:a', 'drop:b', 'width:b']);
  check('gone after 2 missing scans', kinds(c.feed([ap('a', -56, 6), ap('b', -67, 1, 40), ap('d', -40)], (t += 1000))), ['gone:c']);
  check('reappear is new', kinds(c.feed([ap('a', -56, 6), ap('b', -67, 1, 40), ap('c', -70), ap('d', -40)], (t += 1000))), ['new:c']);
  check('counts', c.counts(), { new: 1, gone: 1, drop: 1, chan: 1, width: 1 });
  check('flags within ttl', Object.keys(c.flagsFor('b', t, 25_000)).sort(), ['drop', 'width']);
  check('flags expire', Object.keys(c.flagsFor('b', t + 30_000, 25_000)).length, 0);
  check('recent newest first', c.recent(2).map((e) => e.kind), ['new', 'gone']);
  const drop = c.recent(10).find((e) => e.kind === 'drop');
  check('drop event carries from/delta', [drop.from, drop.delta, drop.rssi], [-60, -7, -67]);
}

// ---- 抖动：-22 / -39 交替，只有单轮低，永远不报掉
{
  const c = Changes.create();
  let t = 5000;
  let drops = 0;
  for (const r of [-22, -39, -22, -39, -22, -39, -22, -39]) drops += c.feed([ap('j', r)], (t += 1000)).filter((e) => e.kind === 'drop').length;
  check('alternating jitter never reports a drop', drops, 0);
}

// ---- 真掉：第二轮确认后报一次，之后维持低值不再报
{
  const c = Changes.create();
  let t = 9000;
  let drops = 0;
  for (const r of [-50, -51, -50, -58, -58, -58, -58, -58]) drops += c.feed([ap('s', r)], (t += 1000)).filter((e) => e.kind === 'drop').length;
  check('sustained drop reported exactly once', drops, 1);
}

// ---- 冷却：同一 BSSID 60 秒内再掉也不报，过了冷却再报
{
  const c = Changes.create();
  let t = 20_000;
  const seq = [-40, -40, -40, -50, -50, -50, -60, -60];
  let drops = 0;
  for (const r of seq) drops += c.feed([ap('k', r)], (t += 1000)).filter((e) => e.kind === 'drop').length;
  check('second drop within cooldown suppressed', drops, 1);
  t += Changes.DROP_COOLDOWN_MS;
  drops += c.feed([ap('k', -70)], (t += 1000)).filter((e) => e.kind === 'drop').length;
  drops += c.feed([ap('k', -70)], (t += 1000)).filter((e) => e.kind === 'drop').length;
  check('drop after cooldown reported', drops, 2);
}

// ---- 半截列表：10 → 2 → 2 → 10，不该有 gone
{
  const c = Changes.create();
  let t = 40_000;
  const ten = Array.from({ length: 10 }, (_, i) => ap('p' + i, -60));
  let n = 0;
  n += c.feed(ten, (t += 1000)).length;
  n += c.feed(ten.slice(0, 2), (t += 1000)).length;
  n += c.feed(ten.slice(0, 2), (t += 1000)).length;
  n += c.feed(ten, (t += 1000)).length;
  check('partial scan lists do not count as absence', n, 0);
}

// ---- 环形缓冲上限
{
  const c = Changes.create();
  let t = 60_000;
  c.feed([], (t += 1000));
  c.feed([], (t += 1000));
  for (let i = 0; i < Changes.MAX_EVENTS + 50; i++) c.feed([ap('x' + i, -50)], (t += 1000));
  check('ring buffer capped', c.size(), Changes.MAX_EVENTS);
  c.reset();
  check('reset clears everything', [c.size(), c.scans()], [0, 0]);
}

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
