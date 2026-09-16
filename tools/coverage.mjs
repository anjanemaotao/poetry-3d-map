// 教材篇目覆盖度检查：把 tools/textbook-list.mjs 的目标清单与 js/data 中已有诗篇做差集。
//
// 用法（在 poetry-3d-map 目录下）：
//   node tools/coverage.mjs           # 摘要 + 缺失清单
//   node tools/coverage.mjs --full    # 额外列出已覆盖篇目

import { POEMS } from '../js/data/poetry.js';
import { TEXTBOOK } from './textbook-list.mjs';

/**
 * 归一化篇名，用于宽松匹配。
 * 只抹掉「（节选）」「（并序）」这类纯版本说明；
 * 「（其一）」「（其二十五）」「（葡萄美酒夜光杯）」「（迟日江山丽）」「（春归何处）」
 * 这类是**区分同名诗的必要信息**，必须保留——否则《绝句（迟日江山丽）》会被
 * 误判成已有《绝句（两个黄鹂鸣翠柳）》，《己亥杂诗（九州生气）》会被误判成
 * 已有《己亥杂诗（其五）》。
 */
const norm = (s) => s
  .replace(/[（(](节选|并序)[）)]/g, '')
  .replace(/[·・\s]/g, '')
  .replace(/[，。？！；：、,.\?!;:]/g, '')
  .trim();

/** 全部抹掉括注，只作兜底匹配用 */
const stripAll = (s) => s
  .replace(/[（(][^）)]*[）)]/g, '')
  .replace(/[·・\s]/g, '')
  .replace(/[，。？！；：、,.\?!;:]/g, '')
  .trim();

/** 目标篇名是否带「区分性括注」。带括注就必须精确匹配，不许兜底 */
const hasDistinctParen = (s) => /[（(]/.test(s.replace(/[（(](节选|并序)[）)]/g, ''));

const haveExact = new Map();
POEMS.forEach((p) => haveExact.set(`${norm(p.title)}|${p.author}`, p));
const havePlain = new Map();          // stripAll(title)|author
POEMS.forEach((p) => {
  const k = `${stripAll(p.title)}|${p.author}`;
  if (!havePlain.has(k)) havePlain.set(k, p);
});
const haveTitle = new Map();          // stripAll(title)
POEMS.forEach((p) => {
  const k = stripAll(p.title);
  if (!haveTitle.has(k)) haveTitle.set(k, p);
});

const missing = [];
const covered = [];
TEXTBOOK.forEach((e) => {
  let hit = haveExact.get(`${norm(e.t)}|${e.a}`);
  // 目标是不带区分性括注的「素名」（如《出塞》对应库里的《出塞（其一）》）时，才允许兜底
  if (!hit && !hasDistinctParen(e.t)) hit = havePlain.get(`${stripAll(e.t)}|${e.a}`);
  if (!hit) hit = haveTitle.get(stripAll(e.t));
  if (hit) covered.push({ ...e, site: hit.siteName, as: hit.title });
  else missing.push(e);
});

const byGrade = (g) => TEXTBOOK.filter((e) => e.g === g).length;
const missByGrade = (g) => missing.filter((e) => e.g === g).length;

console.log('=== 教材篇目覆盖度 ===');
console.log(`目标清单（统编版 小学 + 初中 + 高中新课标诗词曲）：${TEXTBOOK.length} 篇`);
[...new Set(TEXTBOOK.map((e) => e.g))].forEach((g) => {
  console.log(`  ${g} ${byGrade(g)} 篇，缺 ${missByGrade(g)} 篇`);
});
console.log(`当前库内诗篇：${POEMS.length} 篇`);
console.log(`已覆盖教材篇目：${covered.length} 篇（${(covered.length / TEXTBOOK.length * 100).toFixed(1)}%）`);
console.log(`尚缺：${missing.length} 篇`);

console.log('\n=== 缺失清单（按册次） ===');
const order = [...new Set(TEXTBOOK.map((e) => e.n))];
order.forEach((n) => {
  const list = missing.filter((e) => e.n === n);
  if (!list.length) return;
  console.log(`${n}（${list.length}）：` + list.map((e) => `${e.t}·${e.a}`).join('、'));
});

if (process.argv.includes('--full')) {
  console.log('\n=== 已覆盖（按册次） ===');
  order.forEach((n) => {
    const list = covered.filter((e) => e.n === n);
    if (!list.length) return;
    console.log(`${n}（${list.length}）：` + list.map((e) => `${e.t}[${e.site}]`).join('、'));
  });
}

// 库内诗篇里不属于教材清单的（拓展篇目），供参考
const targetSet = new Set(TEXTBOOK.map((e) => norm(e.t)));
const extra = POEMS.filter((p) => !targetSet.has(norm(p.title)));
console.log(`\n库内非教材篇目（拓展）：${extra.length} 篇`);
console.log('  ' + extra.map((p) => p.title).join('、'));
