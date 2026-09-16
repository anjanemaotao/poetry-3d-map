/* e2e-bubbles.mjs —— 行迹气泡卡片布局回归。
 *
 * 焦点：16 条行迹（任意一条添加新行迹自动包含进来），
 *       逐条选中后逐项检查：
 *         - 气泡数 = 行迹站数（差的根因是 buildRouteBubbles 漏挂 / 多挂）
 *         - 气泡两两之间互不重叠（防重叠算法是否撑得住）
 *         - 每个气泡都在视口内（出界 = 引线指不到锚点）
 *         - 每个气泡都装了诗作或显式「未见存世诗作」（留空会让用户以为是 bug）
 *
 * 五层验证之外的一个独立层 —— 因为气泡层有「站点少 → 撑得开，
 * 站点多 → 塞不下」的退化曲线，每加一条行迹都要重跑一次。
 */
import { execFileSync } from 'node:child_process';

const ab = (a) => execFileSync('agent-browser', a, { encoding: 'utf8', maxBuffer: 64e6 });
const sleep = (ms) => execFileSync('node', ['-e', `setTimeout(()=>{},${ms})`]);
const ev = (js) => {
  let v;
  try { v = JSON.parse(ab(['eval', js]).trim()); } catch { return null; }
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return v; } }
  return v;
};

const TARGET = 'http://127.0.0.1:8777/index.html';

// ── 隔离 ── open → 设视口 → reload → 等落定 → 三次失败抛错
//   （不加 reload 实测约一半概率停在 about:blank，加了 100% 稳定）
let booted = false;
for (let attempt = 0; attempt < 3; attempt += 1) {
  ab(['open', TARGET]);
  ab(['set', 'viewport', '1440', '900']);
  ab(['reload']);
  ab(['wait', '4000']);
  // 必须确认到行迹切换按钮真的存在 —— guard 只看搜索框有可能 reload 那一帧 DOM 半成品
  booted = ev(`!!document.querySelector('#searchInput') && !!document.querySelector('[data-mode="route"]') && document.body.children.length > 0 && location.href.indexOf('127.0.0.1') > 0`) === true;
  if (booted) break;
  if (attempt === 2) throw new Error(`页面打不开：${TARGET}`);
}
if (!booted) throw new Error(`页面打不开：${TARGET}`);

ab(['eval', `document.querySelector('[data-mode="route"]').click()`]);
ab(['wait', '1200']);

const routes = ev(`JSON.stringify([...document.querySelectorAll('#routeList .route-item')].map(e => e.dataset.id))`);
console.log(`→ 共 ${routes.length} 条行迹\n`);

const MEASURE = `JSON.stringify((() => {
  const bs = [...document.querySelectorAll('#bubbleLayer .rb-bubble')];
  const W = innerWidth, H = innerHeight;
  const boxes = bs.map(e => { const r = e.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
             name: (e.querySelector('.rb-name')||{}).textContent || '?',
             poem: (e.querySelector('.rb-poem-line')||{}).textContent || null,
             none: !!e.querySelector('.rb-none'),
             shown: getComputedStyle(e).display !== 'none' }; });
  let ov = 0, worst = 0;
  for (let i=0;i<boxes.length;i++) for (let j=i+1;j<boxes.length;j++) {
    const a=boxes[i], b=boxes[j];
    const ox = Math.min(a.x+a.w,b.x+b.w) - Math.max(a.x,b.x);
    const oy = Math.min(a.y+a.h,b.y+b.h) - Math.max(a.y,b.y);
    if (ox>2 && oy>2) { ov++; worst = Math.max(worst, ox*oy); }
  }
  const out = boxes.filter(b => b.x < 0 || b.y < 0 || b.x+b.w > W || b.y+b.h > H).map(b => b.name);
  return { n: boxes.length, ov, worst, out,
           noContent: boxes.filter(b => !b.poem && !b.none).length,
           emptySites: boxes.filter(b => b.none).length };
})())`;

let passed = 0, failed = 0;
for (const id of routes) {
  ab(['eval', `document.querySelector('#routeList .route-item[data-id="${id}"]').click()`]);
  sleep(2600);   // 镜头飞 ~1.7s，留落定余量
  const m = ev(MEASURE);
  const stops = ev(`JSON.stringify(+((document.querySelector('#routeList .route-item[data-id="${id}"] .rc')?.textContent || '').match(/(\\d+)\\s*站/) || [0,0])[1])`);
  if (!m) { console.log(`  ❌ ${id.padEnd(14)} 测量失败`); failed++; continue; }
  const checks = [
    ['数=站', m.n === stops],
    ['不重叠', m.ov === 0],
    ['不出界', m.out.length === 0],
    ['有内容', m.noContent === 0],
  ];
  const ok = checks.every(([, v]) => v);
  if (ok) passed++; else failed++;
  const fails = checks.filter(([, v]) => !v).map(([n]) => n).join('、');
  const flag = ok ? '✅' : '❌';
  const detail = ok ? '' :
    `  ❌ ${fails} (n=${m.n}, ov=${m.ov}, out=${m.out.join(',')||'无'}, empty=${m.noContent})`;
  console.log(`  ${flag} ${id.padEnd(14)} 站 ${String(stops).padStart(2)} / 气泡 ${String(m.n).padStart(2)} | 空白站 ${m.emptySites}${detail}`);
}

console.log(`\n→ ${routes.length} 条行迹 · ${passed} 通过 · ${failed} 失败`);
process.exit(failed ? 1 : 0);