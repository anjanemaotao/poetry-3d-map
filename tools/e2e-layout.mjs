#!/usr/bin/env node
/* 多视口布局巡检（本地开发用）。
 *
 * 与 e2e-all.mjs 的分工：
 *   e2e-all.mjs    在**一个**视口（1440×900）里跑功能回归，回答「功能对不对」；
 *   e2e-layout.mjs 在**一组**视口里量几何，回答「摆得下吗」。
 *
 * 为什么必须单独有一套：布局类缺陷只在特定宽度才出现，1440 下量什么都是对的。
 * 本文件里的视口刻意取在每个响应式断点的**两侧**（断点 1280 / 1080 / 860 / 640 的
 * 左右各一个），因为「某个宽度忘了覆盖」这类错误正好藏在断点右边的缝隙里 ——
 * 实测就是靠 390/480 才量出「左右两栏同时展开时水平重叠 57px」，
 * 而左栏默认收起，在常规视口里根本复现不出来。
 *
 * 判定口径：一律量 getBoundingClientRect()，不比类名、不看 DOM 结构 ——
 * 浮层遮挡、宽度算成负数回退、横向溢出这些问题在数据层和 DOM 上都看不出异常。
 *
 * 用法：
 *   node tools/e2e-layout.mjs                    # 默认 http://127.0.0.1:8777/index.html
 *   E2E_URL=... node tools/e2e-layout.mjs
 * 前置：本地静态服务器已启动（serve.py），agent-browser 已安装。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeAb, runScript } from './ab-run.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TARGET = process.env.E2E_URL || 'http://127.0.0.1:8777/index.html';

/** 每个断点的两侧各取一个视口 —— 见文件头说明 */
const VIEWPORTS = [
  [390, 844],    // 手机竖屏
  [480, 900],
  [640, 800],    // 640 断点左侧
  [861, 700],    // 860 断点右侧（左栏不再默认收起的那一档）
  [1024, 768],
  [1081, 800],   // 1080 断点右侧（两栏同时展开、卡片最挤的区间）
  [1281, 800],   // 1280 断点右侧
  [1440, 900],
];

const ab = makeAb();

const script = fs.readFileSync(path.join(HERE, 'e2e-layout.js'), 'utf8');

const results = [];
for (const [w, h] of VIEWPORTS) {
  // 顺序要紧：open 会把视口重置回默认值，必须「先开页面、再设视口、再 reload」，
  // 让页面按新视口重新初始化（左栏是否默认收起就取决于初始 innerWidth）。
  ab(['open', TARGET]);
  ab(['set', 'viewport', String(w), String(h)]);
  ab(['reload']);
  ab(['wait', '3400']);

  /* 启动兜底：serve.py 是单线程 http.server，首屏要并发拉几十个模块，
     偶发某个 import 超时（#lfMsg 显示 "Failed to fetch dynamically imported module"），
     页面停在加载页 —— 这时脚本一读 window.__app 就抛异常，
     表现为「某几个视口执行失败」，且每次失败的视口都不一样（实测确实如此），
     看着像布局缺陷，其实是启动抖动。重载一次即可，不重试就会假红。 */
  for (let i = 0; i < 4; i += 1) {
    if (ab(['eval', '!!window.__app']).trim() === 'true') break;
    if (i === 3) break;
    ab(['reload']);
    ab(['wait', '3400']);
  }

  let res;
  try {
    /* 8 个视口 × 每个视口一套完整布局断言，单次 eval 必超时 —— 走 runScript。 */
    res = runScript(ab, script, { label: `e2e-layout.js @${w}x${h}` }).R;
  } catch (e) {
    results.push({ vp: `${w}x${h}`, bad: [`脚本执行失败：${e.message.split('\n')[0]}`] });
    console.log(`✗ ${`${w}x${h}`.padEnd(10)} 执行失败 —— ${e.message.split('\n')[0].slice(0, 120)}`);
    continue;
  }
  results.push(res);
  const ok = res.bad.length === 1 && res.bad[0].startsWith('(');
  console.log(`${ok ? '✓' : '✗'} ${`${w}x${h}`.padEnd(10)} ${res.bad.join(' | ')}`);
}

const bad = results.filter((r) => !(r.bad.length === 1 && r.bad[0].startsWith('(')));
console.log('-'.repeat(46));
console.log(bad.length
  ? `❌ ${bad.length} / ${results.length} 个视口存在布局问题`
  : `✅ ${results.length} 个视口全部通过（无重叠 / 无溢出 / 宽度正常）`);

if (bad.length) process.exit(1);
