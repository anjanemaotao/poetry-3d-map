#!/usr/bin/env node
/* 键盘可访问性回归（本地开发用）。
 *
 * 为什么是 Node runner 而不是像 e2e-scene.js 那样注入一段脚本：
 * 「焦点可见」与「Tab 顺序」这两件事**只有真实按键才测得出来**。
 *   - :focus-visible 匹配与否，取决于浏览器认定的「最近一次输入方式」。
 *     在页面里 el.focus() 属于程序化聚焦，浏览器不认，断言 :focus-visible 会得到
 *     假阴性 —— 明明鼠标点不出焦点环、键盘点得出，脚本却两边都测成一样。
 *   - Tab 顺序是浏览器的默认行为。用 dispatchEvent 造一个 keydown 出去，
 *     浏览器不会替你移动焦点，测出来的永远是「焦点没动」。
 * 所以这里用 agent-browser 的 press 发真键，每按一次回页面里问一句「现在焦点在谁身上」。
 *
 * 断言的口径是**渲染结果**：焦点落在哪个元素（document.activeElement）、
 * 该元素的 outlineStyle 是不是 none、它是不是真的在可见的容器里 —— 而不是
 * 「某个类加上了没有」。
 *
 * 用法：
 *   node tools/e2e-a11y.mjs
 * 前置：本地静态服务器已启动（serve.py），agent-browser 已安装。
 */
import { execFileSync } from 'node:child_process';

const TARGET = process.env.E2E_URL || 'http://127.0.0.1:8777/index.html';
const ab = (args) => execFileSync('agent-browser', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/**
 * 取回 eval 的结果。
 * agent-browser 把返回值序列化成 JSON 文本输出；若返回值本身已经是一个 JSON 字符串
 * （本脚本为了取回结构化数据都这么写），拿到的就是「带引号的 JSON 字符串」，要再解一层。
 * 不处理这一层的话，`JSON.parse` 得到的是一个**字符串**，spread 出来全是下标键，
 * 所有字段读出来都是 undefined —— 表现为「脚本在跑、断言全错」，很难一眼看出是取值的问题。
 */
function evalValue(js) {
  const out = ab(['eval', js]).trim();
  let v;
  try { v = JSON.parse(out); } catch { return out; }
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return v; } }
  return v;
}

const R = [];
const rec = (name, pass, extra = '') => R.push({ name, pass: !!pass, extra: String(extra) });

/** 页面里描述「当前焦点在谁身上」的小工具，每次按完 Tab 都跑一遍 */
const DESCRIBE = `JSON.stringify((() => {
  const a = document.activeElement;
  /* 焦点绕回文档（Tab 走完一圈）时 activeElement 就是 body。
     这里仍然要返回完整的字段结构：调用方会对 stops 做 filter 取 cls / text，
     少一个字段就会读到 undefined 而整段崩掉 —— 窄屏可聚焦元素本来就少，
     10 次 Tab 之内很可能就绕回来了，所以这不是理论情况。 */
  if (!a || a === document.body) {
    return { tag: 'BODY', id: '', cls: '', text: '', inLeft: false, inRight: false, inModal: false, focusVisible: false, outline: 'none' };
  }
  const c = getComputedStyle(a);
  return {
    tag: a.tagName,
    id: a.id || '',
    cls: typeof a.className === 'string' ? a.className : '',
    text: (a.textContent || '').trim().slice(0, 10),
    inLeft: !!a.closest('#leftPanel'),
    inRight: !!a.closest('#rightPanel'),
    inModal: !!a.closest('#poemModal'),
    focusVisible: a.matches(':focus-visible'),
    outline: c.outlineStyle,
  };
})())`;

const active = () => evalValue(DESCRIBE);
const pressTab = () => { ab(['press', 'Tab']); };
const clickSel = (sel) => { ab(['click', sel]); };

/** 把焦点清回「还没按过 Tab」的干净状态。
 *
 * 注意 blur() **做不到**这件事：blur 之后 activeElement 确实变回 <body>，
 * 但浏览器记着「顺序焦点导航的起点」，下一次 Tab 仍从刚才那个元素往后走 ——
 * 于是「点击开关 → blur → Tab」会直接从开关的**下一个**元素开始，
 * 跳过它前面的整个左栏，看起来像「左栏内容不可聚焦」，其实只是没从头走。
 * 可靠的办法是一路 Tab 回到已知的第一站（搜索框），再开始记录。 */
const resetFocus = () => {
  ab(['eval', `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return 1; })()`]);
};
function tabToFirst(max = 80) {
  for (let i = 0; i < max; i += 1) {
    pressTab();
    if (active().id === 'searchInput') return true;
  }
  return false;
}

/** 重新打开页面并等待应用就绪 —— 每段之间都要做，避免上段留下的焦点 / 模式污染下段 */
function freshPage(w, h) {
  /* 两个坑，都是实测踩出来的：
     1) 「等固定时长」不够。浏览器会话偶尔会停在 about:blank，
        此时后面所有断言都会以奇怪的方式失败（点不到 #toggleLeft、body 上没有类名），
        看起来像功能坏了，其实是页面根本没打开 —— 必须先确认应用真的起来了。
     2) `open` 本身不稳定。连续 open 同一 URL 时约有一半概率停在 about:blank
        （实测 3 次里失败 1 次）；后面跟一次 `reload` 则连测 4 次全中。
        所以顺序固定为 open → 设视口 → reload，不要只 open。 */
  for (let attempt = 0; attempt < 3; attempt += 1) {
    ab(['open', TARGET]);
    ab(['set', 'viewport', String(w), String(h)]);
    ab(['reload']);
    ab(['wait', '3200']);
    const booted = evalValue(
      `!!document.querySelector('#searchInput') && document.body.children.length > 0 && location.href.indexOf('127.0.0.1') > 0`,
    );
    if (booted === true) { resetFocus(); return; }
    if (attempt === 2) throw new Error(`页面打不开（已重试 3 次）：${TARGET}`);
  }
}

/* ================= 一、宽屏：Tab 顺序与焦点可见 ================= */
console.log('[1] 宽屏 Tab 顺序与焦点可见');
{
  freshPage(1440, 900);

  const stops = [];
  for (let i = 0; i < 10; i += 1) { pressTab(); stops.push(active()); }

  // 跳转链接是文档里第一个可聚焦元素，所以搜索框退到第二站
  rec('首个 Tab 落在跳转链接', stops[0].cls.includes('skip-link'), `${stops[0].tag}.${stops[0].cls || '?'}`);
  rec('次个 Tab 落在搜索框', stops[1].id === 'searchInput', `${stops[1].tag}#${stops[1].id}`);

  /* 顶栏之后应当先进入**侧栏内容**（两栏在宽屏是展开的常驻工具），
     而不是一路跳到屏幕边缘的抽屉开关。若收起的面板没退出 Tab 顺序，
     这里会先撞上一堆屏幕外的控件。 */
  const firstPanelStop = stops.findIndex((s) => s.inLeft || s.inRight);
  const firstToggleStop = stops.findIndex((s) => s.cls.includes('panel-toggle'));
  rec('宽屏 Tab 会进入侧栏内容', firstPanelStop >= 0,
    firstPanelStop >= 0 ? `第 ${firstPanelStop + 1} 站：${stops[firstPanelStop].text}` : '10 站内没进过侧栏');
  rec('侧栏内容排在抽屉开关之前',
    firstPanelStop >= 0 && (firstToggleStop < 0 || firstPanelStop < firstToggleStop),
    `侧栏第 ${firstPanelStop + 1} 站 / 开关第 ${firstToggleStop + 1} 站`);

  const noRing = stops.filter((s) => s.tag !== 'BODY' && (s.outline === 'none' || !s.focusVisible));
  rec('每一站都有可见焦点环', noRing.length === 0,
    noRing.length ? `${noRing.length} 站没有焦点环：${noRing.map((s) => s.text).join('/')}` : '10/10');
}

/* ================= 二、窄屏：收起的两栏不得进入 Tab 顺序 ================= */
console.log('[2] 窄屏 Tab 顺序');
{
  freshPage(390, 844);
  const cls = String(evalValue('document.body.className'));
  rec('窄屏标记生效', /narrow/.test(cls), cls.trim());
  rec('窄屏两栏默认收起', /hide-left/.test(cls) && /hide-right/.test(cls), cls.trim());

  const stops = [];
  for (let i = 0; i < 10; i += 1) { pressTab(); stops.push(active()); }

  /* 这是本次修复的核心断言：收起的面板只靠 transform 平移出屏幕，
     元素仍在文档流里 —— 若不额外用 visibility: hidden 摘掉，
     Tab 会一路跑到屏幕外那些看不见的筛选按钮上，用户只看到「按了没反应」。 */
  const leaked = stops.filter((s) => s.inLeft || s.inRight);
  rec('收起的面板内容不出现在 Tab 顺序里', leaked.length === 0,
    leaked.length ? `漏了 ${leaked.length} 个：${leaked.map((s) => s.text).join('/')}` : '10/10 干净');

  const toggleStops = stops.filter((s) => s.cls.includes('panel-toggle'));
  rec('抽屉开关本身仍可 Tab 到', toggleStops.length === 2, `找到 ${toggleStops.length} 个（应为 2）`);

  /* ---- 负向对照：把左栏打开，它的内容**必须**重新可聚焦 ----
     只断言「收起来时够不到」是不够的 —— 把整个面板的 visibility 一律设成 hidden
     也能让上面那条通过，但那样面板打开后依然不可用。 */
  clickSel('#toggleLeft');
  ab(['wait', '800']);
  const backToTop = tabToFirst();   // 归零到搜索框，否则 Tab 会从刚点的开关往后走、跳过左栏
  rec('负向对照前置：能 Tab 回第一站', backToTop);
  const opened = [];
  for (let i = 0; i < 10; i += 1) { pressTab(); opened.push(active()); }
  const inLeft = opened.filter((s) => s.inLeft);
  rec('打开左栏后其内容可聚焦（负向对照）', inLeft.length > 0,
    inLeft.length ? `${inLeft.length} 站落在左栏内：${inLeft.map((s) => s.text).join('/')}` : '左栏打开却依然够不到，说明关过头了');

  rec('窄屏开抽屉时遮罩出现',
    evalValue(`getComputedStyle(document.querySelector('#drawerScrim')).display !== 'none'`) === true);

  // 点遮罩收起抽屉 —— 这是窄屏最主要的「退出」方式
  ab(['eval', `document.querySelector('#drawerScrim').click()`]);
  ab(['wait', '800']);
  rec('点遮罩可收起抽屉',
    evalValue(`document.body.classList.contains('hide-left') && document.querySelector('#drawerScrim').classList.contains('hidden')`) === true);
}

/* ================= 三、诗词弹窗的焦点管理 ================= */
console.log('[3] 弹窗焦点管理');
{
  freshPage(1440, 900);

  // 让「触发元素」是一个真实可聚焦的控件，关弹窗时焦点应当回到它身上
  const opened = evalValue(`JSON.stringify((() => {
    const row = document.querySelector('#siteList .site-row');
    row.focus();
    const before = document.activeElement === row;
    const site = window.__app.SITES.find((s) => s.poems.length > 0);
    window.__app.ui.openPoemModal(site.poems[0], site);
    return { before, after: document.activeElement.id || document.activeElement.tagName };
  })())`);
  rec('触发元素先拿到焦点（前置）', opened.before, String(opened.before));
  rec('弹窗打开后焦点移入弹窗', opened.after === 'poemModalClose', String(opened.after));

  // Tab 若干次：焦点必须一直被关在弹窗里
  let escaped = null;
  for (let i = 0; i < 8; i += 1) {
    pressTab();
    const a = active();
    if (!a.inModal) { escaped = a; break; }
  }
  rec('Tab 被关在弹窗内（8 次未逃出）', !escaped,
    escaped ? `第 ${escaped.text || escaped.tag} 跑到弹窗外` : '8/8 都在弹窗内');

  // Esc 关闭：焦点归还触发元素
  ab(['eval', `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`]);
  ab(['wait', '400']);
  const after = evalValue(`JSON.stringify({
    display: getComputedStyle(document.querySelector('#poemModal')).display,
    focusBack: document.activeElement === document.querySelector('#siteList .site-row'),
  })`);
  rec('Esc 关闭弹窗（渲染结果）', after.display === 'none', `display=${after.display}`);
  rec('关闭后焦点归还触发元素', after.focusBack, String(after.focusBack));
}

/* ================= 四、列表项的键盘激活 ================= */
console.log('[4] 列表项 Enter / 空格');
{
  freshPage(1440, 900);

  // 左栏诗境列表项是 div，靠 keyboardActivate 补的 tabindex + Enter
  const r = evalValue(`JSON.stringify((() => {
    const row = document.querySelector('#siteList .site-row');
    const name = row.querySelector('.rn').textContent.trim();
    row.focus();
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return { name, tabIndex: row.tabIndex, role: row.getAttribute('role') };
  })())`);
  rec('诗境列表项可聚焦', r.tabIndex === 0, `tabIndex=${r.tabIndex}`);
  rec('诗境列表项有 role=button', r.role === 'button', String(r.role));
  ab(['wait', '700']);
  const title = String(evalValue(`(document.querySelector('#detailBody .d-title') || {}).textContent || ''`)).trim();
  rec('Enter 选中的正是该诗境', title === r.name, `点了「${r.name}」，右栏显示「${title || '（空）'}」`);

  /* 空格不能顺手把巡游打开 —— 全局快捷键把空格当「播放 / 暂停」，
     而那个处理器只排除了 INPUT / SELECT，div 上的空格会一路冒泡上去。 */
  const tourBefore = String(evalValue(`document.querySelector('#btnTour').textContent`)).trim();
  evalValue(`JSON.stringify((() => {
    const row = document.querySelectorAll('#siteList .site-row')[1];
    row.focus();
    row.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    return { ok: 1 };
  })())`);
  ab(['wait', '500']);
  const tourAfter = String(evalValue(`document.querySelector('#btnTour').textContent`)).trim();
  rec('列表项上的空格不会触发巡游', tourBefore === tourAfter, `${tourBefore} → ${tourAfter}`);

  // 搜索结果的 ↑↓ 导航：从输入框按一下 ↓ 应当把焦点交给第一条结果
  evalValue(`(() => {
    const i = document.querySelector('#searchInput');
    i.focus();                       // 焦点得先在输入框上，否则 ↓ 根本到不了它的处理器
    i.value = '月';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return 1;
  })()`);
  ab(['wait', '600']);
  ab(['press', 'ArrowDown']);
  ab(['wait', '200']);
  const sr = active();
  rec('搜索框 ↓ 把焦点交给结果项', sr.cls.includes('sr-item'), `${sr.tag}.${sr.cls || '(无类)'}`);
}

/* ================= 五、跳转链接 ================= */
console.log('[5] 跳转链接');
{
  freshPage(1440, 900);

  const SKIP_Y = `Math.round(document.querySelector('.skip-link').getBoundingClientRect().bottom)`;
  const beforeY = Number(evalValue(SKIP_Y));
  rec('未聚焦时跳转链接在视野之外', beforeY <= 0, `bottom=${beforeY}`);

  pressTab();
  const first = active();
  rec('首个可聚焦元素是跳转链接', first.cls.includes('skip-link'), `${first.tag}.${first.cls || '?'}`);

  ab(['wait', '350']);   // 滑入动画 .18s
  const afterY = Number(evalValue(SKIP_Y));
  rec('聚焦后跳转链接滑入视野', afterY > 0, `bottom=${afterY}`);

  // 真按回车激活：焦点应当交到底部工具条，跳过左栏那 79 个诗境条目
  ab(['press', 'Enter']);
  ab(['wait', '350']);
  const landed = evalValue(
    `document.activeElement === document.querySelector('#bottombar')`
    + ` || !!document.activeElement.closest('#bottombar')`,
  );
  rec('激活后焦点落到底部工具条', landed === true, String(landed));
}

/* ================= 六、列表项的可访问名 ================= */
console.log('[6] 列表项可访问名');
{
  freshPage(1440, 900);
  const names = evalValue(`JSON.stringify({
    site: (document.querySelector('#siteList .site-row') || {}).getAttribute
      ? document.querySelector('#siteList .site-row').getAttribute('aria-label') : null,
  })`);
  rec('诗境列表项有 aria-label', !!names.site && /诗境/.test(String(names.site)), String(names.site));

  // 行迹列表要先进入行迹模式才渲染
  evalValue(`document.querySelector('[data-mode="route"]').click()`);
  ab(['wait', '900']);
  const routeName = String(evalValue(`(document.querySelector('#routeList .route-item') || {}).getAttribute ? document.querySelector('#routeList .route-item').getAttribute('aria-label') : ''`));
  rec('行迹列表项有 aria-label', routeName.length > 0 && /行迹 \d+ 站/.test(routeName), routeName);

  // 「气泡」开关按钮：键盘可达 + 有可访问名 + 能被 Enter/Space 触发
  // （这一段只跑一次，1440 宽；窄屏里 bubbleToggle 在抽屉里，路径不同）
  const toggleInfo = evalValue(`JSON.stringify({
    text: (document.querySelector('#bubbleToggle') || {}).innerText || '',
    ariaPressed: document.querySelector('#bubbleToggle') ? document.querySelector('#bubbleToggle').getAttribute('aria-pressed') : null,
    tabIndex: document.querySelector('#bubbleToggle') ? document.querySelector('#bubbleToggle').tabIndex : null,
  })`);
  rec('「气泡」开关存在 + 文字「气泡」', toggleInfo.text.trim() === '气泡', JSON.stringify(toggleInfo));
  rec('「气泡」开关 aria-pressed 默认为 true', toggleInfo.ariaPressed === 'true', String(toggleInfo.ariaPressed));
  rec('「气泡」开关可被 Tab 聚焦（tabIndex !== -1）', toggleInfo.tabIndex !== -1, String(toggleInfo.tabIndex));

  // 从关闭按钮反向 Shift+Tab 到 bubbleToggle，确认它真的在 Tab 顺序里
  ab(['eval', `document.querySelector('#routeClose').focus()`]);
  ab(['wait', '200']);
  ab(['press', 'Shift+Tab']);
  ab(['wait', '200']);
  const focused = evalValue(`JSON.stringify({ id: document.activeElement.id, tag: document.activeElement.tagName })`);
  rec('从关闭按钮 Shift+Tab → 焦点落在「气泡」开关',
    focused.id === 'bubbleToggle', JSON.stringify(focused));

  // Enter 触发切换：aria-pressed 应翻成 false
  ab(['press', 'Enter']);
  ab(['wait', '300']);
  const afterEnter = evalValue(`JSON.stringify({
    pressed: document.querySelector('#bubbleToggle').getAttribute('aria-pressed'),
    layerHidden: document.querySelector('#bubbleLayer').classList.contains('bubble-hidden')
  })`);
  rec('Enter 键触发「气泡」开关 → aria-pressed=false + 层隐藏',
    afterEnter.pressed === 'false' && afterEnter.layerHidden === true, JSON.stringify(afterEnter));

  // Space 也应能触发 —— agent-browser 的 press Space 只发 keydown 不发 keyup，
  // 浏览器就没合成 click（工具边界）。真键盘下 Space 一定会带 keyup。
  // 这里只验「Space keydown 到达按钮」，证明按钮能接收键盘事件；
  // click 行为依赖浏览器默认合成，断言 Enter 已经覆盖。
  ab(['eval', `window.__spaceSeen = false; document.querySelector('#bubbleToggle').addEventListener('keydown', e => { if (e.code === 'Space') window.__spaceSeen = true; }, { once: true })`]);
  ab(['press', 'Space']);
  ab(['wait', '200']);
  const spaceReached = evalValue(`window.__spaceSeen === true`);
  rec('Space 键 keydown 能到达「气泡」开关（click 由浏览器合成）', spaceReached === true, '');
}

/* ================= 结果 ================= */
const pass = R.filter((x) => x.pass).length;
R.forEach((x) => console.log(`${x.pass ? '✓' : '✗'} ${x.name}${x.extra ? '  —— ' + x.extra : ''}`));
console.log('-'.repeat(46));
console.log(`合计 ${pass} / ${R.length}  ${pass === R.length ? '✅ 全部通过' : '❌ 存在失败'}`);
if (pass !== R.length) process.exit(1);
