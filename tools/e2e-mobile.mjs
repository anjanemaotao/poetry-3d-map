#!/usr/bin/env node
/* 窄屏（移动端）回归 runner（本地开发用）。
 *
 * 与 e2e-all.mjs 的分工：
 *   e2e-all.mjs    在 1440×900 里跑功能回归，回答「功能对不对」；
 *   e2e-layout.mjs 在 8 个视口里量几何，回答「摆得下吗」；
 *   e2e-mobile.mjs 只在 390×844 里跑，回答「**手机上那些覆盖式抽屉和下拉浮层好不好用**」。
 *
 * 为什么值得单独一套：窄屏的形态和宽屏不是「同一套东西小一点」，
 * 而是三件在宽屏上**根本不成立**的事 ——
 *   1. 底栏变成横向滚动容器，按钮可以停在视口外（浮层因此会飘走）；
 *   2. 两栏 + 行迹面板变成铺满屏幕的覆盖式抽屉（地图只剩几十像素）；
 *   3. 抽屉开关的位置按面板宽度现算，各断点宽度不同。
 * 这三条在 1440 下量什么都是对的，只有 390 才复现。
 *
 * 用法：
 *   node tools/e2e-mobile.mjs                    # 默认 http://127.0.0.1:8777/index.html
 *   E2E_URL=... node tools/e2e-mobile.mjs
 * 前置：本地静态服务器已启动（serve.py），agent-browser 已安装。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeAb, runScript } from './ab-run.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TARGET = process.env.E2E_URL || 'http://127.0.0.1:8777/index.html';
const W = process.env.E2E_W || '390';
const H = process.env.E2E_H || '844';

const ab = makeAb();

/* 顺序要紧：open 会把视口重置回默认值，所以「先开页面、再设视口、再 reload」，
   让页面按新视口重新初始化（body.narrow 是在启动时按 innerWidth 定的）。
   reload 不能省：连续 open 同一 URL 时约有一半概率停在 about:blank。 */
ab(['open', TARGET]);
ab(['set', 'viewport', W, H]);
ab(['reload']);
ab(['wait', '3400']);

const booted = ab(['eval', `!!(window.__app && window.__app.effects && window.__app.effects.beacons.size) && location.href.indexOf('127.0.0.1') > 0`]).trim();
if (booted !== 'true') {
  console.error(`✗ 页面没起来（window.__app 不存在或停在 about:blank）：${TARGET}`);
  process.exit(1);
}

const { R, ms } = runScript(ab, fs.readFileSync(path.join(HERE, 'e2e-mobile.js'), 'utf8'), {
  label: 'e2e-mobile.js',
});

R.forEach((x) => console.log(`${x.pass ? '✓' : '✗'} ${x.name}${x.extra ? '  —— ' + x.extra : ''}`));
const pass = R.filter((x) => x.pass).length;
console.log('-'.repeat(46));
console.log(`合计 ${pass} / ${R.length}  ${pass === R.length ? '✅ 全部通过' : '❌ 存在失败'}  （${W}×${H}，${(ms / 1000).toFixed(1)}s）`);
if (pass !== R.length) process.exit(1);
