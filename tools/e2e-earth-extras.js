/* 地球模式回归 · 第 2 部分：地名标注 + 右键拖动。
 *
 * 拆成第二个 eval 是为了让 agent-browser 的 daemon 有喘息窗口 —— 一口气灌进
 * 几百行脚本 + 多次镜头飞行会让 daemon 的 stdout 读取撞上 EAGAIN，
 * 报 "Resource temporarily unavailable (os error 35)"。
 *
 * 与 e2e-earth.js 共用同一个浏览器会话（无 reload）：第 9 节把页面收尾到
 * 「3D 探索 + 无行迹」，正好从这里继续 —— 直接再进地球做第 10 节即可。
 */
(async () => {
  const out = [];
  const rec = (name, pass, extra = '') => out.push({ name, pass: !!pass, extra });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const app = window.__app;
  if (!app) return [{ name: 'window.__app 存在', pass: false, extra: '缺少调试钩子' }];

  /* ---------- 10. 地球模式地名标注 + 右键拖动 ----------
   * 本轮新加的两件事都在「地球 + 无行迹」下测 —— 行迹的第 9 节会污染可见集合，
   * 而且它的相机停在某个取景点，闸门 / 近半球判定会被它牵着走。
   * 两条防线都是「真坑」：
   *   ① 地名没拉显，会让用户以为地球只是颗空球；
   *   ② 右键拖动若绑到 PAN（默认）会把 controls.target 拽离球心，破坏整套
   *      「target 恒为球心」的假设（markerScale / 行迹取景 / 选中朝前都按球心算）。 */
  const run = async () => {
    // 第 9 节收尾后 state 是 3D 探索、无行迹 —— 再进地球后做这一节。
    $('[data-view="earth"]').click();
    await sleep(1600);          // flyCamera 1.5s，落定后再改相机
    rec('回到地球模式（无行迹干扰）', app.state.earth === true);

    /* 「可见地名数」必须先看**整层**有没有被关掉。
       坑：getComputedStyle(子元素).display 在父元素 display:none 时**仍返回子元素自己的
       display**（'block'），不会跟着变 'none' —— 直接数子元素会得到「整层藏了但还是有 22 个」
       这种假象，闸门断言（d=3.6 应为 0）就会假失败。先查层，再数子元素。
       另外一并量 offsetParent，把「有 display 但没参与布局」的情况也排除掉。 */
    const visLabels = () => {
      const L = $('#labelLayer');
      if (getComputedStyle(L).display === 'none') return 0;
      return [...L.children]
        .filter((e) => e.offsetParent !== null && getComputedStyle(e).display !== 'none').length;
    };
    // 复用第 5 节的 setDistAt（async）：把相机挪到指定距离，再调 controls.update。
    // 改完位置后单独跑一次 updateEarthLabels 拿到稳定读数。
    const refreshLabels = () => {
      app.camera.updateMatrixWorld(true);
      app.updateEarthLabels();
    };

    /* 闸门默认关：默认太空视角（d=5.34）下 79 处地名挤在中国那一小片里，
       整层都该藏起来 —— 否则一进场就是一团黑字。 */
    rec('默认太空视角下标注层 hidden，可见数 0',
      visLabels() === 0 && getComputedStyle($('#labelLayer')).display === 'none',
      `display=${getComputedStyle($('#labelLayer')).display} 可见=${visLabels()}`);

    /* 闸门开：拉近到 2.0 后应有地名逐个冒出。79 处全在中国，按距离 / 防重叠
       排版后这一档至少能放出 3 个以上 —— 这条「≥ 3」是宽松门槛，留给密度算法。 */
    await setDistAt(2.0); refreshLabels();
    rec('拉近到 d=2.0 后地名逐个冒出（可见 ≥ 3 个）',
      visLabels() >= 3, `可见 ${visLabels()}`);
    rec('拉近后 #labelLayer 回到正常显示', getComputedStyle($('#labelLayer')).display !== 'none',
      `display=${getComputedStyle($('#labelLayer')).display}`);

    /* 闸门边界：EARTH_LABEL_DIST = 3.4。d=3.6 上方关、d=3.3 下方开 —— 各取一档实测。 */
    await setDistAt(3.6); refreshLabels();
    const above = visLabels();
    await setDistAt(3.3); refreshLabels();
    const below = visLabels();
    rec('距离闸门 ≈ 3.4：d=3.6 可见 0、d=3.3 可见 ≥ 1',
      above === 0 && below >= 1, `d=3.6 → ${above} · d=3.3 → ${below}`);

    /* 地名图层开关走「整层一起管关」的契约：toggle 关掉 → 整层 display:none。 */
    const labelsBtn = $('#layerGroup [data-layer="labels"]');
    labelsBtn.click(); await sleep(150);
    await setDistAt(2.0); refreshLabels();
    rec('地球模式地名图层关掉 → 标注层 hidden，可见数 0',
      visLabels() === 0 && getComputedStyle($('#labelLayer')).display === 'none',
      `display=${getComputedStyle($('#labelLayer')).display}`);
    labelsBtn.click(); await sleep(150);   // 还原回原本的「开」状态

    /* 近半球剔除：把中国转到背面（camera.position *= -1），中国那 79 处全部
       落在远半球，应一个都不显示。 */
    await setDistAt(2.6);
    app.camera.position.multiplyScalar(-1);
    app.controls.update();
    refreshLabels();
    const farCount = visLabels();
    rec('把中国转到背面 → 不再显示这些地名（近半球剔除生效）',
      farCount === 0, `背面可见 ${farCount}`);
    app.camera.position.multiplyScalar(-1);    // 还原
    app.controls.update();
    refreshLabels();

    /* 右键绑定：地球模式必须把 RIGHT 重定向到 ROTATE，地图侧则按 PAN = 2 保留。 */
    rec('地球模式下 mouseButtons.RIGHT 绑定为 ROTATE（值 0）',
      app.controls.mouseButtons.RIGHT === 0, `RIGHT=${app.controls.mouseButtons.RIGHT}`);

    /* 真实右键拖动：必须带 pointerId 才能让 setPointerCapture 不抛 —— 见
       vendor/three OrbitControls 第 1000 行。不带会让 onPointerDown 在
       setPointerCapture 阶段炸掉、整次拖动被吞。 */
    await setDistAt(2.6);
    const azR = () => Math.atan2(app.camera.position.z, app.camera.position.x) * 180 / Math.PI;
    const azR0 = azR();
    const cx = innerWidth / 2, cy = innerHeight / 2;
    const cEl = app.renderer.domElement;
    const pe = (type, x, opts = {}) => new PointerEvent(type, {
      pointerId: 1, isPrimary: true, button: 2, buttons: 2,
      clientX: x, clientY: cy, pointerType: 'mouse', bubbles: true, ...opts,
    });
    cEl.dispatchEvent(pe('pointerdown', cx));
    for (let i = 1; i <= 12; i++) cEl.dispatchEvent(pe('pointermove', cx - i * 30));
    cEl.dispatchEvent(pe('pointerup', cx - 360, { button: 2, buttons: 0 }));
    app.controls.update();
    rec('右键拖动 → 相机方位角确实转动（变化 ≥ 6°）',
      Math.abs(azR() - azR0) >= 6, `Δaz=${(azR() - azR0).toFixed(2)}°（起点 ${azR0.toFixed(2)}）`);

    /* 右键菜单拦截：没这一步，右键拖到一半浏览器菜单弹出，拖动被迫中断。 */
    const cmev = new Event('contextmenu', { bubbles: true, cancelable: true });
    cEl.dispatchEvent(cmev);
    rec('画布上右键菜单被拦截（contextmenu defaultPrevented）',
      cmev.defaultPrevented === true, `defaultPrevented=${cmev.defaultPrevented}`);

    /* 收尾：退出地球模式。退出后 RIGHT 必须还原成 PAN（值 2，OrbitControls 默认），
       不能把地球这套假设（target = 球心、RIGHT = ROTATE）留给地图档。 */
    $('[data-view="earth"]').click();
    await sleep(1600);
    rec('退出地球模式后 mouseButtons.RIGHT 还原成 PAN（值 2）',
      app.controls.mouseButtons.RIGHT === 2, `RIGHT=${app.controls.mouseButtons.RIGHT}`);
    rec('退出地球模式后回到 3D 探索', app.state.earth === false && app.state.flat === false,
      `earth=${app.state.earth} flat=${app.state.flat}`);

    return out;
  };

  /* setDistAt 从 e2e-earth.js 顶部拷贝过来（两个文件不共享变量）：把相机挪到指定距离。
   * 异步 300ms 等 OrbitControls 把 spherical 应用完，再跑断言；不延迟以复用稳定读数。
   * 这套工具是单条防线，已在 e2e-earth.js 第 5/6 节用过 N 次验证过。 */
  const setDistAt = async (d) => {
    const dir = app.camera.position.clone().normalize();
    app.camera.position.copy(dir.multiplyScalar(d));
    app.controls.update();
    await sleep(300);
  };

  /* 出错也要把已收集的断言交出去 —— 见 e2e-earth.js 顶部注释里的真实事故。 */
  return run().catch((e) => {
    rec('脚本未意外中断（异常前已收集的断言仍然有效）', false, `${(e && e.message) || e}`);
    return out;
  });
})();