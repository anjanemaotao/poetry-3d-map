/* 浏览器端回归脚本（在页面上下文里跑，通过 agent-browser eval --stdin 注入）。
 *
 * 覆盖本轮新增的四组能力：
 *   1. 左右抽屉收起后，展开按钮必须仍然可见可点（用户反馈「找不到展开按钮」）
 *   2. 点击地图省份 → 右侧地区介绍 + 底部区域诗词列表
 *   3. 点击诗词卡片 → 详情弹窗（内容完整性 + 三条关闭路径）
 *   4. 2D 平面模式切换、行迹模式只显示该行迹的站点
 *
 * 判定口径沿用项目约定：一律断言**渲染结果**（getComputedStyle / getBoundingClientRect /
 * 场景对象状态），不断言类名 —— 类名是意图，不是事实。
 */
(() => {
  const R = [];
  const rec = (name, pass, extra = '') => R.push({ name, pass, extra });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const app = window.__app;

  const fire = (el, type, init = {}) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
  const realClick = (el) => { fire(el, 'pointerdown'); fire(el, 'mousedown'); fire(el, 'pointerup'); fire(el, 'mouseup'); fire(el, 'click'); };

  /** 元素在视口里真的看得见（有面积、display 不为 none、且与视口有交集） */
  const onScreen = (el) => {
    if (!el) return false;
    const b = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden'
      && b.width > 0 && b.height > 0
      && b.right > 0 && b.left < window.innerWidth
      && b.bottom > 0 && b.top < window.innerHeight;
  };
  const shown = (sel) => {
    const el = typeof sel === 'string' ? $(sel) : sel;
    return !!el && getComputedStyle(el).display !== 'none';
  };

  /**
   * 两个浮层的重叠面积（px²）。任一不可见则视为 0。
   *
   * 为什么要专门测这个：浮层都是 fixed 定位、各自为政，**不会自动避让**。
   * 底部诗词条（z 44，居中 980 宽）曾压住右栏 180px 宽（「代表篇目」被切掉）、
   * 左栏 55px、行迹面板 8.5k px²；HUD（z 30）则 100% 落在右栏底下。
   * 这些都是纯视觉问题，数据层和 DOM 结构都看不出异常，只有量矩形才暴露。
   */
  const ovArea = (selA, selB) => {
    const a = $(selA);
    const b = $(selB);
    if (!a || !b) return 0;
    const visible = (el) => {
      const s = getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden';
    };
    if (!visible(a) || !visible(b)) return 0;
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    const ox = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
    const oy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
    return ox > 2 && oy > 2 ? Math.round(ox * oy) : 0;
  };
  const recNoOverlap = (label, selA, selB) => {
    const ar = ovArea(selA, selB);
    rec(label, ar === 0, ar ? `重叠 ${ar}px²` : '无重叠');
  };

  /* ---------- 工具：在某个省份内取若干候选屏幕点 ---------- */
  /**
   * 逐格扫描经纬度，把落在目标省份内的格子等距抽样成一批候选屏幕点。
   *
   * 为什么不只取「省域中心」一个点：
   *   - 三维浮雕地图里各省台面高度不同，射线可能先打中更近/更高的邻省；
   *   - 光柱是竖直圆柱，斜视角下投影成一条又高又窄的竖条，中心点很可能正好被截走。
   * 所以必须在省内多取几个点，逐个验证射线与拾取结果。
   */
  const candidatePointsOfProvince = (adcode, maxPts = 14) => {
    const cells = [];
    for (let lon = 73; lon <= 136; lon += 1) {
      for (let lat = 17; lat <= 55; lat += 1) {
        if (app.provinceAt(lon, lat).code === adcode) cells.push([lon, lat]);
      }
    }
    if (!cells.length) return [];
    const r = app.renderer.domElement.getBoundingClientRect();
    const step = Math.max(1, Math.floor(cells.length / maxPts));
    const out = [];
    for (let i = 0; i < cells.length; i += step) {
      const v = app.lonLatToWorld(cells[i][0], cells[i][1], 0).project(app.camera);
      const x = r.left + (v.x * 0.5 + 0.5) * r.width;
      const y = r.top + (-v.y * 0.5 + 0.5) * r.height;
      if (v.z > 1 || x < 0 || x > window.innerWidth || y < 0 || y > window.innerHeight) continue;
      out.push({ x, y });
    }
    return out;
  };

  /**
   * 与最近光柱的水平屏幕距离。
   * 只看水平：光柱是竖直圆柱，斜视角下投影成竖条，用直线距离会误判
   * （曾挑到一个「直线 56px、水平仅 4px」的点，点击被光柱吃掉）。
   */
  const nearestBeaconDx = (x) => {
    let best = Infinity;
    const p = new (app.lonLatToWorld(0, 0).constructor)();
    app.effects.beacons.forEach((b) => {
      // 抬到拾取柱体中部；柱体随缩放补偿缩短，这里乘同一个系数
      p.copy(b.group.position); p.y += 0.9 * (b.group.scale.y || 1);
      const q = p.project(app.camera);
      const sx = app.renderer.domElement.getBoundingClientRect().left + (q.x * 0.5 + 0.5) * app.renderer.domElement.getBoundingClientRect().width;
      best = Math.min(best, Math.abs(sx - x));
    });
    return best;
  };

  /** 用与主程序相同的射线逻辑，问「这个屏幕点实际落在哪个省」 */
  const resolveProvinceAt = (x, y) => {
    const r = app.renderer.domElement.getBoundingClientRect();
    const V2 = app.pointer.constructor;
    const p = new V2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    app.raycaster.setFromCamera(p, app.camera);
    const hits = app.raycaster.intersectObjects(app.map.hoverTargets, false);
    return hits.length ? hits[0].object.userData : null;
  };

  const clickCanvas = (pt) => {
    const c = app.renderer.domElement;
    fire(c, 'pointerdown', { clientX: pt.x, clientY: pt.y });
    fire(c, 'pointerup', { clientX: pt.x, clientY: pt.y });
  };

  return (async () => {
    if (!app) { rec('页面已启动', false, 'window.__app 不存在'); return R; }
    const tl = $('#toggleLeft');
    const tr = $('#toggleRight');

    /* ================= 1. 抽屉开关 ================= */
    rec('左右两个抽屉开关都在 DOM 里', !!tl && !!tr);

    // 左栏：收起 → 开关必须仍可见；再点 → 必须能展开
    if (!document.body.classList.contains('hide-left')) { realClick(tl); }
    await sleep(450);   // 等 0.32s 的位移过渡走完再量位置
    rec('左栏收起后，展开按钮仍可见', onScreen(tl),
      `left=${tl.style.left} rect=${JSON.stringify(tl.getBoundingClientRect().toJSON ? { l: Math.round(tl.getBoundingClientRect().left), w: Math.round(tl.getBoundingClientRect().width) } : {})}`);
    rec('左栏收起后，按钮贴在屏幕左边缘', tl.getBoundingClientRect().left >= -1 && tl.getBoundingClientRect().left < 4,
      String(Math.round(tl.getBoundingClientRect().left)));
    realClick(tl);
    await sleep(450);
    rec('点左开关 → 左栏展开（按钮回到面板右缘）',
      !document.body.classList.contains('hide-left') && $('#leftPanel').getBoundingClientRect().left > 0,
      String(Math.round($('#leftPanel').getBoundingClientRect().left)));

    // 右栏（与左栏同样先判断当前状态：若已收起还点一下，会把它展开，断言就反过来失败了）
    if (!document.body.classList.contains('hide-right')) { realClick(tr); }
    await sleep(450);
    rec('右栏收起后，展开按钮仍可见', onScreen(tr), `right=${tr.style.right}`);
    rec('右栏收起后，按钮贴在屏幕右边缘',
      window.innerWidth - tr.getBoundingClientRect().right <= 1,
      `right=${Math.round(tr.getBoundingClientRect().right)} vw=${window.innerWidth}`);
    realClick(tr);
    await sleep(450);
    rec('点右开关 → 右栏展开',
      !document.body.classList.contains('hide-right')
      && $('#rightPanel').getBoundingClientRect().right <= window.innerWidth,
      String(Math.round($('#rightPanel').getBoundingClientRect().right)));

    /* ================= 2. 点击省份 → 地区介绍 + 底部诗词列表 ================= */
    // 优先挑「诗篇最多」的省份，才能顺带验证诗词条装得下很多张卡片。
    // 约束：射线必须真的落在这个省上，且附近没有光柱（否则点击会先被光柱吃掉）。
    let pick = null;
    const cands = [...app.PROVINCE_SITES.entries()]
      .map(([code, e]) => ({ code, prov: e.prov, sites: e.sites,
        poems: e.sites.reduce((n, s) => n + s.poems.length, 0) }))
      .filter((c) => c.poems > 0)
      .sort((a, b) => b.poems - a.poems);

    for (const c of cands.slice(0, 12)) {
      let found = null;
      for (const pt of candidatePointsOfProvince(c.code)) {
        const dx = nearestBeaconDx(pt.x);
        if (dx <= 10) continue;
        const hit = resolveProvinceAt(pt.x, pt.y);
        if (!hit) continue;
        // 直接问主程序：这个点会不会被光柱截走？（点击逻辑是「先光柱、后省份」）
        if (app.pickBeacon({ clientX: pt.x, clientY: pt.y })) continue;
        const target = app.PROVINCE_SITES.get(hit.adcode);
        if (!target || !target.sites.length) continue;
        found = { ...pt, near: dx, prov: { code: hit.adcode, name: hit.name, height: hit.baseHeight, total: target.sites.length }, sites: target.sites };
        break;
      }
      if (found) { pick = found; break; }
    }
    rec('找到可测试的省份（有诗境且不挨着光柱）', !!pick,
      pick ? `${pick.prov.name} ${pick.sites.length} 处诗境（最近光柱 ${Math.round(pick.near)}px）` : '');

    if (pick) {
      const expectPoems = pick.sites.reduce((n, s) => n + s.poems.length, 0);
      clickCanvas(pick);
      await sleep(300);

      rec('点省份 → 底部区域诗词条出现', shown('#regionBar'));
      rec('点省份 → 底部标题是省名', $('#rbTitle').textContent === pick.prov.name,
        `${$('#rbTitle').textContent} / ${pick.prov.name}`);
      const cards = [...document.querySelectorAll('#rbList .rb-card')];
      rec('区域诗词条列出该省全部诗词', cards.length === expectPoems,
        `${cards.length} 张 / 期望 ${expectPoems}`);
      if (cards.length > 3) {
        const listEl = $('#rbList');
        rec('诗词条可横向滚动（卡片超出可视宽度）',
          listEl.scrollWidth > listEl.clientWidth + 2,
          `scrollW=${listEl.scrollWidth} clientW=${listEl.clientWidth}`);
      }
      rec('诗词卡片都带标题与作者',
        cards.every((c) => c.querySelector('.rc-t').textContent.trim()
          && c.querySelector('.rc-a').textContent.includes('·')));

      const title = $('#detailBody .d-title');
      rec('点省份 → 右侧抽屉显示地区介绍', !!title && title.textContent === pick.prov.name,
        title ? title.textContent : '(无)');
      rec('地区介绍含「境内诗境」清单', $('#detailBody').textContent.includes('境内诗境'));
      rec('地区介绍列出了地势等级', /雪线高原|高原山地|丘陵盆地|平原水乡/.test($('#detailBody').textContent));

      /* --- 浮层避让：诗词条不能压住两栏，HUD 不能被两栏盖住 --- */
      await sleep(450);   // 等让位过渡（bottom .3s）走完再量矩形
      recNoOverlap('诗词条不压左栏', '#leftPanel', '#regionBar');
      recNoOverlap('诗词条不压右栏', '#rightPanel', '#regionBar');
      recNoOverlap('HUD 不被右栏盖住', '.hud', '#rightPanel');
      recNoOverlap('HUD 不被诗词条压住', '.hud', '#regionBar');

      /* ================= 3. 点诗词卡片 → 详情弹窗 ================= */
      if (cards.length) {
        const cardTitle = cards[0].querySelector('.rc-t').textContent;
        realClick(cards[0]);
        await sleep(320);

        rec('点诗词卡片 → 弹窗打开', shown('#poemModal'));
        const body = $('#poemModalBody');
        rec('弹窗标题与卡片一致', body.querySelector('.d-title').textContent === cardTitle,
          body.querySelector('.d-title').textContent);
        const need = [
          ['诗词正文', '.poem-body'],
          ['词语注释', '.notes-box'],
          ['赏析', '.appr-box'],
          ['意象字', '.d-tags'],
          ['竖排/对照译文/朗读工具条', '.poem-tools'],
        ];
        need.forEach(([label, sel]) => rec(`弹窗含${label}`, !!body.querySelector(sel)));
        rec('弹窗诗句非空', (body.querySelector('.poem-body').textContent || '').trim().length > 4,
          String((body.querySelector('.poem-body').textContent || '').trim().length) + ' 字');
        const kwCount = body.querySelectorAll('.notes-box:last-of-type .d-tags span').length;
        rec('弹窗意象字有内容', kwCount > 0, String(kwCount));

        // 竖横排切换
        const vbtn = body.querySelector('.poem-tools button');
        const before = body.querySelector('.poem-body').className;
        realClick(vbtn); await sleep(200);
        const after = body.querySelector('.poem-body').className;
        rec('弹窗内可切换竖排/横排', before !== after, `${before} → ${after}`);
        realClick(body.querySelector('.poem-tools button')); await sleep(200);

        // 关闭路径 1：✕
        realClick($('#poemModalClose')); await sleep(200);
        rec('弹窗关闭路径1 ✕ 按钮', !shown('#poemModal'));

        // 关闭路径 2：点遮罩
        realClick(cards[0]); await sleep(250);
        rec('重新打开弹窗', shown('#poemModal'));
        realClick($('#poemModalMask')); await sleep(200);
        rec('弹窗关闭路径2 点遮罩', !shown('#poemModal'));

        // 关闭路径 3：Esc
        realClick(cards[0]); await sleep(250);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await sleep(200);
        rec('弹窗关闭路径3 Esc', !shown('#poemModal'));
        rec('Esc 关弹窗时没有连带关掉底部列表', shown('#regionBar'));
      }

      // 区域诗词条关闭
      realClick($('#rbClose')); await sleep(200);
      rec('区域诗词条可关闭', !shown('#regionBar'));

      /* --- 筛选把该省诗境全隐藏时，文案要能区分「筛掉了」和「本来就没有」 --- */
      const xyChip = [...document.querySelectorAll('#dynastyChips button')]
        .find((b) => b.textContent === '先秦');
      if (xyChip) {
        realClick(xyChip); await sleep(450);
        clickCanvas(pick); await sleep(320);
        const txt = $('#detailBody').textContent.replace(/\s+/g, ' ');
        rec('该省诗境被筛选全部隐藏时，说明是「被筛选隐藏」而非「没有」',
          /都被当前筛选/.test(txt), txt.slice(0, 70));
        realClick($('#btnResetFilter')); await sleep(450);
        realClick($('#rbClose')); await sleep(200);
      }

      /* --- 地区介绍必须跟着可见性走 ---
       * 否则会出现自相矛盾：地图上只剩 1 根光柱，右栏却仍然列出 4 处诗境，
       * 用户照着清单去地图上找，根本找不到。 */
      const regionCode = $('#detailBody').dataset.region;
      rec('右栏展示地区介绍时带地区标记（供可见性变化后重算）', !!regionCode, String(regionCode || ''));
      const baseItems = document.querySelectorAll('#detailBody .notes-box .note-item').length;
      const xy2 = [...document.querySelectorAll('#dynastyChips button')]
        .find((b) => b.textContent === '先秦');
      if (xy2 && regionCode) {
        realClick(xy2); await sleep(500);
        const nowItems = document.querySelectorAll('#detailBody .notes-box .note-item').length;
        rec('改筛选 → 右栏地区介绍自动重算，不残留已隐藏的诗境',
          nowItems < baseItems, `${baseItems} → ${nowItems}`);
        rec('改筛选 → 右栏仍停在同一个省', $('#detailBody .d-title').textContent === pick.prov.name,
          $('#detailBody .d-title').textContent);
        realClick($('#btnResetFilter')); await sleep(500);
        const backItems = document.querySelectorAll('#detailBody .notes-box .note-item').length;
        rec('重置筛选 → 右栏诗境数复原', backItems === baseItems, `${backItems}/${baseItems}`);
      }
    }

    /* ================= 4. 2D 平面模式 ================= */
    const flatBtn = $('[data-view="flat"]');
    const earthBtn = $('[data-view="earth"]');
    rec('存在 2D 切换按钮', !!flatBtn);
    const b0 = [...app.effects.beacons.values()][0];
    realClick(flatBtn);
    await sleep(900);
    rec('切 2D：按钮高亮', flatBtn.classList.contains('on'));
    rec('切 2D：body 带 flat-mode', document.body.classList.contains('flat-mode'));
    rec('切 2D：光柱已隐藏', b0.column.visible === false);
    rec('切 2D：灯球已隐藏', b0.lantern.visible === false);
    /* 2D 的落点标记是**小圆点**，不再是放大的地面光圈。
       光圈是「三维里一盏灯落在地上的光晕」，俯视平面地图上它又大又糊，
       和旁边的小圆点叠在一起反而像重影 —— 用户要的是「一个小圆点」。 */
    rec('切 2D：落点小圆点已显示', b0.dot.visible !== false);
    rec('切 2D：圆点描边已显示（浅色地形上也要看得见）', b0.rim.visible !== false);
    rec('切 2D：地面光圈已收起（改为小圆点）', b0.ring.visible === false);
    rec('切 2D：锁定旋转', app.controls.enableRotate === false);
    rec('切 2D：相机已在正上方', app.camera.position.y > Math.abs(app.camera.position.x)
      && app.camera.position.y > Math.abs(app.camera.position.z),
      `pos=(${app.camera.position.x.toFixed(1)},${app.camera.position.y.toFixed(1)},${app.camera.position.z.toFixed(1)})`);

    /* ---- 三选一：2D / 3D / 地球 互斥 ----
       历史 bug：地球模式下点「2D 平面」走的是 setFlatMode(!state.flat)，
       完全不碰 state.earth —— 于是地球层与版图层同时可见，
       极角限制与近裁剪面互相打架。这里绕「2D → 地球 → 2D」一圈，逐段验互斥。 */
    realClick(earthBtn);
    await sleep(1400);
    rec('2D 点「地球」→ 已进入地球且退出 2D', app.state.earth === true && app.state.flat === false,
      `earth=${app.state.earth} flat=${app.state.flat}`);
    rec('2D 点「地球」→ 地球层可见', app.globe.root.visible === true);
    rec('2D 点「地球」→ 2D 按钮高亮已摘掉', !flatBtn.classList.contains('on'));
    rec('2D 点「地球」→ 版图已隐藏（两层不允许同时存在）', app.map.root.visible === false);

    realClick(flatBtn);
    await sleep(1400);
    rec('地球点「2D」→ 已回到 2D 且退出地球', app.state.flat === true && app.state.earth === false,
      `flat=${app.state.flat} earth=${app.state.earth}`);
    rec('地球点「2D」→ 地球层已隐藏', app.globe.root.visible === false);
    rec('地球点「2D」→ 地球按钮高亮已摘掉', !earthBtn.classList.contains('on'));
    rec('地球点「2D」→ 近裁剪面切回地图档（地球档 0.2 会把平面地图整片裁掉）',
      app.camera.near >= 0.35, `near=${app.camera.near}`);

    realClick(flatBtn);
    await sleep(1400);
    rec('切回 3D：光柱恢复', b0.column.visible === true);
    rec('切回 3D：小圆点收起', b0.dot.visible === false);
    rec('切回 3D：地面光圈恢复', b0.ring.visible === true);
    rec('切回 3D：恢复旋转', app.controls.enableRotate === true);
    rec('切回 3D：body 去掉 flat-mode', !document.body.classList.contains('flat-mode'));
    rec('切回 3D：两个互斥开关都不高亮',
      !flatBtn.classList.contains('on') && !earthBtn.classList.contains('on'));

    /* ================= 5. 行迹模式只显示行迹上的站点 ================= */
    const total = app.SITES.length;
    const visBeacons = () => [...app.effects.beacons.values()].filter((b) => b.visible).length;
    rec('探索模式下光柱全开', visBeacons() === total, `${visBeacons()}/${total}`);

    $('[data-mode="route"]').click();
    await sleep(400);
    rec('切到行迹模式后行迹面板可见', shown('#routePanel'));

    const items = [...document.querySelectorAll('#routePoetMenu .route-item')];
    rec('行迹列表有内容', items.length > 0, `${items.length} 条`);

    if (items.length) {
      realClick(items[0]);
      await sleep(700);
      const stops = document.querySelectorAll('#routeDetail .rp-stop').length;
      const shownBeacons = visBeacons();
      rec('选中行迹 → 光柱数等于该行迹站数', shownBeacons === stops,
        `可见 ${shownBeacons} / 行迹 ${stops} 站`);
      rec('选中行迹 → 其余站点确实被隐藏', shownBeacons < total,
        `${shownBeacons} < ${total}`);
      const visRows = [...document.querySelectorAll('#siteList .site-row')]
        .filter((r) => r.style.display !== 'none').length;
      rec('左侧列表也同步只剩行迹站点', visRows === stops || visRows === 0,
        `列表 ${visRows} / 行迹 ${stops}`);

      /* 负向：**宽屏不该自动收起行迹面板**。
         「选完诗人自动收起」是窄屏专属的补救（那里面板占 87% 屏宽，地图只剩 50px）；
         宽屏两栏并排、地图仍占中间空白区，收起反而把详情藏起来了。
         这条同时守住「isNarrow() 判断没写反」—— 写反了窄屏那条会过、这条必挂。
         本套跑在 1440×900，所以这里断言的是**不收起**。 */
      rec('宽屏选完诗人 → 行迹面板不收起（自动收起只属于窄屏）',
        !document.body.classList.contains('hide-route')
        && $('#routePanel').getBoundingClientRect().left >= 0,
        `hide-route=${document.body.classList.contains('hide-route')} ` +
        `x=${Math.round($('#routePanel').getBoundingClientRect().left)} ` +
        `narrow=${document.body.classList.contains('narrow')}`);
      /* 面板没收起，行迹开关就该贴在外缘且看得见（宽屏也留一个手动收起的入口）。 */
      rec('宽屏行迹模式下 → 行迹开关可见且贴在面板外缘',
        shown('#toggleRoute')
        && $('#toggleRoute').getBoundingClientRect().left
           >= $('#routePanel').getBoundingClientRect().right - 2,
        `开关 x=${Math.round($('#toggleRoute').getBoundingClientRect().left)} / ` +
        `面板 right=${Math.round($('#routePanel').getBoundingClientRect().right)}`);

      // 行迹聚焦收窄了可见诗境，右栏若还在展示地区介绍就必须跟着收窄，
      // 不能「地图只剩 1 根光柱、右栏却列 4 处诗境」。
      /* `dataset.region` 读出来**永远是字符串**，而 `PROVINCE_SITES` 的键是
         `provinceAt()` 给的**数字** adcode —— 直接 `get(rcCode)` 恒为 undefined，
         这一句以前会抛错把整段脚本打断（或者更糟：被人用 try 吞掉后永远不执行，
         于是这条断言其实是死的）。两种键都试一次。 */
      const rcCode = $('#detailBody').dataset.region;
      const rcEntry = rcCode
        ? (app.PROVINCE_SITES.get(Number(rcCode)) || app.PROVINCE_SITES.get(rcCode))
        : null;
      if (rcEntry) {
        const rItems = document.querySelectorAll('#detailBody .notes-box .note-item').length;
        const rVis = rcEntry.sites
          .filter((s) => { const b = app.effects.beacons.get(s.id); return b && b.visible; }).length;
        rec('行迹聚焦 → 右栏地区介绍同步收窄到可见诗境', rItems === rVis,
          `右栏 ${rItems} / 可见 ${rVis}（region=${rcCode}）`);
      }

      /* ================= 6. 行迹气泡卡片 ================= */
      // 选了诗人后，地图上每个行迹站点挂一个气泡，罗列他在此地所作的诗文。
      /* 等镜头飞完并停稳。原先固定 sleep(2000)，而飞行要 1.7s，只剩 300ms 余量 ——
         实测会偶发在途中测量：锚点还在移动，气泡布点就会算出一堆重叠
         （「5 对重叠」「2 对重叠」各见过一次，重跑又全绿）。
         改成轮询相机位置直到不再变化，与 e2e-layout 的 settle() 同一种做法。 */
      let lastCam = null;
      for (let i = 0; i < 60; i++) {
        const k = app.camera.position.toArray().map((n) => n.toFixed(4)).join(',');
        if (k === lastCam) break;
        lastCam = k;
        await sleep(120);
      }
      const bs = [...document.querySelectorAll('#bubbleLayer .rb-bubble')];
      rec('气泡层有内容', bs.length === stops, `${bs.length} 个 / 行迹 ${stops} 站`);
      const items6 = bs.map((b) => {
        const r = b.getBoundingClientRect();
        const dot = b.querySelector('.rb-dot').getBoundingClientRect();
        const poem = b.querySelector('.rb-poem-line')?.textContent || null;
        const none = b.querySelector('.rb-none')?.textContent || null;
        return {
          shown: getComputedStyle(b).display !== 'none' && r.width > 1,
          w: Math.round(r.width), h: Math.round(r.height),
          poem: poem, none: none,
          name: b.querySelector('.rb-name')?.textContent || '?',
          sideL: b.classList.contains('side-left'),
          sideR: b.classList.contains('side-right'),
          sideT: b.classList.contains('side-top'),
          sideB: b.classList.contains('side-bottom'),
          dotX: Math.round(dot.x + dot.width / 2), dotY: Math.round(dot.y + dot.height / 2),
        };
      });
      rec('每个气泡都只装本人诗作或显式说明「无」',
        items6.every((it) => it.poem || it.none), '漏: ' + items6.filter((it) => !it.poem && !it.none).length);
      /* 卡片停靠在左右两条空白带里（见 ui.dockRect），引线从卡片**朝锚点那条边**的
         中点指向锚点。所以「对不齐」的判据不再是「锚点离卡片水平中心近」——
         那正是旧版把卡片贴在锚点上下时的判据；现在卡片离锚点几十到两百像素是设计。
         新的四条不变量：
           a) 每张卡片都带且只带一个方向类（side-left/right/top/bottom）；
           b) 出线那条边朝向锚点（左栏卡片 → 锚点在右；右栏 → 锚点在左；
              锚点横向被卡片自己盖住时改用上/下边，此时锚点在卡片正上或正下方）；
           c) 锚点不被卡片矩形盖住（盖住了就没有任何一条边能连到它）；
           d) 引线长度在合理区间 —— 否则线会横穿整张地图。 */
      const shownItems = items6.filter((it) => it.shown);
      const shownBoxes = shownItems.map((it) => {
        const r = bs[items6.indexOf(it)].getBoundingClientRect();
        return {
          x: r.x, y: r.y, w: r.width, h: r.height,
          dotX: it.dotX, dotY: it.dotY,
          sideL: it.sideL, sideR: it.sideR, sideT: it.sideT, sideB: it.sideB,
          name: it.name,
        };
      });
      const noSide = shownBoxes.filter((b) => (b.sideL + b.sideR + b.sideT + b.sideB) !== 1);
      rec('每张卡片都带且只带一个方向类（side-left/right/top/bottom）', noSide.length === 0,
        `异常 ${noSide.length} 个: ` + noSide.map((b) => b.name).join(' '));

      const badEdge = shownBoxes.filter((b) => {
        if (b.sideL) return b.dotX <= b.x + b.w;          // 卡片在左 → 锚点必须在它右边
        if (b.sideR) return b.dotX >= b.x;                // 卡片在右 → 锚点必须在它左边
        if (b.sideT) return b.dotY >= b.y + b.h / 2;      // 锚点在卡片上方
        return b.dotY <= b.y + b.h / 2;                   // side-bottom：锚点在下方
      });
      rec('出线那条边朝向锚点（方向不会反）', badEdge.length === 0,
        `异常 ${badEdge.length} 个: `
        + badEdge.map((b) => `${b.name}(锚点 ${b.dotX},${b.dotY} vs 卡片 ${Math.round(b.x)}~${Math.round(b.x + b.w)} × ${Math.round(b.y)}~${Math.round(b.y + b.h)})`).join(' '));

      const covered = shownBoxes.filter((b) => b.dotX > b.x + 2 && b.dotX < b.x + b.w - 2
        && b.dotY > b.y + 2 && b.dotY < b.y + b.h - 2);
      rec('锚点没有被自己的卡片盖住（盖住了引线无从连起）', covered.length === 0,
        `被盖住 ${covered.length} 个: ` + covered.map((b) => b.name).join(' '));

      const stems = shownBoxes.map((b) => {
        const sx = b.sideL ? b.x + b.w : b.sideR ? b.x : Math.max(b.x + 8, Math.min(b.x + b.w - 8, b.dotX));
        const sy = b.sideT ? b.y : b.sideB ? b.y + b.h : b.y + b.h / 2;
        return { name: b.name, len: Math.hypot(b.dotX - sx, b.dotY - sy) };
      });
      const tooLong = stems.filter((s) => s.len > 620);
      rec('引线长度都在合理区间（≤ 620px，不会横穿整张地图）', tooLong.length === 0,
        `最长 ${Math.round(Math.max(...stems.map((s) => s.len)))}px，超限 ${tooLong.length} 个`);
      // 互不重叠
      let ov6 = 0;
      for (let i = 0; i < shownBoxes.length; i++) {
        for (let j = i + 1; j < shownBoxes.length; j++) {
          const a = shownBoxes[i], b = shownBoxes[j];
          const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
          const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
          if (ox > 2 && oy > 2) ov6 += 1;
        }
      }
      rec('气泡之间互不重叠', ov6 === 0, `${ov6} 对重叠`);

      // 切换诗人 → 气泡按新诗人的作品刷新（站点名应当与新行迹一致）
      const items7 = [...document.querySelectorAll('#routePoetMenu .route-item')];
      if (items7.length >= 2) {
        realClick(items7[1]);
        await sleep(2400);
        // 右侧 detail 列出新行迹的所有停站 —— 气泡站点集应当等于它
        const detailNames = new Set([...document.querySelectorAll('#routeDetail .rp-stop .info b')].map((b) => b.textContent));
        const bubbleNames = new Set([...document.querySelectorAll('#bubbleLayer .rb-name')].map((e) => e.textContent));
        let inter = 0; detailNames.forEach((n) => { if (bubbleNames.has(n)) inter += 1; });
        rec('切到另一位诗人 → 气泡站点集与新行迹一致',
          inter === detailNames.size && bubbleNames.size === detailNames.size,
          `交集 ${inter}/${detailNames.size}，气泡 ${bubbleNames.size} 个`);
      }

      // 关「地名」层 → 气泡隐藏（与地名标注是同一类「地图上的文字」）
      const labelBtn = document.querySelector('[data-layer="labels"]');
      const wasOn = labelBtn.classList.contains('on');
      if (wasOn) realClick(labelBtn);
      await sleep(400);
      const allHidden = [...document.querySelectorAll('#bubbleLayer .rb-bubble')]
        .every((b) => getComputedStyle(b).display === 'none');
      rec('关闭地名图层 → 气泡跟着隐藏', allHidden);
      if (wasOn) realClick(labelBtn);   // 还原
      await sleep(400);
    }

    // 行迹模式下点省份 → 诗词条出现，同样不能压住行迹面板（它是独立类，容易漏让位）
    const anyMesh = app.map.hoverTargets.find((x) => app.PROVINCE_SITES.has(x.userData.adcode));
    if (anyMesh) {
      app.focusProvince(anyMesh);
      await sleep(700);
      rec('行迹模式下点省份 → 诗词条正常出现', shown('#regionBar'));
      recNoOverlap('行迹模式下诗词条不压行迹面板', '#routePanel', '#regionBar');
      realClick($('#rbClose'));
      await sleep(300);
    }

    // 退出行迹模式 → 全部恢复
    realClick($('#routeClose'));
    await sleep(700);
    rec('退出行迹模式 → 光柱全部恢复', visBeacons() === total, `${visBeacons()}/${total}`);
    rec('退出行迹模式 → 面板已收起', !shown('#routePanel'));
    rec('退出行迹模式 → 顶部切回探索', $('[data-mode="explore"]').classList.contains('active'));
    // 行迹模式会把底部诗词条收起来；退出后若右栏还在展示地区介绍，它应该一并回来
    if ($('#detailBody').dataset.region) {
      rec('退出行迹模式 → 底部诗词条随之恢复', shown('#regionBar'));
    }
    // 气泡是「选中了某位诗人」才有的东西，一并清掉 —— 否则下一次进行迹模式
    // 旧气泡会和新的叠加/重叠，看着像脏数据。
    rec('退出行迹模式 → 气泡已清空',
      document.querySelectorAll('#bubbleLayer .rb-bubble').length === 0);

    /* ================= 7. 练习卡的布局与让位 ================= */
    /**
     * 这一组守的是两类真实缺陷：
     *
     * (a) 卡片宽度按「两侧栏之间的剩余空间」算，窄屏上减出负数 → width 声明整条失效
     *     → 回退 shrink-to-fit，390 宽只剩 163px、高度反涨到 468px。
     *     所以断言写成**不变量**：宽度必须等于 min(560, 100vw - 24)，任何视口都成立。
     * (b) 「练习卡打开了」被错挂在 onQuizMode 的参数上，只有看图识诗会置位 ——
     *     另外两种题型 HUD 不隐藏（压 17.6k px²）、侧栏不让位，还会把刚收起的诗词条
     *     又拉回来（卡片×诗词条重叠 95k px²）。所以三种题型都要逐一验证。
     */
    const quizExpectW = () => Math.min(560, window.innerWidth - 24);
    const cardW = () => Math.round($('#quizCard').getBoundingClientRect().width);
    const quizTypes = [['geo', '看图识诗'], ['fill', '补全诗句'], ['feihua', '飞花令']];
    for (const [type, label] of quizTypes) {
      const btn = $(`#classGroup button[data-quiz="${type}"]`);
      if (!btn) continue;
      realClick(btn);
      await sleep(800);
      rec(`${label}：卡片宽度 = min(560, 视口宽-24)`, Math.abs(cardW() - quizExpectW()) <= 2,
        `实测 ${cardW()}px，应为 ${Math.round(quizExpectW())}px（视口 ${window.innerWidth}）`);
      rec(`${label}：HUD 让位（卡片通栏，会整个压住右下角）`,
        getComputedStyle($('.hud')).display === 'none');
      rec(`${label}：底部诗词条不与练习卡叠在一起`, !shown('#regionBar'),
        shown('#regionBar') ? `重叠 ${ovArea('#quizCard', '#regionBar')}px²` : '诗词条已收起');
      recNoOverlap(`${label}：练习卡不压左栏`, '#quizCard', '#leftPanel');
      recNoOverlap(`${label}：练习卡不压右栏`, '#quizCard', '#rightPanel');
      rec(`${label}：侧栏让位后仍有可用高度`, $('#rightPanel').getBoundingClientRect().height >= 120,
        `${Math.round($('#rightPanel').getBoundingClientRect().height)}px`);
      realClick($('#quizClose'));
      await sleep(700);
      rec(`${label}：退出后 HUD 恢复`, getComputedStyle($('.hud')).display !== 'none');
      rec(`${label}：退出后侧栏高度复原`, $('#rightPanel').getBoundingClientRect().height >= 300,
        `${Math.round($('#rightPanel').getBoundingClientRect().height)}px`);
      // 退出练习若右栏还在展示地区介绍，诗词条必须一起回来
      if ($('#detailBody').dataset.region) {
        rec(`${label}：退出后底部诗词条随之恢复`, shown('#regionBar'));
      }
    }

    /* ================= 8. 选中省份 → 边界线跟着亮 ================= */
    /**
     * 这一组守的是「点了某个省，看不出点的是哪一块」。三个坑都在这里翻过车：
     *
     * (a) 边界线最早挂在 root 直属的 borderGroup 里，省份 hover 抬起 0.22 时线留在原地，
     *     抬起来的那块与地面之间裂出一道缝。改成 mesh.add(lineMesh) 才跟着走 ——
     *     所以断言里量的是「线的世界坐标 == 省份的世界坐标」，而不是看代码里写没写 add。
     * (b) 各省必须各自 clone 一份 material。共用一份的话 lerp 会串台：点亮一个省，
     *     全省边界线一起变橙 —— 那就等于没有选中效果。
     * (c) focusProvince 里曾写成 `m.userData.hovered = m.adcode === u.adcode`（漏了 userData）：
     *     Mesh 上没有 adcode，恒为 undefined，这一句把**所有**省份的高亮都置成 false，
     *     点了省份高亮反而当场熄灭。更根本的是 hovered 是瞬时的，鼠标一移到诗词卡片上
     *     就没了 —— 所以另开 selected 字段把「选中」留住。
     *
     * 颜色判定用三通道最大差值（0~1）而不是比字符串：lerp 是渐变的，
     * 永远到不了精确的 #ffb84a，写死等值必然假失败。
     */
    {
      const V3 = app.map.provinces[0].position.constructor;
      const hex = (c) => c.getHexString();
      const dist = (c, h) => {   // 与目标色的三通道最大差值，0=完全一致
        const t = new (c.constructor)(h);
        return Math.max(Math.abs(c.r - t.r), Math.abs(c.g - t.g), Math.abs(c.b - t.b));
      };
      const borderOf = (m) => m.children.find((c) => c.userData && c.userData.isBorder);
      const bordered = app.map.provinces.filter(borderOf);

      rec('每个省份 mesh 下都挂了自己的边界线', bordered.length >= 30,
        `${bordered.length}/${app.map.provinces.length}`);
      rec('各省边界线材质是独立实例（hover 才不会串台）',
        borderOf(bordered[0]).material !== borderOf(bordered[1]).material);

      // 挑一个「境内有诗境」的省，顺带让底部诗词条真的打开，才能测到「收起即复位」
      const target = bordered.find((m) => (app.PROVINCE_SITES.get(m.userData.adcode)?.sites || []).length)
        || bordered[0];
      const line = borderOf(target);
      const baseHex = hex(line.userData.baseColor);
      const baseOpacity = line.userData.baseOpacity;
      rec('边界线记下了复位基准（baseColor / baseOpacity）',
        baseOpacity > 0 && /^[0-9a-f]{6}$/.test(baseHex), `#${baseHex} / ${baseOpacity}`);

      const others = bordered.filter((m) => m !== target).slice(0, 3).map(borderOf);

      app.focusProvince(target);
      await sleep(900);   // lerp 是 dt*10，900ms 足够收敛（54 帧后残差 5e-5）

      rec('选中省份 → 全场只有这一块是选中态',
        app.map.provinces.filter((m) => m.userData.selected).length === 1,
        `${app.map.provinces.filter((m) => m.userData.selected).length} 块`);
      rec('选中省份 → 地形抬起', target.userData.lift > 0.15,
        `lift=${target.userData.lift.toFixed(3)}`);
      const wp = line.getWorldPosition(new V3());
      const mp = target.getWorldPosition(new V3());
      rec('边界线挂在省份 mesh 下（跟着一起抬，不留缝）',
        line.parent === target && Math.abs(wp.y - mp.y) < 0.01,
        `Δy=${Math.abs(wp.y - mp.y).toFixed(4)}`);
      rec('选中省份 → 边界线变实（opacity → 0.95）', line.material.opacity > 0.85,
        `opacity=${line.material.opacity.toFixed(3)}`);
      rec('选中省份 → 边界线换成饱和橙金 #ffb84a', dist(line.material.color, '#ffb84a') < 0.08,
        `#${hex(line.material.color)} Δ=${dist(line.material.color, '#ffb84a').toFixed(3)}`);
      rec('其它省份边界线不被串台（仍是淡金原色）',
        others.every((l) => dist(l.material.color, '#' + hex(l.userData.baseColor)) < 0.08
          && l.material.opacity < 0.6),
        others.map((l) => `#${hex(l.material.color)}/${l.material.opacity.toFixed(2)}`).join(' '));

      /* 收起诗词条 → 选中态要一起清，否则「列表没了、那块地还亮着」，
         用户会以为列表是被误关的。四个收起入口（点空白 / 点 × / 切模式 / 进练习）
         都走 hideRegionBar 这一个出口，这里测 × 这一个。 */
      $('#rbClose').click();
      await sleep(1200);
      rec('收起诗词条 → 省份选中态清空', app.map.provinces.every((m) => !m.userData.selected));
      rec('收起诗词条 → 边界线复位到原色', dist(line.material.color, '#' + baseHex) < 0.08,
        `#${hex(line.material.color)} → #${baseHex}`);
      rec('收起诗词条 → 边界线不透明度复位', Math.abs(line.material.opacity - baseOpacity) < 0.06,
        `${line.material.opacity.toFixed(3)} / ${baseOpacity}`);
      rec('收起诗词条 → 地形落回', target.userData.lift < 0.05,
        `lift=${target.userData.lift.toFixed(3)}`);
    }

    /* ================= 9. 2D + 行迹：序号牌取代落点圆点 =================
       序号牌与落点圆点锚在**同一个坐标**上，而序号牌的圆底是半透明的（0.94）、
       落点圆点是纯色实心圆盘 —— 圆点会从圆底里透上来，在数字正中糊出一块亮斑
       （实测长安那一站的「2」下半截就被糊掉了，用户报的正是「序号看不清」）。
       所以 2D 下被行迹覆盖的站点不画圆点：序号牌本身就是那个站点的标记。 */
    $('[data-mode="route"]').click();
    await sleep(600);
    const items9 = [...document.querySelectorAll('#routePoetMenu .route-item')];
    if (items9.length) {
      realClick(items9[0]);
      await sleep(1800);
      realClick($('[data-view="flat"]'));
      await sleep(1600);

      const stations = [...app.effects.routeStationIds]
        .map((id) => app.effects.beacons.get(id)).filter(Boolean);
      rec('2D + 行迹：行迹站点集合非空（前置）', stations.length > 0, `${stations.length} 站`);
      rec('2D + 行迹：被行迹覆盖的站点不画落点圆点（序号牌即落点标记）',
        stations.length > 0 && stations.every((b) => b.dot.visible === false && b.rim.visible === false),
        `${stations.filter((b) => b.dot.visible).length} / ${stations.length} 仍画着圆点`);

      /* 负向验证：没被行迹覆盖的站点圆点必须还在 ——
         否则上面那条可能是「2D 下圆点一律不显示」的恒真断言。 */
      const outsider = [...app.effects.beacons.entries()]
        .find(([id]) => !app.effects.routeStationIds.has(id));
      rec('2D + 行迹：未覆盖的站点圆点仍在（不是「一律不画」）',
        !!outsider && outsider[1].dot.visible === true,
        outsider ? `${outsider[0]} dot.visible=${outsider[1].dot.visible}` : '无对照站点');

      /* 负向验证 2：退出行迹，被让位的圆点要回来 */
      realClick($('#routeClose'));
      await sleep(1400);
      rec('退出行迹 → 2D 下落点圆点全部回来',
        stations.length > 0 && stations.every((b) => b.dot.visible === true),
        `${stations.filter((b) => b.dot.visible).length} / ${stations.length}`);

      realClick($('[data-view="flat"]'));
      await sleep(1200);
    }

    return R;
  })();
})()
