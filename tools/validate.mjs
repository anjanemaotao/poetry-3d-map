// 诗篇数据校验：检查字段完整性、译文与联数对应、标点、意象字、id 唯一性、
// 朝代覆盖与自动出题可用性，以及 .hidden 隐藏类是否真的有 CSS 生效。
//
// 用法（在 poetry-3d-map 目录下）：
//   node tools/validate.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SITES, POEMS, LINE_BANK, DYNASTIES, STATS } from '../js/data/poetry.js';
import { dynastyEra } from '../js/data/poetry.js';
import { ROUTES, FEIHUA_KEYS } from '../js/data/meta.js';
import { buildGeoQuiz, buildFillQuiz, buildFeihua, search } from '../js/data/poetry.js';
import { POEMS_TEXTBOOK } from '../js/data/poems-textbook.js';
import { WORLD_ELEV, LAND_OUTER, LAND_HOLE } from '../js/data/world.js';
import { CHINA_GEO } from '../js/data/geo.js';

let fail = 0;
const bad = (msg) => { fail++; console.log('  ✗ ' + msg); };
const ok = (msg) => console.log('  ✓ ' + msg);

/* ---------- 1. 站点与诗篇基本字段 ---------- */
console.log('[1] 字段完整性');
const siteIds = new Set();
SITES.forEach((s) => {
  if (siteIds.has(s.id)) bad(`站点 id 重复：${s.id}`);
  siteIds.add(s.id);
  ['name', 'sub', 'geo', 'story'].forEach((k) => {
    if (!s[k] || typeof s[k] !== 'string') bad(`站点 ${s.id} 缺字段 ${k}`);
  });
  if (typeof s.lon !== 'number' || typeof s.lat !== 'number') bad(`站点 ${s.id} 经纬度非数字`);
  if (!Array.isArray(s.themes) || !s.themes.length) bad(`站点 ${s.id} 缺 themes`);
  if (!Array.isArray(s.poems) || !s.poems.length) bad(`站点 ${s.id} 无诗篇`);
});
ok(`${SITES.length} 个站点字段检查完毕`);

// 经纬度完全相同的两个站点，在三维场景里会叠成同一根光柱：看起来少了一处诗境，
// 点击也只能命中其中一个。这类问题在数据层看不出异常，只有到浏览器里才暴露，
// 所以在这里静态拦一道。同一座城市若确有两处诗境，应合并为一个站点。
const coordSeen = new Map();
SITES.forEach((s) => {
  const k = `${s.lon},${s.lat}`;
  if (coordSeen.has(k)) {
    const prev = coordSeen.get(k);
    bad(`站点 ${prev}(${prev}) 与 ${s.id}(${s.name}) 经纬度完全相同（${k}），三维场景中光柱会重叠`);
  } else {
    coordSeen.set(k, `${s.id}(${s.name})`);
  }
});
if (coordSeen.size === SITES.length) ok('站点经纬度无重合');

/* ---------- 1b. 坐标精度与间距 ----------
 * 起因：地图现在可以拉近约 14 倍（默认视域 262km → 最近 19km），
 * 站点之间的间距第一次变得「看得见」。三条守卫：
 *   1) 坐标必须落在 0.01° 网格上（≈1.1km），这是这批数据的既定精度。
 *      注意不能按字面小数位判断：`119.6` 就是 `119.60`，尾零被省略了而已，
 *      按字面判断会误报 27 处。
 *      也不去强求 3~4 位：这些诗境多为江、山、关这类**面状**地点而非点，
 *      再补位数是假精度（已抽查 20 处地标，2 位小数与真实坐标均在 1km 内吻合）。
 *   2) 必须落在国境经纬度范围内。经纬度写反（lon/lat 互换）在数据层看不出来，
 *      在三维场景里却是「光柱跑到国外」。
 *   3) 两站间距 ≥ 1.5km。标记屏幕尺寸恒定，最近处光圈约 45px（≈0.6km），
 *      再近就会互相盖住。当前最近的一对是金陵↔秦淮（5.8km），余量充足。
 */
const onGrid = (n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;
const distKm = (a, b) => {
  const dx = (a.lon - b.lon) * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180) * 111;
  const dy = (a.lat - b.lat) * 111;
  return Math.hypot(dx, dy);
};
const offGrid = SITES.filter((s) => !onGrid(s.lon) || !onGrid(s.lat));
if (offGrid.length) {
  bad(`站点经纬度不在 0.01° 网格上（过粗或过细）：${offGrid.map((s) => `${s.id}(${s.lon},${s.lat})`).join(' ')}`);
} else {
  ok(`站点经纬度均落在 0.01° 网格上（≈1.1km，放大后误差 <3px）`);
}

const outside = SITES.filter((s) => s.lon < 73 || s.lon > 136 || s.lat < 3 || s.lat > 54);
if (outside.length) bad(`站点落在国境经纬度范围外（lon 73~136 / lat 3~54）：${outside.map((s) => `${s.id}(${s.lon},${s.lat})`).join(' ')}`);
else ok('站点经纬度均在国境范围内');

let closest = { km: Infinity };
for (let i = 0; i < SITES.length; i += 1) {
  for (let j = i + 1; j < SITES.length; j += 1) {
    const km = distKm(SITES[i], SITES[j]);
    if (km < closest.km) closest = { km, a: SITES[i], b: SITES[j] };
  }
}
if (closest.km < 1.5) bad(`站点间距过近：${closest.a.id} ↔ ${closest.b.id} 仅 ${closest.km.toFixed(2)}km，放大后标记会互相盖住`);
else ok(`站点间距下限 ${closest.km.toFixed(1)}km（${closest.a.id} ↔ ${closest.b.id}），放大后仍分得开`);

/* ---------- 2. 诗篇逐条校验 ---------- */
console.log('[2] 诗篇逐条校验');
const poemIds = new Set();
POEMS.forEach((p) => {
  const tag = `${p.siteName}/${p.title}`;
  if (poemIds.has(p.id)) bad(`诗篇 id 重复：${p.id}`);
  poemIds.add(p.id);

  ['title', 'author', 'dynasty', 'form', 'level', 'appreciation'].forEach((k) => {
    if (!p[k] || typeof p[k] !== 'string') bad(`${tag} 缺字段 ${k}`);
  });
  if (!Array.isArray(p.lines) || !p.lines.length) { bad(`${tag} lines 为空`); return; }
  if (p.lines.length !== p.trans.length) {
    bad(`${tag} 联数 ${p.lines.length} 与译文数 ${p.trans.length} 不一致`);
  }
  // 近体诗（绝句/律诗）必须两句一联；词、古体诗、乐府、楚辞、歌行
  // 在数据模型里允许「一句一组」（如《念奴娇》上下阕的短句、《登幽州台歌》的长句）。
  const isNear = /绝句|律诗|排律/.test(p.form);
  p.lines.forEach((g, i) => {
    if (!Array.isArray(g) || !g.length) { bad(`${tag} 第 ${i + 1} 联为空`); return; }
    if (isNear && g.length !== 2) bad(`${tag} 第 ${i + 1} 联不是两句（${p.form} 应为两句一联）`);
    if (!isNear && g.length > 2) bad(`${tag} 第 ${i + 1} 联超过两句（${p.form}）`);
    g.forEach((line) => {
      if (typeof line !== 'string' || line.length < 3) bad(`${tag} 第 ${i + 1} 联存在过短句：「${line}」`);
    });
  });
  if (!Array.isArray(p.notes) || !p.notes.length) bad(`${tag} 缺注释`);
  else p.notes.forEach((n) => { if (!n.t || !n.d) bad(`${tag} 注释项不完整`); });
  if (!Array.isArray(p.keywords) || !p.keywords.length) bad(`${tag} 缺意象字`);

  // 意象字必须真的出现在正文里，否则飞花令/检索会出现空结果
  const body = p.lines.flat().join('');
  new Set(p.keywords).forEach((k) => {
    if (k.length !== 1) bad(`${tag} 意象字「${k}」不是单字`);
    else if (!body.includes(k)) bad(`${tag} 意象字「${k}」未出现在正文中`);
  });
  if (new Set(p.keywords).size !== p.keywords.length) bad(`${tag} 意象字有重复`);

  // 朝代必须能被筛选规则识别
  if (!dynastyEra(p.dynasty)) bad(`${tag} 朝代「${p.dynasty}」无法映射到筛选朝代`);
});
ok(`${POEMS.length} 首诗篇校验完毕`);

/* ---------- 3. 标点 ---------- */
console.log('[3] 标点规范');
// 中文里句末标点常被右引号包住（如「家中有阿谁？」），所以先剥掉结尾的收尾符号，
// 再看最后一个实义字符是不是标点。
const TAIL_MARKS = /[」』”’）)】》]$/;
const stripTail = (s) => { let t = s; while (TAIL_MARKS.test(t)) t = t.slice(0, -1); return t; };
let punctBad = 0;
POEMS.forEach((p) => {
  // 只有近体诗能要求「句末标点有固定位置」——绝句/律诗一联即一句：
  // 上句以逗号（或问号）收，下句以句号（或叹号/问号）收。
  // 词、曲、古体诗的一句可以独立成句，不能一概而论。
  const isNear = /绝句|律诗|排律/.test(p.form);
  p.lines.forEach((g, gi) => {
    if (!Array.isArray(g) || !g.length) return;
    g.forEach((line, li) => {
      const core = stripTail(line);
      if (!/[，。？！、；：]$/.test(core)) {
        bad(`${p.title}「${line}」句末缺标点`);
        punctBad++;
        return;
      }
      if (!isNear) return;
      const isLastInGroup = li === g.length - 1;
      const isLastGroup = gi === p.lines.length - 1;
      if (!isLastInGroup && !/[，、；：？]$/.test(core)) {
        bad(`${p.title}「${line}」是上句，却以「${core.slice(-1)}」收尾`);
        punctBad++;
      } else if (isLastInGroup && !isLastGroup && !/[。？！：]$/.test(core)) {
        bad(`${p.title}「${line}」是中间各联的下句，却以「${core.slice(-1)}」收尾`);
        punctBad++;
      }
    });
  });
});
if (!punctBad) ok('标点检查通过');

/* ---------- 4. 朝代覆盖（筛选可用性） ---------- */
console.log('[4] 朝代筛选覆盖');
DYNASTIES.forEach((d) => {
  const n = SITES.filter((s) => s.eras.includes(d.id)).length;
  if (n === 0) bad(`朝代筛选「${d.name}」无任何站点命中（死选项）`);
  else ok(`${d.name}：${n} 个站点命中`);
});

/* ---------- 5. 朝代分布 ---------- */
console.log('[5] 诗篇朝代分布');
const dist = {};
POEMS.forEach((p) => { dist[p.dynasty] = (dist[p.dynasty] || 0) + 1; });
console.log('  ' + Object.entries(dist).sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `${k} ${v}`).join(' / '));
const tangRatio = (dist['唐'] || 0) / POEMS.length;
console.log(`  唐代占比 ${(tangRatio * 100).toFixed(1)}%`);

/* ---------- 6. 行迹站点引用 ---------- */
console.log('[6] 诗人行迹引用');
ROUTES.forEach((r) => {
  if (!Array.isArray(r.stops) || r.stops.length < 2) { bad(`行迹「${r.name}」站点不足`); return; }
  r.stops.forEach((s) => {
    const id = typeof s === 'string' ? s : s.site;
    if (!siteIds.has(id)) bad(`行迹「${r.name}」引用了不存在的站点 ${id}`);
  });
});
ok(`${ROUTES.length} 条行迹检查完毕`);

/* ---------- 7. 自动出题 ---------- */
console.log('[7] 自动出题');
const geo = buildGeoQuiz(8);
if (geo.length !== 8) bad(`看图识诗只生成 ${geo.length} 题`);
geo.forEach((q, i) => {
  const names = q.choices.map((c) => c.name);
  if (new Set(names).size !== names.length) bad(`看图识诗第 ${i + 1} 题选项重复`);
  if (!names.includes(q.answerName)) bad(`看图识诗第 ${i + 1} 题选项不含正确答案`);
});
ok('看图识诗 8 题选项无重复且含答案');

const fill = buildFillQuiz(8);
if (fill.length !== 8) bad(`补全诗句只生成 ${fill.length} 题`);
fill.forEach((q, i) => {
  if (new Set(q.choices).size !== q.choices.length) bad(`补全诗句第 ${i + 1} 题选项重复`);
  if (!q.choices.includes(q.answer)) bad(`补全诗句第 ${i + 1} 题选项不含答案`);
});
ok('补全诗句 8 题选项无重复且含答案');

FEIHUA_KEYS.forEach((k) => {
  const r = buildFeihua(k, 6);
  if (r.length < 3) bad(`飞花令「${k}」例句不足（仅 ${r.length} 句）`);
});
ok(`飞花令 ${FEIHUA_KEYS.length} 个令字例句充足`);

/* ---------- 8. 检索 ---------- */
console.log('[8] 检索');
['月', '杜甫', '李白', '西湖', '长安', '春风', '黄鹤楼'].forEach((k) => {
  const n = search(k).length;
  if (!n) bad(`检索「${k}」无结果`);
  else console.log(`  ✓ 「${k}」→ ${n} 条`);
});

/* ---------- 9. 统计 ---------- */
console.log('[9] 统计');
console.log(`  诗境 ${STATS.sites} / 诗篇 ${STATS.poems} / 诗人 ${STATS.authors} / 诗句 ${LINE_BANK.length} / 朝代档 ${STATS.dynasties}`);
if (STATS.poems !== POEMS.length) bad('STATS.poems 与实际不符');

/* ---------- 10. .hidden 隐藏类是否真的有 CSS 生效 ---------- */
// 踩过的坑：JS 反复给 #searchResults 加 hidden 类、类也确实加上了，
// 但 style.css 里只写了 .quiz-card.hidden / .route-panel.hidden / .hover-tip.hidden，
// 漏了 .search-results.hidden —— 于是搜索下拉框永远关不掉。
// 所以这里静态检查：index.html 中每一个带 hidden 类的元素，都必须被某条 CSS 规则真正隐藏。
console.log('[10] hidden 隐藏类');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const css = readFileSync(join(ROOT, 'css/style.css'), 'utf8');

// 通用工具类：.hidden { ... display: none ... }（允许 !important、允许换行）
const genericRe = /(^|[\s,}])\.hidden\s*\{([^}]*)\}/gm;
let hasGeneric = false;
for (const m of css.matchAll(genericRe)) {
  if (/display\s*:\s*none/.test(m[2])) hasGeneric = true;
}

// 逐元素收集：<tag ... id="x" class="a b hidden" ...>
const hiddenEls = [];
for (const m of html.matchAll(/<[a-zA-Z][^>]*\bclass="([^"]*\bhidden\b[^"]*)"[^>]*>/g)) {
  const tag = m[0];
  const classes = m[1].split(/\s+/).filter(Boolean);
  const id = (tag.match(/\bid="([^"]+)"/) || [])[1] || '';
  hiddenEls.push({ id, classes });
}

if (!hiddenEls.length) {
  bad('index.html 中找不到任何带 hidden 类的元素，检查是否解析失效');
} else if (hasGeneric) {
  ok(`通用 .hidden 工具类存在，${hiddenEls.length} 个隐藏元素全部受控`);
} else {
  // 没有通用类，则每个元素都必须有自己的 .xxx.hidden 或 #id.hidden 规则
  hiddenEls.forEach(({ id, classes }) => {
    const sel = classes.filter((c) => c !== 'hidden');
    const hit = sel.some((c) => new RegExp(`\\.${c}\\.hidden\\s*\\{[^}]*display\\s*:\\s*none`).test(css))
      || (id && new RegExp(`#${id}\\.hidden\\s*\\{[^}]*display\\s*:\\s*none`).test(css));
    if (!hit) bad(`带 hidden 类的元素（id=${id || '无'} class="${classes.join(' ')}"）没有任何 CSS 规则会隐藏它——加了类也不会消失`);
  });
  if (hiddenEls.length) ok(`${hiddenEls.length} 个隐藏元素逐条检查完毕`);
}

/* ---------- 11. 教材扩容批的归属是否有效 ---------- */
// poems-textbook.js 里每条都带一个 site 字段指向目标站点。
// site 写错时该诗会被静默丢弃（EXTRA 桶里没人来取），从数据上看不出任何异常，
// 所以这里显式核对：每个 site 都必须是真实存在的站点，且该诗确实被聚合进了那个站点。
console.log('[11] 教材扩容批归属');
{
  const seen = new Set();
  let badCount = 0;
  POEMS_TEXTBOOK.forEach((e) => {
    if (!siteIds.has(e.site)) {
      bad(`扩容篇目《${e.title}》指向不存在的站点 ${e.site}`);
      badCount++;
      return;
    }
    if (seen.has(e.id)) { bad(`扩容篇目 id 重复：${e.id}`); badCount++; }
    seen.add(e.id);
    const site = SITES.find((s) => s.id === e.site);
    if (!site.poems.some((p) => p.id === e.id)) {
      bad(`扩容篇目《${e.title}》声明归入 ${e.site}，但并未出现在该站点中`);
      badCount++;
    }
  });
  if (!badCount) ok(`${POEMS_TEXTBOOK.length} 条扩容篇目归属全部有效`);
}

/* ---------- 12. 抽屉开关不能被放在面板内部 ---------- */
// 踩过的坑：开关原本是 .panel 的子元素。而面板收起靠的是 `transform: translateX()`，
// transform 会给后代建立新的包含块 —— 开关跟着一起平移，左栏收到 x≈5px、
// 右栏收到 x≈W-1px，两个都只剩一两个像素可见，用户「收起后找不到展开按钮」。
// 这类问题在数据层、在 CSS 上都看不出异常，只有到浏览器里点一次才暴露。
console.log('[12] 抽屉开关位置');
{
  const panelBlocks = [...html.matchAll(/<aside[^>]*class="[^"]*\bpanel\b[^"]*"[^>]*>([\s\S]*?)<\/aside>/g)]
    .map((m) => m[1]);
  let n = 0;
  panelBlocks.forEach((b, i) => {
    if (b.includes('panel-toggle')) {
      bad(`第 ${i + 1} 个 .panel 内部仍有 .panel-toggle：面板靠 transform 收起，`
        + '开关会跟着移出视野，收起后就再也点不到展开按钮了');
      n++;
    }
  });
  const hasBoth = /\bid="toggleLeft"/.test(html) && /\bid="toggleRight"/.test(html);
  if (!hasBoth) { bad('index.html 里找不到 toggleLeft / toggleRight 抽屉开关'); n++; }
  /* 行迹面板（#routePanel）是第三个会平移收起的容器，同一个坑要一并钉住：
     它的开关必须留在外面，否则收起后跟着一起飞出屏幕。
     #routePanel 是 <div> 且有嵌套，不能用「到第一个 </div> 为止」来截 ——
     那样只会截到内层，真把开关塞进去反而检不出来。这里按 div 配平扫到真正的收尾。 */
  const hasRouteToggle = /\bid="toggleRoute"/.test(html);
  if (!hasRouteToggle) { bad('index.html 里找不到 toggleRoute 行迹面板开关'); n++; }
  const rpStart = html.indexOf('id="routePanel"');
  if (rpStart < 0) { bad('index.html 里找不到 #routePanel'); n++; }
  else {
    let depth = 0;
    let i = html.lastIndexOf('<', rpStart);
    let end = html.length;
    const tag = /<\/?div\b[^>]*>/g;
    tag.lastIndex = i;
    for (let m; (m = tag.exec(html)); ) {
      depth += m[0][1] === '/' ? -1 : 1;
      if (depth === 0) { end = m.index; break; }
    }
    if (html.slice(i, end).includes('toggleRoute')) {
      bad('#routePanel 内部有 .panel-toggle：行迹面板同样靠 transform 收起，开关会跟着移出视野');
      n++;
    }
  }
  if (!n) ok(`${panelBlocks.length} 个面板外置开关 + 行迹开关，均不在面板内部`);
}

/* ---------- 13. 全球底图数据（地球模式） ---------- */
// 地球模式由两套数据拼出来：1° 高程网格（起伏 + 上色）与 110m 陆地轮廓（海陆掩膜）。
// 它们完全不参与主地图，改坏了主地图的 12 类校验一条都不会响 ——
// 所以单独设一节，把「数据本身对不对」钉住。这里的断言全部对着**实际字节**算，
// 不看数据文件里写着的 nx/ny/range 声明（那正是最容易和实际脱节的东西）。
console.log('[13] 全球底图数据');
{
  const W = WORLD_ELEV;
  const bin = Buffer.from(W.b64, 'base64');
  let elev = null;
  if (bin.length !== W.nx * W.ny * 2) {
    bad(`高程网格字节数 ${bin.length} ≠ ${W.nx}×${W.ny}×2 = ${W.nx * W.ny * 2}（Int16 小端序，2 字节/点）`);
  } else {
    elev = new Int16Array(bin.buffer, bin.byteOffset, W.nx * W.ny);
    ok(`高程网格 ${W.nx}×${W.ny}，字节数与 Int16 一致（${elev.length} 点）`);
  }

  if (elev) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < elev.length; i++) { const v = elev[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    if (lo !== W.min || hi !== W.max) {
      bad(`声明的高程范围 ${W.min}~${W.max} 与实际 ${lo}~${hi} 不符 —— `
        + 'range 被 globe.js 用作色带归一化基准，不一致会让地形色偏、高度比例失真');
    } else {
      ok(`高程范围与声明一致（${lo} ~ ${hi} m）`);
    }

    const at = (lon, lat) => {
      const i = Math.round(((lon - W.lon0) % 360 + 360) % 360);
      const j = Math.max(0, Math.min(W.ny - 1, Math.round(lat - W.lat0)));
      return elev[j * W.nx + i];
    };
    // 采样点挑的都是「大范围地形」，避开 1° 网格下会被邻格平均掉的小地形。
    // 马里亚纳海沟就是反例：它只有约 2° 宽，1° 网格上被两侧 4000m 深海一平均只剩
    // −4593m（真实最深 −11034m）。所以这里只卡「明显比周围深」，
    // 全局极值另有单独一条盯着。
    const PLACES = [
      ['珠峰一带', 86.9, 28.0, 5000, Infinity],
      ['青藏高原', 88.0, 32.0, 4000, Infinity],
      ['马里亚纳海沟', 142.0, 11.5, -Infinity, -4000],
      ['太平洋中部', -150.0, 0.0, -Infinity, -3000],
      ['大西洋中部', -30.0, 20.0, -Infinity, -3000],
      ['北京', 116.4, 39.9, -50, 500],
      ['拉萨', 91.1, 29.7, 3000, Infinity],
      ['乌鲁木齐', 87.6, 43.8, 100, 2500],
      ['海南岛', 109.8, 19.2, -50, 2000],
      ['台北', 121.5, 25.0, -50, 2500],
    ];
    let pBad = 0;
    for (const [name, lon, lat, min, max] of PLACES) {
      const v = at(lon, lat);
      if (!(v >= min && v <= max)) { bad(`${name}（${lon}°E ${lat}°N）高程 ${v}m 不在期望区间 [${min}, ${max}]`); pBad++; }
    }
    if (!pBad) ok(`${PLACES.length} 个采样点高程全部落在期望区间（珠峰 / 马里亚纳 / 青藏高原 / 北京 / 拉萨…）`);

    // 全局极值：最深点必须真的在深海里（< -8000），最高点必须真的在高山上（> 5500）。
    // 这一条防的是「数据被截断或换成了低精度版本」—— 那种情况下采样点可能还对，
    // 但极值会明显缩水，地形起伏整体变平。
    if (elev) {
      let loI = 0, hiI = 0;
      for (let i = 1; i < elev.length; i++) { if (elev[i] < elev[loI]) loI = i; if (elev[i] > elev[hiI]) hiI = i; }
      const ll = (i) => `${-180 + (i % W.nx)}°E ${-90 + Math.floor(i / W.nx)}°N`;
      if (!(elev[loI] < -8000)) bad(`全局最低点只有 ${elev[loI]}m（${ll(loI)}），深海地形被削平了`);
      else if (!(elev[hiI] > 5500)) bad(`全局最高点只有 ${elev[hiI]}m（${ll(hiI)}），高山地形被削平了`);
      else ok(`全局极值合理：最低 ${elev[loI]}m（${ll(loI)}）、最高 ${elev[hiI]}m（${ll(hiI)}）`);
    }
  }

  /* 陆地轮廓：环的合法性 + 海陆掩膜与高程网格是否自洽 */
  const ringsOk = (rings, label) => {
    let n = 0;
    rings.forEach((r, i) => {
      if (r.length % 2) { bad(`${label} 第 ${i} 环坐标个数为奇数（${r.length}）`); n++; }
      if (r.length < 6) { bad(`${label} 第 ${i} 环不足 3 个点（${r.length / 2}）`); n++; }
      for (let k = 0; k < r.length; k += 2) {
        if (!(r[k] >= -180 && r[k] <= 180) || !(r[k + 1] >= -90 && r[k + 1] <= 90)) {
          bad(`${label} 第 ${i} 环第 ${k / 2} 点 (${r[k]}, ${r[k + 1]}) 越出经纬度范围`); n++; break;
        }
      }
    });
    return n;
  };
  const outerPts = LAND_OUTER.reduce((a, r) => a + r.length / 2, 0);
  const holePts = LAND_HOLE.reduce((a, r) => a + r.length / 2, 0);
  const rBad = ringsOk(LAND_OUTER, 'LAND_OUTER') + ringsOk(LAND_HOLE, 'LAND_HOLE');
  if (rBad) { /* 已在 ringsOk 里逐条报过 */ } else if (LAND_OUTER.length < 100 || outerPts < 4000) {
    bad(`陆地轮廓只有 ${LAND_OUTER.length} 环 / ${outerPts} 点，比 110m 数据的正常规模小得多（疑似被截断）`);
  } else {
    ok(`陆地轮廓 ${LAND_OUTER.length} 环 ${outerPts} 点 + 内环 ${LAND_HOLE.length} 环 ${holePts} 点，逐环合法`);
  }

  /* 点是否落在陆地上：射线法。掩膜错了的表现是「海岸线整体错位」，
     在浏览器里看起来只是「地形怪怪的」，不看数据根本定位不到。 */
  const inRing = (lon, lat, ring) => {
    let inside = false;
    const n = ring.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = ring[i * 2], yi = ring[i * 2 + 1];
      const xj = ring[j * 2], yj = ring[j * 2 + 1];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  const onLand = (lon, lat) => LAND_OUTER.some((r) => inRing(lon, lat, r))
    && !LAND_HOLE.some((r) => inRing(lon, lat, r));
  const MASK = [
    ['北京', 116.4, 39.9, true], ['拉萨', 91.1, 29.7, true], ['乌鲁木齐', 87.6, 43.8, true],
    ['海南岛', 109.8, 19.2, true], ['台北', 121.5, 25.0, true],
    ['巴黎', 2.35, 48.85, true], ['开罗', 31.2, 30.0, true], ['巴西利亚', -47.9, -15.8, true],
    ['太平洋中部', -150.0, 0.0, false], ['大西洋中部', -30.0, 20.0, false],
    ['印度洋', 80.0, -20.0, false], ['马里亚纳海沟', 142.0, 11.5, false],
  ];
  let mBad = 0;
  for (const [name, lon, lat, want] of MASK) {
    const got = onLand(lon, lat);
    if (got !== want) { bad(`海陆掩膜判错：${name}（${lon}°, ${lat}°）应为${want ? '陆地' : '海洋'}，实得${got ? '陆地' : '海洋'}`); mBad++; }
  }
  if (!mBad) ok(`${MASK.length} 个采样点的海陆判定全部正确（含内陆、海岛、四大洋）`);

  /* 合规：全球底图只描述自然地理，不得混入任何政治边界层 */
  const worldKeys = Object.keys(await import('../js/data/world.js')).sort().join(',');
  if (worldKeys !== 'LAND_HOLE,LAND_OUTER,WORLD_ELEV') {
    bad(`world.js 的导出变成 [${worldKeys}] —— 该文件只允许「高程 + 海陆轮廓」三项，`
      + '任何行政/国界数据都必须来自 js/data/geo.js 的中国标准地图');
  } else {
    ok('world.js 只导出高程与海陆轮廓，不含任何政治边界');
  }

  /* 合规：地球上的中国版图必须包含台湾省、香港、澳门与南海诸岛。
     这几项是领土要素，缺一项就是错的 —— 而地图上少画一块地方，
     肉眼几乎发现不了（尤其在球面上），只能靠数据断言盯住。 */
  const CHINA_NEED = [
    ['710000', '台湾省'], ['810000', '香港特别行政区'],
    ['820000', '澳门特别行政区'], ['100000_JD', '南海诸岛'],
  ];
  const codes = new Set(CHINA_GEO.map((f) => String(f.c)));
  let cBad = 0;
  for (const [code, name] of CHINA_NEED) {
    if (!codes.has(code)) { bad(`中国版图数据缺少「${name}」（编码 ${code}）`); cBad++; }
  }
  if (!cBad) ok(`中国版图含台湾省、香港、澳门特别行政区与南海诸岛（共 ${CHINA_GEO.length} 个要素）`);

  // 版图不得越出中国疆域范围（越界说明数据里混进了邻国或别的图层）
  let outCnt = 0;
  for (const f of CHINA_GEO) {
    for (const poly of f.p) {
      for (const ring of poly) {
        for (const [lon, lat] of ring) {
          if (lon < 73 || lon > 136 || lat < 3 || lat > 54) outCnt++;
        }
      }
    }
  }
  if (outCnt) bad(`中国版图数据有 ${outCnt} 个顶点越出疆域范围（经 73~136、纬 3~54）`);
  else ok(`中国版图 ${CHINA_GEO.reduce((a, f) => a + f.p.reduce((b, p) => b + p.reduce((d, r) => d + r.length, 0), 0), 0)} 个顶点全部落在疆域范围内`);
}

/* ---------- 结果 ---------- */

console.log('');
if (fail) {
  console.log(`❌ 校验失败：${fail} 项问题`);
  process.exit(1);
} else {
  console.log('✅ 全部校验通过');
}
