// 诗词数据聚合层：站点、诗篇、诗句库与自动生成的练习题

import { SITES_NORTH } from './sites-north.js';
import { SITES_CENTRAL } from './sites-central.js';
import { SITES_SOUTH } from './sites-south.js';
import { SITES_NEW_NORTH, SITES_NEW_CENTRAL, SITES_NEW_SOUTH } from './sites-new.js';
import { SITE_READING } from './sites-reading.js';
import { POEMS_TEXTBOOK } from './poems-textbook.js';
import { DYNASTIES, THEMES, REGIONS, ROUTES, FEIHUA_KEYS } from './meta.js';

/**
 * 朝代名 → 筛选用的朝代 id（与 meta.js 的 DYNASTIES 对应）。
 * 站点自带一个 era（主朝代），但一处诗境往往横跨数代：
 * 西湖既有白居易的唐音，也有苏轼的宋调，还收了于谦（明）、龚自珍（清）。
 * 只按站点 era 筛选会让「元明清」这类选项变成永远点不出东西的死选项。
 */
const DYN_ERA_RULES = [
  [/^(先秦|战国|西周|东周|春秋)/, 'xy'],
  [/^(汉|魏|三国|建安|汉魏)/, 'hw'],
  [/^(东晋|西晋|两晋|晋|南北朝|南朝|北朝)/, 'jn'],
  [/^唐/, 'tang'],
  [/^宋/, 'song'],
  [/^(元|明|清|金|辽)/, 'yh'],
];

export function dynastyEra(d) {
  for (const [re, id] of DYN_ERA_RULES) if (re.test(d)) return id;
  return null;
}

// 教材扩容批：按 site 字段分桶，聚合时并入目标站点（见 poems-textbook.js）
const EXTRA = new Map();
POEMS_TEXTBOOK.forEach(({ site, ...p }) => {
  if (!EXTRA.has(site)) EXTRA.set(site, []);
  EXTRA.get(site).push(p);
});

// 站点 → 覆盖的朝代集合（站点自身 era ∪ 其全部诗篇的朝代）
const tag = (list, region) => list.map((s) => {
  const extra = EXTRA.get(s.id) || [];
  const poems = extra.length ? [...s.poems, ...extra] : s.poems;
  const eras = new Set([s.era]);
  // 虚拟专题站点（如「课内诵读」）只按自身那一档匹配，不并入各朝代档。
  // 否则它收了唐宋元明清各代的篇目，就会在每一个朝代筛选里都冒出来，把地理筛选搅浑。
  if (!s.virtual) {
    poems.forEach((p) => {
      const e = dynastyEra(p.dynasty);
      if (e) eras.add(e);
    });
  }
  return { ...s, region, eras: [...eras], poems };
});

export const SITES = [
  ...tag(SITES_NORTH, 'north'),
  ...tag(SITES_NEW_NORTH, 'north'),
  ...tag(SITES_CENTRAL, 'central'),
  ...tag(SITES_NEW_CENTRAL, 'central'),
  ...tag(SITES_SOUTH, 'south'),
  ...tag(SITES_NEW_SOUTH, 'south'),
  ...tag([SITE_READING], 'read'),
];

export const SITE_MAP = new Map(SITES.map((s) => [s.id, s]));
export { DYNASTIES, THEMES, REGIONS, ROUTES, FEIHUA_KEYS };

export const ERA_MAP = new Map(DYNASTIES.map((d) => [d.id, d]));

// —— 诗篇扁平表 ——
export const POEMS = [];
SITES.forEach((site) => {
  site.poems.forEach((p) => {
    POEMS.push({ ...p, siteId: site.id, siteName: site.name, siteSub: site.sub, era: site.era });
  });
});

// —— 诗句库（用于飞花令 / 补句 / 检索）——
const stripPunct = (s) => s.replace(/[，。？！；：、（）「」《》\s]/g, '');

export const LINE_BANK = [];
POEMS.forEach((p) => {
  p.lines.forEach((group, gi) => {
    group.forEach((raw) => {
      const text = stripPunct(raw);
      if (text.length < 4) return;
      LINE_BANK.push({
        text,
        raw,
        group: gi,
        poemId: p.id,
        title: p.title,
        author: p.author,
        dynasty: p.dynasty,
        siteId: p.siteId,
        siteName: p.siteName,
        theme: (SITE_MAP.get(p.siteId) || {}).themes || [],
      });
    });
  });
});

// 按字索引，供飞花令快速检索
export const CHAR_INDEX = new Map();
LINE_BANK.forEach((l) => {
  for (const ch of new Set(l.text.split(''))) {
    if (!CHAR_INDEX.has(ch)) CHAR_INDEX.set(ch, []);
    CHAR_INDEX.get(ch).push(l);
  }
});

export function linesWithChar(ch) {
  return CHAR_INDEX.get(ch) || [];
}

// —— 统计 ——
export const STATS = {
  sites: SITES.length,
  poems: POEMS.length,
  lines: LINE_BANK.length,
  authors: new Set(POEMS.map((p) => p.author)).size,
  dynasties: DYNASTIES.length,
};

// —— 自动生成题库 ——

const shuffle = (arr, seed = Math.random) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(seed() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

/**
 * 题型一：看图（句）识地——给出一句诗，在 3D 地图上点出它的诞生地。
 * 优先选择含明确地名或地理特征的名句。
 */
const GEO_HINTS = [
  '白帝', '黄鹤', '庐山', '西湖', '洞庭', '泰山', '长安', '玉门', '阳关', '凉州', '庐山', '赤壁',
  '秦淮', '姑苏', '扬州', '北固', '巴山', '剑门', '峨眉', '建德', '鹿门', '滁州', '敬亭', '滕王',
  '青海', '轮台', '阴山', '碣石', '幽州', '雁门', '鹳雀', '辋川', '蓝关', '罗浮', '儋州', '会稽',
  '桃花潭', '枫桥', '乌衣巷', '洞庭湖', '锦官城', '汨罗', '永州', '塞下',
];

export function buildGeoQuiz(count = 8) {
  const pool = POEMS.filter((p) => {
    // 无地理出处的篇目（「课内诵读」专题）不能出「识地」题——它们本来就没有诞生地
    const site = SITE_MAP.get(p.siteId);
    if (site && site.virtual) return false;
    const txt = p.lines.flat().join('');
    return GEO_HINTS.some((h) => txt.includes(h)) || p.level !== '拓展';
  });
  const picked = shuffle(pool).slice(0, count);
  return picked.map((p) => {
    const all = p.lines.flat();
    // 优先挑含地名的句子，否则用首句
    const hint = all.find((l) => GEO_HINTS.some((h) => l.includes(h))) || all[0];
    // 干扰项同样排除虚拟专题站点，否则四选一里会出现一个不可能「被点在地图上」的答案
    const others = shuffle(SITES.filter((s) => s.id !== p.siteId && !s.virtual)).slice(0, 3);
    return {
      type: 'geo',
      prompt: hint,
      poemTitle: p.title,
      author: p.author,
      dynasty: p.dynasty,
      answer: p.siteId,
      answerName: p.siteName,
      explanation: `出自${p.dynasty}·${p.author}《${p.title}》，写于${p.siteName}（${p.siteSub}）。`,
      choices: shuffle([SITE_MAP.get(p.siteId), ...others]).map((s) => ({ id: s.id, name: s.name })),
    };
  });
}

/** 题型二：补全诗句——给出上句，四选一 */
export function buildFillQuiz(count = 8) {
  const candidates = [];
  POEMS.forEach((p) => {
    p.lines.forEach((group) => {
      if (group.length === 2) {
        candidates.push({
          first: group[0],
          second: group[1],
          title: p.title,
          author: p.author,
          dynasty: p.dynasty,
          siteId: p.siteId,
          siteName: p.siteName,
        });
      }
    });
  });
  const picked = shuffle(candidates).slice(0, count);
  return picked.map((c) => {
    const wrong = shuffle(candidates.filter((x) => x.second !== c.second)).slice(0, 3);
    const site = SITE_MAP.get(c.siteId);
    return {
      type: 'fill',
      prompt: c.first,
      answer: c.second,
      poemTitle: c.title,
      author: c.author,
      dynasty: c.dynasty,
      siteId: c.siteId,
      explanation: site && site.virtual
        ? `出自${c.dynasty}·${c.author}《${c.title}》，收于「${c.siteName}」专题。`
        : `出自${c.dynasty}·${c.author}《${c.title}》，与「${c.siteName}」相关。`,
      choices: shuffle([c.second, ...wrong.map((w) => w.second)]),
    };
  });
}

/** 题型三：飞花令——列出含指定字的诗句 */
export function buildFeihua(ch, count = 6) {
  const pool = linesWithChar(ch);
  return shuffle(pool).slice(0, count).map((l) => ({
    text: l.raw,
    title: l.title,
    author: l.author,
    dynasty: l.dynasty,
    siteName: l.siteName,
    siteId: l.siteId,
  }));
}

/** 全文检索 */
export function search(keyword) {
  const k = keyword.trim();
  if (!k) return [];
  const out = [];
  SITES.forEach((s) => {
    if (s.name.includes(k) || s.sub.includes(k) || s.story.includes(k)) {
      out.push({ kind: 'site', id: s.id, title: s.name, sub: s.sub, weight: 3 });
    }
  });
  POEMS.forEach((p) => {
    const text = p.lines.flat().join('');
    if (p.title.includes(k)) out.push({ kind: 'poem', id: p.siteId, poemId: p.id, title: p.title, sub: `${p.dynasty}·${p.author}`, weight: 3 });
    else if (p.author.includes(k)) out.push({ kind: 'poem', id: p.siteId, poemId: p.id, title: p.title, sub: `${p.dynasty}·${p.author}`, weight: 2 });
    else if (text.includes(k)) {
      const hit = p.lines.flat().find((l) => l.includes(k));
      out.push({ kind: 'line', id: p.siteId, poemId: p.id, title: hit, sub: `${p.dynasty}·${p.author}《${p.title}》`, weight: 1 });
    }
  });
  return out.sort((a, b) => b.weight - a.weight).slice(0, 24);
}
