(async () => {
  const app = window.__app;
  const sl = (ms) => new Promise((r) => setTimeout(r, ms));
  const f = (el, t, i = {}) => el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, ...i }));
  const rc = (el) => { ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((t) => f(el, t)); };
  const $ = (s) => document.querySelector(s);

  // 窄屏（≤860）下两栏是互斥的覆盖式抽屉，另有一套不变量，见 snap() 末尾
  const narrow = document.body.classList.contains('narrow');

  /* 等抽屉滑到位再量。
     面板收起/展开是 320ms 的 transform 过渡，固定 sleep 有时会在动画中途量到一个
     中间值 —— 实测见过「展开后 x 仍然是 -338」的假失败，重跑一次又好了。
     轮询到位置不再变化为止，比赌一个睡眠时长可靠。 */
  const settle = async (sel, tries = 30) => {
    let last = null;
    for (let i = 0; i < tries; i += 1) {
      await sl(50);
      const x = Math.round($(sel).getBoundingClientRect().x);
      if (x === last) return x;
      last = x;
    }
    return last;
  };

  const SEL = {
    topbar: '.topbar', left: '#leftPanel', right: '#rightPanel', bottom: '.bottombar',
    hud: '.hud', regionBar: '#regionBar', routePanel: '#routePanel', quizCard: '#quizCard',
  };

  const rectOf = (s) => {
    const el = $(s);
    if (!el) return null;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') return null;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  };
  const ov = (a, b) => {
    const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    return ox > 2 && oy > 2 ? Math.round(ox * oy) : 0;
  };

  const R = [];
  const snap = (label) => {
    const rects = {};
    Object.entries(SEL).forEach(([k, s]) => { const r = rectOf(s); if (r) rects[k] = r; });
    const ks = Object.keys(rects);
    const bad = [];
    for (let i = 0; i < ks.length; i += 1) {
      for (let j = i + 1; j < ks.length; j += 1) {
        const a = ov(rects[ks[i]], rects[ks[j]]);
        if (a > 0) bad.push(`${ks[i]}×${ks[j]}=${a}`);
      }
    }
    // 让位后侧栏被压得过矮也是问题（内容只剩一两行）
    ['left', 'right', 'routePanel'].forEach((k) => {
      if (rects[k] && rects[k].h < 190) bad.push(`${k} 仅 ${Math.round(rects[k].h)}px 高`);
    });
    // 避让过度同样不可用：练习卡两列选项会挤成一团，诗词条放不下一张卡。
    // 练习卡的宽度不变量最严格：只受视口约束，必须正好是 min(560, 100vw - 24)。
    // 曾经的写法按「两侧栏之间」算，窄屏减出负数 → width 整条失效 → 回退 163px。
    if (rects.quizCard) {
      const want = Math.min(560, innerWidth - 24);
      if (Math.abs(rects.quizCard.w - want) > 2) {
        bad.push(`quizCard ${Math.round(rects.quizCard.w)}px（应为 ${Math.round(want)}px）`);
      }
    }
    if (rects.regionBar && rects.regionBar.w < 240) bad.push(`regionBar 仅 ${Math.round(rects.regionBar.w)}px 宽`);
    // 横向溢出：只看「自己不能滚」的容器 —— .bottombar 是设计上就横向滚动的，
    // 内容超出属于预期（已给它加了可见滚动条）。
    ['.topbar', '.bottombar', '#detailBody', '#siteList'].forEach((s) => {
      const el = $(s);
      if (!el) return;
      const ox = getComputedStyle(el).overflowX;
      if (ox === 'auto' || ox === 'scroll') return;
      if (el.scrollWidth > el.clientWidth + 2) {
        bad.push(`${s} 横向溢出 ${el.scrollWidth - el.clientWidth}px`);
      }
    });
    // 视口外溢：元素右侧越过视口
    ks.forEach((k) => {
      if (rects[k].x + rects[k].w > innerWidth + 2) bad.push(`${k} 右溢 ${Math.round(rects[k].x + rects[k].w - innerWidth)}px`);
    });

    /* ---- 窄屏专项 ----
       窄屏下两栏是盖在地图上的抽屉，必须**互斥**：同时铺两块会互相盖住，
       而且这正是「390 宽下地图只剩约 40px」的病根（两栏各占半屏，并排挤没了地图）。
       这条断言直接编码了修复本身，宽屏不适用（宽屏两栏并排是设计）。 */
    if (narrow) {
      if (rects.left && rects.right) {
        bad.push(`窄屏下左右两栏同时可见（左 ${Math.round(rects.left.w)}px / 右 ${Math.round(rects.right.w)}px，应互斥）`);
      }
      // 抽屉宽度不变量：总要在另一侧留出 ≥32px 的地图缝隙，
      // 让用户看得出「后面还有东西」，不至于以为界面就只剩这一块。
      ['left', 'right', 'routePanel'].forEach((k) => {
        if (rects[k] && rects[k].w > innerWidth - 48 + 2) {
          bad.push(`${k} ${Math.round(rects[k].w)}px 宽，没给地图留出缝隙（上限 ${innerWidth - 48}px）`);
        }
      });
    }
    if (bad.length) R.push(`${label} → ${bad.join(' | ')}`);
  };

  const mesh = [...app.map.hoverTargets].find((x) => app.PROVINCE_SITES.has(x.userData.adcode)
    && app.PROVINCE_SITES.get(x.userData.adcode).sites.length >= 4);

  snap('初始');

  if (mesh) { app.focusProvince(mesh); await sl(700); }
  snap('点省份');

  rc($('#rbClose'));
  await sl(300);
  rc($('[data-mode="route"]'));
  await sl(500);
  const it = $('#routePoetMenu .route-item');
  if (it) { rc(it); await sl(1800); }
  snap('行迹模式');

  if (mesh) { app.focusProvince(mesh); await sl(700); }
  snap('行迹+点省份');

  rc($('#routeClose'));
  await sl(900);

  /* 练习卡：三种题型逐一过一遍。
     「练习卡打开了」曾只对看图识诗置位 —— 补全诗句 / 飞花令 开着卡片却没有 quiz-open，
     HUD 不隐藏、侧栏不让位，还会把刚收起的诗词条又拉回来（卡片×诗词条重叠 95k px²）。
     先点省份把诗词条打开再进练习，才能复现那一层重叠。 */
  for (const t of ['geo', 'fill', 'feihua']) {
    const qb = $(`#classGroup button[data-quiz="${t}"]`);
    if (!qb) continue;
    rc(qb);
    await sl(800);
    snap(`练习-${t}`);
    rc($('#quizClose'));
    await sl(700);
  }

  /* 最坏情形：两栏都试着展开 + 练习卡。861~1080 这一段两栏同时占掉近 600px，
     卡片若还按「两栏之间」算宽度就会窄到 221px。

     窄屏下这一步的含义不同：两栏是互斥抽屉，第二个开关点下去会把第一个收起来。
     所以这里验的不是「摆不摆得下」，而是**互斥到底有没有生效** —— 若不生效，
     两个 340px 的抽屉会把 390 宽的屏幕整个盖满，正是这次要修的问题。 */
  if (document.body.classList.contains('hide-left')) { rc($('#toggleLeft')); await settle('#leftPanel'); }
  if (document.body.classList.contains('hide-right')) { rc($('#toggleRight')); await settle('#rightPanel'); }
  if (narrow) {
    const bothOpen = !document.body.classList.contains('hide-left')
      && !document.body.classList.contains('hide-right');
    if (bothOpen) R.push('窄屏互斥失效：两个抽屉开关都点过之后，两栏仍同时处于展开状态');
    const openOne = !document.body.classList.contains('hide-left')
      || !document.body.classList.contains('hide-right');
    if (!openOne) R.push('窄屏互斥过头：两个开关都点过之后，两栏反而都收起了');
  }
  snap(narrow ? '只开一栏' : '两栏全开');
  rc($('#classGroup button[data-quiz="fill"]'));
  await sl(800);
  snap(narrow ? '只开一栏+练习' : '两栏全开+练习');
  rc($('#quizClose'));
  await sl(700);
  snap('退出练习后');

  return { vp: `${innerWidth}x${innerHeight}`, bad: R.length ? R : ['(无重叠 / 无溢出 / 宽度正常)'] };
})()
