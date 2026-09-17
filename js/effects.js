// 视觉特效：诗境地标光柱、行迹飞线、云海、涟漪
import * as THREE from 'three';
import { lonLatToWorld, provinceAt, makeGlowTexture, makeCloudTexture } from './map3d.js';

const ERA_COLOR = {
  xy: 0xb9a6ff, hw: 0x7ec8ff, jn: 0x6fe8cf,
  tang: 0xffc65e, song: 0xff8f76, yh: 0xd3a6ff,
  read: 0x8fb6d6,
};

// 行迹站点序号牌的基准边长，以及它在站点正上方的基准抬升高度（均为世界单位、补偿系数为 1 时的值）
const ROUTE_BADGE = 0.62;
const BADGE_LIFT = 2.05;

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
    this.flat = false;   // 2D 平面模式：光柱换成平面圆点
    // 缩放补偿：见 setMarkerRef / markerScale
    this.markerRef = 0;      // 参考相机距离（默认取景距离），由 main.js 注入
    this.markerComp = 1;     // 当前补偿系数，供外部断言/调试读取
    this.routeTube = null;   // 行迹管线的 mesh，半径需按缩放重建
    this.routeTubeBase = 0.026;
    this.routeBadges = [];   // 行迹站点序号牌（Sprite），需按缩放改 scale
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
   * 2D 平面模式开关。
   * 从正上方俯视时，一根竖直光柱是看不到柱身的（只剩顶上的灯球），
   * 所以 2D 下把它换成放大后的地面光圈，作为平面落点标记 —— 与地图的平面观感一致。
   */
  setFlatMode(on) {
    this.flat = on;
    this.beacons.forEach((b) => {
      b.column.visible = !on;
      b.lantern.visible = !on;
      b.halo.visible = !on;
    });
  }

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
        group, column, ring, lantern, halo, hit, site, color, baseY,
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
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.2, 0.3, 64),
      new THREE.MeshBasicMaterial({ color: b.color, transparent: true, opacity: 0.9, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(b.group.position.x, b.baseY + 0.03, b.group.position.z);
    this.scene.add(mesh);
    // 带上该站点的补偿基准：涟漪也要保持恒定屏幕尺寸，不能随缩放胀开。
    this.ripples.push({ mesh, t: 0, refDepth: b.refDepth });
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

    const group = new THREE.Group();
    const color = new THREE.Color(route.color);
    const pts = stops.map((s) => s.site.group.position.clone());

    // 抬升成弧线：距离越远抬得越高
    const curvePts = [];
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
    const curve = new THREE.CatmullRomCurve3(curvePts, false, 'catmullrom', 0.35);
    this.routeCurve = curve;

    const tube = new THREE.Mesh(
      new THREE.TubeGeometry(curve, 220, this.routeTubeBase * this.markerComp, 8, false),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    group.add(tube);
    // 管线的「长度」是地理量（不能缩），但「粗细」是标记量（要按缩放补偿）。
    // 二者共用一个 mesh，没法用 scale 分开，所以按补偿系数重建几何。
    this.routeTube = tube;
    this._tubeComp = this.markerComp;

    // 流动光点
    for (let i = 0; i < 10; i++) {
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(0.055, 10, 8),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95 - i * 0.08, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      group.add(dot);
      this.routeDots.push({ mesh: dot, offset: i / 10 });
    }

    // 站点序号牌
    this.routeBadges = [];
    stops.forEach((s, i) => {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.numberTexture(i + 1, route.color), transparent: true, depthWrite: false,
      }));
      sprite.scale.setScalar(ROUTE_BADGE * this.markerComp);
      sprite.position.copy(s.site.group.position).setY(s.site.group.position.y + BADGE_LIFT * this.markerComp);
      group.add(sprite);
      // 序号牌锚在站点上，所以用它所属站点的补偿基准，尺寸与该站光柱一致。
      this.routeBadges.push({ sprite, pos: s.site.group.position.clone(), refDepth: s.site.refDepth });
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
      // 2D 下光柱已隐藏，把地面光圈放大成落点圆点，保证在平面地图上依然醒目。
      // 倍数不宜太大：中原一带站点密集，放太大光圈会连成一片反而看不清点位。
      const flatK = this.flat ? 2.1 : 1;
      // 整个 group 统一补偿：光柱、灯球、光晕、地面光圈、拾取柱体一起等比缩放。
      // 拾取柱体跟着缩是对的 —— 它随缩放保持恒定屏幕大小，且高倍下不会再和邻站互相重叠。
      const comp = this.beaconScale(b, camPos, fwd);
      b.comp = comp;
      b.group.scale.setScalar(comp);
      b.column.material.uniforms.uTime.value = t;
      b.column.material.uniforms.uOpacity.value = (b.selected ? 0.9 : 0.5) * (0.7 + 0.3 * Math.sin(t * 1.8 + b.phase));
      b.column.scale.setScalar(s);
      b.halo.scale.setScalar((0.5 + 0.12 * Math.sin(t * 2.4 + b.phase)) * (b.selected ? 2.0 : 1));
      b.lantern.scale.setScalar(b.selected ? 1.7 : 1);
      const rp = 1 + 0.28 * Math.sin(t * 1.6 + b.phase);
      b.ring.scale.setScalar(rp * (b.selected ? 1.6 : 1) * flatK);
      const base = b.selected ? 0.9 : (this.flat ? 0.85 : 0.5);
      b.ring.material.opacity = base * (0.7 + 0.3 * Math.sin(t * 2 + b.phase));
      // 面向相机的标签层由 UI 处理；此处仅让光柱轻微呼吸
    });

    // 涟漪
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const r = this.ripples[i];
      r.t += dt;
      const k = r.t / 1.5;
      r.mesh.scale.setScalar((1 + k * 6) * this.pointScale(r.refDepth, r.mesh.position, camPos, fwd));
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
        const comp = this.pointScale(b.refDepth, b.pos, camPos, fwd);
        b.sprite.scale.setScalar(ROUTE_BADGE * comp);
        b.sprite.position.y = b.pos.y + BADGE_LIFT * comp;
      });
      // 管线粗细靠重建几何：长度必须保持地理尺度，用 scale 会把长度也一起缩。
      // 只在补偿系数变化超过 15% 时重建，避免缩放过程中每帧都换几何。
      if (this.routeTube && Math.abs(gComp / this._tubeComp - 1) > 0.15) {
        this.routeTube.geometry.dispose();
        this.routeTube.geometry = new THREE.TubeGeometry(this.routeCurve, 220, this.routeTubeBase * gComp, 8, false);
        this._tubeComp = comp;
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
