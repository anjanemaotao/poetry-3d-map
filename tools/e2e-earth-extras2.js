/* 地球模式回归 · 第 3 部分：点选 ripple 闸门 + 地球档点省份识别。
 *
 * 拆成第三个 eval 是为了让 agent-browser 的 daemon 有喘息窗口 —— 见
 * e2e-earth-extras.js 顶部注释里的 EAGAIN 教训。第 11 节收尾后 state 是
 * 「3D 探索 + 无行迹」，从这里继续：先切到地球，再做本节的 4 条断言。
 *
 * 两条 bug 都在这一轮（HEAD `fe5b54e`）修：
 *   Bug 1 根因：ripple 直接 add 到 scene（不在 beaconGroup 下），
 *     applyEarthMode 设的 beaconGroup.visible=false 拦不住，地图档坐标
 *     的省份级圆环落到地球档被甩出 + 放大成「位置不对的大光环」。
 *     修法：effects.setMode('earth') 清空 ripple 数组 + setSelected 闸门
 *       不在 'earth' 模式时调 ripple。
 *   Bug 2 根因：pointerup 地球档直接 return，没把经纬度落到省份上。
 *     修法：用 globeLonLatAt + provinceAt + map.hoverTargets 拼出省份 → focusProvince。
 */
(async () => {
  const out = [];
  const rec = (name, pass, extra = '') => out.push({ name, pass: !!pass, extra });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = window.__app;
  if (!app) return [{ name: 'window.__app 存在', pass: false, extra: '缺少调试钩子' }];

  /* setDistAt：把相机挪到指定球面距离。等 300ms 让 OrbitControls 把 spherical 应用完，
     再跑断言。不复用 e2e-earth.js 里的工具（两个文件不共享变量）。
     同款工具在 e2e-earth-extras.js / e2e-earth.js 各拷了一份。 */
  const setDistAt = async (d) => {
    const dir = app.camera.position.clone().normalize();
    app.camera.position.copy(dir.multiplyScalar(d));
    app.controls.update();
    await sleep(300);
  };

  const run = async () => {
    /* 进地球 */
    app.setViewMode('earth', { quiet: true });
    await sleep(2500);

    /* 12.1 地球档 selectSite 不会创建 ripple（修 Bug 1） */
    await setDistAt(2.4);
    const rippleBefore = app.effects.ripples.length;
    app.selectSite('jieshi');
    await sleep(2500);
    rec('地球档选中站点不再创建 ripple（避免大光环）',
      app.effects.ripples.length === rippleBefore,
      `before=${rippleBefore} after=${app.effects.ripples.length}`);
    rec('地球档选中站点后该 beacon 的 ring / halo / column 仍隐藏（setMode earth 生效）',
      app.effects.beacons.get('jieshi')?.ring?.visible === false
      && app.effects.beacons.get('jieshi')?.halo?.visible === false
      && app.effects.beacons.get('jieshi')?.column?.visible === false);

    /* 12.2 地球档点空白处能 focusProvince（修 Bug 2） */
    /* 默认视角下中国在屏幕中央偏左上的球面上 —— 那个点应该落在新疆/内蒙古一带。 */
    app.setViewMode('earth', { quiet: true });
    await sleep(2500);
    const cv = app.renderer.domElement;
    const rect = cv.getBoundingClientRect();
    const px = rect.left + rect.width * 0.45;
    const py = rect.top + rect.height * 0.45;
    cv.dispatchEvent(new PointerEvent('pointerdown', { clientX: px, clientY: py, pointerType: 'mouse', bubbles: true }));
    cv.dispatchEvent(new PointerEvent('pointerup', { clientX: px, clientY: py, pointerType: 'mouse', bubbles: true }));
    await sleep(400);
    /* 「右栏显示地区介绍」 = currentRegion() 有值 + 是中国省份。
       这里不再要求具体哪个省（取决于屏幕坐标），只验证「有响应」。 */
    const code = app.ui?.currentRegion?.() || null;
    const regionOk = code && /^[0-9]{6}$/.test(code) && code !== '100000_JD';
    rec('地球档点空白处能 focus 到某个中国省份',
      regionOk,
      `currentRegion=${code}`);
    rec('focusProvince 联动把地区介绍 + 诗词条都打开',
      app.ui?.isRegionBarOpen?.() === true,
      `isRegionBarOpen=${app.ui?.isRegionBarOpen?.()}`);

    /* 12.3 退出地球档后 ripple 模式恢复正常（点选站仍创建 ripple）
     * ripple 生命周期 1.5s，断言窗口必须比这短，否则 ripple 自己消完了再量 rippleCount
     * 会得到 0 —— 看起来「闸门没解除」，其实是断言时机错了。300ms 足够 observe 到
     * 数组里有未消的元素。 */
    app.setViewMode('3d', { quiet: true });
    await sleep(2200);
    const rippleBefore2 = app.effects.ripples.length;
    app.selectSite('jieshi');
    await sleep(300);
    rec('退出地球回 3D 后选中站点又能创建 ripple（setSelected 闸门已解除）',
      app.effects.ripples.length > rippleBefore2,
      `before=${rippleBefore2} after=${app.effects.ripples.length}`);

    return out;
  };

  return run().catch((e) => {
    rec('脚本未意外中断（异常前已收集的断言仍然有效）', false, `${(e && e.message) || e}`);
    return out;
  });
})();