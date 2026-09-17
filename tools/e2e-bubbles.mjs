/* e2e-bubbles.mjs —— 行迹气泡卡片布局回归。
 *
 * 焦点：16 条行迹（任意一条添加新行迹自动包含进来），
 *       逐条选中后逐项检查：
 *         - 气泡数 = 行迹站数（差的根因是 buildRouteBubbles 漏挂 / 多挂）
 *         - 气泡两两之间互不重叠（防重叠算法是否撑得住）
 *         - 每个气泡都在视口内（出界 = 引线指不到锚点）
 *         - **每个气泡都停靠在左右两条空白带里**（不能压在地图中央）
 *         - 每个气泡都带了方向类（side-left / side-right，决定引线从哪条边出发）
 *         - 每个气泡都装了诗作或显式「未见存世诗作」（留空会让用户以为是 bug）
 *
 * 五层验证之外的一个独立层 —— 因为气泡层有「站点少 → 撑得开，
 * 站点多 → 塞不下」的退化曲线，每加一条行迹都要重跑一次。
 *
 * 「停靠左右」这条是后加的：原先只验「不出界」，而卡片全堆在画面正中
 * 同样不出界 —— 用户要的是「诗词卡片放在地图的左右两侧空白区域」，
 * 所以要拿 ui.dockRect() 实测的空白带当判据。
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
  const ui = window.__app.ui;
  /* 停靠带要现算：面板开合/视口变化都会改它，缓存的可能是上一轮的 */
  ui.invalidateDock();
  const dock = ui.dockRect();
  const boxes = bs.map(e => { const r = e.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
             name: (e.querySelector('.rb-name')||{}).textContent || '?',
             poem: (e.querySelector('.rb-poem-line')||{}).textContent || null,
             none: !!e.querySelector('.rb-none'),
             sideL: e.classList.contains('side-left'),
             sideR: e.classList.contains('side-right'),
             sideT: e.classList.contains('side-top'),
             sideB: e.classList.contains('side-bottom'),
             shown: getComputedStyle(e).display !== 'none' }; });
  let ov = 0, worst = 0;
  for (let i=0;i<boxes.length;i++) for (let j=i+1;j<boxes.length;j++) {
    const a=boxes[i], b=boxes[j];
    const ox = Math.min(a.x+a.w,b.x+b.w) - Math.max(a.x,b.x);
    const oy = Math.min(a.y+a.h,b.y+b.h) - Math.max(a.y,b.y);
    if (ox>2 && oy>2) { ov++; worst = Math.max(worst, ox*oy); }
  }
  const out = boxes.filter(b => b.x < 0 || b.y < 0 || b.x+b.w > W || b.y+b.h > H).map(b => b.name);
  /* 卡片必须停靠在左右两条空白带里 —— 不能压在中间的地图区。
     这是「诗词卡片不要放在地图上方」那条需求的守门人：
     光看「不出界」是不够的，卡片全堆在画面正中也不出界。 */
  const offDock = boxes.filter(b => b.x < dock.left - 1 || b.x + b.w > dock.right + 1).map(b => b.name);
  const noSide = boxes.filter(b => (b.sideL ? 1 : 0) + (b.sideR ? 1 : 0) + (b.sideT ? 1 : 0) + (b.sideB ? 1 : 0) !== 1).map(b => b.name);
  return { n: boxes.length, ov, worst, out, dock,
           offDock, noSide,
           noContent: boxes.filter(b => !b.poem && !b.none).length,
           emptySites: boxes.filter(b => b.none).length };
})())`;

/**
 * 等镜头飞完并停稳。
 *
 * 原先是固定 `sleep(2600)`（飞行 1.7s + 900ms 余量），实测仍会偶发假失败：
 * 一旦在飞行途中测量，锚点还在移动，气泡布点就会算出一堆重叠
 * （实测见过「5 对重叠」和「2 对重叠」各一次，重跑又全绿）。
 * 轮询到相机位置不再变化为止，比赌一个睡眠时长可靠 —— 与 e2e-layout 里
 * settle() 的做法一致。
 */
const waitSettled = (maxMs = 8000) => {
  let last = null;
  for (let t = 0; t < maxMs; t += 120) {
    const p = ev(`JSON.stringify(window.__app.camera.position.toArray().map(n => +n.toFixed(4)))`);
    const k = p ? p.join(',') : 'null';
    if (k === last && k !== 'null') return true;
    last = k;
    sleep(120);
  }
  return false;
};

let passed = 0, failed = 0;
for (const id of routes) {
  ab(['eval', `document.querySelector('#routeList .route-item[data-id="${id}"]').click()`]);
  waitSettled();   // 镜头飞 ~1.7s，轮询到停稳再量
  const m = ev(MEASURE);
  const stops = ev(`JSON.stringify(+((document.querySelector('#routeList .route-item[data-id="${id}"] .rc')?.textContent || '').match(/(\\d+)\\s*站/) || [0,0])[1])`);
  if (!m) { console.log(`  ❌ ${id.padEnd(14)} 测量失败`); failed++; continue; }
  const checks = [
    ['数=站', m.n === stops],
    ['不重叠', m.ov === 0],
    ['不出界', m.out.length === 0],
    ['停靠左右', m.offDock.length === 0],
    ['有方向', m.noSide.length === 0],
    ['有内容', m.noContent === 0],
  ];
  const ok = checks.every(([, v]) => v);
  if (ok) passed++; else failed++;
  const fails = checks.filter(([, v]) => !v).map(([n]) => n).join('、');
  const flag = ok ? '✅' : '❌';
  const detail = ok ? '' :
    `  ❌ ${fails} (n=${m.n}, ov=${m.ov}, out=${m.out.join(',')||'无'}, 出带=${m.offDock.join(',')||'无'}, 无方向=${m.noSide.join(',')||'无'}, empty=${m.noContent})`;
  console.log(`  ${flag} ${id.padEnd(14)} 站 ${String(stops).padStart(2)} / 气泡 ${String(m.n).padStart(2)} | 空白站 ${m.emptySites}${detail}`);
}

// ── 气泡开关（行迹面板里的「气泡」按钮）──
// 默认可见 → 点一下整层隐藏 → 再点整层回来。位置和「数=站」等几何断言无关，
// 独立测一遍确认 toggle 与 buildRouteBubbles / updateRouteBubbles 三者解耦。
// 不量单气泡位置 —— 相机聚焦时多数气泡在屏外，但层仍该按 toggle 显隐。
console.log(`\n→ 气泡开关`);
// sweep 循环结束时停在 routes 数组最后一项（DOM 顺序最后，liqingzhao 3 站），
// 不是第一项 libai —— n 不该硬编码 9。从 routes 数组直接拿最后一项的站数。
const lastRouteId = routes[routes.length - 1];
const lastRouteN = +ev(`JSON.stringify(+(((document.querySelector('#routeList .route-item[data-id=\\\"${lastRouteId}\\\"] .rc')||{}).textContent || '').match(/(\\d+)/) || [,'?'])[1])`);

const layerDisplay = () => ev(`getComputedStyle(document.querySelector('#bubbleLayer')).display`);   // 直接返回字符串
const layerHasHiddenClass = () => ev(`document.querySelector('#bubbleLayer').classList.contains('bubble-hidden')`);
const btnHasOffClass = () => ev(`document.querySelector('#bubbleToggle').classList.contains('off')`);
const pressed = () => ev(`document.querySelector('#bubbleToggle').getAttribute('aria-pressed') === 'true'`);   // boolean
const totalBubbles = () => ev(`document.querySelectorAll('#bubbleLayer .rb-bubble').length`);   // 层里的气泡数（不算位置）

// 当前已选中 routes 数组最后一项（默认显示）
const beforeDisplay = layerDisplay();
const beforeHidden = layerHasHiddenClass();
const beforeN = totalBubbles();
console.log(`  ${beforeDisplay === 'block' && beforeHidden === false && beforeN === lastRouteN ? '✅' : '❌'} 默认显示：display=block, 无 hidden 类, ${lastRouteN} 个气泡 (display=${beforeDisplay}, hidden=${beforeHidden}, n=${beforeN}, 期望=${lastRouteN})`);

ab(['eval', `document.querySelector('#bubbleToggle').click()`]);
sleep(500);
const offDisplay = layerDisplay();
const offHasHidden = layerHasHiddenClass();
const offBtn = btnHasOffClass();
const offPressed = pressed();
console.log(`  ${offDisplay === 'none' && offHasHidden === true ? '✅' : '❌'} 点开关 → 层 display:none + hidden 类 (display=${offDisplay}, hidden=${offHasHidden})`);
console.log(`  ${offBtn === true ? '✅' : '❌'} 按钮加 off 类`);
console.log(`  ${offPressed === false ? '✅' : '❌'} aria-pressed=false (实际=${offPressed})`);

ab(['eval', `document.querySelector('#bubbleToggle').click()`]);
sleep(500);
const onDisplay = layerDisplay();
const onHasHidden = layerHasHiddenClass();
const onBtn = btnHasOffClass();
const onPressed = pressed();
console.log(`  ${onDisplay === 'block' && onHasHidden === false ? '✅' : '❌'} 再点 → display=block + 去掉 hidden 类 (display=${onDisplay}, hidden=${onHasHidden})`);
console.log(`  ${onBtn === false ? '✅' : '❌'} 按钮去掉 off 类`);
console.log(`  ${onPressed === true ? '✅' : '❌'} aria-pressed=true (实际=${onPressed})`);

// 切到另一位诗人 → 按钮偏好保留（用户 choice 不被覆盖）
ab(['eval', `document.querySelector('#bubbleToggle').click()`]);   // 再关
sleep(300);
ab(['eval', `document.querySelector('#routeList .route-item[data-id="xinqiji"]').click()`]);
sleep(2600);
const afterSwitchDisplay = layerDisplay();
const afterSwitchN = totalBubbles();
console.log(`  ${afterSwitchDisplay === 'none' && afterSwitchN === 2 ? '✅' : '❌'} 切诗人偏好保留：仍隐藏，但 xinqiji 的 2 个气泡已建 (display=${afterSwitchDisplay}, n=${afterSwitchN})`);

// 退出行迹模式 → 气泡清空，**按钮状态应保留**（不重置成「显示」—— 用户偏好不该被覆盖）。
// layer 的 display 跟随按钮状态：off 时 display:none，on 时 display:block。前面已 off → 仍 none。
ab(['eval', `document.querySelector('#routeClose').click()`]);
sleep(800);
const afterExitDisplay = layerDisplay();
const afterExitBtn = btnHasOffClass();
const afterExitN = totalBubbles();
console.log(`  ${afterExitDisplay === 'none' && afterExitBtn === true && afterExitN === 0 ? '✅' : '❌'} 退出行迹：气泡清空，状态保留（display:none + 按钮 off）(display=${afterExitDisplay}, btnOff=${afterExitBtn}, n=${afterExitN})`);

console.log(`\n→ ${routes.length} 条行迹 · ${passed} 通过 · ${failed} 失败`);
process.exit(failed ? 1 : 0);