// 主程序：三维场景装配、交互、相机运镜、巡游与课堂联动
import * as THREE from 'three';
import { OrbitControls } from '../vendor/jsm/controls/OrbitControls.js';
import { EffectComposer } from '../vendor/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from '../vendor/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from '../vendor/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from '../vendor/jsm/postprocessing/OutputPass.js';

import { SITES, SITE_MAP, ROUTES, ERA_MAP } from './data/poetry.js';
import {
  buildMap, buildOcean, buildStars, buildRivers, lonLatToWorld, provinceAt, unprojectToLonLat,
} from './map3d.js';
import { Effects, ERA_COLOR } from './effects.js';
import { Globe, R as GLOBE_R, dirFromLonLat, lonLatFromDir } from './globe.js';
import { UI } from './ui.js';

/* ================= 启动进度上报 ================= */
/**
 * 加载页的进度条由这里驱动。
 * 之所以要真进度而不是一条无限滑动的假动画：卡住时能直接看出停在哪一步。
 */
const stage = (text, pct) => { if (window.__bootStage) window.__bootStage(text, pct); };
stage('加载诗词数据', 22);

/* ================= 基础状态 ================= */
const state = {
  eras: new Set(),
  themes: new Set(),
  regions: new Set(),
  voice: false,
  layers: { rivers: true, labels: true, clouds: true },
  quizMode: false,
  flat: false,          // 2D 平面模式（由 setViewMode 维护，与 earth 互斥）
  earth: false,         // 地球模式（太空视角）
  activeRoute: null,    // 当前选中的行迹（切换视图时要按新视图重建）
  routeFocus: null,     // Set<siteId>：只看某条行迹上的站点，null 表示不限制
};

let visibleSites = [];
let selectedId = null;
let hoveredId = null;
let hoveredProvince = null;
let tourTimer = null;
const tour = { playing: false, scope: 'filtered', index: 0, list: [] };

/* ================= 渲染器 / 场景 ================= */
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.06;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x04080e);
scene.fog = new THREE.FogExp2(0x05090f, 0.0055);

// 使用窄视角（长焦）模拟近似轴测的效果，避免大幅地图产生强烈透视畸变
const camera = new THREE.PerspectiveCamera(30, window.innerWidth / window.innerHeight, 0.5, 900);
camera.position.set(0, 46, 58);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.065;
controls.rotateSpeed = 0.62;
controls.zoomSpeed = 0.85;
controls.panSpeed = 0.7;
controls.minDistance = 5;
controls.maxDistance = 260;
controls.maxPolarAngle = 1.5;
controls.minPolarAngle = 0.05;
controls.autoRotateSpeed = 0.42;

/* ================= 灯光 ================= */
scene.add(new THREE.AmbientLight(0x53789a, 0.92));
const key = new THREE.DirectionalLight(0xfff0d8, 1.72);
key.position.set(-38, 62, 34);
scene.add(key);
const rim = new THREE.DirectionalLight(0x5fd0ff, 0.75);
rim.position.set(46, 28, -42);
scene.add(rim);
const warm = new THREE.PointLight(0xffb454, 45, 130, 2);
warm.position.set(6, 18, 6);
scene.add(warm);

/* ================= 地图与装饰 ================= */
const map = buildMap();
scene.add(map.root);
stage('生成地势起伏', 46);

const ocean = buildOcean();
scene.add(ocean.root);

const stars = buildStars(2800);
scene.add(stars);

const rivers = buildRivers();
scene.add(rivers);

const effects = new Effects(scene);
effects.createBeacons(SITES);
effects.buildClouds(16);
stage('点亮诗境地标', 68);

/* ================= 地球 ================= */
/**
 * 地球是独立于地图的一层：进入地球模式时把地图那一整套整体隐藏，退出时原样恢复，
 * 两者不共用几何、不共用取景，也就不需要为地球再写一套缩放补偿与拾取补偿。
 *
 * 懒构建 —— 贴图与球面几何加起来要几百毫秒，放在启动链上会拖慢所有人，
 * 而绝大多数使用者并不会进地球模式。第一次点「地球」时再生成。
 */
const globe = new Globe({
  renderer,
  sites: SITES,
  eraColor: ERA_COLOR,
});
scene.add(globe.root);

/* ================= 行政区 → 诗境索引 ================= */
/**
 * 点击省份时要列出「发生在这一地区的诗词」，所以预先按省把诗境分好桶。
 * 用与光柱落点完全相同的判定（provinceAt），保证「点哪根光柱」和
 * 「点那个省」得到的结果一致。
 */
const PROVINCE_SITES = new Map();
SITES.forEach((s) => {
  const p = provinceAt(s.lon, s.lat);
  const key = p.code || 'sea';
  if (!PROVINCE_SITES.has(key)) PROVINCE_SITES.set(key, { prov: p, sites: [] });
  PROVINCE_SITES.get(key).sites.push(s);
});

/* ================= 后期处理 ================= */
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight), 0.3, 0.6, 0.88,
);
composer.addPass(bloom);
composer.addPass(new OutputPass());

/* ================= 视野基准 ================= */
const boxMain = new THREE.Box3();
map.provinces.forEach((m) => boxMain.expandByObject(m));
const centerMain = boxMain.getCenter(new THREE.Vector3());

const boxAll = boxMain.clone().expandByObject(map.jdGroup);
const centerAll = boxAll.getCenter(new THREE.Vector3());

/**
 * 取景采样点。两个要点：
 * 1) 地形用「真实顶点等距抽样」，不用包围盒角点——像内蒙古这种狭长弧形版图，
 *    其包围盒角点远在空白处，会把取景盒子撑得过大、版图被缩得很小。
 * 2) 把 41 根光柱的柱顶也纳入采样，保证光柱与灯球完整入镜。这比统一抬高
 *    整片地形更精确：光柱只在少数点位，统一抬高会白白浪费大量竖直空间。
 * 因需要光柱数据，改为惰性构建（首次取景时 effects 已就绪）。
 */
const FRAME_PAD_Y = 0.35;   // 柱顶之上再留一点余量，容纳 DOM 标注
const BEACON_TOP_Y = 2.1;   // 光柱 1.75 + 灯球/光晕半径
let frameSamples = null;
function getFrameSamples() {
  if (frameSamples) return frameSamples;

  const collect = (objs) => {
    const out = [];
    objs.forEach((m) => {
      if (!m.isMesh || !m.geometry.attributes.position) return;
      const pos = m.geometry.attributes.position;
      const step = Math.max(1, Math.floor(pos.count / 360));
      for (let i = 0; i < pos.count; i += step) {
        out.push(new THREE.Vector3().fromBufferAttribute(pos, i));
      }
      out.push(new THREE.Vector3().fromBufferAttribute(pos, pos.count - 1));
    });
    return out;
  };

  const main = collect(map.provinces);
  const all = main.concat(collect(map.jdGroup.children));

  const tops = [];
  if (effects.beacons) {
    const p = new THREE.Vector3();
    effects.beacons.forEach((b) => {
      b.group.getWorldPosition(p);
      tops.push(p.clone().setY(p.y + BEACON_TOP_Y));
    });
  }

  const withTops = (arr) => arr.concat(tops);
  const lift = (arr) => arr.map((q) => q.clone().setY(q.y + FRAME_PAD_Y));

  frameSamples = {
    main: withTops(main),
    all: withTops(all),
    liftedMain: lift(withTops(main)),
    liftedAll: lift(withTops(all)),
  };
  return frameSamples;
}
const frameTmpV = new THREE.Vector3();

// 界面占位：直接读真实 DOM，使取景随窗口尺寸与响应式布局自适应。
// 读不到（元素被隐藏、小屏折叠）时退回静态默认值。
const INSET_FALLBACK = { left: 298, right: 382, top: 88, bottom: 80 };
function measureInset() {
  const W = window.innerWidth, H = window.innerHeight;
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return (b.width > 4 && b.height > 4) ? b : null;
  };
  const GAP = 10;
  const lp = box('#leftPanel'), rp = box('#rightPanel');
  const tb = box('.topbar'), bb = box('.bottombar');
  /* 窄屏下两栏是盖在地图上的抽屉，不占版面 —— 必须按 0 计。
     若照常按面板宽度留白，取景会把地图挤进「抽屉之外的那条缝」里：
     390 宽时两栏各 340px，地图会被压成几十像素，比原样还糟。
     判据用 body.narrow（ui.js 按 860 断点维护），与 css 里的抽屉形态同一个来源。 */
  const overlay = document.body.classList.contains('narrow');
  const inset = {
    left: overlay ? 0 : (lp ? lp.right + GAP : INSET_FALLBACK.left),
    right: overlay ? 0 : (rp ? W - rp.left + GAP : INSET_FALLBACK.right),
    top: tb ? tb.bottom + GAP : INSET_FALLBACK.top,
    bottom: bb ? H - bb.top + GAP : INSET_FALLBACK.bottom,
  };
  // 兜底：任何情况下都要留出一块可用的空白区
  if (W - inset.left - inset.right < 260) { inset.left = 0; inset.right = 0; }
  if (H - inset.top - inset.bottom < 220) { inset.top = 56; inset.bottom = 56; }
  return inset;
}

const VIEW = {
  // 默认展示完整版图（含南海诸岛），确保领土要素完整可见
  reset: { id: 'reset', box: 'all', dir: new THREE.Vector3(0, 0.72, 0.70).normalize() },
  mainland: { id: 'mainland', box: 'main', dir: new THREE.Vector3(0, 0.74, 0.72).normalize() },
  top: { id: 'top', box: 'all', dir: new THREE.Vector3(0, 1, 0.02).normalize() },
  territory: { id: 'territory', box: 'all', dir: new THREE.Vector3(0, 0.26, 1.0).normalize() },
  // 2D 平面：正上方俯视。倾角留 0.02 而不是 0，是因为 frameView 要用
  // cross((0,1,0), dir) 求屏幕右轴，dir 与 up 完全平行时会退化成零向量。
  flat: { id: 'flat', box: 'all', dir: new THREE.Vector3(0, 1, 0.02).normalize() },
};

/**
 * 计算能完整容纳地图的相机距离，并把地图居中于左右面板之间的「可视空白区」。
 *
 * 这里不用解析式估算：因为相机是斜视的，靠近相机的一侧（南部）会因透视被放大，
 * 解析式会低估实际横向占宽，导致版图被面板压住。改为用一台临时相机**实测**投影
 * 包围盒，再迭代收敛距离；最后把投影包围盒的中心对齐到空白区中心。
 */
function frameView(preset) {
  const isAll = preset.box === 'all';
  const center = (isAll ? centerAll : centerMain).clone();
  const dir = preset.dir.clone();

  const W = window.innerWidth, H = window.innerHeight;
  const INSET = measureInset();
  const freeW = Math.max(280, W - INSET.left - INSET.right);
  const freeH = Math.max(240, H - INSET.top - INSET.bottom);

  const vFov = (camera.fov * Math.PI) / 180;
  const visibleH = 2 * Math.tan(vFov / 2);      // 单位距离上的可见高度
  const visibleW = visibleH * camera.aspect;

  const fs = getFrameSamples();
  const base = isAll ? fs.all : fs.main;
  const pts = base.concat(isAll ? fs.liftedAll : fs.liftedMain);

  const probe = new THREE.PerspectiveCamera(camera.fov, camera.aspect, 0.5, 900);
  let d = Math.max(visibleW, visibleH) * 2;
  const box = { x0: 0, x1: 0, y0: 0, y1: 0 };
  const FIT = 0.985;   // 留 1.5% 安全边，抵消顶点抽样可能漏掉的极值

  // 把一组采样点投影到屏幕，返回包围盒
  const projectBox = (list, out) => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < list.length; i++) {
      const q = frameTmpV.copy(list[i]).project(probe);
      const sx = (q.x * 0.5 + 0.5) * W;
      const sy = (-q.y * 0.5 + 0.5) * H;
      if (sx < x0) x0 = sx;
      if (sx > x1) x1 = sx;
      if (sy < y0) y0 = sy;
      if (sy > y1) y1 = sy;
    }
    out.x0 = x0; out.x1 = x1; out.y0 = y0; out.y1 = y1;
    return out;
  };

  for (let iter = 0; iter < 8; iter++) {
    probe.position.copy(center).addScaledVector(dir, d);
    probe.lookAt(center);
    probe.updateMatrixWorld(true);
    probe.updateProjectionMatrix();

    // 定缩放用「含抬升点」的盒子：为光柱与标注预留竖直余量
    projectBox(pts, box);
    const k = Math.max((box.x1 - box.x0) / (freeW * FIT), (box.y1 - box.y0) / (freeH * FIT));
    if (Math.abs(k - 1) < 0.006) break;
    d *= k;
  }

  // 定居中只用真实地形点：抬升点是单向的，用它居中会把画面整体压偏
  const cbox = projectBox(base, { x0: 0, x1: 0, y0: 0, y1: 0 });

  // 屏幕右轴 / 上轴在世界坐标中的方向（与 lookAt 的基向量一致）
  const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), dir).normalize();
  const up = new THREE.Vector3().crossVectors(dir, right).normalize();
  const worldPerPxX = (visibleW * d) / W;
  const worldPerPxY = (visibleH * d) / H;

  // 移动 target 会让画面朝相反方向移动。
  // 注意两个轴的符号不同：屏幕 y 轴向下、相机 up 轴向上，故纵向取正号。
  const dx = INSET.left + freeW / 2 - (cbox.x0 + cbox.x1) / 2;
  const dy = INSET.top + freeH / 2 - (cbox.y0 + cbox.y1) / 2;
  const target = center.clone()
    .addScaledVector(right, -dx * worldPerPxX)
    .addScaledVector(up, dy * worldPerPxY);

  return { target, dist: d, dir };
}

// 记录当前取景预设，以及用户是否手动调整过相机。
// 窗口尺寸变化时，只有「用户没手动动过相机、也没选中具体诗境、且没有补间在跑」
// 才自动重新取景，避免把用户正在看的画面强行拉回全景。
let activeView = 'reset';
let userAdjusted = false;

function applyView(v, instant = false) {
  const f = frameView(v);
  const pos = f.target.clone().add(f.dir.clone().multiplyScalar(f.dist));
  // 向内可拉近到默认取景距离的约 1/14（原为 1/3.4）：
  // 原来最多只能拉近 3.4 倍，视域还有四百多公里宽，「放大查看细节」根本无从谈起
  // —— 连相距 5.8km 的金陵与秦淮都只差 17px。标记不再随缩放变大之后，
  // 拉近倍数就是纯粹的细节增益，所以这里一并放宽。
  // 下限取 1.2 而不是更小：相机 near 面在 0.5，再近会开始裁掉脚下地形。
  controls.minDistance = Math.min(1.2, f.dist * 0.08);
  activeView = v.id || activeView;
  userAdjusted = false;
  if (instant) {
    camera.position.copy(pos);
    controls.target.copy(f.target);
    controls.update();
    return;
  }
  flyCamera(pos, f.target, 1.25);
}

/* ================= 2D 平面模式 ================= */
/**
 * 2D 模式并不真的换成一台正交相机。
 *
 * 版图是用 ExtrudeGeometry 挤出的水平顶面，从正上方俯视时，顶面本身没有任何
 * 透视畸变，侧壁又被自身遮住 —— 视觉上与一张平面地图等价。所以只要
 * 「正上方取景 + 收起三维装饰 + 锁定旋转」，就得到了干净的 2D 地图，
 * 而不必再维护第二台相机、第二套控制器和两套取景逻辑。
 */
let lastView3D = 'reset';

function applyFlatMode(on, opts = {}) {
  if (state.flat === on) return;
  state.flat = on;
  document.body.classList.toggle('flat-mode', on);

  if (effects.cloudGroup) effects.cloudGroup.visible = on ? false : state.layers.clouds;
  stars.visible = !on;
  bloom.enabled = !on;
  effects.setMode(on ? 'flat' : '3d');
  ui.invalidateDock();

  // 2D 下锁定旋转：能平移缩放、不能转到斜视角，才像一张平面地图
  controls.enableRotate = !on;
  if (on) {
    controls.autoRotate = false;
    document.querySelector('[data-view="spin"]').classList.remove('on');
    map.provinces.forEach((m) => { m.userData.hovered = false; m.position.y = 0; });
    lastView3D = activeView === 'flat' ? 'reset' : activeView;
  }

  // noView：调用方自己接着会 applyView（比如从 2D 直接点「俯视」），
  // 此时不要在这里多飞一次相机，否则两次补间会互相打架。
  if (!opts.noView) applyView(on ? VIEW.flat : (VIEW[lastView3D] || VIEW.reset));
  if (!opts.quiet) ui.toast(on ? '已切换到 2D 平面地图（锁定旋转）' : '已回到 3D 地势地图');
}

/* ================= 视图模式：2D 平面 / 3D / 地球 —— 三选一 ================= */
/**
 * 三个视图是**互斥**的，不是三个独立开关。
 *
 * 早先 2D 与地球各有一个自己的 on/off，进入地球时会顺手退出 2D，
 * 但反过来「在地球模式下点 2D」不会退出地球 —— 于是两个模式同时成立：
 * 地球层与版图层都可见、相机极角限制与近裁剪面互相打架，
 * 画面变成一团谁也说不清的东西。
 *
 * 所以把「切换视图」收成**唯一入口**，三个状态在这里一次性算清楚：
 * 先退出旧的、再进入新的，中间那次退出不取景（noView），
 * 因为紧接着的进入分支会自己飞一次相机。
 */
function setViewMode(mode, opts = {}) {
  const m = (mode === 'flat' || mode === 'earth') ? mode : '3d';
  const cur = state.earth ? 'earth' : state.flat ? 'flat' : '3d';
  if (cur === m) return false;
  const to3d = m === '3d';
  const leave = to3d ? opts : { ...opts, noView: true, quiet: true };
  if (cur === 'earth') applyEarthMode(false, leave);
  if (cur === 'flat') applyFlatMode(false, leave);
  if (m === 'flat') applyFlatMode(true, opts);
  if (m === 'earth') applyEarthMode(true, opts);
  syncViewButtons();
  // 行迹在三种视图下的画法完全不同（版图弧线 / 平面线 / 球面大圆航线），
  // 换视图必须整条重建，否则会把上一个坐标系里的线留在屏幕上 ——
  // 「地球模式下那几根粗管子」就是这么来的：行迹在地球模式下才被建出来，
  // 用的却是版图坐标系（一个世界单位 = 半张中国地图），放到半径 1 的球上自然离谱。
  const stops = rebuildRoute();
  /* 重建之后还要按新坐标系**重新取景**。
     退旧进新时那两次 applyView 取的是「默认版图 / 默认太空视角」，
     带着行迹切过去就会看到缩在一角的版图，行迹几乎看不见 ——
     2D 下明明框得好好的，切到 3D 却像换了一条路线。
     noView 时跳过：那是调用方自己接着要 applyView（比如点「俯视」），
     不该被行迹取景盖掉。 */
  if (stops && !opts.noView) frameRoute(stops);
  return true;
}

/** 底栏「2D 平面 / 地球」两个互斥开关的高亮，只在这一处维护 */
function syncViewButtons() {
  const mode = state.earth ? 'earth' : state.flat ? 'flat' : '3d';
  document.querySelectorAll('#viewGroup button').forEach((b) => {
    const v = b.dataset.view;
    if (v !== 'flat' && v !== 'earth') return;
    const on = v === mode;
    b.classList.toggle('on', on);
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

/** 兼容旧签名：外部脚本 / 调试钩子仍按 on/off 调用 */
function setFlatMode(on, opts = {}) { return setViewMode(on ? 'flat' : '3d', opts); }

/* ================= 地球模式 ================= */
/**
 * 进入 / 退出太空视角。
 *
 * 与 2D 平面模式的区别：2D 是「同一台相机换一个俯视角」，地球是**换一层内容** ——
 * 所以要整体切换显隐，而不是只改取景。地图那一整套（地形 / 海洋 / 江河 / 光柱 /
 * 云海 / 标注 / 气泡）在地球模式下全部隐藏，地球层在其余时候不可见。
 *
 * 相机的自由度也要换：地图是「俯视一块版图」，极角必须卡在 0.05~1.5，否则会钻到地下；
 * 地球是「从太空看一颗球」，极角要放开到接近两极，用户才能真正朝任意方向转动它。
 */
// 默认视角把中国（约 104°E / 34°N）转到正面朝前 —— 这台地球是为中国古典诗词做的，
// 一进去就该看见那簇诗境，而不是随机给一片大洋。相机放在「该地点的球面方向 × 距离」上，
// 视线自然落在球心，该地点就落在画面正中，正北朝上。
const EARTH_DIR = dirFromLonLat(104, 34).normalize();
const EARTH_ZOOM_IN = 1.8;    // 选中某处诗境后拉近到的距离（一屏约 26° 跨度，东亚范围）
/**
 * 最近距离由**数据分辨率**定，不是由「能不能再靠近」定。
 *
 * 地球上的缩放比直觉猛得多：一屏可见的球心角跨度不是 2·acos(R/d)，
 * 而是由视场角卡住的 —— 视线边缘 φ = fov/2 对应的球心角 θ 满足
 *   tan φ = R·sinθ / (d − R·cosθ)
 * 解出来（fov=30°、R≈1.0）：
 *   d=5.34 → 跨度 164°（整颗地球）   d=3.0 → 72°   d=1.4 → 12.6°   d=1.08 → 2.4°
 * 也就是说 d 从 1.4 走到 1.08 这「一小步」，跨度缩了 5 倍。
 *
 * 而高程数据是 **1° 网格**（ETOPO1 抽样，见 js/data/world.js）。d=1.08 时
 * 整屏只有 2.4 个数据格，双线性插值出来必然是一片平滑的色块 ——
 * 实测把相机放到阿尔卑斯上空：贴图在该处 9.5° 跨度内的对比度是 165，
 * 而渲染出来只有 24，肉眼看就是一片发白，完全没有「地形的变化」。
 * 同一位置 d=1.4（12.6° 跨度）的对比度是 172，正常。
 *
 * 取 1.4：跨度 12.6°、约 12 个数据格，是这套数据还撑得住的极限，
 * 同时距球面 0.372（最高地形 1.028 处），远大于近裁剪面 0.2。
 * 从默认视角到这里是 13 倍放大（164° → 12.6°），缩放本身已经很够用。
 * 想再往里看，要换更细的高程数据，不是把 minDistance 调小。
 */
const EARTH_MIN = 1.4;
const EARTH_MAX = 14;

/**
 * 近裁剪面必须按模式切换，否则「放大」会把整个地球裁没。
 *
 * 球面沿视线方向距相机的距离约是 d − R（d 为相机到球心距离，R ≈ 1.0~1.03）。
 * 地图档的 near = 0.5 在 d < 1.53 时就把**整个可见球面**推进了近裁剪面之内：
 * 实测 d = 1.35 与 1.10 两档，屏幕上只剩星空，地球彻底消失 ——
 * 而滚轮能一路缩到 EARTH_MIN，也就是说「放大」这个功能有一整段是黑屏。
 *
 * 地球档取 0.2：d = EARTH_MIN 时最近的地面点在相机前方约 0.37，留有余量。
 * 也不能取更小 —— 近裁剪面越小，远处（d 最大到 14）的深度分辨力越差：
 * 水面壳相对球面只抬升 5e-4，near=0.02 时 z=14 处的深度分辨力约 5.9e-4，
 * 两者同量级，海陆交界会开始起斑。near=0.2 时是 5.8e-5，安全。
 * 退出时必须还原成 0.5：地图那边要的是大范围取景。
 */
const CAM_NEAR_MAP = 0.5;
const CAM_NEAR_EARTH = 0.2;

function setCameraNear(n) {
  if (Math.abs(camera.near - n) < 1e-9) return;
  camera.near = n;
  camera.updateProjectionMatrix();
}

/**
 * 默认太空取景距离：让**整颗地球**（含大气外壳）恰好落在左右面板之间的可视区里。
 *
 * 不能写死。可视区随窗口尺寸与响应式布局变化 —— 窄屏下两栏是盖在地图上的抽屉、
 * 不占版面，写死就会出现「宽屏刚好看全、窄屏地球被面板切掉一半」。
 *
 * 球在屏幕上的角半径 α 满足 tanα = rad / √(d² − rad²)，要求它不超过
 * 半个视场角乘以「可视区占全窗口的比例」，解出 d 即可。
 */
function earthDist() {
  const W = window.innerWidth, H = window.innerHeight;
  const inset = measureInset();
  const freeW = Math.max(280, W - inset.left - inset.right);
  const freeH = Math.max(240, H - inset.top - inset.bottom);
  const tanV = Math.tan((camera.fov * Math.PI) / 360);
  const tanH = tanV * camera.aspect;
  const rad = GLOBE_R * 1.055;                       // 含大气辉光外壳
  const fit = (T) => rad * Math.sqrt(1 + 1 / (T * T));
  return Math.max(fit(tanV * (freeH / H)), fit(tanH * (freeW / W))) * 1.05;
}
let earthDistNow = 5;

/**
 * 地球模式下的光照：把主光改成**跟着相机走的太阳**。
 *
 * 主光在地图模式下是固定的一个方向，那是为「俯视一块版图」调的。到了地球上就不成立：
 * 用户把球转到哪一面，那一面就可能是夜面 —— 实测选中一处诗境后，地球转到该地点正面
 * 朝前，而那个方向恰好背光，整个画面只剩一片黑，地形与版图全看不见。
 * 这里让光的方向跟着相机走（固定偏开约 30°），看到的那一面永远是亮的，
 * 同时保留明暗过渡。退出时还原，地图那套光照完全不受影响。
 *
 * 两条踩过的坑：
 *
 * 1) 偏移量**不能**随缩放收敛。曾经写过 `off = 0.18 + 0.37·clamp((d−1.05)/2.6)`，
 *    依据是「拉近后可见球冠只有 56°，固定偏 31.6° 会让中国北方整片变黑」——
 *    但那个「变黑」其实另有原因（贴图 flipY 让地球上下颠倒，看到的是一片深蓝），
 *    诊断错了。收敛的后果实测是：缩到最近处时夹角只剩 8.6°，光几乎正对镜头，
 *    地形起伏对法线的扰动退化成二阶效应（正射光下 N·L ≈ 1 − α²/2），
 *    整屏变成一片发白的平光，对比度量出来是 1 —— 正是「看不到地形变化」。
 *    斜射光下同一扰动是一阶的（≈ α·sinθ），所以夹角越接近垂直越好，
 *    只要不把晨昏线推进可见球冠之内。
 *
 * 2) 偏转要绕**屏幕横轴**，不能绕地球自转轴。绕 Y 轴偏 off 时，光与视线的
 *    实际夹角是 off·cos(相机纬度)：赤道附近有 26°，转到极区就只剩 4°，
 *    又退化成无影灯。绕「视线 × 上方向」偏转，则处处都是同一个夹角。
 */
const LIGHT_UP = new THREE.Vector3(0, 1, 0);
const KEY_POS_MAP = key.position.clone();
const RIM_POS_MAP = rim.position.clone();
const lightDirTmp = new THREE.Vector3();
const lightAxisTmp = new THREE.Vector3();
/** 主光相对视线的夹角：30°。够斜、能照出山脊，又不至于把可见球冠边缘推进夜面 */
const EARTH_LIGHT_OFF = 0.52;

function updateEarthLights() {
  lightDirTmp.copy(camera.position).normalize();
  lightAxisTmp.crossVectors(lightDirTmp, LIGHT_UP);
  if (lightAxisTmp.lengthSq() < 1e-8) lightAxisTmp.set(1, 0, 0);   // 相机正对两极时退化
  lightAxisTmp.normalize();
  key.position.copy(lightDirTmp).applyAxisAngle(lightAxisTmp, EARTH_LIGHT_OFF).multiplyScalar(60);
  // 轮廓光放到背面偏侧：给球的边缘勾一道冷色，和主光的暖色分开
  rim.position.copy(lightDirTmp).applyAxisAngle(lightAxisTmp, EARTH_LIGHT_OFF + 1.9).multiplyScalar(60);
}

function restoreMapLights() {
  key.position.copy(KEY_POS_MAP);
  rim.position.copy(RIM_POS_MAP);
}

let earthPrev = null;

// HUD 底部那行说明两种模式说的不是一回事，不能混着显示 ——
// 在地球模式下还写「依据中国标准地图 Albers 投影绘制」是错的。
const HUD_NOTE_MAP = '底图依据中国标准地图 Albers 投影绘制<br/>含台湾省、香港特别行政区、澳门特别行政区及南海诸岛';
const HUD_NOTE_EARTH = '全球地形依据 ETOPO1 高程数据绘制<br/>中国版图依据中国标准地图数据（含台湾省及南海诸岛）';

function applyEarthMode(on, opts = {}) {
  if (state.earth === on) return;
  state.earth = on;
  document.body.classList.toggle('earth-mode', on);
  ui.invalidateDock();

  if (on) {
    globe.build();
    earthPrev = {
      minPolarAngle: controls.minPolarAngle,
      maxPolarAngle: controls.maxPolarAngle,
      enablePan: controls.enablePan,
      view: activeView === 'flat' ? lastView3D : activeView,
    };

    map.root.visible = false;
    ocean.root.visible = false;
    rivers.visible = false;
    effects.beaconGroup.visible = false;
    if (effects.routeGroup) effects.routeGroup.visible = false;
    if (effects.cloudGroup) effects.cloudGroup.visible = false;
    document.getElementById('labelLayer').style.display = 'none';

    // 星空留着 —— 它就是太空背景
    stars.visible = true;

    controls.minDistance = EARTH_MIN;
    controls.maxDistance = EARTH_MAX;
    controls.minPolarAngle = 0.02;
    controls.maxPolarAngle = Math.PI - 0.02;
    controls.enablePan = false;
    setCameraNear(CAM_NEAR_EARTH);

    globe.show(true);
    earthDistNow = earthDist();
    /* 补偿基准取的是「相机将要落到的那处默认太空视角」，不是相机此刻的位置 ——
       此刻相机还在版图视角上（距球心约 17.8，而这里只有 5.3），
       拿它当基准会把 79 个地标一律压小近 4 倍（详见 globe.js captureRefAt）。 */
    const earthHome = EARTH_DIR.clone().multiplyScalar(earthDistNow);
    const earthAim = new THREE.Vector3(0, 0, 0);
    globe.captureRefAt(earthHome, earthAim);
    const note = document.querySelector('.hud-note');
    if (note) note.innerHTML = HUD_NOTE_EARTH;
    flyCamera(earthHome, earthAim, 1.5);
  } else {
    globe.show(false);
    map.root.visible = true;
    ocean.root.visible = true;
    rivers.visible = state.layers.rivers;
    effects.beaconGroup.visible = true;
    if (effects.routeGroup) effects.routeGroup.visible = true;
    if (effects.cloudGroup) effects.cloudGroup.visible = state.layers.clouds;
    document.getElementById('labelLayer').style.display = state.layers.labels ? '' : 'none';

    if (earthPrev) {
      controls.minPolarAngle = earthPrev.minPolarAngle;
      controls.maxPolarAngle = earthPrev.maxPolarAngle;
      controls.enablePan = earthPrev.enablePan;
    }
    controls.maxDistance = 260;
    restoreMapLights();
    setCameraNear(CAM_NEAR_MAP);
    const note = document.querySelector('.hud-note');
    if (note) note.innerHTML = HUD_NOTE_MAP;
    if (!opts.noView) applyView(VIEW[(earthPrev && earthPrev.view) || 'reset']);
  }
  if (!opts.quiet) {
    ui.toast(on
      ? `已进入地球模式 · 拖动可任意方向转动地球，滚轮缩放（${SITES.length} 处诗境集中在中国）`
      : '已回到中国地势图');
  }
}

/** 兼容旧签名：外部脚本 / 调试钩子仍按 on/off 调用 */
function setEarthMode(on, opts = {}) { return setViewMode(on ? 'earth' : '3d', opts); }

/* ================= 相机补间 ================= */
let tween = null;
function flyCamera(toPos, toTarget, dur = 1.3) {
  tween = {
    t: 0, dur,
    p0: camera.position.clone(), p1: toPos.clone(),
    t0: controls.target.clone(), t1: toTarget.clone(),
  };
}
const easeInOut = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

function updateTween(dt) {
  if (!tween) return;
  tween.t += dt;
  const k = Math.min(1, tween.t / tween.dur);
  const e = easeInOut(k);
  camera.position.lerpVectors(tween.p0, tween.p1, e);
  controls.target.lerpVectors(tween.t0, tween.t1, e);
  if (k >= 1) tween = null;
}

/* ================= 筛选 ================= */
function matchSite(s) {
  // 行迹聚焦：选中某位诗人的行迹后，只保留他真正到过的站点。
  // 不这么做的话，79 根光柱会和他自己的行迹叠在一起，完全看不出路线走向。
  if (state.routeFocus && !state.routeFocus.has(s.id)) return false;
  // 按站点覆盖的朝代集合匹配（含其诗篇所属朝代），而非仅站点主朝代
  if (state.eras.size && !s.eras.some((e) => state.eras.has(e))) return false;
  if (state.themes.size && !s.themes.some((t) => state.themes.has(t))) return false;
  if (state.regions.size && !state.regions.has(s.region)) return false;
  return true;
}

function applyVisibility() {
  visibleSites = state.quizMode ? SITES.slice() : SITES.filter(matchSite);
  const vis = new Set(visibleSites.map((s) => s.id));
  SITES.forEach((s) => effects.setBeaconVisible(s.id, vis.has(s.id)));
  // 地球层是另一套地标（球面上的 79 个精灵），可见性必须一起算 ——
  // 否则行迹聚焦后版图只剩 9 根光柱、地球上却还亮着 79 个点。
  if (globe.built) globe.setRouteFocus(state.quizMode ? null : state.routeFocus);
  ui.refreshList(visibleSites.map((s) => s.id));
  rivers.visible = state.layers.rivers;
  if (effects.cloudGroup) effects.cloudGroup.visible = state.layers.clouds;
  tour.list = scopeList(tour.scope);
  refreshRegionPanel();
}

/**
 * 可见性变化后，把右栏的「地区介绍」和底部诗词条按当前可见的诗境重算一遍。
 *
 * 不重算就会自相矛盾：点开四川省看到 4 处诗境，再切到李白行迹 ——
 * 地图上只剩行迹那 9 站（四川省内只剩峨眉山），右栏却仍然列着 4 处，
 * 用户照着清单去地图上找，根本找不到。筛选（朝代 / 题材 / 地域）变化同理。
 *
 * 这是「同一件事的多个侧面必须一起复位」的又一个实例：
 * 地图光柱、左侧列表、右栏地区介绍、底部诗词条，四个侧面同源于可见集合，
 * 任何一个单独更新都会打架。挂在 applyVisibility 末尾就一劳永逸。
 */
function refreshRegionPanel(opts = {}) {
  if (!ui || typeof ui.currentRegion !== 'function') return;
  const code = ui.currentRegion();
  if (!code) return;                       // 右栏显示的是诗境详情，别打断用户
  const mesh = map.hoverTargets.find((m) => m.userData.adcode === code);
  if (!mesh) return;

  const u = mesh.userData;
  const entry = PROVINCE_SITES.get(code);
  const all = entry ? entry.sites : [];
  const sites = all.filter((s) => {
    const b = effects.beacons.get(s.id);
    return b && b.visible;
  });
  const prov = { code, name: u.name, height: u.baseHeight, total: all.length };

  // expand: false —— 用户可能刚把右栏收起来，内容保持最新即可，不要自动弹开
  ui.renderRegion(prov, sites, { expand: false });
  // 诗词条的显隐有自己的时机（进练习 / 行迹模式会被收起），默认跟着现状走；
  // 退出这些模式时由调用方传 showBar: true 让它回来。
  ui.showRegionBar(prov, sites, { show: opts.showBar ?? ui.isRegionBarOpen() });
}

function scopeList(scope) {
  const base = scope === 'all' ? SITES : visibleSites;
  switch (scope) {
    case 'tang': return SITES.filter((s) => s.era === 'tang');
    case 'song': return SITES.filter((s) => s.era === 'song');
    case 'border': return SITES.filter((s) => s.themes.includes('边塞'));
    case 'water': return SITES.filter((s) => s.region === 'south' || s.themes.includes('田园'));
    default: return base;
  }
}

/* ================= 选中与运镜 ================= */
function selectSite(id, opts = {}) {
  const site = SITE_MAP.get(id);
  if (!site) return;
  selectedId = id;
  effects.setSelected(id);
  globe.setSelected(id);
  ui.renderDetail(site, { poemId: opts.poemId, keyword: opts.keyword });

  if (opts.fly !== false) {
    if (state.earth) {
      // 地球模式下没有「飞过去看光柱」这回事：改为把地球转到让该地点正面朝前。
      // 相机放在「地点方向 × 距离」上，视线自然落在球心，该地点就落在画面正中。
      const dir = globe.dirOf(id);
      if (dir) flyCamera(dir.multiplyScalar(EARTH_ZOOM_IN), new THREE.Vector3(0, 0, 0), 1.35);
    } else {
      const b = effects.beacons.get(id);
      if (b) {
        const p = b.group.position.clone();
        // 2D 平面下必须走俯视方向：复用三维的斜视方向会把相机拉离正上方，
        // 而 2D 锁了旋转，用户再也转不回来 —— 画面卡在一个「既不平面也不立体」
        // 的角度上，这是 2D 模式最容易被漏掉的一处适配。
        const dir = state.flat
          ? VIEW.flat.dir.clone()
          : new THREE.Vector3(0, 0.80, 0.95).normalize();
        const dist = state.flat ? 9 : 11.5;
        flyCamera(
          p.clone().add(dir.multiplyScalar(dist)).setY(p.y + dist * (state.flat ? 1 : 0.62)),
          p.clone().setY(p.y + (state.flat ? 0 : 0.3)),
          1.35,
        );
      }
    }
  }
  if (state.voice) {
    const p = site.poems[0];
    ui.speak(p.lines.flat().join(''));
  }
}

function stepSite(dir) {
  const list = visibleSites.length ? visibleSites : SITES;
  if (!list.length) return;
  const i = list.findIndex((s) => s.id === selectedId);
  const n = ((i < 0 ? 0 : i) + dir + list.length) % list.length;
  selectSite(list[n].id);
}

/* ================= 交互：拾取 ================= */
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
let downPos = null;

function setPointer(e) {
  const r = renderer.domElement.getBoundingClientRect();
  pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
}

/** 屏幕空间就近吸附：点击/悬停在光柱附近也算命中，避免小目标难以点中 */
function pickBeaconByScreen(cx, cy, tol = 26) {
  let best = null, bestD = tol;
  const v = new THREE.Vector3();
  effects.beacons.forEach((b, id) => {
    if (!b.visible || b.hit.userData.disabled) return;
    v.copy(b.group.position);
    // 抬到光柱中部。光柱随缩放补偿缩短，这里必须乘同一个系数 ——
    // 否则放大后按固定 0.9 世界单位取点，吸附圈会飘在光柱上方，点不中。
    v.y += 0.9 * (b.group.scale.y || 1);
    const p = v.project(camera);
    if (p.z > 1) return;
    const sx = (p.x * 0.5 + 0.5) * window.innerWidth;
    const sy = (-p.y * 0.5 + 0.5) * window.innerHeight;
    const d = Math.hypot(sx - cx, sy - cy);
    if (d < bestD) { bestD = d; best = id; }
  });
  return best;
}

/**
 * 拾取地标：先用射线找出「光柱被穿过」的候选，再在其中选屏幕距离最近的一个。
 * 这样既能点中柱体，也能避免前排站点挡住后排站点。
 */
function pickBeacon(e) {
  setPointer(e);
  raycaster.setFromCamera(pointer, camera);
  const objs = effects.pickables.filter((o) => !o.userData.disabled);
  const hits = raycaster.intersectObjects(objs, false);
  if (hits.length) {
    const ids = new Set(hits.map((h) => h.object.userData.siteId));
    let best = null, bestD = Infinity;
    const v = new THREE.Vector3();
    ids.forEach((id) => {
      const b = effects.beacons.get(id);
      if (!b) return;
      v.copy(b.group.position);
      // 抬到拾取柱体的中部。柱体随缩放补偿一起缩，这里必须乘同一个系数，
      // 否则放大后按固定 0.9 世界单位取点会落到柱体上方、射线扑空。
      v.y += 0.9 * (b.group.scale.y || 1);
      const p = v.project(camera);
      const sx = (p.x * 0.5 + 0.5) * window.innerWidth;
      const sy = (-p.y * 0.5 + 0.5) * window.innerHeight;
      const d = Math.hypot(sx - e.clientX, sy - e.clientY);
      if (d < bestD) { bestD = d; best = id; }
    });
    if (best) return best;
  }
  return pickBeaconByScreen(e.clientX, e.clientY);
}

/**
 * 地球上的拾取：直接射线打地标精灵。
 * 这里**不**做屏幕就近吸附 —— 79 处诗境全集中在中国那一小片里，
 * 在太空视角下彼此只差几个像素，再加吸附圈反而会让用户点不到想要的那一个。
 */
function pickGlobe(e) {
  if (!globe.built) return null;
  setPointer(e);
  raycaster.setFromCamera(pointer, camera);
  // 传入相机：背面地标要被排除，否则会点中球体后面看不见的那一个
  const hits = raycaster.intersectObjects(globe.pickables(camera), false);
  return hits.length ? hits[0].object.userData.siteId : null;
}

/** 地球表面（含地形起伏）的命中点 → 经纬度，供 HUD 读数 */
const globeHitPoint = new THREE.Vector3();
function globeLonLatAt() {
  if (!globe.built) return null;
  const hits = raycaster.intersectObject(globe.surface, false);
  if (!hits.length) return null;
  return lonLatFromDir(globeHitPoint.copy(hits[0].point));
}

/**
 * HUD 经纬度读数的小数位：随相机拉近而增加。
 * 1° 纬度 ≈ 111km，所以 2 位 ≈ 1.1km、3 位 ≈ 110m、4 位 ≈ 11m ——
 * 放大到能看清细节时，读数也该细到能对上画面。
 * 判据用「参考距离 / 当前距离」而不是绝对距离，窗口尺寸变化时不会漂。
 */
let hudDecimalsCache = 0;
function hudDecimals() {
  const dist = camera.position.distanceTo(controls.target);
  // 两种模式的「基准距离」量纲完全不同：地图是 16.8 世界单位的版图，
  // 地球是 3.05 的球体。混用同一个基准会让地球一进去就显示 3 位小数，
  // 而那时整颗地球才占满画面、读数细到 110m 毫无意义。
  const ref = state.earth
    ? (globe.markerRef > 0 ? globe.markerRef : dist)
    : (effects.markerRef > 0 ? effects.markerRef : dist);
  const k = ref / Math.max(dist, 0.001);
  return k >= 8 ? 4 : k >= 2.5 ? 3 : 2;
}

// 最近一次鼠标所指的经纬度：缩放会改变读数精度，鼠标不动时也要用它重刷一次。
let hudLL = null;

renderer.domElement.addEventListener('pointerdown', (e) => { downPos = { x: e.clientX, y: e.clientY }; });

renderer.domElement.addEventListener('pointermove', (e) => {
  setPointer(e);
  raycaster.setFromCamera(pointer, camera);

  /* 地球模式：只有地标可交互。
     必须在这里显式分流 —— three.js 的射线检测**不看 visible**，
     隐藏起来的省份网格照样会被打中，不拦就会「点中看不见的省份」。 */
  if (state.earth) {
    const ll = globeLonLatAt();
    if (ll) { hudLL = ll; ui.updateHud(ll[0], ll[1], hudDecimals()); }
    const gid = pickGlobe(e);
    hoveredId = gid;
    const gs = gid ? SITE_MAP.get(gid) : null;
    ui.showHoverTip(e.clientX, e.clientY, gs ? `${gs.name}　${gs.sub}` : null);
    renderer.domElement.style.cursor = gid ? 'pointer' : 'grab';
    return;
  }

  // 省份悬停
  const ph = raycaster.intersectObjects(map.hoverTargets, false);
  const p = ph.length ? ph[0].object : null;
  if (p !== hoveredProvince) {
    if (hoveredProvince) hoveredProvince.userData.hovered = false;
    hoveredProvince = p;
    if (p) p.userData.hovered = true;
  }
  if (p) {
    const prov = p.userData;
    const h = prov.baseHeight;
    const grade = h > 0.72 ? '雪线高原' : h > 0.55 ? '高原山地' : h > 0.38 ? '丘陵盆地' : '平原水乡';
    ui.showHoverTip(e.clientX, e.clientY, `${prov.name}　${grade}`);
  } else {
    ui.showHoverTip(e.clientX, e.clientY, null);
  }

  // 经纬度
  const hit = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(groundPlane, hit)) {
    const ll = unprojectToLonLat(hit.x, hit.z);
    hudLL = ll;
    ui.updateHud(ll[0], ll[1], hudDecimals());
  }

  // 地标悬停
  const id = pickBeacon(e);
  if (id !== hoveredId) {
    hoveredId = id;
    if (id) {
      const s = SITE_MAP.get(id);
      ui.showHoverTip(e.clientX, e.clientY, `${s.name}　${s.sub}`);
    }
  }
  renderer.domElement.style.cursor = id ? 'pointer' : (p ? 'pointer' : 'default');
});

/**
 * 点击地图上的某个行政区。
 * 流程：右侧抽屉显示该地区介绍 → 底部列出发生在这个地区的全部诗词
 *       → 点其中一首 → 弹出诗词详情弹窗（见 ui.openPoemModal）。
 */
function focusProvince(mesh) {
  const u = mesh.userData;
  const entry = PROVINCE_SITES.get(u.adcode);
  const all = entry ? entry.sites : [];
  // 只列当前地图上真的显示出来的诗境。
  // 否则会出现「地图上只剩 2 根光柱，地区介绍却列出 8 处诗境」这种自相矛盾的情况。
  const sites = all.filter((s) => {
    const b = effects.beacons.get(s.id);
    return b && b.visible;
  });
  const prov = { code: u.adcode, name: u.name, height: u.baseHeight, total: all.length };
  const poemCount = sites.reduce((n, s) => n + s.poems.length, 0);

  ui.renderRegion(prov, sites);
  ui.showRegionBar(prov, sites);
  ui.toast(sites.length
    ? `${u.name}：${sites.length} 处诗境 · ${poemCount} 首诗词`
    : (all.length ? `${u.name}：本区 ${all.length} 处诗境被当前筛选隐藏了` : `${u.name}：暂未收录诗境`));

  // 让被点中的省份保持高亮，用户才知道自己点到了哪一块
  map.hoverTargets.forEach((m) => { m.userData.hovered = m.adcode === u.adcode; });
  hoveredProvince = mesh;
}

renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downPos) return;
  const moved = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
  downPos = null;
  if (moved > 6) return; // 拖动不算点击

  // 地球模式：点地标即选中，地球会自动转到让该地点正面朝前（见 selectSite）
  if (state.earth) {
    const gid = pickGlobe(e);
    if (gid) selectSite(gid);
    return;
  }

  const id = pickBeacon(e);
  if (id) {
    if (state.quizMode && ui.answerGeoByMap(id)) return;
    selectSite(id);
    return;
  }
  // 没点中光柱 → 视为点击了某个省域
  setPointer(e);
  raycaster.setFromCamera(pointer, camera);
  const ph = raycaster.intersectObjects(map.hoverTargets, false);
  if (ph.length) focusProvince(ph[0].object);
  else ui.hideRegionBar();
});

/* ================= 巡游 ================= */
function startTour() {
  tour.list = scopeList(tour.scope);
  if (!tour.list.length) { ui.toast('当前范围没有可巡游的诗境'); return; }
  tour.playing = true;
  tour.index = -1;
  if (state.layers.labels) { /* 保持标注 */ }
  ui.setTourState({ playing: true, total: tour.list.length, index: 0, label: '准备出发…' });
  nextTourStep();
  clearInterval(tourTimer);
  tourTimer = setInterval(nextTourStep, 7200);
}

function stopTour() {
  tour.playing = false;
  clearInterval(tourTimer);
  ui.setTourState({ playing: false, label: '已暂停' });
  ui.stopSpeak();
}

function nextTourStep() {
  if (!tour.playing) return;
  tour.index += 1;
  if (tour.index >= tour.list.length) { stopTour(); ui.toast('巡游结束，共 ' + tour.list.length + ' 处诗境'); return; }
  const s = tour.list[tour.index];
  selectSite(s.id);
  const p = s.poems[0];
  ui.setTourState({
    playing: true, index: tour.index, total: tour.list.length,
    label: `${tour.index + 1}/${tour.list.length}　${s.name}　${p.dynasty}·${p.author}《${p.title}》`,
  });
  ui.speak(p.lines.flat().join(''));
}

/* ================= 行迹：三种视图各有一套画法 ================= */
/**
 * 按当前视图建行迹，返回 stops（供气泡与聚焦用）。
 *
 * 为什么不能一套几何通吃：
 *   - 版图是 Albers 投影 + 9.2 倍缩放，一个世界单位约等于一百公里；
 *     地球是半径 1 的球，一个世界单位约等于 6371 公里。同一个「抬升 3.6」的弧线，
 *     在版图上是优雅的飞线，在球上就是 3.6 个地球半径的巨型管子。
 *   - 2D 俯视下弧线不产生屏幕位移，只会让线偏离真实走向。
 * 所以三种视图各画各的，切换时整条重建。
 */
function buildRouteInView(route) {
  if (state.earth) {
    globe.build();
    return globe.buildRoute(route);
  }
  return effects.buildRoute(route);
}

/** 视图切换后按新视图把行迹重建一遍（含气泡与聚焦集合），返回 stops 供取景用 */
function rebuildRoute() {
  if (!state.activeRoute) return null;
  effects.clearRoute();
  globe.clearRoute();
  const stops = buildRouteInView(state.activeRoute);
  ui.buildRouteBubbles(state.activeRoute, stops || []);
  ui.invalidateDock();
  if (stops && stops.length) {
    state.routeFocus = new Set(stops.map((s) => s.siteId));
    applyVisibility();
  }
  return stops || null;
}

/**
 * 行迹取景：地图与平面共用一套（平面下强制俯视），地球另算。
 *
 * 2D 下必须走俯视方向 —— 复用三维的 (0, 0.86, 0.86) 会把相机拉到斜视角，
 * 而 2D 模式锁了旋转，用户再也转不回来，画面就卡在一个「既不平面也不立体」的
 * 尴尬角度上。
 */
function frameRoute(stops) {
  if (state.earth) {
    const dirs = stops.map((s) => globe.dirOf(s.siteId)).filter(Boolean);
    if (!dirs.length) return;
    const c = dirs.reduce((a, b) => a.add(b), new THREE.Vector3());
    if (c.lengthSq() < 1e-9) return;
    c.normalize();
    let half = 0;
    dirs.forEach((d) => { half = Math.max(half, Math.acos(Math.max(-1, Math.min(1, c.dot(d))))); });
    /* 由视场角反解距离：tan φ = R·sinθ/(d − R·cosθ) ⇒ d = R·cosθ + R·sinθ/tanφ。
       θ 取「行迹最大半张角 + 一点余量」，φ 取水平/竖直视场里较小的那个，
       保证整条行迹在横竖两个方向都装得下。 */
    const th = Math.min(1.45, half + 0.10);
    const tanV = Math.tan((camera.fov * Math.PI) / 360);
    const tanH = tanV * camera.aspect;
    const tan = Math.max(0.05, Math.min(tanV, tanH));
    const d = Math.min(EARTH_MAX, Math.max(EARTH_MIN, Math.cos(th) + Math.sin(th) / tan)) * 1.04;
    flyCamera(c.multiplyScalar(d), new THREE.Vector3(0, 0, 0), 1.7);
    return;
  }

  const pts = stops.map((s) => {
    const b = effects.beacons.get(s.siteId);
    return b ? b.group.position.clone() : null;
  }).filter(Boolean);
  if (!pts.length) return;
  const mid = pts.reduce((a, b) => a.add(b), new THREE.Vector3()).multiplyScalar(1 / pts.length);
  const box = new THREE.Box3().setFromPoints(pts);
  const size = box.getSize(new THREE.Vector3());
  const d = Math.max(11.5, Math.max(size.x, size.z) * 2.0 + 8);
  const dir = state.flat ? VIEW.flat.dir.clone() : new THREE.Vector3(0, 0.86, 0.86).normalize();
  flyCamera(mid.clone().add(dir.multiplyScalar(d)), mid, 1.7);
}

/* ================= UI 上下文 ================= */
const ui = new UI({
  sites: SITES,
  state,
  onFilterChange: () => { applyVisibility(); },
  onSelectSite: (id, opts) => selectSite(id, opts),
  onStep: (d) => stepSite(d),
  onHoverSite: (id) => { hoveredId = id; effects.setSelected(id || selectedId); },
  onBuildRoute: (route) => {
    state.activeRoute = route;
    const stops = buildRouteInView(route);
    // 先建气泡再取景：气泡一建出来 ui 就知道每帧要投影哪些站点，
    // 取景飞行那 1.7 秒里它们是跟着走的，而不是飞完才「啪」地冒出来。
    ui.buildRouteBubbles(route, stops || []);
    if (stops && stops.length) {
      // 只看这条行迹上的站点。
      // 不聚焦的话，79 根光柱和行迹线全叠在一起，路线走向完全看不出来 ——
      // 这正是「一片，看不清」的成因。
      state.routeFocus = new Set(stops.map((s) => s.siteId));
      applyVisibility();
      ui.toast(`${route.name}行迹：${stops.length} 站（${state.earth ? '地球' : state.flat ? '平面' : '地图'}已只显示这些站点）`);
      frameRoute(stops);
    }
  },
  onClearRoute: () => {
    state.routeFocus = null;
    state.activeRoute = null;
    effects.clearRoute();
    globe.clearRoute();
    ui.clearRouteBubbles();
    applyVisibility();
    // 行迹模式会把底部诗词条收起来；退出后若右栏还在展示某地区介绍，
    // 就把它一并带回来 —— 否则用户会以为「刚才的诗词列表不见了」。
    if (ui.currentRegion()) refreshRegionPanel({ showBar: true });
  },
  onPanelChange: () => { /* 抽屉开合只影响界面占位，不改动相机，避免把用户正在看的画面拉走 */ },
  /**
   * 「地图全亮、等用户点省份作答」—— 只有看图识诗需要。
   *
   * 注意它**不等于**「练习卡打开了」：补全诗句与飞花令也会开卡，但地图照旧按筛选显示，
   * ui 那边是拿 onQuizMode(false) 来开这两种题的。早先这里顺手把 body.quiz-open 也
   * 挂在同一个参数上，于是这两种题型练习卡开着却没有 quiz-open ——
   * HUD 不隐藏（实测被卡片压 17.6k px²）、侧栏不让位，还会把刚收起的诗词条又拉回来
   * （卡片与诗词条重叠 95k px²，整条诗词条被盖住）。两者现已拆开，见 onQuizCard。
   */
  onQuizMode: (on) => {
    state.quizMode = on;
    applyVisibility();
  },
  /**
   * 「练习卡开 / 关」—— 三种题型都会走到。
   *
   * 卡片是通栏浮层，会盖住右下角 HUD 与两侧栏的底部，所以这里要：
   *   1. 用 body.quiz-open 让 HUD 退场、两栏竖向让位（CSS 见 .quiz-card 与 body.quiz-open）
   *   2. 重新同步抽屉开关的位置 —— 让位会改面板的实际高度与偏移
   *   3. 退出练习时，若右栏还在展示某地区介绍，把诗词条带回来
   *      （进练习时 startQuiz 会先 hideRegionBar，不还回去用户会以为列表丢了）
   */
  onQuizCard: (on) => {
    document.body.classList.toggle('quiz-open', on);
    ui.syncPanelToggles();
    if (!on && ui.currentRegion()) refreshRegionPanel({ showBar: true });
  },
  onQuizFeedback: (ok, siteId) => {
    if (ok && siteId) { selectSite(siteId); }
    else if (!ok && siteId) { const b = effects.beacons.get(siteId); if (b) { flyCamera(b.group.position.clone().add(new THREE.Vector3(0, 12, 12)), b.group.position.clone(), 1.1); } }
  },
});

/* ================= 底栏按钮 ================= */
function bindBars() {
  document.querySelectorAll('#viewGroup button').forEach((b) => {
    b.onclick = () => {
      const v = b.dataset.view;
      if (v === 'spin') {
        controls.autoRotate = !controls.autoRotate;
        b.classList.toggle('on', controls.autoRotate);
        ui.toast(controls.autoRotate ? '自动旋转已开启' : '自动旋转已关闭');
        return;
      }
      // 2D 平面与地球是两个互斥的开关，点的是同一个就退出回 3D。
      // 二者都走 setViewMode —— 三个视图状态的唯一入口（见其注释）。
      if (v === 'earth') { setViewMode(state.earth ? '3d' : 'earth'); return; }
      if (v === 'flat') { setViewMode(state.flat ? '3d' : 'flat'); return; }
      // 点其它视角按钮时自动退出 2D / 地球，但不在这里飞相机（下面会 applyView）
      setViewMode('3d', { noView: true, quiet: true });
      applyView(VIEW[v]);
      document.querySelectorAll('#viewGroup button').forEach((x) => {
        if (x.dataset.view === 'flat' || x.dataset.view === 'earth') return;
        x.classList.toggle('active', x === b);
      });
    };
  });

  document.querySelectorAll('#layerGroup button').forEach((b) => {
    b.onclick = () => {
      const key = b.dataset.layer;
      if (key === 'voice') {
        state.voice = !state.voice;
        b.classList.toggle('on', state.voice);
        if (!state.voice) ui.stopSpeak();
        ui.toast(state.voice ? '朗读已开启（选中诗境时自动朗读）' : '朗读已关闭');
        return;
      }
      state.layers[key] = !state.layers[key];
      b.classList.toggle('on', state.layers[key]);
      if (key === 'rivers') rivers.visible = state.layers.rivers;
      if (key === 'clouds' && effects.cloudGroup) effects.cloudGroup.visible = state.layers.clouds;
      if (key === 'labels') document.getElementById('labelLayer').style.display = state.layers.labels ? '' : 'none';
    };
  });

  document.getElementById('btnTour').onclick = () => {
    tour.playing ? stopTour() : startTour();
  };
  document.getElementById('tourScope').onchange = (e) => {
    tour.scope = e.target.value;
    tour.list = scopeList(tour.scope);
    ui.toast(`巡游范围：${e.target.selectedOptions[0].textContent}（${tour.list.length} 处）`);
    if (tour.playing) { stopTour(); startTour(); }
  };
}

/* ================= 键盘 ================= */
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.code === 'Space') { e.preventDefault(); tour.playing ? stopTour() : startTour(); }
  if (e.key === 'Escape') {
    // 由内向外逐层关闭：一次 Esc 只收掉最上面那一层，避免把用户想保留的内容一起关掉
    if (ui.isPoemModalOpen()) { ui.closePoemModal(); return; }
    if (ui.isRegionBarOpen()) { ui.hideRegionBar(); return; }
    // 窄屏的抽屉盖在地图上，是「当前这一层」，Esc 先收它。
    // 宽屏下两栏是并排的常驻工具、不是弹层，Esc 不该把它们收起来。
    if (ui.isNarrow() && ui.closeAnyDrawer()) return;
    if (!document.getElementById('quizCard').classList.contains('hidden')) { ui.closeQuiz(); return; }
    if (ui.isRouteMode()) { ui.exitRouteMode(); return; }
    // 地球模式是「换了一层内容」，把它放在最外层：上面那些弹层 / 抽屉 / 面板
    // 都先关，最后再退出地球模式 —— 否则按一次 Esc 会连着丢掉用户正在看的东西。
    if (state.earth) { setViewMode('3d'); return; }
  }
  if (state.earth) {
    // 地球模式下 r 回到默认太空视角（t 不适用：地球没有「俯视」这个预设）
    if (e.key === 'r' || e.key === 'R') {
      flyCamera(EARTH_DIR.clone().multiplyScalar(earthDistNow), new THREE.Vector3(0, 0, 0), 1.2);
    }
  } else if (state.flat) {
    // 2D 下只有俯视这一个预设：r / t 都回俯视
    if (e.key === 'r' || e.key === 'R' || e.key === 't' || e.key === 'T') applyView(VIEW.flat);
  } else {
    if (e.key === 'r' || e.key === 'R') applyView(VIEW.reset);
    if (e.key === 't' || e.key === 'T') applyView(VIEW.top);
  }
  if (e.key === 'ArrowRight') stepSite(1);
  if (e.key === 'ArrowLeft') stepSite(-1);
  if (e.key === '1') document.querySelector('[data-mode="explore"]').click();
  if (e.key === '2') document.querySelector('[data-mode="route"]').click();
  if (e.key === '3') document.querySelector('[data-mode="class"]').click();
});

/* ================= 悬停高亮动画 ================= */
function updateProvinces(dt) {
  map.provinces.forEach((m) => {
    const u = m.userData;
    // 2D 平面模式下不做抬升，否则地形一被「点起来」就破坏了平面观感
    const targetLift = (u.hovered && !state.flat) ? 0.22 : 0;
    u.lift += (targetLift - u.lift) * Math.min(1, dt * 9);
    m.position.y = state.flat ? 0 : u.lift;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    const top = mats[0];
    if (u.hovered) {
      top.color.lerp(new THREE.Color('#ffe0a0'), Math.min(1, dt * 8));
      top.emissive.lerp(new THREE.Color('#8a6a20'), Math.min(1, dt * 8));
      top.emissiveIntensity += (1.4 - top.emissiveIntensity) * Math.min(1, dt * 8);
    } else {
      top.color.lerp(u.baseColor, Math.min(1, dt * 6));
      top.emissive.lerp(u.baseColor.clone().multiplyScalar(0.22), Math.min(1, dt * 6));
      top.emissiveIntensity += (0.55 - top.emissiveIntensity) * Math.min(1, dt * 6);
    }
  });
}

/* ================= 标注投影（带防重叠排版） ================= */
const tmpV = new THREE.Vector3();
const placed = [];   // 已占位的屏幕矩形

function rectHit(r) {
  for (let i = 0; i < placed.length; i++) {
    const q = placed[i];
    if (r.x < q.x2 && r.x2 > q.x && r.y < q.y2 && r.y2 > q.y) return true;
  }
  return false;
}

function updateLabels() {
  if (!state.layers.labels) return;
  const w = window.innerWidth, h = window.innerHeight;
  const entries = [];
  placed.length = 0;

  const list = [];
  SITES.forEach((s) => {
    const b = effects.beacons.get(s.id);
    if (!b || !b.visible) return;
    tmpV.copy(b.group.position);
    list.push({ site: s, b, dist: camera.position.distanceTo(tmpV) });
  });

  // 优先级：选中 > 悬停 > 距离近
  list.sort((a, b) => {
    const pa = a.site.id === selectedId ? -1000 : a.site.id === hoveredId ? -900 : a.dist;
    const pb = b.site.id === selectedId ? -1000 : b.site.id === hoveredId ? -900 : b.dist;
    return pa - pb;
  });

  let shown = 0;
  const MAX = 22;
  /* 3D 下标注挂在光柱顶端；2D 下光柱已收起，改为贴在落点圆点旁边。
     2D 要「圆点 + 旁边一行地名」，所以横向再让开 14px ——
     地名压在圆点上会把那个点整个盖掉，用户就看不出「地点在哪」了。 */
  const side = state.flat;
  const LABEL_Y = state.flat ? 0.55 : 1.95;
  const SIDE_DX = 14;
  list.forEach((x) => {
    tmpV.copy(x.b.group.position);
    tmpV.y += LABEL_Y;
    const p = tmpV.clone().project(camera);
    const onScreen = p.z < 1 && p.x > -1.05 && p.x < 1.05 && p.y > -1.05 && p.y < 1.05;
    const sx = (p.x * 0.5 + 0.5) * w + (side ? SIDE_DX : 0);
    const sy = (-p.y * 0.5 + 0.5) * h;

    const isFocus = x.site.id === selectedId || x.site.id === hoveredId;
    const halfW = (x.site.name.length * 13 + 20) / 2;
    // 2D 下标签的锚点是「左缘中点」（CSS .map-label.side），矩形要按左对齐算
    const rect = side
      ? { x: sx, x2: sx + halfW * 2, y: sy - 11, y2: sy + 11 }
      : { x: sx - halfW, x2: sx + halfW, y: sy - 11, y2: sy + 11 };

    let visible = onScreen && x.dist < 130;
    if (visible && !isFocus) {
      if (shown >= MAX || rectHit(rect)) visible = false;
      else { placed.push(rect); shown += 1; }
    } else if (visible && isFocus) {
      placed.push(rect);
    }
    entries.push({
      site: x.site, x: sx, y: sy, visible, side,
      selected: x.site.id === selectedId,
      dim: false,
    });
  });
  ui.syncLabels(entries);
}

/**
 * 行迹气泡：把每处行迹地点的三维坐标投影成屏幕坐标，交给 ui 定位。
 *
 * 与 updateLabels 分开写，是因为两者要回答的问题不同：标注是「这个点叫什么」，
 * 气泡是「这位诗人在这里写了什么」。混在一起，标注的避让逻辑（超出 22 个就不再显示）
 * 会把气泡一起裁掉，而气泡的卡片高度又会把标注全挤走。
 */
function updateRouteBubbles() {
  const targets = ui.bubbleTargets();
  if (!targets.length) return;
  // 气泡属于「地图上的文字标注」，跟「地名」开关走同一条规则 ——
  // 老师想要一张干净的地图时，有一处能关掉它们。
  if (!state.layers.labels) { ui.updateRouteBubbles([]); return; }

  const w = window.innerWidth, h = window.innerHeight;
  const entries = targets.map((t) => {
    let v = null;
    if (state.earth) {
      /* 地球模式下锚点在球面上，必须另算：
         1) 用球面可见性判据（P·C > |P|²）排除背面 —— 引线不该指到球后面去；
         2) 沿法线再抬一点，让引线落在序号牌上而不是穿进球里。 */
      const m = globe.markerOf(t.siteId);
      if (!m || !m.sprite.visible) return { x: 0, y: 0, visible: false };
      const p = m.sprite.position;
      if (p.dot(camera.position) <= p.lengthSq()) return { x: 0, y: 0, visible: false };
      v = p.clone().multiplyScalar(1.015);
    } else {
      const b = effects.beacons.get(t.siteId);
      if (!b || !b.visible) return { x: 0, y: 0, visible: false };
      /* 锚点取光柱顶端序号牌再往上一点：正好是气泡该「指」的那个位置。
         抬升量必须乘上该站点当前的缩放补偿 —— 序号牌的高度是 2.05·comp，
         而 comp 随缩放变化（行迹取景时约 0.68）。写成固定世界高度的话，
         光柱缩了、锚点没缩，气泡会整体飘到序号牌上方近 90px 并挤在一起
         （实测 e2e-region「气泡之间互不重叠」因此报 5 对重叠）。
         2.36 = 序号牌中心 2.05 + 半高 0.31，是 comp = 1 时的原始值。
         2D 下序号牌就贴在圆点上（FLAT_BADGE_LIFT = 0.12），锚点自然也要落到圆点处。 */
      const comp = b.group.scale.y || 1;
      v = b.group.position.clone();
      v.y += (state.flat ? 0.30 : 2.36) * comp;
    }
    const p = v.project(camera);
    const onScreen = p.z < 1 && p.x > -1.05 && p.x < 1.05 && p.y > -1.05 && p.y < 1.05;
    return {
      x: (p.x * 0.5 + 0.5) * w,
      y: (-p.y * 0.5 + 0.5) * h,
      visible: onScreen,
    };
  });
  ui.updateRouteBubbles(entries);
}

/* ================= 主循环 ================= */
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, clock.getDelta());
  const t = clock.elapsedTime;

  updateTween(dt);
  controls.update();
  // 两种模式驱动的东西完全不同：地球模式下地图那一整套都不可见，
  // 再跑一遍它们的动画既浪费、又会把隐藏对象的尺寸算歪（切回来时会跳一下）。
  if (state.earth) {
    updateEarthLights();
    globe.update(camera);
    globe.updateRoute(camera);
    // 行迹卡片在地球模式下也要跟着走：卡片是停靠在左右两侧的，
    // 不会盖住球面，所以没有理由把它关掉 —— 关了反而会让用户以为「地球上没有诗」。
    updateRouteBubbles();
  } else {
    updateProvinces(dt);
    effects.update(dt, camera, camera.position.distanceTo(controls.target));
    ocean.mat.uniforms.uTime.value = t;
    map.jdGroup.children.forEach((m) => { if (m.material[0]) m.material[0].emissiveIntensity = 0.6 + 0.25 * Math.sin(t * 1.6); });
    updateLabels();
    updateRouteBubbles();
  }
  // 缩放会改变 HUD 读数精度：鼠标不动、只滚轮缩放时，也要重刷一次读数。
  const hd = hudDecimals();
  if (hd !== hudDecimalsCache) {
    hudDecimalsCache = hd;
    if (hudLL) ui.updateHud(hudLL[0], hudLL[1], hd);
  }
  stars.rotation.y += dt * 0.006;
  composer.render();
}

/* ================= 尺寸 ================= */
// 用户一旦手动拖拽/缩放，就不再在 resize 时自动重新取景
controls.addEventListener('start', () => { userAdjusted = true; });

window.addEventListener('resize', () => {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
  bloom.setSize(w, h);
  // 气泡在窄屏会收窄，尺寸一变缓存的宽高就过期了 —— 不重量一遍，
  // 防重叠会按旧尺寸排，出现「看起来没重叠其实压住了」。
  ui.measureBubbles();
  // 取景距离依赖视口与界面占位，尺寸变了就重新取景。
  // 地球模式不适用：那边是「从太空看球」，重新套用版图取景会把镜头拉回地图。
  if (!state.earth && !userAdjusted && !tween && !selectedId) applyView(VIEW[activeView], true);
});

/* ================= 启动 ================= */
function boot() {
  stage('装配界面与题库', 84);
  ui.init();
  bindBars();
  applyVisibility();
  applyView(VIEW.reset, true);
  // 标记缩放补偿的基准：全局取「相机到 target 的距离」，逐站点取「该站点到相机的距离」。
  // 逐站点那份才是光柱/光圈用的（标记的屏幕尺寸只取决于它自己到相机的距离）。
  // 只在这里定一次，不跟着 applyView 变 —— 否则切到「2D 平面」等预设时
  // 基准一变，标记大小会莫名其妙地跳一下。
  effects.setMarkerRef(camera.position.distanceTo(controls.target));
  effects.captureMarkerRefs(camera);
  ui.syncChips();
  ui.updateStatStrip();
  animate();
  stage('就绪', 100);

  // 先挂上调试钩子再撤加载页：看门狗以 window.__app 判断「是否已启动」，
  // 撤页与挂钩之间哪怕只差一帧，也可能被误判成启动超时。
  window.__app = {
    scene, camera, controls, renderer, composer, map, effects, ui, state, SITES,
    lonLatToWorld, provinceAt, PROVINCE_SITES,
    pickBeacon, pickBeaconByScreen, selectSite, focusProvince, setFlatMode,
    applyView, VIEW, raycaster, pointer,
    globe, setEarthMode, pickGlobe, lonLatFromDir,
    setViewMode, syncViewButtons, rebuildRoute, frameRoute, buildRouteInView,
  };

  setTimeout(() => {
    const l = document.getElementById('loader');
    if (l) {
      l.classList.add('done');
      setTimeout(() => l.remove(), 800);
    }
    ui.toast(`已加载 ${SITES.length} 处诗境 · 点击光柱读诗，点击省份看该地区诗词`);
  }, 380);
}

try {
  boot();
} catch (err) {
  console.error(err);
  if (window.__loadError) window.__loadError(err && err.message ? err.message : String(err), 'runtime');
}
