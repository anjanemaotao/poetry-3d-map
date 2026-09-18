#!/usr/bin/env node
/* 浏览器端回归统一入口（本地开发用）。
 *
 * 为什么需要它：三套 e2e-*.js 是「注入页面上下文执行」的脚本，共用同一个浏览器会话。
 * 若不隔离，前一套留下的状态会污染后一套 —— 历史上真踩过：
 *   e2e-scene 第 12 段会把 #viewGroup 里所有视角按钮都点一遍（含后来新增的「2D 平面」），
 *   跑完页面停在 flat-mode；紧接着跑的 e2e-region 里「切 2D」系列断言因为
 *   setFlatMode(on) 里 `if (state.flat === on) return` 直接早退而全部假失败。
 *
 * 所以这里的核心纪律只有一条：**每套脚本跑之前重新导航（reload）页面**。
 * 脚本自身也各自做了结尾复位（如 e2e-scene 主动退回 3D），两道防线并存。
 *
 * 第二条纪律（后来才补上）：**别把整个脚本塞进一次 eval**。
 * 单次 eval 有等待上限，超了会报成 `os error 35 … daemon may be busy`，
 * 看着像环境坏了，其实是脚本太长。统一走 runScript()（见 ab-run.mjs）派发 + 轮询。
 *
 * 用法：
 *   node tools/e2e-all.mjs                    # 默认 http://127.0.0.1:8777/index.html
 *   E2E_URL=http://127.0.0.1:8777/index.html node tools/e2e-all.mjs
 * 前置：本地静态服务器已启动（serve.py），agent-browser 已安装。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeAb, runScript } from './ab-run.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TARGET = process.env.E2E_URL || 'http://127.0.0.1:8777/index.html';
const SUITES = ['e2e-search.js', 'e2e-scene.js', 'e2e-region.js'];

const ab = makeAb();

let total = 0;
let pass = 0;
const failed = [];

for (const suite of SUITES) {
  /* ── 隔离：每套前重新导航，清掉上一套留下的 DOM / 相机 / 模式状态 ──
     顺序要紧：open 会把视口重置回默认值，所以「先开页面、再设视口、再 reload」，
     让页面按新视口重新初始化。
     reload 这步不能省：连续 `open` 同一 URL 时约有一半概率停在 about:blank，
     后面所有断言就会以「点不到元素 / 读不到类名」这种看不懂的方式失败
     （在 e2e-a11y.mjs 里实测 3 次失败 1 次，补上 reload 后连测 4 次全中）。 */
  ab(['open', TARGET]);
  ab(['set', 'viewport', '1440', '900']);
  ab(['reload']);
  ab(['wait', '3000']);

  let arr;
  let ms = 0;
  try {
    const res = runScript(ab, fs.readFileSync(path.join(HERE, suite), 'utf8'), { label: suite });
    arr = res.R;
    ms = res.ms;
  } catch (e) {
    console.log(`✗ ${suite.padEnd(16)} 执行失败：${e.message.split('\n')[0]}`);
    failed.push({ suite, name: '(脚本执行失败)', extra: e.message });
    total += 1;
    continue;
  }

  const p = arr.filter((r) => r.pass).length;
  total += arr.length;
  pass += p;
  const bad = arr.filter((r) => !r.pass);
  bad.forEach((r) => failed.push({ suite, name: r.name, extra: r.extra }));
  console.log(`${bad.length ? '✗' : '✓'} ${suite.padEnd(16)} ${String(p).padStart(3)} / ${arr.length}  ${String((ms / 1000).toFixed(1)).padStart(5)}s`);
}

console.log('-'.repeat(46));
console.log(`合计 ${pass} / ${total}  ${pass === total ? '✅ 全部通过' : '❌ 存在失败'}`);

if (failed.length) {
  console.log('\n失败明细：');
  failed.forEach((f) => {
    /* 脚本执行失败的 extra 是完整堆栈（这正是走 runScript 换来的好处），
       详情里只印第一行，完整堆栈单独摊开在后面。 */
    const head = (f.extra || '').split('\n')[0];
    console.log(`  ✗ [${f.suite}] ${f.name}${head ? '  —— ' + head : ''}`);
  });
  const stacks = failed.filter((f) => f.name === '(脚本执行失败)' && f.extra.includes('\n'));
  stacks.forEach((f) => console.log(`\n── ${f.suite} 完整堆栈 ──\n${f.extra}`));
  process.exit(1);
}
