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
 * 用法：
 *   node tools/e2e-all.mjs                    # 默认 http://127.0.0.1:8777/index.html
 *   E2E_URL=http://127.0.0.1:8777/index.html node tools/e2e-all.mjs
 * 前置：本地静态服务器已启动（serve.py），agent-browser 已安装。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TARGET = process.env.E2E_URL || 'http://127.0.0.1:8777/index.html';
const SUITES = ['e2e-search.js', 'e2e-scene.js', 'e2e-region.js'];

const ab = (args) =>
  execFileSync('agent-browser', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** agent-browser eval 的输出是 pretty-printed JSON，可能夹带提示行 —— 从首个 '[' 截到末个 ']' */
function parseResult(out) {
  const a = out.indexOf('[');
  const b = out.lastIndexOf(']');
  if (a < 0 || b < a) throw new Error('输出里找不到 JSON 数组：\n' + out.slice(0, 500));
  return JSON.parse(out.slice(a, b + 1));
}

let total = 0;
let pass = 0;
const failed = [];

for (const suite of SUITES) {
  // ── 隔离：每套前重新导航，清掉上一套留下的 DOM / 相机 / 模式状态 ──
  ab(['open', TARGET]);
  ab(['set', 'viewport', '1440', '900']);
  ab(['wait', '3000']);

  let arr;
  try {
    arr = parseResult(ab(['eval', fs.readFileSync(path.join(HERE, suite), 'utf8')]));
  } catch (e) {
    console.log(`✗ ${suite.padEnd(16)} 执行失败：${e.message.split('\n')[0]}`);
    failed.push({ suite, name: '(脚本执行失败)', extra: e.message.split('\n')[0] });
    total += 1;
    continue;
  }

  const p = arr.filter((r) => r.pass).length;
  total += arr.length;
  pass += p;
  const bad = arr.filter((r) => !r.pass);
  bad.forEach((r) => failed.push({ suite, name: r.name, extra: r.extra }));
  console.log(`${bad.length ? '✗' : '✓'} ${suite.padEnd(16)} ${String(p).padStart(3)} / ${arr.length}`);
}

console.log('-'.repeat(46));
console.log(`合计 ${pass} / ${total}  ${pass === total ? '✅ 全部通过' : '❌ 存在失败'}`);

if (failed.length) {
  console.log('\n失败明细：');
  failed.forEach((f) => console.log(`  ✗ [${f.suite}] ${f.name}${f.extra ? '  —— ' + f.extra : ''}`));
  process.exit(1);
}
