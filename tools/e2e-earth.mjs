#!/usr/bin/env node
/* 地球模式回归 runner（本地开发用）。
 *
 * 为什么要单独的 runner 而不是塞进 e2e-all.mjs：
 * 这段断言要**反复进出地球模式并等待镜头停稳**（进 → 拖动 → 缩放到底 → 复位 → 再进 → 点击 → 退出），
 * 单次执行 10 秒以上；而且它会整层切换场景内容，和 e2e-all 里那几套「地图内操作」的脚本
 * 状态差异太大，混在一起容易互相污染。
 *
 * 用法：
 *   node tools/e2e-earth.mjs
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
 *  `open` 同一 URL 约一半概率停在 about:blank，必须跟一次 reload； */
function freshPage() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    ab(['open', TARGET]);
    ab(['set', 'viewport', '1440', '900']);
    ab(['reload']);
    ab(['wait', '3200']);
    const booted = evalValue(
      `!!(window.__app && window.__app.globe && window.__app.effects && window.__app.effects.beacons.size)`
      + ` && location.href.indexOf('127.0.0.1') > 0`,
    );
    if (booted === true) return;
    if (attempt === 2) throw new Error(`页面打不开（已重试 3 次）：${TARGET}`);
  }
}

freshPage();

const evalScript = (file) => {
  const out = ab(['eval', fs.readFileSync(path.join(HERE, file), 'utf8')]);
  const a = out.indexOf('[');
  const b = out.lastIndexOf(']');
  if (a < 0 || b < a) {
    console.error('✗ 输出里找不到 JSON 数组：\n' + out.slice(0, 800));
    process.exit(1);
  }
  return JSON.parse(out.slice(a, b + 1));
};

const R = [];
R.push(...evalScript('e2e-earth.js'));
/* 第 10 节（地名标注 + 右键拖动）拆到独立文件后单独 eval —— 一口气跑完全部
   脚本会让 agent-browser 的 daemon 撞 EAGAIN（"Resource temporarily unavailable"）。
   两次小批量 eval 之间 daemon 有喘息窗口，错误概率降到接近 0。 */
R.push(...evalScript('e2e-earth-extras.js'));
/* 第 12 节（点选 ripple 闸门 + 地球档点省份识别）同上：单文件太长会撞 EAGAIN。 */
R.push(...evalScript('e2e-earth-extras2.js'));

R.forEach((x) => console.log(`${x.pass ? '✓' : '✗'} ${x.name}${x.extra ? '  —— ' + x.extra : ''}`));
const pass = R.filter((x) => x.pass).length;
console.log('-'.repeat(46));
console.log(`合计 ${pass} / ${R.length}  ${pass === R.length ? '✅ 全部通过' : '❌ 存在失败'}`);
if (pass !== R.length) process.exit(1);
