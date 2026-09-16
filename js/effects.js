// 视觉特效：诗境地标光柱、行迹飞线、云海、涟漪
import * as THREE from 'three';
import { lonLatToWorld, provinceAt, makeGlowTexture, makeCloudTexture } from './map3d.js';

const ERA_COLOR = {
  xy: 0xb9a6ff, hw: 0x7ec8ff, jn: 0x6fe8cf,
  tang: 0xffc65e, song: 0xff8f76, yh: 0xd3a6ff,
  read: 0x8fb6d6,
};

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
    this.ripples.push({ mesh, t: 0 });
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
      new THREE.TubeGeometry(curve, 220, 0.026, 8, false),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    group.add(tube);

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
    stops.forEach((s, i) => {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.numberTexture(i + 1, route.color), transparent: true, depthWrite: false,
      }));
      sprite.scale.setScalar(0.62);
      sprite.position.copy(s.site.group.position).setY(s.site.group.position.y + 2.05);
      group.add(sprite);
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

  /* ---------------- 每帧更新 ---------------- */
  update(dt, camera, zoomFactor = 1) {
    this.time += dt;
    const t = this.time;

    this.beacons.forEach((b) => {
      if (!b.visible) return;
      const s = b.selected ? 1.55 : 1;
      // 2D 下光柱已隐藏，把地面光圈放大成落点圆点，保证在平面地图上依然醒目。
      // 倍数不宜太大：中原一带站点密集，放太大光圈会连成一片反而看不清点位。
      const flatK = this.flat ? 2.1 : 1;
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
      r.mesh.scale.setScalar(1 + k * 6);
      r.mesh.material.opacity = Math.max(0, 0.85 * (1 - k));
      if (k >= 1) {
        this.scene.remove(r.mesh);
        r.mesh.geometry.dispose();
        r.mesh.material.dispose();
        this.ripples.splice(i, 1);
      }
    }

    // 飞线光点
    if (this.routeCurve) {
      this.routeDots.forEach((d) => {
        const p = (t * 0.12 + d.offset) % 1;
        const v = this.routeCurve.getPointAt(p);
        d.mesh.position.copy(v);
      });
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
