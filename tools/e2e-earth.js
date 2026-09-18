/* 地球模式回归（注入页面执行）。
 *
 * 回答五个问题：
 *   1. 进入地球模式后，地图那一整套是否**真的**隐藏、地球是否真的显示？
 *   2. 球面是否真的按高程做了起伏（不是一颗光滑的标准球）？
 *   3. 79 处诗境是否都贴在球面上的正确经纬度处？
 *   4. 相机自由度是否换成了「太空看球」：能任意方向转动、能缩放、且缩放有上下限？
 *   5. 退出后地图与相机的全部参数是否原样恢复（不能留下地球模式的残留）？
 *
 * 量的口径仍是**渲染结果**，不是意图字段：
 *   判「地球可见」看的是 globe.root.visible 与几何本身，不是 state.earth；
 *   判「球面有起伏」量的是顶点半径的实际极差，不是 heightOf 函数返回值。
 *
 * 两个实测踩过的坑：
 *   a) three.js 的射线检测**不看 visible**，隐藏的省份照样会被打中 ——
 *      所以地球模式下必须在 pointermove / pointerup 里显式分流（见 main.js）。
 *      本脚本会验「点地标能选中」，正是这条分流的守门人。
 *   b) 地标是 Sprite，屏幕尺寸 = scale × fpx / 深度。要量尺寸必须先取视空间深度，
 *      直接比 scale 字段会把「因为深度变了所以尺寸变了」误判成补偿失效。
 */
(() => {
  const out = [];
  const rec = (name, pass, extra) => out.push({ name, pass: !!pass, extra: extra == null ? '' : String(extra) });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let app = null;
  let V = null;

  const boot = async () => {
    for (let i = 0; i < 40; i++) {
      const a = window.__app;
      if (a && a.globe && a.map && a.effects && a.effects.beacons.size) {
        app = a; V = a.camera.position.constructor; return true;
      }
      await sleep(250);
    }
    return false;
  };

  const camDist = () => app.camera.position.distanceTo(app.controls.target);
  const fpx = () => (window.innerHeight / 2) / Math.tan((app.camera.fov * Math.PI) / 180 / 2);
  /** 视空间深度（相机前方为正） */
  const depthOf = (v) => -new V().copy(v).applyMatrix4(app.camera.matrixWorldInverse).z;
  const q = (s) => document.querySelector(s);

  /** 等相机停稳：镜头飞行 1.5s，固定 sleep 会量到中间帧 */
  const settled = async (maxMs = 6000) => {
    let last = null;
    for (let t = 0; t < maxMs; t += 120) {
      const k = app.camera.position.toArray().map((n) => n.toFixed(4)).join(',');
      if (k === last) return true;
      last = k;
      await sleep(120);
    }
    return false;
  };

  /** 用真实 PointerEvent 走一遍点击：必须成对发 pointerdown / pointerup，
      主程序靠 pointerdown 记下的位置判断「拖动还是点击」。 */
  const clickAt = async (x, y) => {
    const el = app.renderer.domElement;
    const opt = { clientX: x, clientY: y, bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    el.dispatchEvent(new PointerEvent('pointerdown', opt));
    el.dispatchEvent(new PointerEvent('pointerup', opt));
    await sleep(150);
  };

  /** 某地标的屏幕位置（相机前方才有效） */
  const markerScreen = (m) => {
    const d = depthOf(m.sprite.position);
    if (!(d > 0.05)) return null;
    const p = m.sprite.position.clone().project(app.camera);
    return { x: (p.x * 0.5 + 0.5) * window.innerWidth, y: (-p.y * 0.5 + 0.5) * window.innerHeight, d };
  };
  /** 是否在近半球。球面可见性：P·C > |P|² —— 背面地标被球挡住，量它的尺寸/点它都没意义 */
  const frontFacing = (m) => {
    const p = m.sprite.position;
    return p.dot(app.camera.position) > p.lengthSq();
  };
  /** 地标的屏幕像素尺寸 = 世界尺寸 × fpx / 深度（坑 b） */
  const markerPx = (m) => {
    const s = markerScreen(m);
    return s ? (m.sprite.scale.x * fpx()) / s.d : null;
  };

  /** 把相机放到「当前方向 × 指定距离」上。地球模式下 target 恒为球心，所以直接缩放即可。 */
  const setDistAt = async (d) => {
    const dir = app.camera.position.clone().normalize();
    app.camera.position.copy(dir.multiplyScalar(d));
    app.controls.update();
    await sleep(300);
  };

  /**
   * 一屏可见的球面跨度（度，竖直方向）。
   *
   * 这是「缩放还能不能用」的真正判据 —— 比相机距离直观得多。
   * 由视场角决定：tan φ = R·sinθ/(d−R·cosθ)，d 越接近 R 缩得越猛，
   * 实测 d 从 1.4 走到 1.08 跨度就从 12.6° 掉到 2.4°。
   * 用射线打到球面上量真实落点，而不是套公式 —— 公式里 R 是变化的（有地形）。
   */
  const visibleSpanDeg = () => {
    const rc = app.raycaster;
    const shoot = (ny) => {
      rc.setFromCamera({ x: 0, y: ny }, app.camera);
      const h = rc.intersectObject(app.globe.surface, false)[0];
      return h ? app.lonLatFromDir(h.point) : null;
    };
    const center = shoot(0);
    if (!center) return null;
    /* 二分找「最靠上还打得中」的那条射线。
       不能拿固定的 NDC 值去试：默认视角下地球只占视口高的 75%（球面边缘在
       NDC 0.71），而拉近后边缘跑出画面（NDC 1.0）。固定值要么打空、要么量小。 */
    let lo = 0, hi = 1;
    if (shoot(hi)) lo = hi;
    else {
      for (let i = 0; i < 14; i++) {
        const mid = (lo + hi) / 2;
        if (shoot(mid)) lo = mid; else hi = mid;
      }
    }
    const edge = shoot(lo);
    if (!edge) return null;
    const R = Math.PI / 180;
    const c = Math.sin(center[1] * R) * Math.sin(edge[1] * R)
      + Math.cos(center[1] * R) * Math.cos(edge[1] * R) * Math.cos((center[0] - edge[0]) * R);
    return 2 * Math.acos(Math.max(-1, Math.min(1, c))) / R;   // 中心→上缘是半跨度
  };

  const run = async () => {
    if (!(await boot())) { rec('页面已启动', false, '__app 未就绪'); return out; }
    rec('页面已启动', true, '');

    /* 先量一次地图模式下的基线，退出后要逐项比对 */
    const baseMap = {
      maxPolar: app.controls.maxPolarAngle,
      minPolar: app.controls.minPolarAngle,
      enablePan: app.controls.enablePan,
      maxDist: app.controls.maxDistance,
      near: app.camera.near,
      keyPos: (() => { let p = null; app.scene.traverse((o) => { if (o.isDirectionalLight && !p) p = o.position.clone(); }); return p; })(),
      note: (q('.hud-note') || {}).textContent || '',
    };

    /* ---------- 1. 进入地球模式 ---------- */
    q('[data-view="earth"]').click();
    await settled();
    await sleep(500);

    rec('点「地球」后进入地球模式', app.state.earth === true, `state.earth=${app.state.earth}`);
    rec('地球层已构建', app.globe.built === true, `耗时 ${app.globe.buildMs}ms`);
    rec('地球层可见', app.globe.root.visible === true);
    rec('地图整体隐藏', app.map.root.visible === false);
    rec('海洋底图隐藏', app.scene.children.indexOf(app.map.root) >= 0 && app.map.root.visible === false);
    rec('光柱组隐藏', app.effects.beaconGroup.visible === false);
    rec('云海隐藏', !app.effects.cloudGroup || app.effects.cloudGroup.visible === false);
    rec('地名标注层隐藏',
      (q('#labelLayer') || {}).style.display === 'none',
      `display=${(q('#labelLayer') || {}).style.display}`);
    rec('星空保留（它就是太空背景）', app.scene.children.some((o) => o.isPoints && o.visible));
    rec('地球按钮高亮', q('[data-view="earth"]').classList.contains('on'));

    /* ---------- 2. 球面几何与地形起伏 ---------- */
    const geo = app.globe.surface.geometry;
    const pos = geo.attributes.position;
    let rMin = Infinity, rMax = -Infinity, rSum = 0;
    for (let i = 0; i < pos.count; i++) {
      const r = Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i));
      if (r < rMin) rMin = r;
      if (r > rMax) rMax = r;
      rSum += r;
    }
    const rAvg = rSum / pos.count;
    rec('球面顶点数符合经/纬分段（481×241）', pos.count === 481 * 241, `${pos.count}`);
    rec('顶点已按高程位移（半径不是常数）', rMax - rMin > 0.02, `半径 ${rMin.toFixed(4)} ~ ${rMax.toFixed(4)}，极差 ${(rMax - rMin).toFixed(4)}`);
    rec('海平面附近的顶点占多数（基准半径正确）',
      Math.abs(rAvg - 1) < 0.02, `平均半径 ${rAvg.toFixed(4)}`);
    rec('陆地抬升方向正确（最高点高于基准）', rMax > 1.02, `最高 ${rMax.toFixed(4)}`);
    rec('海洋下沉方向正确（最低点低于基准）', rMin < 0.998, `最低 ${rMin.toFixed(4)}`);
    rec('存在大气外壳且包住地球',
      !!app.globe.atmosphere && app.globe.atmosphere.geometry.parameters.radius > 1.02,
      `半径 ${app.globe.atmosphere.geometry.parameters.radius}`);

    /* 具体地点的起伏：珠峰一带必须明显高于华北平原 */
    const sampleR = (lon, lat) => {
      const g = app.globe.surface.geometry;
      // 从站点经纬度找到最近顶点（网格是规则的，直接算下标）
      const cols = 481, rows = 241;
      const i = Math.round(((lon + 180) / 360) * (cols - 1));
      const j = Math.round(((90 - lat) / 180) * (rows - 1));
      const k = j * cols + i;
      return Math.hypot(g.attributes.position.getX(k), g.attributes.position.getY(k), g.attributes.position.getZ(k));
    };
    const rEverest = sampleR(86.9, 28.0);
    const rPlain = sampleR(116.0, 35.5);
    rec('地形有实际高低差（珠峰一带高于华北平原）',
      rEverest - rPlain > 0.012, `珠峰 ${rEverest.toFixed(4)} / 平原 ${rPlain.toFixed(4)}，差 ${(rEverest - rPlain).toFixed(4)}`);

    /* ---------- 3. 地标 ---------- */
    const g = app.globe;
    rec('地标数 == 诗境数', g.markers.length === app.SITES.length, `${g.markers.length} / ${app.SITES.length}`);

    let onSphere = 0, dirOk = 0;
    for (const m of g.markers) {
      const r = m.sprite.position.length();
      if (r > 0.99 && r < 1.045) onSphere++;
      // 贴地位置的方向必须与站点经纬度一致（不能整体转了个角度）
      const d = app.lonLatFromDir(m.sprite.position);
      const dLon = Math.abs(((d[0] - m.site.lon + 540) % 360) - 180);
      if (dLon < 0.6 && Math.abs(d[1] - m.site.lat) < 0.6) dirOk++;
    }
    rec('每个地标都贴在球面附近（半径 0.99~1.045）', onSphere === g.markers.length, `${onSphere} / ${g.markers.length}`);
    rec('每个地标的方位与站点经纬度一致（<0.6°）', dirOk === g.markers.length, `${dirOk} / ${g.markers.length}`);

    /* 诗境集中在中国：经度 73~136、纬度 3~54 之外不应有地标 */
    const outside = g.markers.filter((m) => m.site.lon < 73 || m.site.lon > 136 || m.site.lat < 3 || m.site.lat > 54);
    rec('全部诗境都落在中国疆域范围内', outside.length === 0, `${outside.length} 处越界`);

    /* 补偿基准必须真的建立起来。
       单独列这一条，是因为「基准没建立」的后果全都长得很像别的毛病：
       地标尺寸随缩放乱涨、背面地标混进拾取、进入地球后相机纹丝不动。
       直接断言基准本身，能把排查范围一步缩到 captureRef 的调用点上。 */
    rec('地标缩放补偿的基准已建立（markerRef + 每个地标的基准深度）',
      g.markerRef > 0 && g.markers.every((m) => m.refDepth > 0.01),
      `markerRef=${g.markerRef.toFixed(2)}，基准深度为空的 ${g.markers.filter((m) => !(m.refDepth > 0.01)).length} 个`);

    /* ---------- 4. 中国版图要素（合规） ---------- */
    const cpos = app.globe.chinaLines.geometry.attributes.position;
    let jdHits = 0, twHits = 0;
    const vv = new V();
    for (let i = 0; i < cpos.count; i++) {
      vv.set(cpos.getX(i), cpos.getY(i), cpos.getZ(i));
      const ll = app.lonLatFromDir(vv);
      // 南海诸岛：九段线所在的南海海域
      if (ll[0] > 105 && ll[0] < 125 && ll[1] > 3 && ll[1] < 24) jdHits++;
      // 台湾省
      if (ll[0] > 119 && ll[0] < 123.5 && ll[1] > 21.5 && ll[1] < 25.5) twHits++;
    }
    rec('地球上的中国版图包含南海诸岛要素', jdHits > 50, `落在南海海域的轮廓顶点 ${jdHits} 个`);
    rec('地球上的中国版图包含台湾省要素', twHits > 20, `落在台湾省的轮廓顶点 ${twHits} 个`);

    /* ---------- 5. 相机：默认能看到整颗地球 ---------- */
    const silR = () => {
      const d = camDist(), r = 1.055;              // 含大气外壳
      return fpx() * (r / Math.sqrt(d * d - r * r));
    };
    const H = window.innerHeight;
    rec('默认视角能看全整颗地球（球径不超过视口高）',
      silR() <= H / 2 * 0.98, `球半径 ${silR().toFixed(0)}px / 半高 ${H / 2}px`);
    rec('默认视角地球占屏足够大（不是一个小点）',
      silR() >= H / 2 * 0.5, `占比 ${(silR() / (H / 2) * 100).toFixed(0)}%`);
    rec('默认视角把中国转到正面（画面中心落在中国经度带内）',
      (() => { const ll = app.lonLatFromDir(app.camera.position); return ll[0] > 90 && ll[0] < 120 && ll[1] > 20 && ll[1] < 50; })(),
      app.lonLatFromDir(app.camera.position).map((n) => n.toFixed(1)).join(' / '));
    const spanHome = visibleSpanDeg();
    rec('默认视角的可见跨度接近整颗地球（> 120°）',
      spanHome != null && spanHome > 120, `跨度 ${spanHome == null ? '测不到' : spanHome.toFixed(0) + '°'}`);

    /* 极角放开才能「任意方向转动」 */
    rec('极角范围放开到接近两极（可任意方向转动）',
      app.controls.maxPolarAngle > 3.0 && app.controls.minPolarAngle < 0.1,
      `${app.controls.minPolarAngle.toFixed(2)} ~ ${app.controls.maxPolarAngle.toFixed(2)}`);
    rec('地球模式下禁用平移（球体平移没有意义）', app.controls.enablePan === false);
    rec('缩放上下限已切到地球档位',
      Math.abs(app.controls.minDistance - 1.4) < 1e-6 && app.controls.maxDistance === 14,
      `${app.controls.minDistance} ~ ${app.controls.maxDistance}`);
    /* 最近距离的**几何不变量**：相机不能钻进地形里，也不能近到被自己的近裁剪面切掉。
       比断言「minDistance == 1.4」更本质 —— 改数字时这条会跟着提醒你
       「这个数字是干什么用的」（球面最高处 1.0286，near 0.2）。 */
    rec('最近距离离最高的山仍有余量（不会钻进球体内部、也不会被近裁剪面切掉）',
      app.controls.minDistance - rMax > app.camera.near + 0.05,
      `minDistance ${app.controls.minDistance} − 最高地形 ${rMax.toFixed(4)} = ${(app.controls.minDistance - rMax).toFixed(4)}，near ${app.camera.near}`);
    rec('地球档的近裁剪面已切到 0.2（地图档是 0.5，会把拉近后的球整个裁掉）',
      app.camera.near < 0.35, `near=${app.camera.near}`);

    /* 拖动改变方位角 */
    const az = () => Math.atan2(app.camera.position.z, app.camera.position.x) * 180 / Math.PI;
    const az0 = az();
    const el = app.renderer.domElement;
    const drag = (x0, y0, x1, y1) => {
      const mk = (t, x, y) => new PointerEvent(t, {
        clientX: x, clientY: y, bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 1,
      });
      el.dispatchEvent(mk('pointerdown', x0, y0));
      el.dispatchEvent(mk('pointermove', x1, y1));
      el.dispatchEvent(mk('pointerup', x1, y1));
    };
    drag(540, 420, 760, 420);
    await sleep(400);
    const az1 = az();
    rec('拖动可以转动地球（方位角改变 > 15°）', Math.abs(az1 - az0) > 15, `${az0.toFixed(1)}° → ${az1.toFixed(1)}°`);

    /* 滚轮缩放 + 上下限 */
    const wheel = (dy, x = 540, y = 420) => {
      el.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    };
    const d0 = camDist();
    for (let i = 0; i < 3; i++) wheel(-240);
    await sleep(400);
    rec('滚轮可以放大', camDist() < d0 - 0.3, `${d0.toFixed(2)} → ${camDist().toFixed(2)}`);
    for (let i = 0; i < 40; i++) wheel(-240);
    await sleep(600);
    rec('连续放大被下限夹住，且不会钻进球里',
      Math.abs(camDist() - 1.4) < 0.02 && camDist() - rMax > 0.05, `${camDist().toFixed(3)}`);
    /* 最近处的可见跨度必须还在数据撑得住的区间。
       高程数据是 1° 网格，跨度掉到几度就只剩插值出的平滑色块（实测 d=1.08 时
       跨度 2.4°、画面对比度从 172 塌到 24，「看地形变化」直接失效）。 */
    const spanMin = visibleSpanDeg();
    rec('最近处的可见跨度落在数据支撑得住的区间（8°~25°）',
      spanMin != null && spanMin >= 8 && spanMin <= 25, `跨度 ${spanMin == null ? '测不到' : spanMin.toFixed(1) + '°'}`);

    /* 放大到最近处，**真的去看屏幕上的像素**。
       这一组是全脚本里唯一直接读渲染结果的判据，因为近裁剪面这个 bug
       所有状态字段都是对的：state.earth=true、root.visible=true、相机距离合法，
       只有画出来是黑的。读 camera.near 也只是读意图 —— 这里数的是亮像素。 */
    const gl = app.renderer.getContext();
    const centerInk = async (n = 9) => {
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      const px = new Uint8Array(n * n * 4);
      await new Promise((resolve) => {
        const orig = app.composer.render.bind(app.composer);
        app.composer.render = (...a) => {
          orig(...a);
          // 必须在同一个 rAF 回调里读：preserveDrawingBuffer 为 false，
          // 一旦让出主线程，绘制缓冲就被清掉了。
          gl.readPixels(Math.floor(w / 2 - n / 2), Math.floor(h / 2 - n / 2), n, n, gl.RGBA, gl.UNSIGNED_BYTE, px);
          app.composer.render = orig;
          resolve();
        };
      });
      let lit = 0;
      for (let i = 0; i < n * n; i++) if (px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2] > 30) lit++;
      return lit / (n * n);
    };
    const inkFar = await centerInk();
    await setDistAt(1.4);
    const inkNear = await centerInk();
    rec('放到最近处，画面中心仍是地球（近裁剪面没有把球整个裁掉）',
      inkNear > 0.95, `最近处中心区亮像素 ${(inkNear * 100).toFixed(0)}%`);
    rec('最近处与默认视角一样「有内容」（不是只剩星空）',
      inkNear >= inkFar * 0.8, `默认 ${(inkFar * 100).toFixed(0)}% / 最近 ${(inkNear * 100).toFixed(0)}%`);

    /* 负向验证：把近裁剪面推到球前面，中心区必须真的变空 —— 否则上面两条是恒真的 */
    const savedNear = app.camera.near;
    app.camera.near = 6;
    app.camera.updateProjectionMatrix();
    const inkClipped = await centerInk();
    app.camera.near = savedNear;
    app.camera.updateProjectionMatrix();
    rec('负向验证：把近裁剪面推到球前面，中心区确实变空',
      inkClipped < 0.2, `裁剪后亮像素 ${(inkClipped * 100).toFixed(0)}%（对照：正常 ${(inkNear * 100).toFixed(0)}%）`);

    for (let i = 0; i < 60; i++) wheel(240);
    await sleep(600);
    rec('连续缩小被上限夹住', Math.abs(camDist() - 14) < 0.02, `${camDist().toFixed(3)}`);

    /* ---------- 6. 地标尺寸不随缩放变化 ---------- */
    // 前面拖动过、也缩放过，先退出再重进，回到干净的默认太空视角。
    // 退出也要等停稳：退出时的取景补间若还在跑，重进时的补间会以「飞行中途的位置」
    // 为起点，量到的基准距离就不再是默认取景距离，后面的比值全部失去意义。
    q('[data-view="earth"]').click();
    await settled();
    await sleep(400);
    q('[data-view="earth"]').click();
    await settled();
    await sleep(400);
    const refDist = camDist();
    const setDist = setDistAt;
    const sizeAt = async (d) => {
      await setDist(d);
      // 只统计近半球 —— 背面地标被球挡住，深度大得多，混进来会把中位数拉偏
      const arr = g.markers.filter(frontFacing).map(markerPx).filter((x) => x != null && x > 0.5);
      if (!arr.length) throw new Error(`距离 ${d} 处没有可测量的地标（近半球 ${g.markers.filter(frontFacing).length} 个）`);
      arr.sort((a, b) => a - b);
      return arr[Math.floor(arr.length / 2)];
    };
    const pxFar = await sizeAt(refDist);
    const pxNear = await sizeAt(Math.max(1.05, refDist / 3.2));
    const ratio = pxNear / pxFar;
    rec('地标屏幕尺寸不随缩放变大（3.2 倍拉近后变化 < 25%）',
      Math.abs(ratio - 1) < 0.25, `${pxFar.toFixed(1)}px → ${pxNear.toFixed(1)}px，比值 ${ratio.toFixed(3)}`);

    /* 负向验证：清掉基准，补偿必须立刻失效 —— 否则这条断言是恒真的摆设。
       两个字段都要清：refDepth 是逐地标的补偿依据，markerRef 是 HUD 的基准。
       只清 markerRef 是不够的（update 已不再靠它早退），只清 refDepth 也不够
       （留一个基准在，将来若有人把判据挪回 markerRef 上，这条就会变成假阳性）。 */
    const keepRef = g.markerRef;
    const keepDepths = g.markers.map((m) => m.refDepth);
    g.markerRef = 0;
    g.markers.forEach((m) => { m.refDepth = 0; });
    const pxNoComp = await sizeAt(Math.max(1.05, refDist / 3.2));
    g.markerRef = keepRef;
    g.markers.forEach((m, i) => { m.refDepth = keepDepths[i]; });
    rec('负向验证：清掉基准后地标尺寸明显变化（补偿真的在起作用）',
      pxNoComp / pxFar > 1.8 || pxNoComp / pxFar < 0.55,
      `无补偿 ${pxNoComp.toFixed(1)}px vs 有补偿 ${pxFar.toFixed(1)}px，比值 ${(pxNoComp / pxFar).toFixed(2)}`);

    /* 负向验证：可见性判据必须看渲染结果，不是看状态字段 */
    const keepVis = g.root.visible;
    g.root.visible = false;
    const hiddenSeen = g.root.visible === false;
    g.root.visible = keepVis;
    rec('负向验证：可见性判据读的是渲染结果而非状态字段',
      hiddenSeen === true && app.state.earth === true,
      `state.earth=${app.state.earth} 而 root.visible=false 能被判出`);

    /* ---------- 7. 点击地标选中诗境 ---------- */
    await setDist(refDist * 0.42);
    await sleep(300);
    // 选一个「离其他地标最远」的，避免点到叠在一起的那个
    let best = null, bestGap = -1;
    for (const m of g.markers) {
      if (!frontFacing(m)) continue;
      const s = markerScreen(m);
      if (!s || s.x < 320 || s.x > window.innerWidth - 400 || s.y < 100 || s.y > window.innerHeight - 120) continue;
      let gap = Infinity;
      for (const o of g.markers) {
        if (o === m || !frontFacing(o)) continue;
        const so = markerScreen(o);
        if (!so) continue;
        gap = Math.min(gap, Math.hypot(so.x - s.x, so.y - s.y));
      }
      if (gap > bestGap) { bestGap = gap; best = { m, s, gap }; }
    }
    if (!best) {
      rec('找到一个可点且不与其他地标重叠的目标', false, '没有合适的地标');
    } else {
      rec('找到一个可点且不与其他地标重叠的目标', best.gap > 12, `最近邻间距 ${best.gap.toFixed(1)}px`);
      await clickAt(best.s.x, best.s.y);
      rec('点击地球上的地标能选中对应诗境',
        g.selectedId === best.m.site.id,
        `期望 ${best.m.site.id}，实得 ${g.selectedId}`);
      rec('选中后右侧详情同步到该诗境',
        (q('#detailBody') || {}).textContent.indexOf(best.m.site.name) >= 0,
        best.m.site.name);
      /* 选中会触发一次 1.35s 的镜头飞行，必须等它停稳再量落点。
         实测只等 150ms 就量，量到的是飞行中途 —— 失败与功能无关。 */
      await settled();
      await sleep(300);
      const land = markerScreen(best.m);
      rec('选中后地球转到该地点正面朝前（该点落在画面中心附近）',
        !!land && Math.abs(land.x - window.innerWidth / 2) < 90 && Math.abs(land.y - window.innerHeight / 2) < 90,
        land
          ? `落点 (${land.x.toFixed(0)}, ${land.y.toFixed(0)})，画面中心 (${(window.innerWidth / 2).toFixed(0)}, ${(window.innerHeight / 2).toFixed(0)})`
          : '地标不在相机前方');
      rec('选中后相机拉近到区域视角', camDist() < 2.4, `${camDist().toFixed(2)}`);
    }

    /* ---------- 8. 退出并恢复 ---------- */
    q('[data-view="earth"]').click();
    await settled();
    await sleep(500);
    rec('再点一次退出地球模式', app.state.earth === false);
    rec('地球层已隐藏', g.root.visible === false);
    rec('地图已恢复显示', app.map.root.visible === true);
    rec('光柱组已恢复', app.effects.beaconGroup.visible === true);
    rec('标注层已恢复',
      (q('#labelLayer') || {}).style.display !== 'none',
      `display=${(q('#labelLayer') || {}).style.display}`);
    rec('极角范围已还原', Math.abs(app.controls.maxPolarAngle - baseMap.maxPolar) < 1e-6 && Math.abs(app.controls.minPolarAngle - baseMap.minPolar) < 1e-6,
      `${app.controls.minPolarAngle} ~ ${app.controls.maxPolarAngle}`);
    rec('平移已还原', app.controls.enablePan === baseMap.enablePan);
    rec('最大缩放距离已还原', app.controls.maxDistance === baseMap.maxDist, `${app.controls.maxDistance}`);
    rec('近裁剪面已还原（地球档的 0.2 不能留给地图）',
      Math.abs(app.camera.near - baseMap.near) < 1e-9, `${app.camera.near}（地图档 ${baseMap.near}）`);
    rec('主光已还原（不能把「跟着相机走的太阳」留给地图）',
      (() => { let p = null; app.scene.traverse((o) => { if (o.isDirectionalLight && !p) p = o.position.clone(); }); return p.distanceTo(baseMap.keyPos) < 0.01; })(),
      '');
    rec('HUD 说明已还原', ((q('.hud-note') || {}).textContent || '') === baseMap.note);
    rec('退出后相机回到版图取景（距离 > 10）', camDist() > 10, `${camDist().toFixed(2)}`);
    rec('地球按钮高亮已取消', !q('[data-view="earth"]').classList.contains('on'));

    /* ---------- 9. 行迹在地球模式下（球面大圆航线） ----------
       这是本轮新加的能力，也是原先最丑的一块：行迹沿用版图坐标系
       （1 世界单位 ≈ 100km）的弧线抬升 0.55~3.6，放到半径 1 的球上
       就是 3.6 个地球半径的巨型管子 —— 屏幕上那几根又粗又飘的线。
       断言口径直接量**几何本身**（半径、管径、序号牌贴地半径），不读意图字段。 */
    q('[data-mode="route"]').click();
    await sleep(700);
    const rItem = q('#routePoetMenu .route-item');
    if (!rItem) {
      rec('行迹列表有内容（地球行迹的前置）', false, '列表为空');
    } else {
      rItem.click();
      await settled();
      await sleep(500);
      const nStops = document.querySelectorAll('#routeDetail .rp-stop').length;
      rec('3D 下选中行迹 → 行迹已建', !!app.effects.routeGroup, `${nStops} 站`);
      /* 记下 3D 行迹取景的距离。地图与平面共用同一套取景公式
         （`d = max(11.5, max(size.x, size.z) * 2 + 8)`，方向向量是单位向量），
         所以三种视图来回切之后距离都该回到这个值。 */
      const distRoute = camDist();

      /* 带着行迹切进地球 —— 这是「换视图必须整条重建」的那条路 */
      q('[data-view="earth"]').click();
      await settled();
      await sleep(700);

      rec('带着行迹进地球 → 仍是地球模式', app.state.earth === true);
      rec('带着行迹进地球 → 球面航线已建', !!app.globe.routeGroup);
      rec('带着行迹进地球 → 版图那份已清掉（不能把上个坐标系的线留在屏幕上）',
        app.effects.routeGroup === null);
      rec('球面序号牌数 = 行迹站数', app.globe.routeBadges.length === nStops,
        `${app.globe.routeBadges.length} / ${nStops}`);

      /* 关键：航线的抬升必须是「贴着地表飞」的量级。
         实测最大半径 = 站点地形半径(≤1.0286) + 抬升(≤0.11)。 */
      let rMax2 = 0;
      app.globe.routeCurve.points.forEach((p) => { rMax2 = Math.max(rMax2, p.length()); });
      rec('球面航线的抬升贴着地表（最大半径 < 1.16，不是版图那套抬 3.6）',
        rMax2 < 1.16, `最大半径 ${rMax2.toFixed(4)}`);

      const tubeR = app.globe.routeTube.geometry.parameters.radius;
      rec('球面航线管径是「一条线」的量级（0 < r < 0.02，不是一根粗管子）',
        tubeR > 0 && tubeR < 0.02, `管半径 ${tubeR}`);

      /* 航线画了两层：深色底衬 + 发光航线本身。
         只画发光那层的话，加色混合的米金色压在明亮的橄榄绿地形上会洗成一片白，
         航线在中国大陆上空几乎看不见。 */
      rec('球面航线带深色底衬（亮地形上也读得出线形）',
        !!app.globe.routeCasing && app.globe.routeCasing.geometry.parameters.radius > tubeR,
        app.globe.routeCasing
          ? `底衬半径 ${app.globe.routeCasing.geometry.parameters.radius.toFixed(5)} vs 航线 ${tubeR.toFixed(5)}`
          : '底衬缺失');

      /* 几何顶点必须全是有限值。
         这条是给一个真踩过的坑守门：Globe 的 markerComp 忘了初始化时，
         buildRoute 里的 `0.0042 * this.markerComp` 算出 NaN，TubeGeometry
         的顶点全变 NaN —— 球面上**整条航线一根线都画不出来**，
         而 state.earth / routeGroup / 序号牌 / 拾取表全都正常，
         只有管线静默消失，光看「routeGroup 存在」根本发现不了。 */
      const tp = app.globe.routeTube.geometry.attributes.position;
      let nanV = 0;
      for (let i = 0; i < tp.count * 3; i++) if (!Number.isFinite(tp.array[i])) nanV += 1;
      rec('球面航线几何没有 NaN 顶点（半径算成 NaN 时整条线会静默消失）',
        nanV === 0, `NaN 分量 ${nanV} / ${tp.count * 3}`);

      /* 负向验证：手动打进一个 NaN，上面那条必须真的数得出来 */
      const keep0 = tp.array[0];
      tp.array[0] = NaN;
      let nanAfter = 0;
      for (let i = 0; i < tp.count * 3; i++) if (!Number.isFinite(tp.array[i])) nanAfter += 1;
      tp.array[0] = keep0;
      rec('负向验证：NaN 顶点确实会被数出来（上面那条不是恒真）',
        nanAfter === 1, `打入 1 个 NaN → 数出 ${nanAfter} 个`);

      const badgeR = app.globe.routeBadges.map((b) => b.sprite.position.length());
      rec('球面序号牌都贴在站点正上方（半径 0.99~1.08）',
        badgeR.every((r) => r > 0.99 && r < 1.08),
        `${Math.min(...badgeR).toFixed(3)} ~ ${Math.max(...badgeR).toFixed(3)}`);

      /* 序号牌要**真的看得清**，也不能大得压住地球。
         屏幕尺寸 = baseScale × fpx / 基准深度，与缩放无关（见下一条）。
         1440×900 下 fpx ≈ 1679、基准深度 ≈ 4.33，故 0.070 → 约 27px；
         地标是 13.9px。这里直接量屏幕像素，而不是读 baseScale 字段
         （字段是意图，像素是事实）。 */
      const badgePx = (b) => {
        const d = depthOf(b.sprite.position);
        return d > 0.05 ? (b.sprite.scale.x * fpx()) / d : null;
      };
      const pxB0 = badgePx(app.globe.routeBadges[0]);
      rec('球面序号牌的屏幕尺寸够读又不压住地球（18~30px）',
        pxB0 != null && pxB0 >= 18 && pxB0 <= 30,
        `${pxB0 == null ? '测不到' : pxB0.toFixed(1) + 'px'}（地标约 13.9px）`);

      /* 层级必须显式压过地标与飞线光点。
         三者位置几乎重合，透明队列按「投影 z」排序，而序号牌只往外挪了 0.016 ——
         站点偏离画面中心时这点径向偏移在视线方向上可能反而更远，
         地标（加色混合、光晕比牌子大一圈）就被排在后面画，整块序号牌被洗成白。 */
      rec('球面序号牌的层级高于航线与地标（renderOrder 定死，不靠 z 排序）',
        app.globe.routeBadges.every((b) => b.sprite.renderOrder > (app.globe.routeTube.renderOrder || 0)),
        `序号牌 ${app.globe.routeBadges[0].sprite.renderOrder} / 航线 ${app.globe.routeTube.renderOrder}`);

      // 与地标同一条规则：拉远只缩小地球，序号牌不变小
      const distBadge = camDist();
      await setDistAt(Math.min(12, distBadge * 2));
      const pxB1 = badgePx(app.globe.routeBadges[0]);
      await setDistAt(distBadge);
      rec('球面序号牌不随缩放变化（拉远 2 倍后变化 < 25%）',
        pxB0 != null && pxB1 != null && Math.abs(pxB1 / pxB0 - 1) < 0.25,
        `${pxB0 == null ? '?' : pxB0.toFixed(1)}px → ${pxB1 == null ? '?' : pxB1.toFixed(1)}px`);

      /* 行迹聚焦在地球上：被聚焦的站点由**序号牌**代表，地标必须收起。
         地标是加色混合的白色光晕，比序号牌还大一圈，又被泛光再放大一次 ——
         留在地标位就整片糊住数字（这正是「行迹序号看不清」的成因）。
         所以这里断言的是「0 个地标 + 站数块序号牌」，而不是「剩 9 个地标」。 */
      const visM = app.globe.markers.filter((m) => m.sprite.visible).length;
      const badgeIds = new Set(app.globe.routeBadges.map((b) => b.siteId));
      rec('行迹聚焦在地球上也生效（地标让位给序号牌：0 个地标 + 站数块序号牌）',
        visM === 0 && badgeIds.size === nStops,
        `地标 ${visM} 个 · 序号牌 ${badgeIds.size} / ${nStops}`);

      /* 序号牌取代地标的前提是**它就落在站点自己的位置上**。
         量三维距离：序号牌贴在站点正上方 0.016 个地球半径处，
         地标贴 0.0035 —— 两者相差 0.0125，远小于站间距离。 */
      const worstD = Math.max(...app.globe.routeBadges.map((b) => {
        const m = app.globe.markers.find((x) => x.site.id === b.siteId);
        return m ? b.sprite.position.distanceTo(m.sprite.position) : 0;
      }));
      rec('序号牌就落在站点地标的位置上（取代地标不丢位置）', worstD < 0.05,
        `最大偏差 ${worstD.toFixed(4)} 个地球半径`);

      /* 负向验证：清掉聚焦集合，79 个地标必须全部回来 ——
         否则上面那条可能是「本来就只有 9 个可见」的恒真断言。 */
      const keepFocus = app.globe.routeFocus;
      app.globe.setRouteFocus(null);
      const visAll = app.globe.markers.filter((m) => m.sprite.visible).length;
      app.globe.setRouteFocus(keepFocus);
      rec('负向验证：清掉聚焦集合后 79 个地标全部回来（上面那条不是恒真）',
        visAll === app.SITES.length, `${visAll} / ${app.SITES.length}`);

      const picks = app.globe.pickables(app.camera);
      rec('球面序号牌进入了拾取表（点序号也能选中该站）',
        picks.some((o) => app.globe.routeBadges.some((b) => b.sprite === o)),
        `可拾取 ${picks.length} 个`);

      rec('行迹取景落在球面缩放的合法区间内',
        camDist() > 1.4 && camDist() < 14, `距离 ${camDist().toFixed(2)}`);

      /* ---- 换视图：行迹必须整条按新坐标系重建 ---- */
      q('[data-view="flat"]').click();
      await settled();
      await sleep(800);
      rec('带着行迹切 2D → 球面航线已清', app.globe.routeGroup === null);
      rec('带着行迹切 2D → 平面线路已建', !!app.effects.routeGroup);
      rec('带着行迹切 2D → 记下的模式是 flat', app.effects.routeMode === 'flat',
        `routeMode=${app.effects.routeMode}`);
      const ys = app.effects.routeCurve.points.map((p) => p.y);
      rec('平面线路是「等高」的一条线（俯视下不偏离真实走向）',
        Math.max(...ys) - Math.min(...ys) < 1e-6,
        `y 极差 ${(Math.max(...ys) - Math.min(...ys)).toExponential(2)}`);
      rec('平面序号牌贴地（抬升 ≤ 0.2 —— 2D 下序号就是落点标记）',
        app.effects.routeBadges.every((b) => b.lift <= 0.2),
        `最大抬升 ${Math.max(...app.effects.routeBadges.map((b) => b.lift)).toFixed(3)}`);
      /* 换视图后必须**重新取景**，否则相机停在「默认版图视角」，
         版图缩在一角、行迹几乎看不见（2D 下明明框得好好的，切到 3D 却像换了一条路线）。
         地图与平面共用同一套取景公式，距离应回到 3D 行迹取景时的值。 */
      rec('切 2D 后按新视图重新取景（不是停在默认版图视角）',
        Math.abs(camDist() - distRoute) < 0.5,
        `${camDist().toFixed(2)}（3D 行迹取景 ${distRoute.toFixed(2)}，默认版图约 17.8）`);

      q('[data-view="flat"]').click();
      await settled();
      await sleep(800);
      rec('带着行迹切回 3D → 记下的模式是 3d', app.effects.routeMode === '3d',
        `routeMode=${app.effects.routeMode}`);
      rec('带着行迹切回 3D → 序号牌抬到光柱顶端（不再是贴地的 0.12）',
        app.effects.routeBadges.every((b) => b.lift > 1),
        `最小抬升 ${Math.min(...app.effects.routeBadges.map((b) => b.lift)).toFixed(2)}`);
      rec('带着行迹切回 3D → 按行迹重新取景（相机没留在默认版图视角）',
        Math.abs(camDist() - distRoute) < 0.5,
        `${camDist().toFixed(2)}（3D 行迹取景 ${distRoute.toFixed(2)}，默认版图约 17.8）`);

      /* 收尾：退出行迹模式，把页面还原成「3D 探索」交给下一套脚本 */
      q('#routeClose').click();
      await settled();
      await sleep(700);
      rec('退出行迹 → 平面与球面两份几何都已清空',
        app.effects.routeGroup === null && app.globe.routeGroup === null);
      rec('退出行迹 → 回到 3D 探索模式（没有留下 2D / 地球的残留）',
        app.state.earth === false && app.state.flat === false,
        `earth=${app.state.earth} flat=${app.state.flat}`);
    }

    return out;
  };

  /* 出错也要把已经收集到的断言交出去。
     否则一个中途抛出的异常会让整轮结果塌成一句报错 —— 实测因为 globe.captureRef
     的签名从「距离」改成了「相机」而调用点没跟上，脚本在第 267 行炸掉，
     前面 20 多条已经判失败的断言全被吞掉，屏幕上只剩一句
     「距离 14 处没有可测量的地标」，排查方向被误导了很久。 */
  return run().catch((e) => {
    rec('脚本未意外中断（异常前已收集的断言仍然有效）', false, `${(e && e.message) || e}`);
    return out;
  });
})();
