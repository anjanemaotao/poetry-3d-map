#!/usr/bin/env node
/* 缩放补偿 + HUD 精度回归 runner（本地开发用）。
 *
 * 为什么要单独的 runner 而不是塞进 e2e-all.mjs：
 * 这段断言要**反复移动相机并等待落定**（默认视角 → 中等放大 → 拉到最近 → 复位），
 * 单次执行 6 秒以上，和 e2e-all 里那几套「一口气跑完」的脚本节奏不同；
 * 混在一起会让 e2e-all 的耗时与失败定位都变差。
 *
 * 用法：
 *   node tools/e2e-zoom.mjs
 * 前置：本地静态服务器已启动（serve.py），agent-browser 已安装。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TARGET = process.env.E2E_URL || 'http://127.0.0.1:8777/index.html';
const ab = (args) => execFileSync('agent-browser', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

function evalValue(js) {
  const out = ab(['eval', js]).trim();
  let v;
  try { v = JSON.parse(out); } catch { return out; }
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return v; } }
  return v;
}

/** 打开页面并确认应用真的起来了。
 *  两个坑：`open` 同一 URL 约一半概率停在 about:blank，必须跟一次 reload；
 *  且不能只等固定时长 —— 半渲染的帧会让后面所有断言以奇怪的方式失败。 */
function freshPage() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    ab(['open', TARGET]);
    ab(['set', 'viewport', '1440', '900']);
    ab(['reload']);
    ab(['wait', '3200']);
    const booted = evalValue(
      `!!(window.__app && window.__app.effects && window.__app.effects.beacons.size)`
      + ` && location.href.indexOf('127.0.0.1') > 0`,
    );
    if (booted === true) return;
    if (attempt === 2) throw new Error(`页面打不开（已重试 3 次）：${TARGET}`);
  }
}

freshPage();

const out = ab(['eval', fs.readFileSync(path.join(HERE, 'e2e-zoom.js'), 'utf8')]);
const a = out.indexOf('[');
const b = out.lastIndexOf(']');
if (a < 0 || b < a) {
  console.error('✗ 输出里找不到 JSON 数组：\n' + out.slice(0, 800));
  process.exit(1);
}
const R = JSON.parse(out.slice(a, b + 1));

R.forEach((x) => console.log(`${x.pass ? '✓' : '✗'} ${x.name}${x.extra ? '  —— ' + x.extra : ''}`));
const pass = R.filter((x) => x.pass).length;
console.log('-'.repeat(46));
console.log(`合计 ${pass} / ${R.length}  ${pass === R.length ? '✅ 全部通过' : '❌ 存在失败'}`);
if (pass !== R.length) process.exit(1);
