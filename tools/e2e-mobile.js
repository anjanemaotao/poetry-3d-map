/* 窄屏（移动端）回归脚本（在页面上下文里跑，通过 agent-browser eval --stdin 注入）。
 *
 * 为什么单独一套：这一个视口（390×844）里同时藏着三类**只在窄屏才成立**的形态，
 * 而 e2e-all / e2e-region 都跑在 1440×900，一条都覆盖不到：
 *
 *   1. **底栏是横向滚动容器**。390 宽下 `.bottombar` 的 scrollWidth 是 1093、
 *      clientWidth 只有 356 —— 「巡游范围」按钮默认停在 x=617（视口才 390 宽），
 *      用户不横向滚根本看不到它。下拉浮层若照搬按钮的 rect.left 就会飘到屏幕外，
 *      文字也跟着看不清（用户报的「下拉框位置偏移到其他地方去了」）。
 *   2. **两栏 + 行迹面板都是覆盖式抽屉**，铺满屏幕。行迹面板在 390 宽下是 340px，
 *      占 87% 屏宽 —— 选完诗人不收起来，用户「选了诗人却看不见行迹画在哪」。
 *   3. **抽屉开关的位置是按面板宽度现算的**，各断点宽度不同，写死一定错位。
 *
 * 判定口径沿用项目约定：一律断言**渲染结果**（getBoundingClientRect /
 * getComputedStyle），不断言类名 —— 类名是意图，不是事实。
 */
(() => {
  const R = [];
  const rec = (name, pass, extra = '') => R.push({ name, pass: !!pass, extra: String(extra) });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const fire = (el, type) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
  const realClick = (el) => ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((t) => fire(el, t));
  const box = (sel) => {
    const el = typeof sel === 'string' ? $(sel) : sel;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
  };
  /** 元素真的看得见：有面积、display 不为 none、visibility 不为 hidden */
  const shown = (el) => {
    const e = typeof el === 'string' ? $(el) : el;
    if (!e) return false;
    const s = getComputedStyle(e);
    return s.display !== 'none' && s.visibility !== 'hidden'
      && e.getBoundingClientRect().width > 0;
  };
  /** 与视口有交集（「用户点得到」的最低标准） */
  const onScreen = (el) => {
    const b = box(el);
    return !!b && b.w > 0 && b.h > 0 && b.right > 0 && b.x < window.innerWidth
      && b.bottom > 0 && b.y < window.innerHeight;
  };
  /** 完全落在视口内 */
  const insideViewport = (el) => {
    const b = box(el);
    return !!b && b.w > 0 && b.h > 0
      && b.x >= -1 && b.right <= window.innerWidth + 1
      && b.y >= -1 && b.bottom <= window.innerHeight + 1;
  };
  /** rgba(...) 的 alpha 通道 */
  const alphaOf = (color) => {
    const m = /rgba?\(([^)]+)\)/.exec(color || '');
    if (!m) return 1;
    const parts = m[1].split(',').map((s) => parseFloat(s));
    return parts.length >= 4 ? parts[3] : 1;
  };
  /** 元素自身的可见像素面积（供「浮层有没有真画出来」这类判定） */
  const viewportArea = () => window.innerWidth * window.innerHeight;

  return (async () => {
    if (!window.__app) { rec('页面已启动', false, 'window.__app 不存在'); return R; }
    const app = window.__app;
    const VW = window.innerWidth;
    const VH = window.innerHeight;

    rec('视口确实落在窄屏档（body.narrow）', document.body.classList.contains('narrow'),
      `${VW}×${VH}，narrow=${document.body.classList.contains('narrow')}`);

    /* ================= 1. 「巡游范围」下拉：位置、宽度、可读性 =================
       用户原话是「下拉框位置偏移到其他地方去了，并且文字看不清，样式风格与整体不统一」。
       三件事分别对应：rect 有没有出视口、文字颜色的 alpha 够不够、背景是不是浏览器默认。
       这里全部量出来，而不是看 CSS 里写没写。 */
    {
      const bar = $('.bottombar');
      rec('底栏是横向滚动容器（这正是浮层会飘出去的原因）',
        bar && bar.scrollWidth > bar.clientWidth + 8,
        bar ? `scrollWidth ${bar.scrollWidth} / clientWidth ${bar.clientWidth}` : '找不到 .bottombar');
      if (bar) bar.scrollLeft = 0;

      const btn = $('#tourScopeBtn');
      rec('「巡游范围」按钮存在', !!btn);
      if (btn) {
        const btnBefore = box(btn);
        rec('按钮默认停在视口外（不横向滚就看不到）—— 前置条件',
          btnBefore.x > VW || btnBefore.right < 0,
          `按钮 x=${Math.round(btnBefore.x)}，视口宽 ${VW}`);

        realClick(btn);
        await sleep(500);
        const menu = $('#tourScopeMenu');
        rec('点按钮 → 浮层出现', shown(menu));
        if (menu) {
          rec('浮层完全落在视口内（不偏移到屏幕外）', insideViewport(menu),
            `rect x=${Math.round(box(menu).x)} right=${Math.round(box(menu).right)} ` +
            `y=${Math.round(box(menu).y)} bottom=${Math.round(box(menu).bottom)}（视口 ${VW}×${VH}）`);

          /* 宽度：下拉不该比触发它的按钮还窄。
             这条守的是「min-width 在 display:none 下量成 0」那个坑 ——
             当时浮层缩成 166px 而按钮 314px，看起来像个残缺的浮条。 */
          const bw = box($('#tourScopeBtn')).w;
          const mw = box(menu).w;
          rec('浮层宽度不小于按钮宽度（min-width 没被量成 0）',
            mw >= Math.min(bw, VW - 16) - 2,
            `浮层 ${Math.round(mw)}px / 按钮 ${Math.round(bw)}px`);

          /* 位置：浮层必须与按钮在横向上有重叠，否则就是「飘到别处去了」。
             底栏按钮可以被 scrollIntoView 挪动，所以这里比的是**当前**的按钮位置。 */
          const b2 = box($('#tourScopeBtn'));
          const ov = Math.min(box(menu).right, b2.right) - Math.max(box(menu).x, b2.x);
          rec('浮层与按钮横向对齐（没有飘到别处）', ov > 0,
            `横向重叠 ${Math.round(ov)}px`);

          const cs = getComputedStyle(menu);
          rec('浮层用的是主题深色玻璃底，不是浏览器默认白底',
            alphaOf(cs.backgroundColor) > 0.5 && !/^rgb\(255,\s*255,\s*255\)$/.test(cs.backgroundColor),
            `背景 ${cs.backgroundColor}`);
          rec('浮层有圆角（与整体风格统一）',
            parseFloat(cs.borderRadius) >= 6, `border-radius ${cs.borderRadius}`);

          const opts = $$('#tourScopeMenu [role="option"]');
          rec('浮层里有可选项', opts.length > 0, `${opts.length} 项`);
          if (opts.length) {
            const oc = getComputedStyle(opts[0]);
            rec('选项文字不透明到看得清（alpha ≥ 0.7）', alphaOf(oc.color) >= 0.7,
              `color ${oc.color}`);
            rec('选项字号不小于 11px', parseFloat(oc.fontSize) >= 11, `${oc.fontSize}`);
          }

          realClick(opts[0] || menu);
          await sleep(400);
          rec('点选项 → 浮层自动关闭', !shown(menu));
        }
        if (bar) bar.scrollLeft = 0;
      }
    }

    /* ================= 2. 诗人下拉：不在面板里常驻占位 ================= */
    {
      $('[data-mode="route"]').click();
      await sleep(900);
      const menu = $('#routePoetMenu');
      rec('进行迹模式 → 行迹面板可见', shown('#routePanel'));

      /* 用户报的第 1 条：16 位诗人平铺在面板里，把详情挤出视野。
         判定「没平铺」看的是**渲染结果** —— 浮层没显示，且面板里看不到任何诗人行。 */
      const visibleRows = $$('#routePoetMenu .route-item')
        .filter((el) => el.getBoundingClientRect().height > 0).length;
      rec('诗人列表默认不占位（收在浮层里，面板只剩按钮）',
        !shown(menu) && visibleRows === 0,
        `浮层 display=${getComputedStyle(menu).display}，可见诗人行 ${visibleRows}`);
      rec('下拉按钮显示的是占位文案「选择诗人」',
        $('#routePoetLabel').textContent.trim() === '选择诗人',
        $('#routePoetLabel').textContent.trim());
      rec('下拉按钮占满面板宽度（没被挤成一条窄条）',
        box('#routePoetBtn').w >= box('#routePanel').w - 30,
        `按钮 ${Math.round(box('#routePoetBtn').w)}px / 面板 ${Math.round(box('#routePanel').w)}px`);

      realClick($('#routePoetBtn'));
      await sleep(500);
      rec('点按钮 → 浮层出现', shown(menu));
      rec('浮层里有 16 位诗人', $$('#routePoetMenu .route-item').length === 16,
        `${$$('#routePoetMenu .route-item').length} 位`);
      rec('浮层完全落在视口内', insideViewport(menu),
        `rect x=${Math.round(box(menu).x)} right=${Math.round(box(menu).right)} y=${Math.round(box(menu).y)} bottom=${Math.round(box(menu).bottom)}`);
      /* 浮层必须挂到 body 下：祖先只要带 transform，fixed 后代就会相对该祖先定位，
         而 #routePanel 收起用的正是 translateX —— 留在里面会跟着一起飞出屏幕。 */
      rec('浮层已 portal 到 <body> 下（不受面板 transform 影响）',
        menu.parentElement === document.body, `父节点 ${menu.parentElement.tagName}`);
      rec('按钮 aria-expanded 同步为 true',
        $('#routePoetBtn').getAttribute('aria-expanded') === 'true');

      /* ================= 3. 选完诗人 → 自动收起面板（用户报的第 2 条） ================= */
      const first = $$('#routePoetMenu .route-item')[0];
      const poetName = first.querySelector('.rn').textContent.trim();
      realClick(first);
      await sleep(2400);

      rec('选完诗人 → 浮层自动收起',
        !shown(menu) && $('#routePoetBtn').getAttribute('aria-expanded') === 'false',
        `display=${getComputedStyle(menu).display} aria=${$('#routePoetBtn').getAttribute('aria-expanded')}`);
      rec('选完诗人 → 按钮上换成诗人名',
        $('#routePoetLabel').textContent.trim() === poetName,
        `${$('#routePoetLabel').textContent.trim()}（应为 ${poetName}）`);

      const pb = box('#routePanel');
      rec('窄屏选完诗人 → 行迹面板整块移出视口',
        pb.right <= 0 || pb.x >= VW,
        `面板 x=${Math.round(pb.x)} right=${Math.round(pb.right)}（视口宽 ${VW}）`);

      /* 真正要保的是「地图看得见」。面板不收时 390 宽里被占 340px，
         只剩 50px —— 行迹画在哪完全看不出来，而行迹才是这一步的目的。 */
      const covered = Math.max(0, Math.min(VW, pb.right) - Math.max(0, pb.x));
      rec('选完诗人 → 地图可见宽度 ≥ 90% 视口',
        (VW - covered) >= VW * 0.9,
        `被面板遮住 ${Math.round(covered)}px，剩 ${Math.round(VW - covered)}px`);

      /* 负向：面板收起后必须留下一个能把它叫回来的入口，
         否则「选了诗人反而回不去详情」。 */
      const tb = box('#toggleRoute');
      rec('收起后留下「行迹」开关且看得见可点',
        onScreen('#toggleRoute') && tb.w >= 20,
        tb ? `rect x=${Math.round(tb.x)} w=${Math.round(tb.w)} h=${Math.round(tb.h)}` : '开关不存在');
      rec('开关处于「已收起」语义（aria-expanded=false）',
        $('#toggleRoute').getAttribute('aria-expanded') === 'false',
        $('#toggleRoute').getAttribute('aria-expanded'));

      /* 气泡是行迹模式下最占横向空间的东西：面板不收时它们会被挤到屏幕右边。
         面板让位后应当整批回到视口内。 */
      const bubbles = $$('#bubbleLayer .rb-bubble').map((e) => e.getBoundingClientRect());
      rec('面板收起后气泡全部落在视口内',
        bubbles.length > 0 && bubbles.every((r) => r.left > -2 && r.right < VW + 2),
        bubbles.length
          ? `${bubbles.length} 个，最左 ${Math.round(Math.min(...bubbles.map((r) => r.left)))} 最右 ${Math.round(Math.max(...bubbles.map((r) => r.right)))}`
          : '没有气泡');

      /* ---- 3b. 气泡上下分带（窄屏专属版式） ----
         窄屏下「左右两栏」会退化成贴着右边缘的一整列 —— 实测 390×844 里
         9 张卡全挤在 x=194，从 y=153 一直糊到 y=688，行迹正好被压在底下（用户截图）。
         改成上下两条带之后，中间必须留出一条**没有任何卡片**的横带。
         判据一律量渲染结果，不量「走了哪条分支」—— 分支名是意图，不是事实。 */
      const bb = $$('#bubbleLayer .rb-bubble').map((e) => {
        const r = e.getBoundingClientRect();
        return { x: r.left, y: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height };
      });

      /* 顶带贴顶、底带贴底。少了这条，「两带都挤在中间」也能满足「有空白带」。 */
      const bandTop = Math.min(...bb.map((r) => r.y));
      const bandBottom = Math.max(...bb.map((r) => r.bottom));
      rec('气泡分上下两带：顶带贴顶、底带贴底',
        bb.length > 0 && bandTop <= VH * 0.18 && bandBottom >= VH * 0.82,
        `顶带 y=${Math.round(bandTop)}，底带 bottom=${Math.round(bandBottom)}（视口高 ${VH}）`);

      /* 中间那条「让给地图」的空带 —— 这条需求的核心。
         按「排」归并后取相邻两排之间的最大空隙，而不是看某个写死的坐标：
         卡片高度是内容决定的（49~51px），写死坐标会在换诗人时假失败。 */
      const rows = [...new Set(bb.map((r) => Math.round(r.y)))].sort((a, b) => a - b);
      const rowBottom = (y) => Math.max(...bb.filter((r) => Math.round(r.y) === y).map((r) => r.bottom));
      let gapMax = 0;
      let gapAt = 0;
      for (let i = 1; i < rows.length; i += 1) {
        const g = rows[i] - rowBottom(rows[i - 1]);
        if (g > gapMax) { gapMax = g; gapAt = Math.round(rowBottom(rows[i - 1])); }
      }
      rec('两带之间留出 ≥ 120px 空白横带（地图与行迹不被卡片压住）',
        gapMax >= 120,
        `最大空隙 ${Math.round(gapMax)}px（y=${gapAt} 起）`);

      /* 抽屉开关钉在屏幕左右边缘各 30px（见 .panel-toggle），卡片不能压上去。 */
      const onToggle = bb.filter((r) => r.x < 30 || r.right > VW - 30);
      rec('气泡不压抽屉开关（左右各让开 30px）',
        bb.length > 0 && onToggle.length === 0,
        onToggle.length ? `${onToggle.length} 个越界` : `最左 ${Math.round(Math.min(...bb.map((r) => r.x)))} 最右 ${Math.round(Math.max(...bb.map((r) => r.right)))}`);

      realClick($('#toggleRoute'));
      await sleep(800);
      rec('点开关 → 面板回到原位', box('#routePanel').x >= 0,
        `面板 x=${Math.round(box('#routePanel').x)}`);
      rec('展开后开关的 aria-expanded 同步为 true',
        $('#toggleRoute').getAttribute('aria-expanded') === 'true');
      rec('展开后开关仍与面板外缘相邻（没有叠在面板上）',
        box('#toggleRoute').x >= box('#routePanel').right - 2,
        `开关 x=${Math.round(box('#toggleRoute').x)} / 面板 right=${Math.round(box('#routePanel').right)}`);

      /* ================= 4. 退出 / 再次进入：状态必须复位 ================= */
      realClick($('#routeClose'));
      await sleep(800);
      rec('退出行迹 → 面板隐藏', !shown('#routePanel'));
      rec('退出行迹 → 行迹开关一并隐藏（不留一个点了没反应的按钮）',
        !shown('#toggleRoute'), `display=${getComputedStyle($('#toggleRoute')).display}`);

      $('[data-mode="route"]').click();
      await sleep(800);
      rec('再次进行迹模式 → 面板是展开的（收起状态已复位）',
        box('#routePanel').x >= 0 && !document.body.classList.contains('hide-route'),
        `面板 x=${Math.round(box('#routePanel').x)} hide-route=${document.body.classList.contains('hide-route')}`);
      rec('再次进行迹模式 → 行迹开关可见',
        shown('#toggleRoute'), `display=${getComputedStyle($('#toggleRoute')).display}`);
      /* 负向：上一次的诗人选择不该被带过来（面板复位 ≠ 数据复位，两者独立） */
      rec('再次进行迹模式 → 诗人选择与气泡已清空',
        $$('#bubbleLayer .rb-bubble').length === 0,
        `${$$('#bubbleLayer .rb-bubble').length} 个气泡`);

      /* ================= 5. 左右两栏的开关不被行迹开关顶掉 ================= */
      realClick($('#routeClose'));
      await sleep(700);
      rec('非行迹模式 → 行迹开关隐藏、左栏开关回来',
        !shown('#toggleRoute') && shown('#toggleLeft'),
        `route=${getComputedStyle($('#toggleRoute')).display} left=${getComputedStyle($('#toggleLeft')).display}`);
    }

    /* ================= 6. 窄屏抽屉：开关必须留在屏幕内 =================
       开关若跟着面板一起平移出屏，用户「收起后再也找不到展开按钮」——
       这是项目里踩过两次的坑（见 validate.mjs 第 12 项）。窄屏是唯一能复现的形态。 */
    {
      const check = async (key, label) => {
        const btn = $(`#toggle${key}`);
        const cls = key === 'Left' ? 'hide-left' : 'hide-right';
        /* 开关是「点一下取反」，所以**不能假设点一下就一定收起** ——
           窄屏启动时两栏默认就是收起的，第一次点反而是展开。
           先把状态推到「确定收起」，再断言收起态的样子。 */
        if (!document.body.classList.contains(cls)) { realClick(btn); await sleep(600); }
        rec(`${label}：确认已收起（前置）`, document.body.classList.contains(cls),
          `${cls}=${document.body.classList.contains(cls)}`);

        const b = box(btn);
        rec(`${label}：收起后开关仍在视口内可点`,
          b.w > 0 && b.right > 0 && b.x < VW && b.bottom > 0 && b.y < VH,
          `rect x=${Math.round(b.x)} right=${Math.round(b.right)} w=${Math.round(b.w)}`);
        rec(`${label}：收起后开关显示竖排文字（一眼能找到）`,
          getComputedStyle(btn.querySelector('.pt-label')).display !== 'none',
          `pt-label display=${getComputedStyle(btn.querySelector('.pt-label')).display}`);

        realClick(btn);
        await sleep(600);
        rec(`${label}：再点一下能展开回来`,
          !document.body.classList.contains(cls) && box(btn).w > 0,
          `${cls}=${document.body.classList.contains(cls)}`);
      };
      await check('Left', '左栏');
      await check('Right', '右栏');
      /* 互斥：不能两个抽屉同时铺在屏幕上（390 宽下两个并排会把地图整块盖掉）。 */
      rec('窄屏两栏互斥：不会两个抽屉同时展开',
        !(document.body.classList.contains('hide-left') === false
          && document.body.classList.contains('hide-right') === false),
        `hide-left=${document.body.classList.contains('hide-left')} hide-right=${document.body.classList.contains('hide-right')}`);
    }

    /* ================= 7. 浮层不该盖住整屏 ================= */
    {
      const anyBig = ['#tourScopeMenu', '#routePoetMenu']
        .filter((s) => shown(s))
        .filter((s) => box(s).w * box(s).h > viewportArea() * 0.8);
      rec('没有浮层铺满整屏（浮层该是「一小块」而不是「一整页」）',
        anyBig.length === 0, anyBig.join(' ') || '无');
    }

    return R;
  })();
})()
