// 3D 地图构建：中国标准 Albers 等积割圆锥投影 + 按海拔挤出 + 江河示意
import * as THREE from 'three';
import { CHINA_GEO } from './data/geo.js';

const DEG = Math.PI / 180;

/* ---------- 中国标准地图常用投影参数（中央经线 105°E，双标准纬线 25°N / 47°N） ---------- */
const LON0 = 105, LAT1 = 25, LAT2 = 47, LAT0 = 35;
const N = (Math.sin(LAT1 * DEG) + Math.sin(LAT2 * DEG)) / 2;
const C = Math.cos(LAT1 * DEG) ** 2 + 2 * N * Math.sin(LAT1 * DEG);
const RHO0 = Math.sqrt(C - 2 * N * Math.sin(LAT0 * DEG)) / N;

const SCALE = 9.2;          // 每投影单位对应的世界单位
const ORIGIN = { x: 105, y: 35 }; // 视觉中心

function rawProject(lon, lat) {
  const theta = N * (lon - LON0) * DEG;
  const rho = Math.sqrt(Math.max(0, C - 2 * N * Math.sin(lat * DEG))) / N;
  return [rho * Math.sin(theta), RHO0 - rho * Math.cos(theta)];
}

const c0 = rawProject(ORIGIN.x, ORIGIN.y);

/** 经纬度 → 世界坐标（XZ 平面，y 为高度） */
export function lonLatToWorld(lon, lat, y = 0) {
  const [px, py] = rawProject(lon, lat);
  return new THREE.Vector3((px - c0[0]) * SCALE, y, -(py - c0[1]) * SCALE);
}

/** 世界坐标（XZ）→ 经纬度，用于 HUD 显示 */
export function unprojectToLonLat(x, z) {
  const px = x / SCALE + c0[0];
  const py = -z / SCALE + c0[1];
  const dx = px;
  const dy = RHO0 - py;
  const rho = Math.hypot(dx, dy);
  const theta = Math.atan2(dx, dy);
  const sinPhi = (C - rho * rho * N * N) / (2 * N);
  const phi = Math.asin(Math.max(-1, Math.min(1, sinPhi))) / DEG;
  const lam = LON0 + theta / (N * DEG);
  return [lam, phi];
}

/* ---------- 各省平均海拔（米，概略值，用于生成地势起伏） ---------- */
const ELEV = {
  110000: 44, 120000: 5, 130000: 500, 140000: 1000, 150000: 1000, 210000: 300,
  220000: 400, 230000: 400, 310000: 4, 320000: 50, 330000: 300, 340000: 200,
  350000: 400, 360000: 200, 370000: 200, 410000: 300, 420000: 300, 430000: 300,
  440000: 200, 450000: 400, 460000: 100, 500000: 400, 510000: 2500, 520000: 1100,
  530000: 1900, 540000: 4500, 610000: 1100, 620000: 1500, 630000: 3500, 640000: 1200,
  650000: 1000, 710000: 600, 810000: 100, 820000: 20,
};

const BASE_H = 0.14;
const MAX_H = 0.82;
export function heightOf(adcode) {
  const e = ELEV[adcode] ?? 400;
  return BASE_H + MAX_H * Math.pow(e / 4500, 0.78);
}

/* ---------- 地势配色（青绿山水 → 高原土黄 → 雪线） ---------- */
const STOPS = [
  { t: 0.00, c: new THREE.Color('#17685a') },
  { t: 0.16, c: new THREE.Color('#2a8f74') },
  { t: 0.36, c: new THREE.Color('#55976f') },
  { t: 0.56, c: new THREE.Color('#95924f') },
  { t: 0.76, c: new THREE.Color('#bda05f') },
  { t: 1.00, c: new THREE.Color('#c3cdd9') },
];
function terrainColor(t) {
  t = Math.min(1, Math.max(0, t));
  for (let i = 1; i < STOPS.length; i++) {
    if (t <= STOPS[i].t) {
      const a = STOPS[i - 1], b = STOPS[i];
      const k = (t - a.t) / (b.t - a.t || 1);
      return a.c.clone().lerp(b.c, k);
    }
  }
  return STOPS[STOPS.length - 1].c.clone();
}

/* ---------- 几何工具 ---------- */
// 形状平面：x = 东，y = 北（正方向）。
// 随后 geometry.rotateX(-90°) 会把 (x, y, z) 映射为 (x, z, -y)，
// 于是世界坐标中 z = -y（北为 -z），与 lonLatToWorld 完全一致。
function ringToShapePoints(ring) {
  return ring.map(([lon, lat]) => {
    const [px, py] = rawProject(lon, lat);
    return new THREE.Vector2((px - c0[0]) * SCALE, (py - c0[1]) * SCALE);
  });
}
function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/* ---------- 点是否在多边形内（用于给站点定高度） ---------- */
function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function provinceAt(lon, lat) {
  for (const f of CHINA_GEO) {
    if (f.c === '100000_JD') continue;
    for (const poly of f.p) {
      if (poly[0] && pointInRing(lon, lat, poly[0])) {
        return { code: f.c, name: f.n, height: heightOf(f.c) };
      }
    }
  }
  return { code: null, name: '海域', height: 0.05 };
}

/* ---------- 构建地图 ---------- */
export function buildMap() {
  const root = new THREE.Group();
  root.name = 'china-map';

  const provinces = [];
  const borderGroup = new THREE.Group();
  const jdGroup = new THREE.Group();
  const hoverTargets = [];

  const borderMat = new THREE.LineBasicMaterial({
    color: 0xe8c07a, transparent: true, opacity: 0.4,
  });

  for (const f of CHINA_GEO) {
    const isJD = f.c === '100000_JD';
    const h = isJD ? 0.05 : heightOf(f.c);
    const t = isJD ? 0 : Math.min(1, Math.pow((h - BASE_H) / MAX_H, 1 / 0.78));
    const top = isJD
      ? new THREE.MeshStandardMaterial({
        color: 0xe8c07a, emissive: 0x5c3f0e, emissiveIntensity: 0.5,
        metalness: 0.5, roughness: 0.4,
      })
      : new THREE.MeshStandardMaterial({
        color: terrainColor(t), emissive: terrainColor(t).multiplyScalar(0.14),
        emissiveIntensity: 0.32, metalness: 0.3, roughness: 0.66,
      });
    const side = new THREE.MeshStandardMaterial({
      color: isJD ? 0xa8863f : terrainColor(t).multiplyScalar(0.5),
      emissive: 0x08141c, emissiveIntensity: 0.22, metalness: 0.3, roughness: 0.92,
    });

    const shapes = [];
    const outlines = [];
    for (const poly of f.p) {
      if (!poly.length) continue;
      let outer = ringToShapePoints(poly[0]);
      if (outer.length < 3) continue;
      if (signedArea(outer) < 0) outer.reverse();
      const shape = new THREE.Shape(outer);
      outlines.push(outer);
      for (let i = 1; i < poly.length; i++) {
        let hole = ringToShapePoints(poly[i]);
        if (hole.length < 3) continue;
        if (signedArea(hole) > 0) hole.reverse();
        shape.holes.push(new THREE.Path(hole));
        outlines.push(hole);
      }
      shapes.push(shape);
    }
    if (!shapes.length) continue;

    const geo = new THREE.ExtrudeGeometry(shapes, {
      depth: h, bevelEnabled: false, curveSegments: 1,
    });
    geo.rotateX(-Math.PI / 2);
    geo.computeVertexNormals();

    const mesh = new THREE.Mesh(geo, [top, side]);
    mesh.userData = {
      adcode: f.c, name: f.n, isJD, baseHeight: h,
      baseColor: top.color.clone(), hovered: false, lift: 0,
    };
    if (isJD) jdGroup.add(mesh);
    else { root.add(mesh); provinces.push(mesh); hoverTargets.push(mesh); }

    // 边界线：抬到顶面上方（注意形状平面的 y 对应世界坐标的 -z）
    const segs = [];
    for (const ring of outlines) {
      const n = ring.length;
      for (let i = 0; i < n; i++) {
        const a = ring[i], b = ring[(i + 1) % n];
        segs.push(a.x, h + 0.012, -a.y, b.x, h + 0.012, -b.y);
      }
    }
    if (segs.length) {
      const lg = new THREE.BufferGeometry();
      lg.setAttribute('position', new THREE.Float32BufferAttribute(segs, 3));
      borderGroup.add(new THREE.LineSegments(lg, isJD
        ? new THREE.LineBasicMaterial({ color: 0xffdca8, transparent: true, opacity: 0.9 })
        : borderMat));
    }
  }

  root.add(borderGroup);
  root.add(jdGroup);

  return { root, provinces, hoverTargets, jdGroup, borderGroup };
}

/* ---------- 海洋 / 星河 / 光晕 ---------- */
export function buildOcean() {
  const geo = new THREE.PlaneGeometry(420, 420, 1, 1);
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uTime: { value: 0 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `
      varying vec2 vUv; uniform float uTime;
      void main(){
        vec2 p = vUv*2.0-1.0; float r = length(p);
        vec3 deep = vec3(0.008,0.028,0.062);
        vec3 mid  = vec3(0.026,0.086,0.140);
        vec3 col = mix(mid, deep, smoothstep(0.05,0.85,r));
        float w = sin(p.x*46.0+uTime*0.55)*sin(p.y*38.0-uTime*0.42);
        float w2 = sin((p.x+p.y)*24.0 - uTime*0.3);
        col += vec3(0.02,0.075,0.105)*(w*0.5+w2*0.3);
        float a = (1.0 - smoothstep(0.42,1.0,r))*0.92;
        gl_FragColor = vec4(col, a);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = -0.06;
  mesh.renderOrder = -2;

  const grid = new THREE.GridHelper(420, 84, 0x1b5878, 0x0d3350);
  grid.position.y = -0.05;
  grid.material.transparent = true;
  grid.material.opacity = 0.28;
  grid.material.depthWrite = false;
  grid.renderOrder = -1;

  const wrap = new THREE.Group();
  wrap.add(mesh, grid);
  return { root: wrap, mesh, mat, grid };
}

export function buildStars(count = 2600) {
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const r = 90 + Math.random() * 180;
    const th = Math.random() * Math.PI * 2;
    const ph = Math.acos(2 * Math.random() - 1);
    pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
    pos[i * 3 + 1] = r * Math.cos(ph) * 0.65 + 20;
    pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
    c.setHSL(0.52 + Math.random() * 0.12, 0.35 + Math.random() * 0.4, 0.6 + Math.random() * 0.35);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const mat = new THREE.PointsMaterial({
    size: 1.5, sizeAttenuation: true, vertexColors: true,
    transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  return new THREE.Points(geo, mat);
}

/** 程序化生成柔光贴图 */
export function makeGlowTexture(inner = 'rgba(255,214,140,1)', outer = 'rgba(255,170,60,0)') {
  const s = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, inner);
  g.addColorStop(0.35, 'rgba(255,190,90,0.45)');
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 程序化生成云海贴图 */
export function makeCloudTexture() {
  const s = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  for (let i = 0; i < 26; i++) {
    const x = Math.random() * s, y = Math.random() * s;
    const r = 18 + Math.random() * 52;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const a = 0.05 + Math.random() * 0.08;
    g.addColorStop(0, `rgba(180,220,240,${a})`);
    g.addColorStop(1, 'rgba(180,220,240,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* ---------- 江河示意（简化走向，仅用于教学演示） ---------- */
export const RIVERS = [
  {
    name: '长江',
    color: 0x63d6ff,
    points: [
      [91.0, 33.5], [94.0, 33.8], [96.5, 33.2], [97.5, 31.5], [99.0, 28.5], [100.0, 26.9],
      [101.3, 26.7], [102.5, 27.4], [104.4, 28.8], [105.5, 28.8], [106.6, 29.6], [107.5, 30.2],
      [108.4, 30.7], [109.6, 31.05], [110.4, 30.9], [111.3, 30.7], [112.4, 30.4], [113.5, 30.3],
      [114.3, 30.6], [115.0, 30.2], [116.0, 29.7], [117.0, 30.4], [117.9, 30.9], [118.8, 32.05],
      [119.6, 32.2], [120.3, 31.9], [121.0, 31.7], [121.8, 31.4],
    ],
  },
  {
    name: '黄河',
    color: 0xffc46b,
    points: [
      [96.0, 35.0], [98.5, 35.3], [100.5, 35.0], [101.8, 36.0], [103.0, 36.1], [104.5, 37.2],
      [105.8, 38.0], [106.8, 38.8], [107.5, 39.6], [108.6, 40.5], [110.0, 40.9], [111.6, 40.2],
      [110.6, 38.6], [110.4, 36.0], [110.4, 34.85], [112.5, 34.8], [113.7, 34.9], [115.0, 35.4],
      [116.5, 36.0], [118.0, 37.0], [118.9, 37.8],
    ],
  },
  {
    name: '京杭大运河',
    color: 0x9fe6c0,
    points: [
      [116.4, 39.9], [117.2, 39.1], [116.6, 37.4], [116.0, 36.0], [117.0, 35.0], [117.3, 34.3],
      [118.3, 33.3], [119.4, 32.4], [119.8, 31.9], [120.4, 31.3], [120.2, 30.3],
    ],
  },
];

export function buildRivers() {
  const group = new THREE.Group();
  const matFor = (color) => new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  RIVERS.forEach((r) => {
    const pts = r.points.map(([lon, lat]) => {
      const p = provinceAt(lon, lat);
      return lonLatToWorld(lon, lat, p.height + 0.045);
    });
    const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.4);
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(64, pts.length * 6), 0.055, 6, false), matFor(r.color));
    tube.userData = { river: r.name };
    group.add(tube);
  });
  return group;
}
