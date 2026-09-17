// 地球模式：用真实高程数据构建的可自由旋转 / 缩放的全球三维模型
//
// 与主地图的关系：地球是**独立的一层**，不与「中国地势图」共用任何几何。
// 进入地球模式时把地图那一整套（地形 / 海洋 / 江河 / 光柱 / 标注 / 气泡）整体隐藏，
// 退出时原样恢复 —— 两者互不干扰，也就不需要为地球再写一套取景与拾取补偿逻辑。
//
// 数据合规：全球底图**只画自然地理**（海陆分界与地形），不画任何政治边界；
// 中国版图另行由 js/data/geo.js 的标准地图数据（含台湾省、南海诸岛）叠加高亮。
// 这样既避免了境外数据源对中国领土要素的错误表达，也让「诗词集中在中国区域」
// 这件事在地球上一眼可见。
import * as THREE from 'three';
import { WORLD_ELEV, LAND_OUTER, LAND_HOLE } from './data/world.js';
import { CHINA_GEO } from './data/geo.js';

const DEG = Math.PI / 180;

/** 地球基准半径（= 海平面） */
export const R = 1;
const AMP_UP = 0.036;      // 陆地最高处相对海平面的抬升
const AMP_DOWN = 0.008;    // 海洋最深处相对海平面的下沉
const ELEV_MAX = 8848;
const DEPTH_MAX = 11000;
// 分段与贴图尺寸的取舍：两者都是「一次构建、长期使用」的开销，
// 但决定放大后清晰度的是**贴图**而不是网格 —— 320 段时网格每段 1.125°，
// 拉近到 d=1.8 时屏幕上每段约 25px，可贴图 0.176°/像素对应的模糊度是它的 4.6 倍，
// 实测画面是一片平滑的糊（看不到三角形棱角），说明瓶颈在贴图。
// 这里两者一起提到 2.25 倍：贴图 0.117°/像素、网格 0.75°/段，
// 拉近后每段约 15px、模糊度降到 3 倍。构建耗时约翻倍（150ms → 300ms 量级），
// 而构建是「首次进入地球模式时懒执行一次」，这个代价换放大后的可用性是值得的。
const LON_SEG = 480;       // 经向分段（0.75°/段）
const LAT_SEG = 240;
const TEX_W = 3072;        // 颜色贴图宽（0.117°/像素）
const TEX_H = 1536;

/* ================= 坐标映射 ================= */
/**
 * 经纬度 → 单位球面方向。+Y 为北极，经度 0° 指向 +X。
 * 整个模块（几何 / UV / 贴图 / 地标）都用这一个函数，避免各处约定不一致。
 */
export function dirFromLonLat(lon, lat, out = new THREE.Vector3()) {
  const a = lat * DEG;
  const b = lon * DEG;
  const ca = Math.cos(a);
  return out.set(ca * Math.cos(b), Math.sin(a), -ca * Math.sin(b));
}

/** dirFromLonLat 的逆运算：球面方向 → [经度, 纬度]，用于 HUD 读数 */
export function lonLatFromDir(v) {
  const n = v.clone().normalize();
  const lat = Math.asin(Math.max(-1, Math.min(1, n.y))) / DEG;
  const lon = Math.atan2(-n.z, n.x) / DEG;
  return [lon, lat];
}

/* ================= 高程 ================= */
let elevGrid = null;

function decodeElev() {
  if (elevGrid) return elevGrid;
  const W = WORLD_ELEV;
  const bin = atob(W.b64);
  const bytes = new Uint8Array(W.nx * W.ny * 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = bin.charCodeAt(i);
  elevGrid = new Int16Array(bytes.buffer);
  return elevGrid;
}

/** 双线性采样全球高程（米）。经向越界按环绕处理，纬向夹紧。 */
export function sampleElev(lon, lat) {
  const W = WORLD_ELEV;
  const g = decodeElev();
  let fx = lon - W.lon0;
  const fy = lat - W.lat0;
  fx = ((fx % W.nx) + W.nx) % W.nx;                 // 经度环绕
  const y0 = Math.max(0, Math.min(W.ny - 2, Math.floor(fy)));
  const x0 = Math.floor(fx);
  const tx = fx - x0;
  const ty = Math.max(0, Math.min(1, fy - y0));
  const x1 = (x0 + 1) % W.nx;
  const r0 = y0 * W.nx, r1 = (y0 + 1) * W.nx;
  const a = g[r0 + x0] + (g[r0 + x1] - g[r0 + x0]) * tx;
  const b = g[r1 + x0] + (g[r1 + x1] - g[r1 + x0]) * tx;
  return a + (b - a) * ty;
}

/** 高程（米）→ 相对海平面的半径偏移（世界单位）。陆地放大、海洋微沉。 */
export function heightOf(elev) {
  if (elev >= 0) {
    const t = Math.min(elev, ELEV_MAX) / ELEV_MAX;
    return 0.0008 + Math.pow(t, 0.62) * AMP_UP;
  }
  return (Math.max(elev, -DEPTH_MAX) / DEPTH_MAX) * AMP_DOWN;
}

/** 站点所在地表的球面半径（地标要贴在起伏的地面上，不能浮在标准球面上） */
export function surfaceRadius(lon, lat) {
  return R + heightOf(sampleElev(lon, lat));
}

/* ================= 色带 ================= */
// 陆地为常规地形色（低地绿 → 高原黄褐 → 雪线），海洋为深浅蓝。
// 生成 256 级查找表，逐像素上色时只做一次数组索引，避免每像素构造颜色对象。
const LAND_STOPS = [
  [0.00, 47, 107, 58], [0.10, 74, 138, 69], [0.26, 143, 160, 74],
  [0.44, 194, 163, 92], [0.62, 168, 121, 76], [0.80, 140, 106, 90],
  [1.00, 242, 244, 248],
];
const SEA_STOPS = [
  [0.00, 31, 111, 168], [0.30, 18, 73, 111], [0.65, 10, 44, 71], [1.00, 6, 25, 43],
];

function makeRamp(stops) {
  const lut = new Float32Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let a = stops[0], b = stops[stops.length - 1];
    for (let k = 1; k < stops.length; k++) {
      if (t <= stops[k][0]) { a = stops[k - 1]; b = stops[k]; break; }
    }
    const span = b[0] - a[0] || 1;
    const k = Math.min(1, Math.max(0, (t - a[0]) / span));
    lut[i * 3] = (a[1] + (b[1] - a[1]) * k) / 255;
    lut[i * 3 + 1] = (a[2] + (b[2] - a[2]) * k) / 255;
    lut[i * 3 + 2] = (a[3] + (b[3] - a[3]) * k) / 255;
  }
  return lut;
}
const LAND_LUT = makeRamp(LAND_STOPS);
const SEA_LUT = makeRamp(SEA_STOPS);

// 中国版图的暖金色调（在自然地形上叠一层，让「诗词集中在中国」一眼可见）。
// 比例刻意压得比较低：0.40 时中国整片变成土黄、地标反而糊在里面看不见了，
// 而且把地形本身的高低起伏也盖掉了。版图轮廓交给描边去表达，底色只轻轻染一层。
const CHINA_TINT = [0.91, 0.75, 0.48];
const CHINA_MIX = 0.22;

/* ================= 颜色贴图 ================= */
/**
 * 生成等经纬（equirectangular）颜色贴图。分两步，各用最合适的工具：
 *   1. 掩膜用 canvas 原生填充路径 —— 海岸线由 5001 个轮廓点精确勾勒，锐利且快；
 *   2. 上色用逐像素循环 —— 颜色要按高程连续变化，只能自己算。
 * 掩膜的 R 通道是陆地、G 通道是中国版图，一次绘制拿到两层信息。
 */
function buildColorTexture() {
  const maskCv = document.createElement('canvas');
  maskCv.width = TEX_W; maskCv.height = TEX_H;
  const mx = maskCv.getContext('2d', { willReadFrequently: true });
  mx.fillStyle = '#000';
  mx.fillRect(0, 0, TEX_W, TEX_H);

  const px = (lon) => ((lon + 180) / 360) * TEX_W;
  const py = (lat) => ((90 - lat) / 180) * TEX_H;

  const traceRings = (rings) => {
    mx.beginPath();
    for (const flat of rings) {
      const n = flat.length / 2;
      if (n < 3) continue;
      mx.moveTo(px(flat[0]), py(flat[1]));
      for (let i = 1; i < n; i++) mx.lineTo(px(flat[i * 2]), py(flat[i * 2 + 1]));
      mx.closePath();
    }
  };

  mx.fillStyle = 'rgb(255,0,0)';           // R = 陆地
  traceRings(LAND_OUTER);
  mx.fill();
  if (LAND_HOLE.length) {                  // 内环（里海等）挖回海色
    mx.fillStyle = '#000';
    traceRings(LAND_HOLE);
    mx.fill();
  }

  // G = 中国版图（含台湾省、香港、澳门特别行政区及南海诸岛界线）
  mx.fillStyle = 'rgb(255,255,0)';
  for (const f of CHINA_GEO) {
    const polys = f.p.map((poly) => poly[0]).filter((r) => r && r.length >= 3);
    if (polys.length) traceRings(polys);
    mx.fill();
  }

  const mask = mx.getImageData(0, 0, TEX_W, TEX_H).data;

  const cv = document.createElement('canvas');
  cv.width = TEX_W; cv.height = TEX_H;
  const cx = cv.getContext('2d');
  const img = cx.createImageData(TEX_W, TEX_H);
  const d = img.data;

  for (let y = 0; y < TEX_H; y++) {
    const lat = 90 - ((y + 0.5) / TEX_H) * 180;
    for (let x = 0; x < TEX_W; x++) {
      const lon = -180 + ((x + 0.5) / TEX_W) * 360;
      const k = (y * TEX_W + x) * 4;
      const e = sampleElev(lon, lat);
      const land = mask[k] > 128;
      let lut, idx;
      if (land) {
        lut = LAND_LUT;
        idx = Math.round(Math.pow(Math.min(e, ELEV_MAX) / ELEV_MAX, 0.62) * 255);
      } else {
        lut = SEA_LUT;
        idx = Math.round(Math.min(1, -e / DEPTH_MAX) * 255);
      }
      idx = idx < 0 ? 0 : idx > 255 ? 255 : idx;
      const o = idx * 3;
      let r = lut[o], g = lut[o + 1], b = lut[o + 2];
      if (mask[k + 1] > 128) {
        r += (CHINA_TINT[0] - r) * CHINA_MIX;
        g += (CHINA_TINT[1] - g) * CHINA_MIX;
        b += (CHINA_TINT[2] - b) * CHINA_MIX;
      }
      d[k] = r * 255; d[k + 1] = g * 255; d[k + 2] = b * 255; d[k + 3] = 255;
    }
  }
  cx.putImageData(img, 0, 0);

  // 中国边界描边：贴图上再勾一圈金线，缩到太空视角时版图轮廓依然清楚。
  // 线宽要克制 —— 贴图是 3072 宽（1 像素 ≈ 0.117°），默认太空视角下被放大 1.45 倍，
  // 拉近到 d=1.8 时放大到 3.1 倍；再粗就是一条压住地形的白带。
  // 近处的清晰度交给贴地的那层矢量线（_buildChinaOutline）去保证。
  cx.lineJoin = 'round';
  cx.lineCap = 'round';
  cx.strokeStyle = 'rgba(255,236,182,0.5)';
  cx.lineWidth = 1.0;
  for (const f of CHINA_GEO) {
    for (const poly of f.p) {
      for (const ring of poly) {
        const n = ring.length;
        if (n < 3) continue;
        cx.beginPath();
        cx.moveTo(px(ring[0][0]), py(ring[0][1]));
        for (let i = 1; i < n; i++) cx.lineTo(px(ring[i][0]), py(ring[i][1]));
        cx.closePath();
        cx.stroke();
      }
    }
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  /* 必须关掉 flipY。three.js 默认 flipY = true（上传时上下翻转），
     于是 uv.y = 0 取到的是画布**最后一行**。而本模块的球面 UV 是「v = 0 在北极」，
     画布第一行才是北极 —— 两者正好相反，不关就是一张上下颠倒的地球：
     实测内蒙的橄榄绿跑到了南半球，看到的是一片深蓝。 */
  tex.flipY = false;
  tex.anisotropy = 8;
  return tex;
}

/* ================= 球面几何 ================= */
/**
 * 手工构建球面网格，不用 SphereGeometry —— 因为它默认的 UV 起止方向与
 * 等经纬贴图是否对得上，要靠反推源码确认，而这里只要 uv = (u, v) 与
 * 「u 随经度递增、v 随纬度递减」严格一致就够了。
 */
function buildSphereGeometry() {
  const cols = LON_SEG + 1;
  const rows = LAT_SEG + 1;
  const count = cols * rows;
  const pos = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  const dir = new THREE.Vector3();

  let p = 0, q = 0;
  for (let j = 0; j < rows; j++) {
    const v = j / LAT_SEG;
    const lat = 90 - v * 180;
    for (let i = 0; i < cols; i++) {
      const u = i / LON_SEG;
      const lon = -180 + u * 360;
      dirFromLonLat(lon, lat, dir);
      const r = R + heightOf(sampleElev(lon, lat));
      pos[p++] = dir.x * r; pos[p++] = dir.y * r; pos[p++] = dir.z * r;
      uv[q++] = u; uv[q++] = v;
    }
  }

  const idx = [];
  for (let j = 0; j < LAT_SEG; j++) {
    for (let i = 0; i < LON_SEG; i++) {
      const a = j * cols + i;
      const b = a + 1;
      const c = a + cols;
      const dd = c + 1;
      idx.push(a, c, b, b, c, dd);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();     // 位移之后必须重算法线，否则起伏不打阴影
  return geo;
}

/* ================= 大气 ================= */
function buildAtmosphere() {
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    blending: THREE.AdditiveBlending,
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: { uColor: { value: new THREE.Color(0x59b0ff) } },
    vertexShader: `
      varying vec3 vN;
      varying vec3 vP;
      void main() {
        vN = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vP = mv.xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying vec3 vN;
      varying vec3 vP;
      uniform vec3 uColor;
      void main() {
        // 视线与法线越接近垂直（越靠近轮廓）越亮 —— 得到一圈大气辉光
        float f = pow(1.0 - abs(dot(normalize(vN), normalize(-vP))), 2.6);
        gl_FragColor = vec4(uColor * f, f * 0.9);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(R * 1.055, 64, 48), mat);
  mesh.renderOrder = 3;
  return mesh;
}

/* ================= 地标贴图 ================= */
/**
 * 地球地标的光点贴图：**白芯 + 朝代色光晕**，每个朝代一张（共 7 张，缓存复用）。
 *
 * 两个坑叠在一起，必须这样做：
 *  1. 不能复用主地图那张金色光晕 —— 地球上的中国底色是暖金色，金点落在金底上
 *     完全没有对比度，实测 79 个地标几乎看不见；
 *  2. 也不能「一张白色贴图 + 材质 color 染色」—— 因为 SpriteMaterial 的
 *     diffuse = 贴图 × color，白芯会被一起染成金色，白芯就没了。
 * 所以把颜色**烘进贴图**（白芯固定、外圈用朝代色），材质 color 保持纯白。
 */
const markerTexCache = new Map();
function markerTextureFor(hex) {
  if (markerTexCache.has(hex)) return markerTexCache.get(hex);
  const c = new THREE.Color(hex);
  const rgb = c.getStyle();                 // sRGB 的 "rgb(r,g,b)"，canvas 要的就是这个
  const s = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0.00, 'rgba(255,255,255,1)');
  g.addColorStop(0.15, 'rgba(255,255,255,0.88)');
  g.addColorStop(0.32, rgb.replace('rgb', 'rgba').replace(')', ',0.55)'));
  g.addColorStop(0.62, rgb.replace('rgb', 'rgba').replace(')', ',0.16)'));
  g.addColorStop(1.00, rgb.replace('rgb', 'rgba').replace(')', ',0)'));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  markerTexCache.set(hex, tex);
  return tex;
}

/* ================= 主体 ================= */
export class Globe {
  constructor({ renderer, sites, eraColor }) {
    this.renderer = renderer;
    this.sites = sites;
    this.eraColor = eraColor;
    this.root = new THREE.Group();
    this.root.name = 'earth-globe';
    this.root.visible = false;
    this.built = false;
    this.markers = [];          // { sprite, site, dir, refDepth }
    this.markerRef = 0;         // 基准机位距球心的距离（非 0 表示补偿已启用），进入地球模式时注入
    this.buildMs = 0;
    this._tmp = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
  }

  /** 懒构建：第一次进入地球模式时才生成贴图与几何，不拖慢启动 */
  build() {
    if (this.built) return this;
    const t0 = performance.now();

    const tex = buildColorTexture();
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      roughness: 0.86,
      metalness: 0.06,
      // 夜面不能全黑：把同一张贴图当作自发光贴图低强度叠加，
      // 背光的那半边仍能看出海陆与地形（教学场景里「看不见的那半」没有意义），
      // 又不会像调高环境光那样把整颗球洗白、也完全不影响到主地图的光照。
      emissiveMap: tex,
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: 0.34,
    });
    this.surface = new THREE.Mesh(buildSphereGeometry(), mat);
    this.root.add(this.surface);

    // 海平面水壳：半透明蓝，压住海底起伏、让海岸线成为清晰的交界。
    // depthWrite 关掉 —— 陆地处水面在更远处，深度测试会自然把它挡掉，
    // 于是陆地「穿出水面」，海面则盖住海底。
    this.water = new THREE.Mesh(
      new THREE.SphereGeometry(R * 1.0005, 96, 64),
      new THREE.MeshStandardMaterial({
        color: 0x0d3f6b, transparent: true, opacity: 0.74,
        roughness: 0.16, metalness: 0.42, depthWrite: false,
        // 与陆地同理：夜面的海也要留一点微光，否则整颗球的暗半边只剩一个黑洞
        emissive: 0x0a2440, emissiveIntensity: 0.55,
      }),
    );
    this.water.renderOrder = 1;
    this.root.add(this.water);

    this.atmosphere = buildAtmosphere();
    this.root.add(this.atmosphere);

    this._buildChinaOutline();
    this._buildMarkers();

    this.built = true;
    this.buildMs = Math.round(performance.now() - t0);
    return this;
  }

  /** 中国版图的三维描边：贴图上的金线在拉近后会糊，这里补一层贴地的矢量线 */
  _buildChinaOutline() {
    const segs = [];
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const jd = [];
    for (const f of CHINA_GEO) {
      const isJD = f.c === '100000_JD';
      for (const poly of f.p) {
        for (const ring of poly) {
          const n = ring.length;
          if (n < 2) continue;
          for (let i = 0; i < n; i++) {
            const p0 = ring[i];
            const p1 = ring[(i + 1) % n];
            // 逐点贴地：抬到该点地表之上一点点，避免被地形吞掉
            dirFromLonLat(p0[0], p0[1], a).multiplyScalar(surfaceRadius(p0[0], p0[1]) + 0.0012);
            dirFromLonLat(p1[0], p1[1], b).multiplyScalar(surfaceRadius(p1[0], p1[1]) + 0.0012);
            segs.push(a.x, a.y, a.z, b.x, b.y, b.z);
            if (isJD) jd.push(a.x, a.y, a.z, b.x, b.y, b.z);
          }
        }
      }
    }
    const mk = (arr, color, opacity) => {
      if (!arr.length) return null;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      return new THREE.LineSegments(g, new THREE.LineBasicMaterial({
        color, transparent: true, opacity, depthWrite: false,
      }));
    };
    this.chinaLines = mk(segs, 0xffd98a, 0.62);
    if (this.chinaLines) this.root.add(this.chinaLines);
    // 南海诸岛单独叠一层更亮更实的线：这是最容易被缩略掉、也最不能省的领土要素
    this.jdLines = mk(jd, 0xfff0c0, 0.95);
    if (this.jdLines) this.root.add(this.jdLines);
  }

  /** 79 处诗境按经纬度贴到地面上 */
  _buildMarkers() {
    const dir = new THREE.Vector3();
    for (const s of this.sites) {
      const r = surfaceRadius(s.lon, s.lat) + 0.0035;
      dirFromLonLat(s.lon, s.lat, dir);
      const era = this.eraColor[s.era] || 0xffd48a;
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: markerTextureFor(era),
        // color 保持纯白：颜色已经烘进贴图，再乘一次会把白芯也染掉（见 markerTextureFor）
        color: 0xffffff,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }));
      sprite.position.copy(dir).multiplyScalar(r);
      sprite.userData.siteId = s.id;
      // 太空视角下 79 处诗境全挤在中国那一小片里，单个地标做大会糊成一团光斑；
      // 做小反而能看出「一大簇密集的点集中在这里」——正是要表达的意思。
      sprite.userData.baseScale = 0.036;
      sprite.scale.setScalar(0.036);
      this.root.add(sprite);
      this.markers.push({ sprite, site: s, dir: dir.clone() });
    }
  }

  /**
   * 定一次补偿基准：逐个地标记下它在**基准机位**下的深度。
   *
   * 基准机位由调用方显式给出（进入地球模式时相机将要落到的那处默认太空视角）。
   * 不能拿「相机当前的位置」充数 —— 进入地球模式的那一刻相机还在版图视角上
   * （距球心 17.8，而默认太空视角是 5.3），此时取基准会让所有地标的基准深度偏大
   * 近 4 倍，补偿系数常年停在 0.25 附近，79 个地标被压成 3px 的小点，
   * 而且「拉近 3.2 倍」时系数只从 0.26 涨到 0.41，看起来像补偿本身失效。
   *
   * 为什么必须逐地标、而且必须是深度：
   *   屏幕尺寸 ∝ 世界尺寸 / 深度。这里的「深度」是**该地标自己**到相机在视线方向上的
   *   分量，不是「相机到球心」的距离 —— 两者差着一个球半径（约 1.0），
   *   而这个差值在拉近时占比越来越大：相机距球心 5.34 时地标深度 4.33，
   *   拉近到 1.67 时深度只剩 0.66。用球心距离做补偿，比值 dist/(dist−R)
   *   会从 1.23 涨到 2.53 —— 实测地标屏幕尺寸照样涨 2 倍，等于没补偿。
   *   这与主地图光柱用的是同一条原则（见 effects.js captureMarkerRefs）。
   */
  captureRefAt(pos, target) {
    const fwd = this._fwd.subVectors(target, pos).normalize();
    this.markerRef = pos.length();
    for (const m of this.markers) {
      m.refDepth = this._tmp.subVectors(m.sprite.position, pos).dot(fwd);
    }
  }

  /** 某处诗境的球面单位方向（选中后要把地球转到它正面朝前） */
  dirOf(siteId) {
    const m = this.markers.find((x) => x.site.id === siteId);
    return m ? m.dir.clone() : null;
  }

  setSelected(siteId) {
    this.selectedId = siteId;
  }

  /** 每帧：把每个地标的屏幕尺寸锁在它自己的基准上 */
  update(camera) {
    if (!this.built || !this.root.visible) return;
    const fwd = this._fwd;
    camera.getWorldDirection(fwd);
    const camPos = camera.position;
    const v = this._tmp;
    for (const m of this.markers) {
      const depth = v.subVectors(m.sprite.position, camPos).dot(fwd);
      /* 没有基准时退回原始尺寸（comp = 1），**不能直接 return 跳过写 scale** ——
         跳过会把 scale 冻在上一帧的值上，「基准缺失」于是表现为「尺寸纹丝不动」，
         看起来和「补偿正常工作」一模一样。实测负向验证就是这么被骗过去的：
         清掉基准后量到的还是 13.9px，与有补偿时完全相同。 */
      const comp = (depth > 0.01 && m.refDepth > 0.01)
        ? Math.min(2.6, Math.max(0.06, depth / m.refDepth))
        : 1;
      const k = m.site.id === this.selectedId ? 1.9 : 1;
      m.sprite.scale.setScalar(m.sprite.userData.baseScale * comp * k);
    }
  }

  /**
   * 供射线拾取的对象表：**只给近半球的地标**。
   *
   * three.js 的射线检测不做遮挡判断 —— 只把精灵丢进去的话，地球背面那些
   * 被球体挡住的地标照样会被打中，表现为「点空白处却选中了一处看不见的诗境」。
   * 球面可见性判据：表面点 P 对相机 C 可见 ⇔ P·C > |P|²。
   */
  pickables(camera) {
    const c = camera.position;
    return this.markers
      .filter((m) => {
        const p = m.sprite.position;
        return p.dot(c) > p.lengthSq();
      })
      .map((m) => m.sprite);
  }

  show(on) {
    this.root.visible = on;
  }
}
