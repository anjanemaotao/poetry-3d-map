/* 缩放补偿 + HUD 精度回归（注入页面执行）。
 *
 * 回答两个问题：
 *   1. 滚轮放大时，光柱 / 地面光圈 / 行迹标记的**屏幕尺寸**是否保持不变？
 *      （修之前它们随缩放一起放大：拉到最近会涨到 15 倍，放大等于没放大。）
 *   2. HUD 的经纬度读数是否随缩放自动提高小数位（2 → 3 → 4）？
 *
 * 量的口径是**投影到屏幕后的像素**，不是 scale 字段 —— scale 对不对不重要，
 * 看起来对不对才重要。
 *
 * 三个实测踩过的坑，改这段前先看：
 *   a) 相机后方的站点必须剔除。它们的 project() 会翻折出垃圾坐标，
 *      曾把远端站点误算成「涨到 2.2 倍」。
 *   b) 光柱偏离视轴时投影成斜线，只取纵向差 |Δy| 会低估，要量投影全长。
 *   c) 光圈有呼吸（scale 含 1 + 0.28·sin），两次快照相隔数百毫秒相位不同，
 *      外径会差 ±50%，必须先扣掉呼吸再比。
 */
(() => {
  const out = [];
  const rec = (name, pass, extra) => out.push({ name, pass: !!pass, extra: extra == null ? '' : String(extra) });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let app = null;
  let V = null;

  /** 启动守卫：reload 后页面偶发还没 boot（__app 未挂），直接读会 TypeError。 */
  const boot = async () => {
    for (let i = 0; i < 40; i++) {
      const a = window.__app;
      if (a && a.effects && a.effects.beacons && a.effects.beacons.size) {
        app = a; V = a.camera.position.constructor; return true;
      }
      await sleep(250);
    }
    return false;
  };

  const camDist = () => app.camera.position.distanceTo(app.controls.target);
  const fpx = () => (window.innerHeight / 2) / Math.tan((app.camera.fov * Math.PI) / 180 / 2);

  /** 全站快照：只统计「在相机前方且完全落在视口内」的站点 */
  const snap = () => {
    const m = new Map();
    const vv = new V();
    const W = window.innerWidth, H = window.innerHeight;
    app.effects.beacons.forEach((b) => {
      if (!b.visible) return;
      const comp = b.group.scale.y || 1;
      const base = b.group.position.clone();
      const top = base.clone().setY(base.y + 1.75 * comp);
      const depth = -vv.copy(base).applyMatrix4(app.camera.matrixWorldInverse).z;
      if (!(depth > 0.15)) return;                 // 坑 a：相机后方，投影不可信
      const proj = (p) => {
        const q = p.clone().project(app.camera);
        return { x: (q.x * 0.5 + 0.5) * W, y: (-q.y * 0.5 + 0.5) * H };
      };
      const A = proj(base);
      if (!(A.x > 40 && A.x < W - 40 && A.y > 40 && A.y < H - 40)) return;   // 只统计视口内
      const B = proj(top);
      const colPx = Math.hypot(B.x - A.x, B.y - A.y);      // 坑 b：投影全长
      const rp = 1 + 0.28 * Math.sin(app.effects.time * 1.6 + b.phase);   // 坑 c：扣呼吸
      const E = proj(base.clone().add(new V(0.175 * comp, 0, 0)));
      m.set(b.site.id, {
        colPx, ringPx: Math.abs(E.x - A.x) * 2 / rp, comp, depth,
        // 假想「没有补偿」时的屏幕高度：用于负向验证，证明断言不是空转
        rawPx: 1.75 * fpx() / depth,
      });
    });
    return m;
  };

  const setDist = async (d) => {
    const dir = app.camera.position.clone().sub(app.controls.target).normalize();
    app.camera.position.copy(app.controls.target).addScaledVector(dir, d);
    app.controls.update();
    await sleep(400);
  };

  const ratios = (a, b, key) => {
    const r = [];
    b.forEach((v, id) => {
      const p = a.get(id);
      if (p && p[key] > 0.5) r.push({ id, k: v[key] / p[key] });
    });
    r.sort((x, y) => Math.abs(Math.log(y.k)) - Math.abs(Math.log(x.k)));
    return r;
  };

  const hudLon = () => document.querySelector('#hudLon').textContent;
  const hudLat = () => document.querySelector('#hudLat').textContent;
  const dec = (s) => (s.includes('.') ? s.split('.')[1].replace(/[^\d]/g, '').length : 0);

  /** 在画布上发一次真实 pointermove，让 HUD 有读数 */
  const moveMouse = () => {
    const r = app.renderer.domElement.getBoundingClientRect();
    app.renderer.domElement.dispatchEvent(new PointerEvent('pointermove', {
      clientX: r.left + r.width * 0.45, clientY: r.top + r.height * 0.55,
      bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse',
    }));
  };

  return (async () => {
    if (!await boot()) { rec('页面已 boot（window.__app 已挂）', false, '等 10s 仍未就绪'); return out; }
    rec('页面已 boot（window.__app 已挂）', true, '');

    /* ---------- 一、补偿基准 ---------- */
    const ref = app.effects.markerRef;
    const withRef = [...app.effects.beacons.values()].filter((b) => b.refDepth > 0).length;
    rec('已注入全局参考距离', ref > 0, ref.toFixed(2));
    rec('每个站点都记录了默认深度基准', withRef === app.effects.beacons.size,
      `${withRef} / ${app.effects.beacons.size} 个站点`);

    /* ---------- 二、缩放范围 ---------- */
    const minD = app.controls.minDistance, maxD = app.controls.maxDistance;
    rec('向内缩放范围 ≥ 10 倍（放大才真的能看细节）', ref / minD >= 10,
      `可拉近 ${(ref / minD).toFixed(1)} 倍（min=${minD.toFixed(2)}）`);
    rec('向外缩放上限未被改动', maxD === 260, `max=${maxD}`);

    /* ---------- 三、默认视角：补偿系数必须恒为 1（画面与修前一致） ---------- */
    const s0 = snap();
    rec('默认视角下所有站点补偿系数 = 1（不改动原画面）',
      [...s0.values()].every((v) => Math.abs(v.comp - 1) < 1e-6), `${s0.size} 个站点在视口内`);

    /* ---------- 四、拉到最近：屏幕尺寸必须不变 ---------- */
    await setDist(0.2);
    rec('拉到最近时距离被夹在 minDistance', Math.abs(camDist() / minD - 1) < 0.05, camDist().toFixed(2));

    const s1 = snap();
    const rc = ratios(s0, s1, 'colPx');
    const rr = ratios(s0, s1, 'ringPx');
    const wc = rc[0], wr = rr[0];
    rec('两视角共同可见的站点足够多（样本可信）', rc.length >= 3, `共同可见 ${rc.length} 个`);
    /* 容差 ±25%：光柱是竖直标记，投影长度还随它在屏幕上的位置变化（越靠视口
       边缘被斜切得越厉害），这是透视投影的二阶效应，标量补偿消不掉，
       原始设计里同样存在。实测最差 1.21×，而修之前是 15 倍。 */
    rec('光柱屏幕高度变化都在 ±25% 内', rc.every((x) => Math.abs(x.k - 1) < 0.25),
      wc ? `最差 ${wc.id} ${wc.k.toFixed(2)}×` : '无样本');
    rec('地面光圈屏幕外径变化都在 ±25% 内', rr.every((x) => Math.abs(x.k - 1) < 0.25),
      wr ? `最差 ${wr.id} ${wr.k.toFixed(2)}×` : '无样本');
    rec('没有任何站点跟着放大', rc.every((x) => x.k < 1.4), wc ? `最大 ${wc.k.toFixed(2)}×` : '无样本');

    /* 负向验证：不加补偿时同一批站点本该涨成好几倍。
       若这条不过，说明上面的「不变」是假通过（比如相机压根没动）。 */
    const raw = rc.map((x) => s1.get(x.id).rawPx / s0.get(x.id).rawPx).sort((a, b) => b - a);
    rec('负向验证：不补偿时屏幕高度本会涨 ≥3 倍（断言非空转）', raw.length > 0 && raw[0] >= 3,
      raw.length ? `不补偿则为 ${raw[0].toFixed(1)}×` : '无样本');

    /* 世界尺寸确实被压小了 —— 证明是「地图变大、标记不变」而非「都没动」 */
    const comps = [...app.effects.beacons.values()].filter((b) => b.visible).map((b) => b.comp || 1);
    rec('标记的世界尺寸确实被压小（是地图在放大）', Math.min(...comps) < 0.3,
      `世界尺寸最小 ${Math.min(...comps).toFixed(3)}×`);

    /* 负向验证：把补偿整个关掉（全局基准归零 + 清掉逐站点基准），
       同一批站点在最近处的屏幕高度必须明显变大。这是最直接的一条 ——
       证明上面那些「不变」是补偿挣来的，而不是因为相机没动或量错了。
       量完必须原样还原，否则会污染后面的断言。 */
    const savedRef = app.effects.markerRef;
    const savedDepths = [...app.effects.beacons.values()].map((b) => b.refDepth);
    app.effects.markerRef = 0;
    [...app.effects.beacons.values()].forEach((b) => { b.refDepth = 0; });
    await setDist(ref);
    const n0 = snap();
    await setDist(0.2);
    const n1 = snap();
    const offR = ratios(n0, n1, 'colPx');
    rec('负向验证：关掉补偿后光柱屏幕高度确实会涨 ≥3 倍',
      offR.length > 0 && offR[0].k >= 3,
      offR.length ? `关掉补偿后最大 ${offR[0].k.toFixed(1)}×` : '无样本');
    app.effects.markerRef = savedRef;
    [...app.effects.beacons.values()].forEach((b, i) => { b.refDepth = savedDepths[i]; });

    /* ---------- 五、视域确实收窄（放大有实际收益） ---------- */
    const H = window.innerHeight, W = window.innerWidth;
    const visW = (d) => 2 * Math.tan((app.camera.fov * Math.PI / 180) / 2) * d * (W / H) * 0.164 * 111;
    rec('拉到最近后视域收窄到 1/8 以下', visW(camDist()) < visW(ref) / 8,
      `${visW(ref).toFixed(0)}km → ${visW(camDist()).toFixed(0)}km`);

    /* ---------- 六、HUD 经纬度精度随缩放提升 ---------- */
    await setDist(ref);
    moveMouse(); await sleep(200);
    rec('默认视角：HUD 有合法经纬度读数', /°[EW]/.test(hudLon()) && /°[NS]/.test(hudLat()),
      `${hudLon()} / ${hudLat()}`);
    rec('默认视角：读数为 2 位小数', dec(hudLon()) === 2, `${dec(hudLon())} 位`);

    await setDist(ref / 3);
    moveMouse(); await sleep(200);
    rec('放大约 3 倍：读数升到 3 位小数', dec(hudLon()) === 3, `${hudLon()}（${dec(hudLon())} 位）`);

    await setDist(0.2);
    moveMouse(); await sleep(200);
    rec('拉到最近：读数升到 4 位小数', dec(hudLon()) === 4, `${hudLon()}（${dec(hudLon())} 位）`);
    rec('读数始终落在国境经纬度范围内', (() => {
      const lon = parseFloat(hudLon()), lat = parseFloat(hudLat());
      return lon >= 70 && lon <= 140 && lat >= 3 && lat <= 56;
    })(), `${hudLon()} / ${hudLat()}`);

    /* 鼠标不动、只滚轮缩放：读数也要跟着升级（渲染循环里重刷） */
    await setDist(ref);
    moveMouse(); await sleep(250);
    rec('回到默认：读数回落到 2 位', dec(hudLon()) === 2, `${hudLon()}`);
    await setDist(ref / 3);            // 这次刻意不再发 pointermove
    await sleep(450);
    rec('鼠标不动、只缩放：读数自动升到 3 位', dec(hudLon()) === 3, `${hudLon()}（${dec(hudLon())} 位）`);

    /* 负向验证：精度参数必须真的被采纳。直接调 updateHud 传不同位数，
       若哪天有人在实现里把小数位写死，这里会立刻失败。 */
    app.ui.updateHud.call(app.ui, 116.39751, 39.90882, 4);
    const d4 = `${hudLon()} / ${hudLat()}`;
    app.ui.updateHud.call(app.ui, 116.39751, 39.90882, 2);
    const d2 = `${hudLon()} / ${hudLat()}`;
    rec('负向验证：updateHud 会采纳传入的小数位数',
      d4 === '116.3975°E / 39.9088°N' && d2 === '116.40°E / 39.91°N', `4位→${d4}；2位→${d2}`);
    app.ui.updateHud.call(app.ui, 116.39751, 39.90882, 0);
    rec('负向验证：位数可降到 0（参数不是被忽略）', hudLon() === '116°E', hudLon());

    await setDist(ref);                // 复位，别污染后续脚本
    return out;
  })();
})();
