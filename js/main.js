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
import { Effects } from './effects.js';
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
  flat: false,          // 2D 平面模式
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
  controls.minDistance = Math.min(5, f.dist * 0.35);
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

function setFlatMode(on, opts = {}) {
  if (state.flat === on) return;
  state.flat = on;
  document.body.classList.toggle('flat-mode', on);

  if (effects.cloudGroup) effects.cloudGroup.visible = on ? false : state.layers.clouds;
  stars.visible = !on;
  bloom.enabled = !on;
  effects.setFlatMode(on);

  // 2D 下锁定旋转：能平移缩放、不能转到斜视角，才像一张平面地图
  controls.enableRotate = !on;
  if (on) {
    controls.autoRotate = false;
    document.querySelector('[data-view="spin"]').classList.remove('on');
    map.provinces.forEach((m) => { m.userData.hovered = false; m.position.y = 0; });
    lastView3D = activeView === 'flat' ? 'reset' : activeView;
  }
  document.querySelector('[data-view="flat"]').classList.toggle('on', on);

  // noView：调用方自己接着会 applyView（比如从 2D 直接点「俯视」），
  // 此时不要在这里多飞一次相机，否则两次补间会互相打架。
  if (!opts.noView) applyView(on ? VIEW.flat : (VIEW[lastView3D] || VIEW.reset));
  if (!opts.quiet) ui.toast(on ? '已切换到 2D 平面地图（锁定旋转）' : '已回到 3D 地势地图');
}

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
  ui.renderDetail(site, { poemId: opts.poemId, keyword: opts.keyword });

  if (opts.fly !== false) {
    const b = effects.beacons.get(id);
    if (b) {
      const p = b.group.position.clone();
      const dir = new THREE.Vector3(0, 0.80, 0.95).normalize();
      const dist = 11.5;
      flyCamera(p.clone().add(dir.multiplyScalar(dist)).setY(p.y + dist * 0.62), p.clone().setY(p.y + 0.3), 1.35);
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
    v.y += 0.9;
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
      v.y += 0.9;
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

renderer.domElement.addEventListener('pointerdown', (e) => { downPos = { x: e.clientX, y: e.clientY }; });

renderer.domElement.addEventListener('pointermove', (e) => {
  setPointer(e);
  raycaster.setFromCamera(pointer, camera);

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
    ui.updateHud(ll[0], ll[1]);
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

/* ================= UI 上下文 ================= */
const ui = new UI({
  sites: SITES,
  state,
  onFilterChange: () => { applyVisibility(); },
  onSelectSite: (id, opts) => selectSite(id, opts),
  onStep: (d) => stepSite(d),
  onHoverSite: (id) => { hoveredId = id; effects.setSelected(id || selectedId); },
  onBuildRoute: (route) => {
    const stops = effects.buildRoute(route);
    // 先建气泡再取景：气泡一建出来 ui 就知道每帧要投影哪些站点，
    // 取景飞行那 1.7 秒里它们是跟着走的，而不是飞完才「啪」地冒出来。
    ui.buildRouteBubbles(route, stops || []);
    if (stops && stops.length) {
      // 只看这条行迹上的站点。
      // 不聚焦的话，79 根光柱和行迹线全叠在一起，路线走向完全看不出来 ——
      // 这正是「一片，看不清」的成因。
      state.routeFocus = new Set(stops.map((s) => s.siteId));
      applyVisibility();
      ui.toast(`${route.name}行迹：${stops.length} 站（地图已只显示这些站点）`);

      const pts = stops.map((s) => s.site.group.position.clone());
      const mid = pts.reduce((a, b) => a.add(b), new THREE.Vector3()).multiplyScalar(1 / pts.length);
      const box = new THREE.Box3().setFromPoints(pts);
      const size = box.getSize(new THREE.Vector3());
      const d = Math.max(11.5, Math.max(size.x, size.z) * 2.0 + 8);
      const dir = new THREE.Vector3(0, 0.86, 0.86).normalize();
      flyCamera(mid.clone().add(dir.multiplyScalar(d)), mid, 1.7);
    }
  },
  onClearRoute: () => {
    state.routeFocus = null;
    effects.clearRoute();
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
      if (v === 'flat') {
        setFlatMode(!state.flat);
        document.querySelectorAll('#viewGroup button')
          .forEach((x) => x.classList.toggle('active', x === b && state.flat));
        return;
      }
      // 点其它视角按钮时自动退出 2D，但不在这里飞相机（下面会 applyView）
      if (state.flat) setFlatMode(false, { noView: true, quiet: true });
      applyView(VIEW[v]);
      document.querySelectorAll('#viewGroup button').forEach((x) => x.classList.toggle('active', x === b));
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
  }
  if (e.key === 'r' || e.key === 'R') applyView(VIEW.reset);
  if (e.key === 't' || e.key === 'T') applyView(VIEW.top);
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
  // 3D 下标注挂在光柱顶端；2D 下光柱已收起，改为贴在落点圆点上方
  const LABEL_Y = state.flat ? 0.55 : 1.95;
  list.forEach((x) => {
    tmpV.copy(x.b.group.position);
    tmpV.y += LABEL_Y;
    const p = tmpV.clone().project(camera);
    const onScreen = p.z < 1 && p.x > -1.05 && p.x < 1.05 && p.y > -1.05 && p.y < 1.05;
    const sx = (p.x * 0.5 + 0.5) * w;
    const sy = (-p.y * 0.5 + 0.5) * h;

    const isFocus = x.site.id === selectedId || x.site.id === hoveredId;
    const halfW = (x.site.name.length * 13 + 20) / 2;
    const rect = { x: sx - halfW, x2: sx + halfW, y: sy - 11, y2: sy + 11 };

    let visible = onScreen && x.dist < 130;
    if (visible && !isFocus) {
      if (shown >= MAX || rectHit(rect)) visible = false;
      else { placed.push(rect); shown += 1; }
    } else if (visible && isFocus) {
      placed.push(rect);
    }
    entries.push({
      site: x.site, x: sx, y: sy, visible,
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
  // 锚点取光柱顶端序号牌再往上一点：正好是气泡该「指」的那个位置
  const ANCHOR_Y = state.flat ? 0.9 : 2.35;
  const entries = targets.map((t) => {
    const b = effects.beacons.get(t.siteId);
    if (!b || !b.visible) return { x: 0, y: 0, visible: false };
    tmpV.copy(b.group.position);
    tmpV.y += ANCHOR_Y;
    const p = tmpV.clone().project(camera);
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
  updateProvinces(dt);
  effects.update(dt, camera);
  ocean.mat.uniforms.uTime.value = t;
  stars.rotation.y += dt * 0.006;
  map.jdGroup.children.forEach((m) => { if (m.material[0]) m.material[0].emissiveIntensity = 0.6 + 0.25 * Math.sin(t * 1.6); });
  updateLabels();
  updateRouteBubbles();
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
  // 取景距离依赖视口与界面占位，尺寸变了就重新取景
  if (!userAdjusted && !tween && !selectedId) applyView(VIEW[activeView], true);
});

/* ================= 启动 ================= */
function boot() {
  stage('装配界面与题库', 84);
  ui.init();
  bindBars();
  applyVisibility();
  applyView(VIEW.reset, true);
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
