// 视觉特效：诗境地标光柱、行迹飞线、云海、涟漪
import * as THREE from 'three';
import { lonLatToWorld, provinceAt, makeGlowTexture, makeCloudTexture } from './map3d.js';

// 各朝代的地标配色。已在文件末尾导出给地球模式复用 —— 同一处诗境在两种视图里
// 必须是同一个颜色，否则用户在两张图之间切换时会以为看的是两批地点。
const ERA_COLOR = {
  xy: 0xb9a6ff, hw: 0x7ec8ff, jn: 0x6fe8cf,
  tang: 0xffc65e, song: 0xff8f76, yh: 0xd3a6ff,
  read: 0x8fb6d6,
};

// 行迹站点序号牌的基准边长，以及它在站点正上方的基准抬升高度（均为世界单位、补偿系数为 1 时的值）
const ROUTE_BADGE = 0.62;
const BADGE_LIFT = 2.05;

/* ---------- 2D 平面模式的三个尺寸 ----------
 *
 * 2D 下光柱、灯球、光晕、地面光圈全部收起，只留一个「落点圆点」。
 * 圆点做多大要按屏幕像素反推，不能凭手感 ——
 * 默认取景时版图（含南海诸岛）约 8 个世界单位宽、落在约 760px 的可视区里，
 * 即约 0.0105 世界单位 / px。所以：
 *   半径 0.07 → 直径 0.14 → 约 13px，是一个明确的「小圆点」；
 *   原地面光圈外径 0.175×2.1 = 0.37 → 约 35px，正是不该再要的那种「光圈」。
 * 圆点随缩放补偿保持恒定屏幕尺寸（与其它标记同一条规则）。
 */
const DOT_R = 0.07;
const DOT_RIM_R = 0.088;      // 深色描边外径：浅色地形上也要看得见
/**
 * 2D 下行迹的「贴地」参数。
 * 序号牌在三维下是浮在光柱顶端的，俯视时它会正压在圆点上 ——
 * 与其让它盖住圆点，不如让它**就是**圆点：抬升压到几乎贴地、尺寸缩到 0.72 倍，
 * 于是一枚带编号的圆点既是落点标记也是序号，两者不再打架。
 */
const FLAT_BADGE_LIFT = 0.12;
const FLAT_BADGE_K = 0.72;
/**
 * 2D 下行迹线路统一抬到「该行迹最高站点之上」再画。
 *
 * 为什么不逐点贴各自省份的高度：版图是挤出的立体地形，四川台面 0.96、
 * 江苏只有 0.16，一条从成都到扬州的线如果贴着各自高度画，经过更高省份的那一段
 * 会被台面**遮住**（俯视下就是「线断了一截」）。抬到最高点之上就没有遮挡问题，
 * 而俯视投影里这个高度差不产生任何屏幕位移，看上去仍是一条平面线。
 */
const FLAT_ROUTE_CLEAR = 0.08;

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.time = 0;
    this.beacons = new Map();   // siteId -> {group, ring, column, lantern, hit, site, color}
    this.ripples = [];
    this.clouds = [];
    this.routeGroup = null;
    this.routeDots = [];
    this.routeCurve = null;
    this.glowTex = makeGlowTexture();
    this.pickables = [];
    this.mode = '3d';    // '3d' | 'flat'：2D 平面下光柱换成落点圆点
    this.flat = false;   // this.mode === 'flat' 的快捷判据（外部/回归脚本读它）
    // 缩放补偿：见 setMarkerRef / markerScale
    this.markerRef = 0;      // 参考相机距离（默认取景距离），由 main.js 注入
    this.markerComp = 1;     // 当前补偿系数，供外部断言/调试读取
    this.routeTube = null;   // 行迹管线的 mesh，半径需按缩放重建
    this.routeTubeBase = 0.026;
    this.routeBadges = [];   // 行迹站点序号牌（Sprite），需按缩放改 scale
    this.routeMode = '3d';   // 建这条行迹时用的视图模式（决定抬升与序号样式）
    this._tubeComp = 1;
    this._fwd = new THREE.Vector3();   // 复用：相机朝向
    this._tmp = new THREE.Vector3();   // 复用：临时向量，避免每帧分配
  }

  /**
   * 注入「全局参考距离」——默认取景时相机到 controls.target 的距离。
   * 只用于没有归属站点的那几样东西：行迹管线、以及 HUD 精度的换算。
   */
  setMarkerRef(dist) {
    if (dist > 0) this.markerRef = dist;
  }

  /**
   * 逐站点记录「默认取景时该站点在相机前方的深度」，作为该站点标记的 1.0 基准。
   *
   * 为什么逐站点，不能用统一系数：标记的屏幕尺寸取决于**它自己**相对相机的
   * 位置，而统一系数只能拿到「相机到 controls.target」的距离 —— 两者仅在站点
   * 恰位于视野中心时才相等。用统一系数，中心处的标记精确，偏出去的会一起缩：
   * 实测离中心 2 个世界单位的站点缩到 0.6 倍、远处站点缩到 0.47 倍，
   * 而拉到最近正是最需要看清偏处细节的时候。
   *
   * 为什么用「深度」而不是「直线距离」：透视投影下屏幕尺寸 ∝ 世界尺寸 / 深度，
   * 深度是相机朝向上（view 空间 z）的分量。偏离视轴 θ 的站点，直线距离 = 深度/cosθ，
   * 用直线距离补偿会多缩 1/cosθ —— 实测远端站点因此涨到 2.2 倍。
   *
   * 基准取「该站点自己的默认深度」，于是默认视角下每个站点的补偿系数都恒为 1，
   * 画面与引入补偿前逐像素一致。
   */
  captureMarkerRefs(camera) {
    const fwd = this._fwd;
    camera.getWorldDirection(fwd);
    const v = this._tmp;
    this.beacons.forEach((b) => {
      v.subVectors(b.group.position, camera.position);
      b.refDepth = v.dot(fwd);
      b.refDist = v.length();     // 保留直线距离，仅供调试/断言参考
    });
  }

  /**
   * 全局补偿系数（只给没有单一归属站点的行迹管线用）。
   *
   * 光柱、地面光圈、行迹圆点这些是「标记」而不是地理实体：透视投影下
   * 屏幕尺寸 ∝ 世界尺寸 / 深度，所以只要让世界尺寸正比于深度，屏幕尺寸就恒定。
   * 效果是滚轮放大时地图变大、标记不变 —— 这样放大才真的「看得出细节」，
   * 而不是连光柱一起放大、看起来跟没放大一样。
   *
   * 上下限只为兜底：下限防止极小深度下标记缩成亚像素，上限防止缩到最远时
   * 标记在世界坐标里大到离谱（缩到最远时标记屏幕尺寸会自然变小，正是想要的）。
   * 下限必须低于实际会用到的极小值：默认取景深度约 17、最近可拉到 1.2，
   * 即补偿系数最小约 0.07 —— 若下限卡在 0.085 之上，拉到最近时光圈会
   * 悄悄缩掉一圈（实测外径 45px → 21px，撞下限那次就是被它吃掉的）。
   */
  markerScale(camDist) {
    if (!(this.markerRef > 0) || !(camDist > 0)) return 1;
    return Math.min(2.4, Math.max(0.02, camDist / this.markerRef));
  }

  /**
   * 任意点位的补偿系数：以该点位自己的默认深度 refDepth 为基准。
   * 未记录基准、或点位落在相机后方（深度 ≤ 0，投影会翻折）时退回全局系数。
   */
  pointScale(refDepth, pos, camPos, fwd) {
    if (!(refDepth > 0)) return this.markerScale(this.markerRef);
    const d = this._tmp.subVectors(pos, camPos).dot(fwd);
    if (!(d > 0)) return this.markerScale(this.markerRef);
    return Math.min(2.4, Math.max(0.02, d / refDepth));
  }

  /** 单个站点标记的补偿系数。 */
  beaconScale(b, camPos, fwd) {
    return this.pointScale(b.refDepth, b.group.position, camPos, fwd);
  }

  /**
   * 视图模式开关（'3d' | 'flat'）。
   *
   * 三维下每个诗境是一根光柱 + 顶端灯球 + 光晕 + 地面光圈；从正上方俯视时
   * 光柱只剩顶上的一个点，整套装饰既不成立、又会连成一片。
   * 2D 下把它们全部收起，只留一个**落点圆点**（见 DOT_R），
   * 地名由 DOM 标注层放在圆点旁边 —— 这才是「平面地图上的一个地点」。
   *
   * 拾取柱体（hit）两种模式都留着：它是不可见的，且俯视下正好是一个小圆盘，
   * 「点圆点能选中」这条路径不该因为换模式而失效。
   */
  setMode(mode) {
    const m = mode === 'flat' ? 'flat' : '3d';
    this.mode = m;
    this.flat = m === 'flat';
    const is3d = m === '3d';
    this.beacons.forEach((b) => {
      b.column.visible = is3d;
      b.lantern.visible = is3d;
      b.halo.visible = is3d;
      b.ring.visible = is3d;
      b.dot.visible = !is3d;
      b.rim.visible = !is3d;
    });
  }

  /** 兼容旧签名（外部脚本 / 调试钩子仍按 on/off 调用） */
  setFlatMode(on) { this.setMode(on ? 'flat' : '3d'); }

  /* ---------------- 地标 ---------------- */
  createBeacons(sites) {
    const beaconGroup = new THREE.Group();
    beaconGroup.name = 'beacons';

    const columnMat = (color) => new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uColor: { value: new THREE.Color(color) }, uTime: { value: 0 }, uOpacity: { value: 0.52 } },
      vertexShader: `
        varying float vY;
        void main(){ vY = position.y + 0.5; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: `
        varying float vY; uniform vec3 uColor; uniform float uTime; uniform float uOpacity;
        void main(){
          float a = pow(clamp(1.0-vY,0.0,1.0), 2.0);
          float pulse = 0.7 + 0.3*sin(uTime*2.2 + vY*7.0);
          gl_FragColor = vec4(uColor, a*uOpacity*pulse);
        }`,
    });

    sites.forEach((site) => {
      const prov = provinceAt(site.lon, site.lat);
      const baseY = prov.height + 0.02;
      const pos = lonLatToWorld(site.lon, site.lat, baseY);
      const color = ERA_COLOR[site.era] || 0xffc65e;

      const group = new THREE.Group();
      group.position.copy(pos);
      group.userData.siteId = site.id;

      // 光柱
      const colH = 1.75;
      const column = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.105, colH, 10, 1, true), columnMat(color));
      column.position.y = colH / 2;
      group.add(column);

      // 顶部灯球
      const lantern = new THREE.Mesh(
        new THREE.SphereGeometry(0.062, 14, 12),
        new THREE.MeshBasicMaterial({ color: 0xffffff }),
      );
      lantern.position.y = colH;
      group.add(lantern);

      const halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.glowTex, color, transparent: true, opacity: 0.42,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      halo.scale.setScalar(0.5);
      halo.position.y = colH;
      group.add(halo);

      // 地面光圈
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.115, 0.175, 40),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.75, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.02;
      group.add(ring);

      /* 2D 落点圆点（默认隐藏，切到平面模式才显）。
         深色描边 + 亮色圆心：地图地形有深绿、土黄、雪白三档明度，
         只画一个纯色点的话，在雪线高原上会直接消失。
         描边用不透明深色、圆心用朝代色，两件都保持恒定屏幕尺寸。 */
      const rim = new THREE.Mesh(
        new THREE.CircleGeometry(DOT_RIM_R, 24),
        new THREE.MeshBasicMaterial({ color: 0x061019, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }),
      );
      rim.rotation.x = -Math.PI / 2;
      rim.position.y = 0.028;
      rim.visible = false;
      rim.renderOrder = 4;
      group.add(rim);

      const dot = new THREE.Mesh(
        new THREE.CircleGeometry(DOT_R, 22),
        new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, depthWrite: false }),
      );
      dot.rotation.x = -Math.PI / 2;
      dot.position.y = 0.030;      // 比描边再高一点，避免同深度打架
      dot.visible = false;
      dot.renderOrder = 5;
      group.add(dot);

      // 拾取用隐形柱体（贴合光柱外形，半径小以免相邻站点互相遮挡）
      const hit = new THREE.Mesh(
        new THREE.CylinderGeometry(0.16, 0.2, 1.9, 8, 1, true),
        new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }),
      );
      hit.position.y = 0.95;
      hit.userData = { siteId: site.id, kind: 'beacon' };
      group.add(hit);
      this.pickables.push(hit);

      beaconGroup.add(group);
      this.beacons.set(site.id, {
        group, column, ring, lantern, halo, hit, dot, rim, site, color, baseY,
        visible: true, selected: false, phase: Math.random() * Math.PI * 2,
      });
    });

    this.scene.add(beaconGroup);
    this.beaconGroup = beaconGroup;
  }

  setBeaconVisible(siteId, v) {
    const b = this.beacons.get(siteId);
    if (!b) return;
    b.visible = v;
    b.group.visible = v;
    b.hit.userData.disabled = !v;
  }

  setSelected(siteId) {
    this.beacons.forEach((b, id) => { b.selected = id === siteId; });
    if (siteId) this.ripple(siteId);
  }

  /** 选中涟漪：一圈扩散的水墨波 */
  ripple(siteId) {
    const b = this.beacons.get(siteId);
    if (!b) return;
    const flat = this.flat;
    const mesh = new THREE.Mesh(
      // 2D 下起点与终点都要小一圈：俯视没有透视缩短，同样的世界半径在屏幕上
      // 比三维斜视时大得多，照搬 0.2→0.3 会扩成一圈盖住半个省的水波纹。
      flat ? new THREE.RingGeometry(0.09, 0.13, 48) : new THREE.RingGeometry(0.2, 0.3, 64),
      new THREE.MeshBasicMaterial({ color: b.color, transparent: true, opacity: 0.9, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(b.group.position.x, b.baseY + 0.03, b.group.position.z);
    this.scene.add(mesh);
    // 带上该站点的补偿基准：涟漪也要保持恒定屏幕尺寸，不能随缩放胀开。
    this.ripples.push({ mesh, t: 0, refDepth: b.refDepth, grow: flat ? 3.6 : 6 });
  }

  /* ---------------- 行迹飞线 ---------------- */
  clearRoute() {
    if (this.routeGroup) {
      this.scene.remove(this.routeGroup);
      this.routeGroup.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
      });
    }
    this.routeGroup = null;
    this.routeDots = [];
    this.routeCurve = null;
    this.routeTube = null;
    this.routeBadges = [];
    this.routeMode = this.mode;
  }

  buildRoute(route) {
    this.clearRoute();
    // 注意保留原始站点 id：route.stops[].site 是**字符串 id**，下面要把它换成 beacon 对象，
    // 若直接覆盖，调用方就再也拿不到 id 了（曾因此让行迹聚焦拿到一串 undefined，
    // 结果一根光柱都不显示）。
    const stops = route.stops
      .map((s) => ({ ...s, siteId: s.site, site: this.beacons.get(s.site) }))
      .filter((s) => s.site);
    if (stops.length < 2) return null;

    /* 记下建这条行迹时用的是哪个模式。之后用户切视图，main 会整条重建，
       但万一有别的路径改了 this.mode 而没重建，至少绘制参数还是自洽的。 */
    const mode = this.mode;
    this.routeMode = mode;
    const flat = mode === 'flat';

    const group = new THREE.Group();
    const color = new THREE.Color(route.color);
    const pts = stops.map((s) => s.site.group.position.clone());

    // 抬升成弧线：距离越远抬得越高。2D 平面下不抬 —— 俯视投影里弧线看不出「弧」，
    // 只会让线在屏幕上偏离真实走向，而「平面线路」正是 2D 模式要的观感。
    const curvePts = [];
    if (flat) {
      const top = Math.max(...stops.map((s) => s.site.group.position.y)) + FLAT_ROUTE_CLEAR;
      pts.forEach((p) => curvePts.push(new THREE.Vector3(p.x, top, p.z)));
    } else {
      for (let i = 0; i < pts.length; i++) {
        curvePts.push(pts[i].clone());
        if (i < pts.length - 1) {
          const a = pts[i], b = pts[i + 1];
          const d = a.distanceTo(b);
          const mid = a.clone().lerp(b, 0.5);
          mid.y += Math.min(3.6, 0.55 + d * 0.28);
          curvePts.push(mid);
        }
      }
    }
    const curve = new THREE.CatmullRomCurve3(curvePts, false, 'catmullrom', 0.35);
    this.routeCurve = curve;

    const tubeR = this.routeTubeBase * (flat ? 0.8 : 1) * this.markerComp;
    const tube = new THREE.Mesh(
      new THREE.TubeGeometry(curve, 220, tubeR, 8, false),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: flat ? 0.72 : 0.5, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    group.add(tube);
    // 管线的「长度」是地理量（不能缩），但「粗细」是标记量（要按缩放补偿）。
    // 二者共用一个 mesh，没法用 scale 分开，所以按补偿系数重建几何。
    this.routeTube = tube;
    this._tubeComp = this.markerComp;

    // 流动光点
    const dotR = flat ? 0.045 : 0.055;
    for (let i = 0; i < 10; i++) {
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(dotR, 10, 8),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95 - i * 0.08, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      group.add(dot);
      this.routeDots.push({ mesh: dot, offset: i / 10 });
    }

    // 站点序号牌
    this.routeBadges = [];
    const lift = flat ? FLAT_BADGE_LIFT : BADGE_LIFT;
    const badgeSize = ROUTE_BADGE * (flat ? FLAT_BADGE_K : 1);
    stops.forEach((s, i) => {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.numberTexture(i + 1, route.color), transparent: true, depthWrite: false,
        // 2D 下序号就是落点标记，必须压在地形之上，否则会被相邻省份的台面吃掉
        depthTest: !flat,
      }));
      sprite.scale.setScalar(badgeSize * this.markerComp);
      sprite.position.copy(s.site.group.position).setY(s.site.group.position.y + lift * this.markerComp);
      if (flat) sprite.renderOrder = 6;
      group.add(sprite);
      // 序号牌锚在站点上，所以用它所属站点的补偿基准，尺寸与该站光柱一致。
      this.routeBadges.push({
        sprite, pos: s.site.group.position.clone(), refDepth: s.site.refDepth, lift, base: badgeSize,
      });
    });

    this.routeGroup = group;
    this.scene.add(group);
    return stops;
  }

  numberTexture(n, color) {
    const s = 128;
    const cv = document.createElement('canvas');
    cv.width = cv.height = s;
    const ctx = cv.getContext('2d');
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, 46, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(8,16,26,0.82)';
    ctx.fill();
    ctx.lineWidth = 5;
    ctx.strokeStyle = '#' + new THREE.Color(color).getHexString();
    ctx.stroke();
    ctx.fillStyle = '#fff8e6';
    ctx.font = 'bold 62px "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(n), s / 2, s / 2 + 3);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /* ---------------- 云海 ---------------- */
  buildClouds(count = 14) {
    const tex = makeCloudTexture();
    const group = new THREE.Group();
    for (let i = 0; i < count; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, transparent: true, opacity: 0.26, depthWrite: false, color: 0x9fc8e8,
      }));
      const ang = Math.random() * Math.PI * 2;
      const rad = 30 + Math.random() * 34;
      sp.position.set(Math.cos(ang) * rad, 7 + Math.random() * 12, Math.sin(ang) * rad - 4);
      const s = 20 + Math.random() * 30;
      sp.scale.set(s, s * 0.5, 1);
      sp.userData = { speed: 0.15 + Math.random() * 0.3, ang, rad };
      group.add(sp);
      this.clouds.push(sp);
    }
    this.scene.add(group);
    this.cloudGroup = group;
  }

  /* ---------------- 每帧更新 ----------------
   * camDist：相机到 controls.target 的距离，由 main.js 每帧传入。
   * 行迹管线用它换算全局补偿系数；光柱/光圈/序号牌则各自按自己的距离补偿
   * （详见 beaconScale —— 逐站点才准）。
   */
  update(dt, camera, camDist) {
    this.time += dt;
    const t = this.time;
    const camPos = camera.position;
    const fwd = this._fwd;
    camera.getWorldDirection(fwd);
    // 全局系数：只给「没有单一归属站点」的行迹管线与飞线光点用
    const gComp = this.markerScale(camDist);
    this.markerComp = gComp;

    this.beacons.forEach((b) => {
      if (!b.visible) return;
      const s = b.selected ? 1.55 : 1;
      // 整个 group 统一补偿：光柱、灯球、光晕、地面光圈、落点圆点、拾取柱体一起等比缩放。
      // 拾取柱体跟着缩是对的 —— 它随缩放保持恒定屏幕大小，且高倍下不会再和邻站互相重叠。
      const comp = this.beaconScale(b, camPos, fwd);
      b.comp = comp;
      b.group.scale.setScalar(comp);

      if (this.flat) {
        /* 2D：光柱那一套已隐藏，只需让圆点「选中时放大一点」。
           不做呼吸 —— 平面地图上点位一闪一闪反而干扰读图。 */
        const k = b.selected ? 1.7 : 1;
        b.dot.scale.setScalar(k);
        b.rim.scale.setScalar(k);
        return;
      }

      b.column.material.uniforms.uTime.value = t;
      b.column.material.uniforms.uOpacity.value = (b.selected ? 0.9 : 0.5) * (0.7 + 0.3 * Math.sin(t * 1.8 + b.phase));
      b.column.scale.setScalar(s);
      b.halo.scale.setScalar((0.5 + 0.12 * Math.sin(t * 2.4 + b.phase)) * (b.selected ? 2.0 : 1));
      b.lantern.scale.setScalar(b.selected ? 1.7 : 1);
      const rp = 1 + 0.28 * Math.sin(t * 1.6 + b.phase);
      b.ring.scale.setScalar(rp * (b.selected ? 1.6 : 1));
      b.ring.material.opacity = (b.selected ? 0.9 : 0.5) * (0.7 + 0.3 * Math.sin(t * 2 + b.phase));
      // 面向相机的标签层由 UI 处理；此处仅让光柱轻微呼吸
    });

    // 涟漪
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const r = this.ripples[i];
      r.t += dt;
      const k = r.t / 1.5;
      r.mesh.scale.setScalar((1 + k * r.grow) * this.pointScale(r.refDepth, r.mesh.position, camPos, fwd));
      r.mesh.material.opacity = Math.max(0, 0.85 * (1 - k));
      if (k >= 1) {
        this.scene.remove(r.mesh);
        r.mesh.geometry.dispose();
        r.mesh.material.dispose();
        this.ripples.splice(i, 1);
      }
    }

    // 飞线光点与站点序号牌：位置是地理量，尺寸是标记量，故只缩 scale 不动 position。
    if (this.routeCurve) {
      this.routeDots.forEach((d) => {
        const p = (t * 0.12 + d.offset) % 1;
        const v = this.routeCurve.getPointAt(p);
        d.mesh.position.copy(v);
        d.mesh.scale.setScalar(gComp);
      });
      this.routeBadges.forEach((b) => {
        // 序号牌锚在站点上，按站点自己的基准补偿，才和该站光柱同比例。
        // 抬升量与基准边长都按建这条行迹时的模式取（2D 是贴地小号，3D 是柱顶大号）。
        const comp = this.pointScale(b.refDepth, b.pos, camPos, fwd);
        b.sprite.scale.setScalar(b.base * comp);
        b.sprite.position.y = b.pos.y + b.lift * comp;
      });
      // 管线粗细靠重建几何：长度必须保持地理尺度，用 scale 会把长度也一起缩。
      // 只在补偿系数变化超过 15% 时重建，避免缩放过程中每帧都换几何。
      if (this.routeTube && Math.abs(gComp / this._tubeComp - 1) > 0.15) {
        const r = this.routeTubeBase * (this.routeMode === 'flat' ? 0.8 : 1) * gComp;
        this.routeTube.geometry.dispose();
        this.routeTube.geometry = new THREE.TubeGeometry(this.routeCurve, 220, r, 8, false);
        // 这里要写回 gComp：早先误写成上面 forEach 里那个块级 comp，一旦真的触发
        // 重建就会抛 ReferenceError —— 而它在「补偿变化 > 15%」时才走到，
        // 平时永远不触发，是个只在缩放时才现形的哑弹。
        this._tubeComp = gComp;
      }
    }

    // 云海漂移
    this.clouds.forEach((c) => {
      c.userData.ang += dt * 0.012 * c.userData.speed;
      c.position.x = Math.cos(c.userData.ang) * c.userData.rad;
      c.position.z = Math.sin(c.userData.ang) * c.userData.rad - 4;
    });
  }
}

export { ERA_COLOR };
