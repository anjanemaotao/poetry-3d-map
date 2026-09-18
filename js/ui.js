// 界面控制层：筛选、列表、诗词详情、标注、检索、课堂练习、行迹面板
import {
  SITES, SITE_MAP, POEMS, DYNASTIES, THEMES, REGIONS, ROUTES, FEIHUA_KEYS, ERA_MAP, STATS,
  buildGeoQuiz, buildFillQuiz, buildFeihua, linesWithChar, search,
} from './data/poetry.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const ERA_HEX = {
  xy: '#b9a6ff', hw: '#7ec8ff', jn: '#6fe8cf',
  tang: '#ffc65e', song: '#ff8f76', yh: '#d3a6ff',
  read: '#8fb6d6',
};

export class UI {
  constructor(ctx) {
    this.ctx = ctx;
    this.visited = new Set();
    this.poemState = new Map();   // siteId -> {index, vertical, trans}
    this.quiz = null;
    this.tour = { playing: false, index: 0, total: 0 };
    this.labelEls = new Map();
    this.bubbleEls = new Map();      // 行迹气泡：气泡键 -> 元素
    this._bubbleStops = [];          // 与气泡一一对应的行迹站点（顺序固定，供每帧投影）
    this._bubbleSizes = new Map();   // 气泡键 -> {w,h}，量一次缓存，别每帧读 offsetHeight
    this.bubbleVisible = true;       // 「气泡」开关状态：行迹面板里的按钮控制
    this._dock = null;               // 气泡停靠区缓存，见 invalidateDock / dockRect
    this._dropdowns = [];            // 所有「按钮 + 浮层」下拉的句柄，见 bindDropdown
  }

  /* ================= 初始化 ================= */
  init() {
    this.buildChips();
    this.buildSiteList();
    this.bindSearch();
    this.bindPanels();
    this.bindModes();
    this.bindQuiz();
    this.bindRoutes();
    /* 诗人下拉：bindRoutes 已经把 16 位诗人塞进 #routePoetMenu，
       这里挂按钮 / 浮层 / 外部点击 / Esc —— 选项点击的副作用
       （toggle .on + renderRouteDetail + onBuildRoute）由 bindRoutes 的 onclick 自己处理，
       bindDropdown 只负责关浮层与同步按钮 label。 */
    this.bindDropdown('#routePoetDD', { labelFrom: '.rn' });
    this.bindRegionBar();
    this.bindBubbleToggle();
    this.updateStatStrip();
  }

  buildChips() {
    const { state } = this.ctx;
    const dc = $('#dynastyChips');
    dc.innerHTML = '';
    DYNASTIES.forEach((d) => {
      const b = document.createElement('button');
      b.dataset.era = d.id;
      b.textContent = d.name;
      b.title = `${d.name}（${d.note}）`;
      b.onclick = () => {
        state.eras.has(d.id) ? state.eras.delete(d.id) : state.eras.add(d.id);
        this.syncChips();
        this.ctx.onFilterChange();
      };
      dc.appendChild(b);
    });

    const tc = $('#themeChips');
    tc.innerHTML = '';
    THEMES.forEach((t) => {
      const b = document.createElement('button');
      b.textContent = t;
      b.onclick = () => {
        state.themes.has(t) ? state.themes.delete(t) : state.themes.add(t);
        this.syncChips();
        this.ctx.onFilterChange();
      };
      tc.appendChild(b);
    });

    const rc = $('#regionChips');
    rc.innerHTML = '';
    REGIONS.forEach((r) => {
      const b = document.createElement('button');
      b.textContent = r.name.split(' · ')[0];
      b.title = r.desc;
      b.onclick = () => {
        state.regions.has(r.id) ? state.regions.delete(r.id) : state.regions.add(r.id);
        this.syncChips();
        this.ctx.onFilterChange();
      };
      rc.appendChild(b);
    });

    $('#btnResetFilter').onclick = () => {
      state.eras.clear(); state.themes.clear(); state.regions.clear();
      this.syncChips(); this.ctx.onFilterChange();
      this.toast('已重置筛选');
    };
    $('#btnAllEras').onclick = () => {
      const all = DYNASTIES.every((d) => state.eras.has(d.id));
      state.eras.clear();
      if (!all) DYNASTIES.forEach((d) => state.eras.add(d.id));
      this.syncChips(); this.ctx.onFilterChange();
    };
  }

  syncChips() {
    const { state } = this.ctx;
    $$('#dynastyChips button').forEach((b) => b.classList.toggle('on', state.eras.has(b.dataset.era)));
    $$('#themeChips button').forEach((b) => b.classList.toggle('on', state.themes.has(b.textContent)));
    $$('#regionChips button').forEach((b, i) => b.classList.toggle('on', state.regions.has(REGIONS[i].id)));
    const eras = state.eras.size ? DYNASTIES.filter((d) => state.eras.has(d.id)).map((d) => d.name).join('、') : '全部';
    $('#hudEra').textContent = eras.length > 12 ? eras.slice(0, 12) + '…' : eras;
  }

  /**
   * 让一个非 button 元素能被键盘操作。
   *
   * 左栏诗境列表、行迹列表、行迹站点、搜索结果这四处原先都是 div + onclick ——
   * 鼠标能用，键盘完全够不到：div 不在 Tab 顺序里，也没有「按下回车」这回事。
   * 这里补三样：tabindex 进 Tab 顺序、role 告诉读屏「这是个可点的东西」、
   * Enter / Space 触发。
   *
   * 没有把它们改成 <button>：这几个类身上挂着大量布局样式（flex 行、margin-left:auto
   * 把副标题推到右端、多行截断），换成 button 会连带吃到 UA 默认的背景色、居中对齐、
   * 字号与内边距，回归面比补三个属性大得多，收益却一样。
   *
   * Space 必须 stopPropagation：全局快捷键把空格当成「开始/暂停巡游」，
   * 而那个处理器只排除了 INPUT / SELECT，div 上的空格会一路冒泡上去，
   * 变成「按空格选中诗境」的同时顺手把巡游打开了。
   *
   * `label` 可选：给元素写一条可访问名。
   *
   * 为什么要写，值得说清楚 —— **不是**因为「不写的话文本太长」。
   * 实测四类列表项的可见文本都不长（.site-row 只有「碣石秦皇岛」5 个字），
   * 问题在另一侧：**可见文本相对完整信息是「有损」的**，
   * 那些被排版和图标承担的信息，读屏拿不到。
   *
   *   .site-row    可见「碣石秦皇岛」  —— 省份被 `sub.split('·')` 截掉了，只剩城市；
   *                                      而且「诗境」这个类别是列表标题给的，
   *                                      读屏聚焦到某一行时不会回头念标题。
   *                → 名字补成「诗境 碣石，河北·秦皇岛」
   *   .route-item  可见「李白 仗剑去国，辞亲远游行迹 9 站」—— 几段文字直接相连，
   *                没有停顿，听上去像「辞亲远游行迹」是一个词。
   *                → 名字补成「李白，仗剑去国，辞亲远游，行迹 9 站」
   *
   * 所以 aria-label 在这里的作用是「补回视觉上由排版/省略承担的信息」，
   * 不是给长文本做摘要。照后一种理解去写，很容易写出比原文更短、反而丢信息的名字。
   */
  keyboardActivate(el, handler, label) {
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    if (label) el.setAttribute('aria-label', label);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        e.stopPropagation();
        handler(e);
      }
    });
  }

  buildSiteList() {
    const box = $('#siteList');
    box.innerHTML = '';
    this.ctx.sites.forEach((s) => {
      const row = document.createElement('div');
      row.className = 'site-row';
      row.dataset.id = s.id;
      row.innerHTML = `<span class="dot" style="background:${ERA_HEX[s.era]}"></span>
        <span class="rn">${s.name}</span><span class="rs">${s.sub.split('·').slice(-1)[0]}</span>`;
      const activate = () => this.ctx.onSelectSite(s.id, { fly: true });
      row.onclick = activate;
      this.keyboardActivate(row, activate, `诗境 ${s.name}，${s.sub}`);
      row.onmouseenter = () => this.ctx.onHoverSite(s.id);
      row.onmouseleave = () => this.ctx.onHoverSite(null);
      box.appendChild(row);
    });
  }

  refreshList(visibleIds) {
    const set = new Set(visibleIds);
    $$('#siteList .site-row').forEach((r) => {
      const on = set.has(r.dataset.id);
      r.style.display = on ? '' : 'none';
      r.classList.toggle('visited', this.visited.has(r.dataset.id));
    });
    $('#siteCount').textContent = visibleIds.length;
  }

  updateStatStrip() {
    $('#statStrip').innerHTML =
      `<span>诗境 <b>${STATS.sites}</b></span><span>诗篇 <b>${STATS.poems}</b></span>` +
      `<span>诗人 <b>${STATS.authors}</b></span><span>诗句 <b>${STATS.lines}</b></span>`;
  }

  /* ================= 检索 ================= */
  bindSearch() {
    const input = $('#searchInput');
    const box = $('#searchResults');
    const clear = $('#searchClear');
    let timer = null;

    /**
     * 统一的关闭入口。
     * 关键：必须同时取消尚未触发的防抖定时器——否则「输入后立刻点别处」时，
     * 框会先关掉、160ms 后又被防抖回调重新弹出来，表现为「结果框关不掉」。
     */
    const hide = () => { clearTimeout(timer); timer = null; box.classList.add('hidden'); };

    const run = () => {
      timer = null;
      const k = input.value.trim();
      clear.classList.toggle('show', !!k);
      if (!k) { box.classList.add('hidden'); return; }
      const res = search(k);
      box.innerHTML = '';
      if (!res.length) {
        box.innerHTML = `<div class="sr-empty">未找到与「${k}」相关的内容</div>`;
      } else {
        res.forEach((r) => {
          const d = document.createElement('div');
          d.className = 'sr-item';
          const kind = r.kind === 'site' ? '诗境' : r.kind === 'poem' ? '诗篇' : '诗句';
          d.innerHTML = `<span class="sr-k">${kind}</span><span class="sr-t">${r.title}</span><span class="sr-s">${r.sub || ''}</span>`;
          const activate = () => {
            hide();
            this.ctx.onSelectSite(r.id, { fly: true, poemId: r.poemId, keyword: k });
          };
          d.onclick = activate;
          this.keyboardActivate(d, activate, `${kind}《${r.title}》${r.sub ? `，${r.sub}` : ''}`);
          // 焦点在结果项上按 Esc：关框并把焦点交回输入框。
          // 不还回去的话，框一 display:none，焦点就掉到 <body>，下次 Tab 从页面开头重来。
          d.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { e.stopPropagation(); hide(); input.focus(); }
          });
          box.appendChild(d);
        });
      }
      box.classList.remove('hidden');
    };

    input.oninput = () => { clearTimeout(timer); timer = setTimeout(run, 160); };
    input.onkeydown = (e) => {
      if (e.key === 'Enter') {
        clearTimeout(timer);
        // 回车 = 选中第一条结果并跳过去。若结果框还开着就直接用现成的第一条，
        // 否则（如刚输入完防抖未触发）先跑一次搜索再取。
        // 注意不能用 run() 了事：run() 结尾会把结果框重新显示出来，等于回车不生效。
        const first = box.querySelector('.sr-item');
        if (first) first.onclick();
        else run();
      }
      // ↑ / ↓ 在结果项之间移动焦点 —— 结果项现在是可以聚焦的，
      // 但没有这条的话，从输入框只能一路 Tab 过去，中间会穿过整个顶栏与左栏。
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const items = $$('#searchResults .sr-item');
        if (!items.length) return;
        e.preventDefault();
        const cur = items.indexOf(document.activeElement);
        const down = e.key === 'ArrowDown';
        const next = cur < 0
          ? (down ? 0 : items.length - 1)
          : (down ? Math.min(cur + 1, items.length - 1) : Math.max(cur - 1, 0));
        items[next].focus();
      }
      if (e.key === 'Escape') { hide(); input.blur(); }
    };
    clear.onclick = () => { input.value = ''; clear.classList.remove('show'); hide(); };

    // 用 pointerdown 而非 click：触发更早，且在地图上拖拽旋转时同样能关掉。
    // 放在捕获阶段，保证先于元素自身的处理逻辑执行。
    document.addEventListener('pointerdown', (e) => {
      const t = e.target;
      if (t && t.closest && t.closest('.searchbox')) return;
      hide();
    }, true);

    // 焦点已不在输入框时，Esc 也要能关掉结果框
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !box.classList.contains('hidden')) hide();
    });
  }

  /* ================= 面板 / 模式 ================= */
  /**
   * 抽屉开关。
   *
   * 开关按钮放在面板外面（见 index.html），位置由这里按面板实际宽度算出来，
   * 所以任何响应式断点都不用单独写媒体查询。
   * 收起状态用 body 上的 hide-left / hide-right 表达，与面板自身的 .collapsed 同步。
   *
   * 窄屏（<= 860）下两栏是覆盖式抽屉且**互斥**，见 setPanelHidden 与 applyNarrowMode。
   */
  bindPanels() {
    this.panels = { left: $('#leftPanel'), right: $('#rightPanel') };
    this._narrow = null;

    [['left', $('#toggleLeft')], ['right', $('#toggleRight')]].forEach(([key, btn]) => {
      btn.onclick = () => {
        // 无条件「点一下 = 收起」会在脏状态下把「收起」点成「展开」，
        // 所以先读当前状态再取反。
        const hidden = !document.body.classList.contains(this.hideClass(key));
        this.setPanelHidden(key, hidden);
      };
    });
    /* 行迹面板的开关。它不参与左右两栏那套「窄屏互斥」—— 行迹面板出现时
       #leftPanel 已经是 display:none，不存在两个抽屉同时铺在屏幕上的问题。 */
    const rb = $('#toggleRoute');
    if (rb) {
      rb.onclick = () => {
        const hidden = !document.body.classList.contains('hide-route');
        this.setRoutePanelHidden(hidden);
      };
    }

    window.addEventListener('resize', () => {
      this.applyNarrowMode();
      this.syncPanelToggles();
    });

    this.applyNarrowMode();
    this.syncPanelToggles();
  }

  hideClass(key) { return key === 'left' ? 'hide-left' : 'hide-right'; }

  isNarrow() { return document.body.classList.contains('narrow'); }

  /** 收起 / 展开某一侧抽屉。
   *
   * **这是唯一的入口** —— 开关按钮、自动展开（选中诗境 / 查看地区）、窄屏互斥全走这里。
   * 曾经 body 上的 hide-x 与面板上的 .collapsed 由三处各写一遍，加一处新逻辑就要
   * 记得三处都补；现在收敛成一个方法，两边永远同步。
   */
  setPanelHidden(key, hidden, opts = {}) {
    const cls = this.hideClass(key);
    const panel = this.panels[key];
    document.body.classList.toggle(cls, hidden);
    panel.classList.toggle('collapsed', hidden);
    // 收起的面板靠 visibility 移出 Tab 顺序（见 css），无障碍树也要跟着摘掉，
    // 否则读屏软件仍会念出屏幕外那一整栏筛选按钮。
    panel.setAttribute('aria-hidden', hidden ? 'true' : 'false');
    const btn = key === 'left' ? $('#toggleLeft') : $('#toggleRight');
    if (btn) {
      btn.setAttribute('aria-expanded', hidden ? 'false' : 'true');
      btn.querySelector('.pt-arrow').textContent =
        (key === 'left') === hidden ? '›' : '‹';
    }

    /* 窄屏互斥。
       窄屏下两栏是盖在地图上的抽屉，同时铺两块会互相盖住、谁也看不清，
       而且这正是「地图只剩 40px」的病根。展开一边就顺手收起另一边 ——
       用户点这一下的意图很明确（「我要看这个」），再让他自己收另一边是多余的一步。
       opts.keepOther 用于内部递归，防止两边互相收起形成死循环。 */
    if (hidden === false && this.isNarrow() && !opts.keepOther) {
      const other = key === 'left' ? 'right' : 'left';
      if (!document.body.classList.contains(this.hideClass(other))) {
        this.setPanelHidden(other, true, { keepOther: true, quiet: true });
      }
    }

    if (!opts.quiet) {
      this.syncPanelToggles();
      this.syncScrim();
      this.ctx.onPanelChange();
    }
  }

  /**
   * 收起 / 展开行迹面板（#routePanel）。
   *
   * 为什么不复用 setPanelHidden：那一套的 key 只有 left / right，而且它靠
   * `body.hide-left` 表达状态、`#leftPanel` / `#rightPanel` 两个固定元素承载。
   * 行迹面板是第三个独立元素，硬塞进去会让 `hideClass()` 变成三分支、还要给
   * `syncPanelToggles` 里那串 `key === 'left' ? ... : ...` 再补一条 ——
   * 与其把一个两态函数改成三态，不如单开一个，语义更清楚。
   *
   * **不能用 `.hidden`**：`isRouteMode()` 就是靠 `#routePanel 有没有 hidden 类`
   * 判断的，加 `.hidden` 会被当成「退出了行迹模式」，紧接着 Esc、模式按钮高亮、
   * 气泡清理全都跟着错乱。所以这里走 `.collapsed` + `body.hide-route`，
   * 与左右两栏一致：只影响绘制与位置，状态原封不动。
   */
  setRoutePanelHidden(hidden, opts = {}) {
    document.body.classList.toggle('hide-route', hidden);
    const panel = $('#routePanel');
    if (panel) {
      panel.classList.toggle('collapsed', hidden);
      /* 收起的面板靠 transform 移出屏幕，但它在无障碍树里仍然「在」——
         读屏软件会念出屏幕外那一整份行迹详情。与 setPanelHidden 同样处理。 */
      panel.setAttribute('aria-hidden', hidden ? 'true' : 'false');
    }
    const btn = $('#toggleRoute');
    if (btn) {
      btn.setAttribute('aria-expanded', hidden ? 'false' : 'true');
      btn.querySelector('.pt-arrow').textContent = hidden ? '›' : '‹';
    }
    if (!opts.quiet) {
      this.syncPanelToggles();
      this.syncScrim();
      this.invalidateDock();
    }
  }

  /** 遮罩只在「窄屏 + 确有抽屉打开」时出现。
   * 宽屏下两栏是并排的常驻工具、地图仍在中间空白区里，不需要一层遮罩。 */
  syncScrim() {
    const el = $('#drawerScrim');
    if (!el) return;
    /* 行迹面板不算在内：它只在行迹模式下存在，而那个模式下 #leftPanel 已经是
       display:none、左右两栏的 hide-x 类都是「收起」。把行迹面板也计进来会
       让窄屏一进行迹模式就多出一层遮罩，属于「顺手改了没被要求的东西」——
       行迹面板自己的收起入口是 #toggleRoute（见 setRoutePanelHidden）。 */
    const anyOpen = !document.body.classList.contains('hide-left')
      || !document.body.classList.contains('hide-right');
    el.classList.toggle('hidden', !(this.isNarrow() && anyOpen));
  }

  /** 窄屏 Esc 用：收起当前打开着的抽屉，返回「是否真的收了东西」。
   * 返回布尔值是为了让 Esc 的分层判断能继续往下走（没收东西就别吞掉这次按键）。 */
  closeAnyDrawer() {
    let closed = false;
    ['right', 'left'].forEach((key) => {
      if (!document.body.classList.contains(this.hideClass(key))) {
        this.setPanelHidden(key, true);
        closed = true;
      }
    });
    /* 行迹面板也是窄屏下铺在屏幕上的一块，Esc 该能收起它 ——
       但它是「退出行迹模式」之外的另一种收法，所以不能走 exitRouteMode：
       那样会连诗人选择、气泡、地图聚焦一起清掉，用户按一次 Esc 就丢了整条行迹。 */
    if (this.isRouteMode() && !document.body.classList.contains('hide-route')) {
      this.setRoutePanelHidden(true);
      closed = true;
    }
    return closed;
  }

  /** 窄屏形态的切换。
   *
   * 只在**跨过断点**时动默认值：resize 过程中反复重置会把用户刚打开的抽屉又收回去
   * （手机浏览器地址栏收起/展开就会触发 resize）。 */
  applyNarrowMode() {
    const narrow = window.innerWidth <= 860;
    if (narrow === this._narrow) return;
    this._narrow = narrow;
    document.body.classList.toggle('narrow', narrow);
    if (narrow) {
      // 进入窄屏：两栏默认都收起，把整幅地图让出来。
      // 宽屏下右栏默认展开（显示操作提示）是有意义的，窄屏下它会盖住大半张地图。
      this.setPanelHidden('left', true, { quiet: true });
      this.setPanelHidden('right', true, { quiet: true });
    } else {
      /* 离开窄屏：恢复宽屏的默认形态（两栏都展开）。
         不补这一步的话，窄屏下两栏是收起的，把窗口拉宽（或手机横竖屏切换）之后
         它们**不会自己回来** —— 用户看到的是一张空荡荡的地图加两个不起眼的开关，
         得自己想到「去点那两个小箭头」才能把界面找回来。 */
      this.setPanelHidden('left', false, { quiet: true });
      this.setPanelHidden('right', false, { quiet: true });
      /* 行迹面板同理。窄屏下它可能正收着（选完诗人自动收的），
         拉到宽屏后该自己回来 —— 宽屏有地方并排放下，没有理由还藏着。 */
      this.setRoutePanelHidden(false, { quiet: true });
    }
    this.syncScrim();
  }

  /** 把开关贴到面板边缘；面板收起时贴到屏幕边缘 */
  syncPanelToggles() {
    const GAP = 16;
    const lb = $('#toggleLeft');
    const rb = $('#toggleRight');
    if (!lb || !rb) return;
    const lHide = document.body.classList.contains('hide-left');
    const rHide = document.body.classList.contains('hide-right');
    lb.style.left = lHide ? '0px' : `${GAP + this.panels.left.offsetWidth - 1}px`;
    rb.style.right = rHide ? '0px' : `${GAP + this.panels.right.offsetWidth - 1}px`;
    // HUD（经纬度 / 朝代）固定在右下角，右栏展开时会 100% 落在它底下 ——
    // 跟开关共用同一套「按面板实际宽度算」的逻辑，让位到右栏左侧。
    document.documentElement.style.setProperty('--hud-right',
      rHide ? '18px' : `${GAP + this.panels.right.offsetWidth + 12}px`);
    // 行迹模式下左栏被整体隐藏（display:none），开关也要跟着藏
    const lGone = this.panels.left.style.display === 'none';
    lb.style.display = lGone ? 'none' : '';

    /* 行迹开关：只在行迹模式下出现。
       此时 #toggleLeft 恰好被上面那句藏掉了，两者永远不同时出现，不会叠在一起。
       位置按 #routePanel 的实际宽度算 —— 它比左右两栏窄，各断点宽度也不一样，
       写死一个 left 值一定会在某个断点错位。 */
    const rtb = $('#toggleRoute');
    const rp = $('#routePanel');
    if (rtb && rp) {
      const inRoute = this.isRouteMode();
      /* 必须写 'flex' 而不是 ''。CSS 里 `#toggleRoute { display: none }` 是默认值，
         而 `style.display = ''` 的语义是「删掉内联声明」，删完 CSS 那条又生效 ——
         结果就是「明明进了行迹模式，开关却始终看不见」。
         （#toggleLeft 那句写 '' 是安全的：它没有 CSS 默认值，靠 .panel-toggle 的 flex 兜底。） */
      rtb.style.display = inRoute ? 'flex' : 'none';
      if (inRoute) {
        const rHide = document.body.classList.contains('hide-route');
        rtb.style.left = rHide ? '0px' : `${GAP + rp.offsetWidth - 1}px`;
        rtb.setAttribute('aria-expanded', rHide ? 'false' : 'true');
        rtb.querySelector('.pt-arrow').textContent = rHide ? '›' : '‹';
      }
    }
    // 开关位置变了 → 气泡停靠带跟着变
    this.invalidateDock();
  }

  /**
   * 把练习卡的实测高度写进 --qc-h，供侧栏竖向让位（见 css 的 body.quiz-open 规则）。
   *
   * 用 ResizeObserver 而不是在每次 renderQuestion 后手动量：卡片高度受题型影响很大
   * —— 四选一的选项要换行、反馈区答完才展开、飞花令还多一个输入框，
   * 逐个渲染路径去补一次测量，早晚会漏掉一条。
   */
  watchQuizHeight() {
    const card = $('#quizCard');
    if (!card) return;
    const write = () => {
      const h = card.offsetHeight;
      if (h > 0) document.documentElement.style.setProperty('--qc-h', `${h}px`);
    };
    if (typeof ResizeObserver === 'function') {
      this._qcRO = new ResizeObserver(write);
      this._qcRO.observe(card);
    }
    write();
  }

  /** 展开某一侧抽屉（选中诗境 / 查看地区时自动调用，避免内容渲染在收起的抽屉里） */
  expandPanel(key) {
    if (!document.body.classList.contains(this.hideClass(key))) return;
    this.setPanelHidden(key, false);
  }

  bindModes() {
    $$('#modeNav button').forEach((b) => {
      b.onclick = () => {
        $$('#modeNav button').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        const mode = b.dataset.mode;
        const isRoute = mode === 'route';
        $('#routePanel').classList.toggle('hidden', !isRoute);
        document.getElementById('leftPanel').style.display = isRoute ? 'none' : '';
        if (mode === 'route') this.toast('选择一位诗人，地图将只保留他的行迹站点');
        if (mode === 'class') this.toast('选择底部的练习开始上课');
        // 面板收起来了，挂在 body 上的诗人下拉浮层不能留在半空
        if (!isRoute) this.closeDropdowns();
        /* 行迹面板的收起状态复位成「展开」，两个方向都复位：
           进来时不复位，用户看到的会是一个空屏幕加一个开关（上一次选完诗人
           自动收起的状态被带过来了），会以为功能坏了；离开时也复位，
           这样下次进来才是干净的。离开后面板本来就是 .hidden，收没收起看不出区别。 */
        this.setRoutePanelHidden(false, { quiet: true });
        if (mode !== 'route') this.ctx.onClearRoute();
        this.hideRegionBar();
        /* 窄屏下行迹面板占着左侧，若右栏抽屉还开着，css 会让行迹面板整块隐去
           （见 body.narrow:not(.hide-right) .route-panel）。与其让它「一进去就不见了」，
           不如进模式时先把右栏收起，用户看到的是行迹面板。 */
        if (isRoute && this.isNarrow()) this.setPanelHidden('right', true, { quiet: true });
        this.syncPanelToggles();
        this.syncScrim();
      };
    });
  }

  /* ================= 诗词详情 ================= */
  renderDetail(site, opts = {}) {
    if (!site) return;
    // 抽屉可能是收起的，先展开，否则内容渲染在一个看不见的地方
    this.expandPanel('right');
    if (!this.poemState.has(site.id)) this.poemState.set(site.id, { index: 0, vertical: true, trans: false });
    const st = this.poemState.get(site.id);
    if (opts.poemId) {
      const i = site.poems.findIndex((p) => p.id === opts.poemId);
      if (i >= 0) st.index = i;
    }
    st.index = Math.min(st.index, site.poems.length - 1);
    const era = ERA_MAP.get(site.era);

    const body = $('#detailBody');
    body.innerHTML = '';
    // 右栏改显示「某个诗境」了，撤掉地区介绍标记 ——
    // 否则筛选 / 行迹变化时会把用户正在看的诗境详情替换成地区介绍。
    delete body.dataset.region;

    const head = document.createElement('div');
    head.className = 'd-head';
    head.innerHTML = `
      <div class="d-title">${site.name}</div>
      <div class="d-sub">${site.sub} · ${era ? era.name + '（' + era.note + '）' : ''}</div>
      <div class="d-tags">
        <span class="era">${era ? era.name : ''}</span>
        ${site.themes.map((t) => `<span>${t}</span>`).join('')}
      </div>`;
    body.appendChild(head);

    const brief = document.createElement('div');
    brief.className = 'd-brief';
    brief.innerHTML = `<b>地理</b>　${site.geo}<br/><br/><b>背景</b>　${site.story}`;
    body.appendChild(brief);

    // 诗篇切换
    if (site.poems.length > 1) {
      const tabs = document.createElement('div');
      tabs.className = 'poem-tabs';
      site.poems.forEach((p, i) => {
        const b = document.createElement('button');
        b.textContent = p.title;
        b.className = i === st.index ? 'on' : '';
        b.onclick = () => { st.index = i; st.trans = false; this.renderDetail(site); };
        tabs.appendChild(b);
      });
      body.appendChild(tabs);
    }

    const poem = site.poems[st.index];
    body.appendChild(this.buildPoemCard(poem, st, { siteName: site.name }));

    // 前后导航
    const actions = document.createElement('div');
    actions.className = 'd-actions';
    const prev = document.createElement('button');
    prev.className = 'mini';
    prev.textContent = '← 上一处诗境';
    prev.onclick = () => this.ctx.onStep(-1);
    const next = document.createElement('button');
    next.className = 'mini primary-mini';
    next.textContent = '下一处诗境 →';
    next.onclick = () => this.ctx.onStep(1);
    actions.append(prev, next);
    body.appendChild(actions);

    body.scrollTop = 0;
    this.visited.add(site.id);
    const row = $(`#siteList .site-row[data-id="${site.id}"]`);
    if (row) row.classList.add('visited');
    $$('#siteList .site-row').forEach((r) => r.classList.toggle('active', r.dataset.id === site.id));
    if (opts.keyword) this.highlightKeyword(body, opts.keyword);
  }

  /**
   * 一首诗的完整卡片。
   * 右侧抽屉与详情弹窗共用同一份渲染逻辑 —— 两边各写一遍迟早会长歪
   * （本项目就出现过「弹窗里有意象字、抽屉里没有」这类不一致）。
   *
   * @param {object} poem  诗篇对象
   * @param {object} st    视图状态 { vertical, trans }，改动后由调用方决定是否重绘
   * @param {object} opts  { siteName, compact }
   */
  buildPoemCard(poem, st, opts = {}) {
    const card = document.createElement('div');
    card.className = 'poem-card';

    const phead = document.createElement('div');
    phead.className = 'poem-head';
    phead.innerHTML = `<span class="poem-title">${poem.title}</span>
      <span class="poem-meta">${poem.dynasty} · ${poem.author}</span>
      <span class="poem-form">${poem.form}</span>
      <span class="poem-lv">${poem.level}</span>`;
    card.appendChild(phead);

    const tools = document.createElement('div');
    tools.className = 'poem-tools';
    const btnV = document.createElement('button');
    btnV.textContent = st.vertical ? '竖排' : '横排';
    btnV.className = 'on';
    btnV.onclick = () => { st.vertical = !st.vertical; this.redrawPoemView(poem, st, opts); };
    const btnT = document.createElement('button');
    btnT.textContent = '对照译文';
    btnT.className = st.trans ? 'on' : '';
    btnT.onclick = () => { st.trans = !st.trans; this.redrawPoemView(poem, st, opts); };
    const btnS = document.createElement('button');
    btnS.textContent = '🔊 朗读';
    btnS.onclick = () => this.speak(poem.lines.flat().join(''));
    tools.append(btnV, btnT, btnS);
    card.appendChild(tools);

    const pbody = document.createElement('div');
    pbody.className = `poem-body ${st.vertical ? 'vertical' : 'horizontal'}`;
    poem.lines.forEach((group, gi) => {
      group.forEach((line, li) => {
        const sp = document.createElement('span');
        sp.className = 'vline' + (li === 0 && gi > 0 ? ' gap' : '');
        sp.textContent = line;
        pbody.appendChild(sp);
      });
    });
    card.appendChild(pbody);

    const trans = document.createElement('div');
    trans.className = 'trans-box' + (st.trans ? ' show' : '');
    trans.innerHTML = poem.trans.map((t) => `<div class="trans-line">${t}</div>`).join('');
    card.appendChild(trans);

    const notes = document.createElement('div');
    notes.className = 'notes-box';
    notes.innerHTML = `<h4>词语注释</h4>` +
      poem.notes.map((n) => `<div class="note-item"><b>${n.t}</b>　${n.d}</div>`).join('');
    card.appendChild(notes);

    const appr = document.createElement('div');
    appr.className = 'appr-box';
    appr.innerHTML = `<h4>赏析</h4><p>${poem.appreciation}</p>`;
    card.appendChild(appr);

    const kw = document.createElement('div');
    kw.className = 'notes-box';
    kw.innerHTML = `<h4>意象字</h4><div class="d-tags">${poem.keywords.map((k) => `<span>${k}</span>`).join('')}</div>`;
    card.appendChild(kw);

    return card;
  }

  /** 竖横排 / 译文切换后就地重绘卡片（弹窗与抽屉各自重绘自己的那一份） */
  redrawPoemView(poem, st, opts) {
    const fresh = this.buildPoemCard(poem, st, opts);
    if (opts.modal) {
      const old = $('#poemModalBody .poem-card');
      if (old) old.replaceWith(fresh);
      return;
    }
    const old = $('#detailBody .poem-card');
    if (old) old.replaceWith(fresh);
  }

  highlightKeyword(root, k) {
    const walk = (node) => {
      if (node.nodeType === 3) {
        const i = node.textContent.indexOf(k);
        if (i < 0) return;
        const span = document.createElement('mark');
        span.style.cssText = 'background:rgba(232,192,122,0.35);color:#fff;border-radius:3px;';
        const after = node.splitText(i);
        after.textContent = after.textContent.slice(k.length);
        span.textContent = k;
        node.parentNode.insertBefore(span, after);
      } else if (!['SCRIPT', 'STYLE', 'MARK'].includes(node.tagName)) {
        Array.from(node.childNodes).forEach(walk);
      }
    };
    walk(root);
  }

  /* ================= 地区（点击地图上的省份） ================= */

  /**
   * 渲染某个行政区的介绍。
   *
   * 内容全部由已收录的数据推导（地势等级、诗境、朝代构成、主题分布、代表篇目），
   * **不编造地理描述** —— 数据里没有的东西宁可不说，也不要写一段看着像那么回事
   * 但查无实据的「地处……自古以来……」。
   */
  renderRegion(prov, sites, opts = {}) {
    if (opts.expand !== false) this.expandPanel('right');
    const body = $('#detailBody');
    body.innerHTML = '';
    // 记住「右栏现在显示的是哪个地区」。筛选 / 行迹聚焦改变可见诗境后，
    // main 靠这个标记判断该不该重算右栏（见 refreshRegionPanel）。
    body.dataset.region = prov.code;

    const poems = sites.flatMap((s) => s.poems.map((p) => ({ ...p, siteId: s.id, siteName: s.name })));
    const grade = this.heightGrade(prov.height);

    const eraCount = new Map();
    poems.forEach((p) => eraCount.set(p.dynasty, (eraCount.get(p.dynasty) || 0) + 1));
    const themeCount = new Map();
    sites.forEach((s) => s.themes.forEach((t) => themeCount.set(t, (themeCount.get(t) || 0) + 1)));

    const head = document.createElement('div');
    head.className = 'd-head';
    head.innerHTML = `
      <div class="d-title">${prov.name}</div>
      <div class="d-sub">地势 ${grade} · 收录 ${sites.length} 处诗境 · ${poems.length} 首诗词</div>
      <div class="d-tags">
        ${[...eraCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
          .map(([d, n]) => `<span class="era">${d} ${n}</span>`).join('')}
        ${[...themeCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
          .map(([t]) => `<span>${t}</span>`).join('')}
      </div>`;
    body.appendChild(head);

    const brief = document.createElement('div');
    brief.className = 'd-brief';
    if (sites.length) {
      brief.innerHTML = `<b>地理</b>　${prov.name}地势为${grade}，境内收录 ${sites.length} 处诗境、${poems.length} 首诗词。` +
        `<br/><br/><b>用法</b>　底部已列出本区全部诗词，点卡片即可展开详情。`;
    } else if (prov.total) {
      // 有诗境但都被筛掉了 —— 要说清是「筛掉了」而不是「没有」，否则用户会以为数据缺了
      brief.innerHTML = `<b>地理</b>　${prov.name}地势为${grade}。<br/><br/>` +
        `<b>提示</b>　本区共收录 ${prov.total} 处诗境，但都被当前筛选（朝代 / 题材 / 地域）或行迹聚焦隐藏了。` +
        `点左侧「重置筛选」即可看到全部。`;
    } else {
      brief.innerHTML = `<b>地理</b>　${prov.name}地势为${grade}。<br/><br/>` +
        `<b>提示</b>　本区暂未收录诗境。可点击其他省份，或在左侧列表中选择诗境。`;
    }
    body.appendChild(brief);

    if (sites.length) {
      const list = document.createElement('div');
      list.className = 'notes-box';
      list.innerHTML = `<h4>境内诗境</h4>`;
      sites.forEach((s) => {
        const d = document.createElement('div');
        d.className = 'note-item';
        d.style.cursor = 'pointer';
        d.innerHTML = `<b>${s.name}</b>　${s.sub.split('·').slice(-1)[0]}　` +
          `<span style="color:rgba(242,234,216,0.4)">${s.poems.length} 首</span>`;
        d.onclick = () => this.ctx.onSelectSite(s.id, { fly: true });
        list.appendChild(d);
      });
      body.appendChild(list);

      const appr = document.createElement('div');
      appr.className = 'appr-box';
      appr.innerHTML = `<h4>代表篇目</h4><p>${poems.slice(0, 4).map((p) => `《${p.title}》`).join('　')}</p>`;
      body.appendChild(appr);
    }

    body.scrollTop = 0;
  }

  /** 由地势高度换算地貌等级，与地图悬停提示保持同一套口径 */
  heightGrade(h) {
    return h > 0.72 ? '雪线高原' : h > 0.55 ? '高原山地' : h > 0.38 ? '丘陵盆地' : '平原水乡';
  }

  /* ================= 底部区域诗词列表 ================= */
  bindRegionBar() {
    $('#rbClose').onclick = () => this.hideRegionBar();
    $('#poemModalClose').onclick = () => this.closePoemModal();
    $('#poemModalMask').onclick = () => this.closePoemModal();
    // 窄屏遮罩：点抽屉以外的任意处收起抽屉。宽屏下遮罩不显示，这条不生效。
    $('#drawerScrim').onclick = () => {
      if (!document.body.classList.contains('hide-left')) this.setPanelHidden('left', true);
      if (!document.body.classList.contains('hide-right')) this.setPanelHidden('right', true);
    };
    // Tab 困在弹窗内。监听挂在弹窗上而不是 document 上：焦点在弹窗里时事件会冒泡到这里，
    // 焦点若已被别的途径带走（比如用户点了地图），这条也不会去抢。
    $('#poemModal').addEventListener('keydown', (e) => {
      if (e.key === 'Tab') this.trapFocus($('#poemModal'), e);
    });
    // 快捷键说明弹窗：与诗词弹窗同一套关闭路径（关闭按钮 / 遮罩 / Esc / Tab 困住）
    $('#shortcutModalClose').onclick = () => this.closeShortcuts();
    $('#shortcutModalMask').onclick = () => this.closeShortcuts();
    $('#shortcutModal').addEventListener('keydown', (e) => {
      if (e.key === 'Tab') this.trapFocus($('#shortcutModal'), e);
    });
  }

  /* ================= 快捷键说明 ================= */
  /**
   * 打开 / 关闭快捷键说明。
   *
   * 焦点处理与诗词弹窗完全一致：**打开时把焦点移进去、关闭时还给触发元素**。
   * 少了前一半，Tab 仍在背后那张地图的界面里游走，键盘用户会以为「弹窗打开了但键盘不管用」；
   * 少了后一半，焦点掉回 <body>，下次 Tab 又从顶栏重新走一遍。
   */
  toggleShortcuts() {
    if (this.isShortcutModalOpen()) this.closeShortcuts();
    else this.openShortcuts();
  }

  openShortcuts() {
    const el = $('#shortcutModal');
    if (!el || !el.classList.contains('hidden')) return;
    this._scReturnFocus = document.activeElement;
    el.classList.remove('hidden');
    const first = $('#shortcutModalClose');
    if (first) first.focus();
  }

  closeShortcuts() {
    const el = $('#shortcutModal');
    if (!el || el.classList.contains('hidden')) return;
    el.classList.add('hidden');
    const back = this._scReturnFocus;
    this._scReturnFocus = null;
    // 触发元素可能已经不在文档里了，先确认再还焦点
    if (back && document.contains(back) && typeof back.focus === 'function') back.focus();
  }

  isShortcutModalOpen() {
    const el = $('#shortcutModal');
    return !!el && !el.classList.contains('hidden');
  }

  /**
   * 渲染底部区域诗词条。
   * opts.show === false 时只更新内容、不动显隐 —— 供「内容同步」使用：
   * 练习 / 行迹模式下诗词条是收起的，但内容仍要跟着可见性走，
   * 否则一旦重新显示就会露出过期数据（比如行迹聚焦后还列着被隐藏的诗境）。
   */
  showRegionBar(prov, sites, opts = {}) {
    const poems = sites.flatMap((s) => s.poems.map((p) => ({ ...p, siteId: s.id, siteName: s.name })));
    $('#rbTitle').textContent = prov.name;
    $('#rbSub').textContent = sites.length
      ? `${sites.length} 处诗境 · ${poems.length} 首诗词 · 点卡片看详情`
      : '暂无收录';

    const list = $('#rbList');
    list.innerHTML = '';
    if (!poems.length) {
      list.innerHTML = `<div class="rb-empty">该地区暂未收录诗词。试试点击其他省份，或从左侧诗境列表中选择。</div>`;
    } else {
      poems.forEach((p) => {
        const b = document.createElement('button');
        b.className = 'rb-card';
        b.innerHTML = `<span class="rc-t">${p.title}</span>
          <span class="rc-a">${p.dynasty} · ${p.author}</span>
          <span class="rc-l">${p.lines.flat()[0] || ''}</span>`;
        b.onclick = () => this.openPoemModal(p, sites.find((s) => s.id === p.siteId));
        list.appendChild(b);
      });
    }
    if (opts.show !== false) {
      $('#regionBar').classList.remove('hidden');
      document.body.classList.add('rb-open');
      // 实测高度写进 CSS 变量：左右两栏与 HUD 据此让位，
      // 避免诗词条压在栏内文字上（右栏「代表篇目」曾被切掉）。
      document.documentElement.style.setProperty('--rb-h', `${$('#regionBar').offsetHeight}px`);
    }
  }

  hideRegionBar() {
    $('#regionBar').classList.add('hidden');
    document.body.classList.remove('rb-open');
    // 让主程序同步清掉省份选中态（地图上的那块地要跟着灭）
    this.ctx?.onHideRegion?.();
  }

  /* ================= 诗词详情弹窗 ================= */
  openPoemModal(poem, site) {
    // 弹窗有自己的视图状态，不复用抽屉里的 —— 否则在弹窗里切了横排，
    // 关掉后抽屉里也跟着变了，用户会以为点错了。
    const st = { vertical: true, trans: false };
    const body = $('#poemModalBody');
    body.innerHTML = '';

    const head = document.createElement('div');
    head.className = 'd-head';
    head.innerHTML = `
      <div class="d-title">${poem.title}</div>
      <div class="d-sub">${poem.dynasty} · ${poem.author}${site ? ' · 收录于「' + site.name + '」' : ''}`;
    body.appendChild(head);
    body.appendChild(this.buildPoemCard(poem, st, { modal: true, siteName: site ? site.name : '' }));

    body.scrollTop = 0;
    // 记住是谁打开的，关掉时把焦点还回去 —— 否则键盘用户的焦点会掉回 <body>，
    // 下次按 Tab 又从页面最开头（顶栏品牌区）重新走一遍，等于丢了位置。
    this._modalReturnFocus = document.activeElement;
    $('#poemModal').classList.remove('hidden');
    // 焦点必须移进弹窗：不移的话 Tab 仍在背后那张地图的界面里游走，
    // 键盘用户会以为「弹窗打开了但键盘不管用」。
    const first = $('#poemModalClose');
    if (first) first.focus();
  }

  closePoemModal() {
    const el = $('#poemModal');
    if (el.classList.contains('hidden')) return;
    el.classList.add('hidden');
    const back = this._modalReturnFocus;
    this._modalReturnFocus = null;
    // 触发元素可能已经不在了（比如它所在的诗词条被收起），所以先确认还在文档里
    if (back && document.contains(back) && typeof back.focus === 'function') back.focus();
  }

  isPoemModalOpen() { return !$('#poemModal').classList.contains('hidden'); }

  /**
   * 把 Tab 困在弹窗内。
   *
   * 弹窗是模态的（有遮罩、点遮罩才关），焦点却可以 Tab 到背后的界面去 ——
   * 那会让键盘用户停在看不见的地方继续操作，甚至误触「退出练习」这类按钮。
   * 做法是接管 Tab：在最后一个可聚焦元素上按 Tab 回到第一个，反向亦然。
   */
  trapFocus(container, e) {
    const items = [...container.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter((el) => el.getClientRects().length > 0);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !container.contains(active))) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && (active === last || !container.contains(active))) {
      e.preventDefault(); first.focus();
    }
  }

  /* ================= 标注层 ================= */
  syncLabels(entries) {
    const seen = new Set();
    entries.forEach((e) => {
      seen.add(e.site.id);
      let el = this.labelEls.get(e.site.id);
      if (!el) {
        el = document.createElement('div');
        el.className = `map-label era-${e.site.era}`;
        el.textContent = e.site.name;
        el.onclick = (ev) => { ev.stopPropagation(); this.ctx.onSelectSite(e.site.id, { fly: true }); };
        $('#labelLayer').appendChild(el);
        this.labelEls.set(e.site.id, el);
      }
      if (!e.visible) { el.style.display = 'none'; return; }
      el.style.display = '';
      el.style.left = `${e.x}px`;
      el.style.top = `${e.y}px`;
      // 2D 平面下标签的锚点是左缘中点（贴在落点圆点右侧），不是中心 ——
      // 见 CSS .map-label.side
      el.classList.toggle('side', !!e.side);
      el.classList.toggle('selected', !!e.selected);
      el.classList.toggle('dim', !!e.dim);
    });
    this.labelEls.forEach((el, id) => { if (!seen.has(id)) el.style.display = 'none'; });
  }

  /* ================= 朗读 ================= */
  speak(text) {
    if (!this.ctx.state.voice || !('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN';
      u.rate = 0.82;
      u.pitch = 1.0;
      window.speechSynthesis.speak(u);
    } catch (e) { /* 忽略朗读失败 */ }
  }

  stopSpeak() {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  }

  /* ================= 行迹 ================= */
  /**
   * 把诗人列表渲染进 #routePoetMenu 下拉浮层（替代原先的常驻列表）。
   *
   * 早先是「16 位诗人直接平铺在面板里」：
   *  - 面板窄屏顶部 88 / 底部 96 之间的 56vh 就那么点空间，常驻列表
   *    把详情挤到完全看不见；
   *  - 想找诗人要先扫一遍 16 行才知道有没有；
   *  - 选完人之后列表还占着位置，「选的是谁」与「详情」互相挤压。
   *
   * 改用 .dd-menu + 下拉触发后：
   *  - 面板默认只剩 head + 详情，「选择诗人」按钮占 1 行；
   *  - 点头按钮才弹出浮层（再按一次收起），浮层 max-height 56vh + 内部滚动；
   *  - 选完人后自动收起，详情露出来 —— 在窄屏尤其有用：
   *    不会同时占着浮层 + 详情两个面板级浮层。
   *
   * 键盘激活交给外层 bindDropdown（在 init 里调），这里只挂 click：
   * 重复挂键盘监听会与 bindDropdown 的 Enter / Space 处理打架，
   * 而且 role="button" 会与 role="option" 冲突。
   */
  bindRoutes() {
    const box = $('#routePoetMenu');
    if (!box) return;
    box.innerHTML = '';
    ROUTES.forEach((r) => {
      const d = document.createElement('li');
      d.className = 'route-item';
      d.setAttribute('role', 'option');
      d.tabIndex = 0;
      d.dataset.id = r.id;
      d.setAttribute('aria-label', `${r.name}，${r.title}，行迹 ${r.stops.length} 站`);
      d.innerHTML = `<div class="rn" style="color:${r.color}">${r.name}</div>
        <div class="rt">${r.title}</div><div class="rc">行迹 ${r.stops.length} 站</div>`;
      const activate = () => {
        $$('#routePoetMenu .route-item').forEach((x) => x.classList.toggle('on', x === d));
        this.renderRouteDetail(r);
        this.ctx.onBuildRoute(r);
        /* 窄屏：选完诗人就把行迹面板收起来，把地图让出来。
           面板在 390 宽下是 340px（占 87% 屏宽），不收的话用户「选了诗人
           却看不见行迹画在哪」—— 而行迹才是这一步的目的。收起后左侧留出
           #toggleRoute 开关，点一下就能把面板叫回来。
           宽屏两栏并排、地图仍占中间空白区，没有这个问题，所以不收。 */
        if (this.isNarrow()) this.setRoutePanelHidden(true);
      };
      d.onclick = activate;
      box.appendChild(d);
    });
    $('#routeClose').onclick = () => this.exitRouteMode();
  }

  /**
   * 通用「按钮 + 浮层」下拉绑定。
   * 复用于「巡游范围」与「诗人选择」两处 —— 同一组件解决同一类问题
   * （原生 <select> 在窄屏由 OS 接管弹层 / 风格脱节）。
   *
   * opts:
   *   onChange(value, label, opt)   — 选项点击时回调；
   *                                   诗人选择不传，由 bindRoutes 的 onclick 自己处理 buildRoute，
   *                                   这里只负责关浮层。
   *   initial: { value }            — 初始值（用于更新按钮 label）；
   *   autoClose: boolean            — 默认 true（点选项就关浮层）；
   *   markSelected: boolean         — 是否给选中项加 .selected 类（默认 true）。
   *
   * 关闭时机：按钮再次点击、点浮层外部、按 Esc、按钮被滚出视口 ——
   * 少一处就是「弹出来关不掉」或「浮层飘在屏幕外」的入口。
   */
  bindDropdown(selector, opts = {}) {
    const root = typeof selector === 'string' ? $(selector) : selector;
    if (!root) return null;
    const btn = root.querySelector('.dd-btn');
    const menu = root.querySelector('.dd-menu');
    const label = root.querySelector('.dd-label');
    if (!btn || !menu) return null;
    const isOpen = () => !menu.classList.contains('hidden');
    const options = $$('[role="option"]', menu);

    /* 把浮层贴到按钮上，并**夹在视口内**。
       不夹的话，底栏是横向滚动的（`.bottombar`），按钮可以停在视口左右边缘之外；
       浮层照搬 `rect.left` 就会有一半在屏幕外，用户看到的是「下拉框位置偏移到
       别的地方去了」。竖向同理：底栏贴底，向上弹的浮层若比上方空间还高，
       顶部会被切掉，所以方向要按可用空间现算，而不是写死 dd-up / dd-down。 */
    const positionMenu = () => {
      const rect = btn.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      /* 先定宽再量高：`min-width` 跟按钮对齐（下拉不该比触发它的按钮还窄），
         但再宽也不许顶出视口 —— 底栏是横向滚动的，按钮可以停在边缘上。 */
      menu.style.minWidth = Math.min(rect.width, vw - 16) + 'px';
      const mw = menu.offsetWidth;
      const mh = menu.offsetHeight;
      menu.style.left = Math.max(8, Math.min(rect.left, vw - mw - 8)) + 'px';
      /* 方向按可用空间定：优先尊重 dd-up / dd-down 的意图，但空间不够就翻面。
         gap 6px 与 CSS 里的 6px 对齐。 */
      const below = vh - rect.bottom;
      const above = rect.top;
      const wantUp = root.classList.contains('dd-up');
      let up = wantUp ? (above >= mh + 6 || above >= below) : !(below >= mh + 6);
      if (up && above < mh + 6 && below > above) up = false;
      menu.style.top = (up ? rect.top : rect.bottom) + 'px';
      menu.style.transform = up ? 'translateY(calc(-100% - 6px))' : 'translateY(6px)';
      menu.style.bottom = 'auto';
    };

    const close = () => {
      menu.classList.add('hidden');
      btn.setAttribute('aria-expanded', 'false');
    };
    const open = () => {
      /* 同时只开一个：两个下拉都挂在 document 上各自监听点击，
         不互相收的话「先开巡游范围、再开诗人选择」会两个浮层一起挂在屏幕上。 */
      this.closeDropdowns(root);
      /* 菜单必须脱离原位置（移到 body 直接子节点），否则会被祖先的
         transform / filter / perspective 拦截 fixed 定位 —— 典型的踩坑：
         .bottombar 用了 transform: translateX(-50%) 居中，这个 transform
         会把它变成内含 fixed 后代的「containing block」，导致菜单的
         top/bottom 不再相对视口，而是相对 bottombar —— 浮层就跑到屏幕外了。
         移到 body 后 fixed 定位重新相对视口，rect.top 也才符合预期。 */
      if (menu.parentElement !== document.body) document.body.appendChild(menu);
      /* 触发按钮若整个在视口外（底栏可以横向滚很远），先把按钮滚进来再贴浮层 ——
         否则会得到一个「锚在一个看不见的按钮上」的浮层，位置再准也没意义。 */
      const r0 = btn.getBoundingClientRect();
      if (r0.right < 0 || r0.left > window.innerWidth
        || r0.bottom < 0 || r0.top > window.innerHeight) {
        btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      /* 先显形再量尺寸：offsetWidth/Height 在 display:none 下恒为 0，
         先量后显会把浮层当成 0×0，夹取与翻面全部失效。 */
      menu.classList.remove('hidden');
      positionMenu();
      btn.setAttribute('aria-expanded', 'true');
    };
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isOpen()) close(); else open();
    });
    /* 点浮层内部不冒泡到 document，否则「点选项」的关闭会被外部点击监听
       抢先关掉，看不到 label 更新（冒泡顺序：opt → menu → document）。 */
    menu.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', (e) => {
      if (!root.contains(e.target)) close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isOpen()) {
        close();
        btn.focus();
      }
    });
    /* 滚动 / 改窗口大小：按钮位置会变，浮层不能留在原地。
       按钮滚出视口就干脆收起 —— 留一个悬在空中的浮层比关掉更让人困惑。 */
    const reflow = () => {
      if (!isOpen()) return;
      const r = btn.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight
        || r.right < 0 || r.left > window.innerWidth) { close(); return; }
      positionMenu();
    };
    window.addEventListener('scroll', reflow, true);
    window.addEventListener('resize', reflow);

    /* 选项的「按钮 label 文本」默认取整个 option 的 textContent（巡游范围 / 简单菜单适用）；
       诗人选项里塞了「李白 / 仗剑去国 / 行迹 9 站」三行，整段拼出来丑且长，
       用 labelFrom 指定只取诗人姓名这一行（.rn）。 */
    const labelOf = (opt) => {
      const raw = opts.labelFrom
        ? (opt.querySelector(opts.labelFrom)?.textContent || opt.textContent)
        : opt.textContent;
      return raw.trim().replace(/\s+/g, ' ');
    };
    options.forEach((opt) => {
      opt.addEventListener('click', () => {
        const value = opt.dataset.value || opt.dataset.id;
        const text = labelOf(opt);
        if (label) label.textContent = text;
        if (opts.markSelected !== false) {
          options.forEach((o) => o.classList.toggle('selected', o === opt));
        }
        if (opts.onChange) opts.onChange(value, text, opt);
        if (opts.autoClose !== false) close();
      });
      opt.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
          e.preventDefault();
          opt.click();
        }
      });
    });
    if (opts.initial && label) {
      const init = menu.querySelector(`[data-value="${opts.initial.value}"]`)
        || menu.querySelector(`[data-id="${opts.initial.value}"]`);
      if (init) label.textContent = labelOf(init);
    }
    const handle = { open, close, root, btn, menu, options, labelOf };
    this._dropdowns.push(handle);
    return handle;
  }

  /** 收起全部下拉（可保留一个）。面板收起 / 切模式时调用，免得浮层悬在原地。 */
  closeDropdowns(except) {
    (this._dropdowns || []).forEach((d) => { if (d.root !== except) d.close(); });
  }

  /**
   * 行迹面板里的「气泡」开关。
   * 默认显示；切到关时把整个 #bubbleLayer display:none，重新打开时恢复。
   * 与「地名」图层开关是两条独立的开关 —— 关地名也带关气泡（更省心），
   * 但关气泡不会带关地名（用户可能就是想看地名不要气泡）。
   */
  bindBubbleToggle() {
    const btn = $('#bubbleToggle');
    if (!btn) return;
    this.syncBubbleToggleUI();
    btn.addEventListener('click', () => {
      this.bubbleVisible = !this.bubbleVisible;
      this.syncBubbleToggleUI();
    });
  }
  syncBubbleToggleUI() {
    const btn = $('#bubbleToggle');
    if (!btn) return;
    btn.classList.toggle('off', !this.bubbleVisible);
    btn.classList.toggle('on', this.bubbleVisible);
    btn.setAttribute('aria-pressed', this.bubbleVisible ? 'true' : 'false');
    const layer = $('#bubbleLayer');
    if (layer) layer.classList.toggle('bubble-hidden', !this.bubbleVisible);
  }

  /**
   * 退出行迹模式。
   * 面板、左栏、顶部模式按钮、地图上的行迹线与站点聚焦是同一件事的五个侧面，
   * 必须一起复位 —— 分散在三处各写一遍，迟早漏掉一个（比如只关了面板、
   * 地图上却还留着只显示行迹站点的聚焦状态）。
   */
  exitRouteMode() {
    $('#routePanel').classList.add('hidden');
    /* 收起状态一并复位。不复位的话，窄屏下「选诗人 → 自动收起 → 退出 →
       再进行迹模式」会看到一块空屏幕（面板还带着 .collapsed 平移在屏幕外），
       而开关上的文字写着「收起」—— 用户只能靠点一下开关猜出来。 */
    this.setRoutePanelHidden(false, { quiet: true });
    document.getElementById('leftPanel').style.display = '';
    $$('#modeNav button').forEach((x) => x.classList.toggle('active', x.dataset.mode === 'explore'));
    $$('#routePoetMenu .route-item').forEach((x) => x.classList.remove('on'));
    // 面板收了，挂在 body 上的诗人下拉浮层不能留着 —— 它已经不属于任何可见的面板了
    this.closeDropdowns();
    $('#routeDetail').innerHTML = '';
    // 气泡是「选中了某位诗人」才有的东西，模式一退就没有诗人了，必须一起清掉 ——
    // 面板、左栏、模式按钮、地图聚焦已经是一件事的四个侧面，气泡是第五个。
    this.clearRouteBubbles();
    this.syncPanelToggles();
    this.syncScrim();
    this.ctx.onClearRoute();
  }

  isRouteMode() { return !$('#routePanel').classList.contains('hidden'); }

  isRegionBarOpen() { return !$('#regionBar').classList.contains('hidden'); }

  /**
   * 右栏当前显示的是哪个地区的介绍。
   * 显示诗境详情（或别的内容）时返回 null —— main 据此决定筛选 / 行迹变化后
   * 要不要重算右栏：正在看诗境详情就别打断，正在看地区介绍就必须跟着更新。
   */
  currentRegion() { return $('#detailBody').dataset.region || null; }

  /* ================= 行迹气泡卡片 =================
   *
   * 选中诗人后，地图上每一处行迹地点挂一个气泡，罗列他在此地所作的诗文。
   * 气泡是**鼠标增强**：同样的内容在右侧行迹面板 + 右栏详情里已经完整存在，
   * 且那条路是键盘可达的。所以气泡层整体 `aria-hidden`、内部不用可聚焦元素 ——
   * 否则 16 条行迹 × 每条 5 站 × 每站 3 首诗 ≈ 240 个 Tab 停靠点，
   * 会把键盘操作从「几十步走完」变成「几百步走不完」，反而更糟。
   */
  clearRouteBubbles() {
    const layer = $('#bubbleLayer');
    if (layer) layer.innerHTML = '';
    this.bubbleEls = new Map();
    this._bubbleStops = [];
    this._bubbleSizes = new Map();
  }

  /** 供 main.js 每帧投影用：返回气泡对应的站点（顺序与传进来的 stops 一致） */
  bubbleTargets() { return this._bubbleStops; }

  /**
   * @param {object} route ROUTES 里的一条
   * @param {Array}  stops effects.buildRoute 的返回值：至少带 siteId / year / note
   */
  buildRouteBubbles(route, stops) {
    const layer = $('#bubbleLayer');
    if (!layer || !stops || !stops.length) { this.clearRouteBubbles(); return; }
    this.clearRouteBubbles();

    // 气泡只放一行诗：诗境 + 1 首诗。多出来的用「+N」标注。
    // 想看全部 → 点地名飞到右栏，那里本来就是诗篇全表 + 注释 + 翻译的完整视图。
    // 把气泡做矮，是为了让它能在地图上「罗列各个点」——9 个气泡各 ~58px 才能塞进
    // 不到 200px 的行迹屏幕范围；做高 100+px 是装得下，但锚点挤的那一片就全糊了。
    const seen = new Map();       // 同一站点可能在一条行迹里出现两次（陆游两度居山阴）

    stops.forEach((st, i) => {
      const site = SITE_MAP.get(st.siteId);
      if (!site) return;
      const n = (seen.get(st.siteId) || 0) + 1;
      seen.set(st.siteId, n);
      // 键里带出现次数：只按 siteId 做键的话，第二次出现的气泡会覆盖第一次的
      const key = `${st.siteId}#${n}`;

      const poems = (site.poems || []).filter((p) => p.author === route.name);
      const el = document.createElement('div');
      el.className = 'rb-bubble';
      el.dataset.key = key;
      const first = poems[0];
      const more = poems.length > 1 ? `<span class="rb-more">+${poems.length - 1}</span>` : '';
      el.innerHTML = `
        <div class="rb-head">
          <span class="rb-idx" style="background:${route.color}">${i + 1}</span>
          <span class="rb-name">${site.name}</span>
          <span class="rb-year">${st.year || ''}</span>
        </div>
        ${first
          ? `<div class="rb-poem-line" title="${first.dynasty} · ${first.author}《${first.title}》">《${first.title}》${more}</div>`
          : '<div class="rb-none">此行未见存世诗作</div>'}
        <span class="rb-tail"></span><span class="rb-stem"></span><span class="rb-dot"></span>`;

      const nameEl = el.querySelector('.rb-name');
      // 点地名飞过去 —— 用的是 div 不是 button：整体 aria-hidden 下放可聚焦元素是错的
      nameEl.style.cursor = 'pointer';
      nameEl.onclick = (ev) => { ev.stopPropagation(); this.ctx.onSelectSite(st.siteId, { fly: true }); };

      const lineEl = el.querySelector('.rb-poem-line');
      if (lineEl && first) {
        lineEl.onclick = (ev) => { ev.stopPropagation(); this.openPoemModal(first, site); };
      }

      layer.appendChild(el);
      this.bubbleEls.set(key, el);
      this._bubbleStops.push({ key, siteId: st.siteId });
    });

    this.measureBubbles();
  }

  /**
   * 量一遍气泡尺寸并缓存。
   * 每帧读 offsetHeight 会强制同步布局（9 个气泡 × 60fps），没必要 ——
   * 尺寸只在「换诗人」和「视口变化（窄屏收窄）」时会变。
   */
  measureBubbles() {
    this._bubbleSizes = new Map();
    this.bubbleEls.forEach((el, key) => {
      this._bubbleSizes.set(key, { w: el.offsetWidth, h: el.offsetHeight });
    });
    // 视口一变，面板位置与宽度都可能变 —— 停靠带必须跟着重量
    this.invalidateDock();
  }

  /**
   * 气泡停靠区（地图左右两侧的空白带）失效。
   * 面板开合、视口变化、视图切换都会改这个区域，任何一处变了就置空重算。
   */
  invalidateDock() { this._dock = null; }

  /**
   * 计算气泡可以停靠的两条竖向「空白带」。
   *
   * 为什么要单独算：气泡原先是在锚点上下找空位贴在地图上的，
   * 结果一片卡片压在地图中央，把地形和路线全盖住了 ——
   * 而屏幕左右两侧本来就有两条没人用的竖带（面板与地图之间）。
   *
   * 边界要**实测**而不是写死：
   *   - 行迹模式下左侧是 #routePanel（276px），探索模式下是 #leftPanel（272px），
   *     两者位置相同但宽度不同；
   *   - 两栏都能被收起到屏幕外，收起后那条带子就该让出来；
   *   - 抽屉开关按钮贴在面板外缘，也要一起让开。
   * 缓存起来是因为它每帧都要用，而 getBoundingClientRect 会强制同步布局。
   */
  dockRect() {
    if (this._dock) return this._dock;
    const W = window.innerWidth;
    const H = window.innerHeight;
    const GAP = 10;
    const visible = (el) => {
      if (!el) return null;
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') return null;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 ? r : null;
    };
    // 左侧：取「还在屏幕内」的最靠右的那条边
    // 收起的面板会整块平移到屏幕外（x ≈ -364），`r.right > GAP + 8` 自然把它排除 ——
    // 于是那条带子自动让出来，不必在这里再判一次「收没收起」。
    let left = GAP;
    [$('#routePanel'), $('#leftPanel'), $('#toggleLeft'), $('#toggleRoute')].forEach((el) => {
      const r = visible(el);
      if (r && r.right > GAP + 8) left = Math.max(left, r.right + GAP);
    });
    // 右侧：取「还在屏幕内」的最靠左的那条边
    let right = W - GAP;
    [$('#rightPanel'), $('#toggleRight')].forEach((el) => {
      const r = visible(el);
      if (r && r.left < W - GAP - 8) right = Math.min(right, r.left - GAP);
    });
    this._dock = {
      left: Math.round(left),
      right: Math.round(right),
      top: 96,                       // 顶栏 88 + 一点余量
      bottom: H - 100,               // 底栏 82 + 一点余量
    };
    return this._dock;
  }

  /**
   * 每帧定位气泡：**停靠在左右两条空白带里**，不再压在地图上方。
   *
   * 分工规则：
   *   - 按锚点横坐标排序后对半分组：靠左的锚点用左栏，靠右的用右栏。
   *     这样引线基本不交叉，也不会出现「左栏的卡片指着最右边的点、一条线横穿全图」。
   *   - 栏内按锚点纵坐标自上而下排开，与地图上的高低顺序一致。
   *   - 空间不够时压缩间距（而不是重叠）—— 卡片高度是内容决定的，压不得。
   *   - 窄屏（两栏是覆盖式抽屉、中间没有真正的空白带）只保留右栏一列。
   *
   * @param {Array} entries 与 bubbleTargets() 一一对应的 [{x, y, visible}]
   */
  updateRouteBubbles(entries) {
    const stops = this._bubbleStops;
    if (!stops.length) return;
    const dock = this.dockRect();

    const items = [];
    stops.forEach((st, i) => {
      const el = this.bubbleEls.get(st.key);
      if (!el) return;
      const e = entries[i];
      if (!e || !e.visible) { el.style.display = 'none'; return; }
      el.style.display = '';
      const size = this._bubbleSizes.get(st.key) || { w: 184, h: 58 };
      items.push({ ...st, el, ax: e.x, ay: e.y, w: size.w, h: size.h });
    });
    if (!items.length) return;

    const colW = items[0].w;
    // 两列 + 中间至少留 160px 地图，否则不如只用一列
    const twoCol = (dock.right - dock.left) >= colW * 2 + 160;

    const byX = [...items].sort((a, b) => a.ax - b.ax);
    const groups = [];
    if (twoCol) {
      const mid = Math.ceil(byX.length / 2);
      groups.push({ side: 'left', list: byX.slice(0, mid) });
      groups.push({ side: 'right', list: byX.slice(mid) });
    } else {
      groups.push({ side: 'right', list: byX });
    }

    const place = (it, x, y, side) => {
      const el = it.el;
      const w = it.w;
      const h = it.h;
      const dotX = it.ax - x;
      const dotY = it.ay - y;

      /* 引线从卡片**哪条边**出发指向锚点 —— 就是锚点相对卡片的那一侧。
       *
       * 注意别把「边」和「卡片在哪一栏」搞混：类名 side-left / side-right 说的是
       * **卡片自己在左边还是右边**（尾巴因而挂在朝内那条边上）。
       * 实测把两者当成一件事，会出现「左栏卡片的尾巴挂到左边缘、朝屏幕外指」——
       * 地图上九条引线有七条方向反了。
       *
       * 横向能解决就用横向。但如果锚点横向正好落在卡片自己的宽度范围里，
       * 横向引线就会横穿卡片本身（屏幕上是一条金色细线压在卡片上，很脏）——
       * 实测 9 站里会出现 2 个（扬州 / 敬亭山·桃花潭：行迹取景后华东那几个站点
       * 正好投影到右侧停靠带里）。这种情况改用纵向，长度通常只有一两百像素。
       */
      const edge = dotX > w ? 'right'
        : dotX < 0 ? 'left'
          : (dotY < h / 2 ? 'top' : 'bottom');

      el.classList.toggle('side-left', edge === 'right');    // 卡片在左，尖角朝右
      el.classList.toggle('side-right', edge === 'left');    // 卡片在右，尖角朝左
      el.classList.toggle('side-top', edge === 'top');
      el.classList.toggle('side-bottom', edge === 'bottom');
      el.style.left = `${Math.round(x)}px`;
      el.style.top = `${Math.round(y)}px`;

      /* 引线起点 + 尾巴三角的位置：
         横向出线时固定在「朝内那条边」的中点（--tail-y / --stem-y = h/2）——
         同列卡片的尾巴因此落在同一条竖线上，看起来是一排整齐的引线；
         纵向出线时才需要把起点横向夹进卡片内，否则起点会跑到卡片外。 */
      let stemX, stemY;
      if (edge === 'left' || edge === 'right') {
        stemX = edge === 'right' ? w : 0;
        stemY = Math.round(h / 2);
      } else {
        stemX = Math.max(8, Math.min(w - 8, Math.round(dotX)));
        stemY = edge === 'top' ? 0 : h;
      }
      const len = Math.hypot(dotX - stemX, dotY - stemY);
      const deg = Math.atan2(dotY - stemY, dotX - stemX) * 180 / Math.PI - 90;

      el.style.setProperty('--tail-x', `${Math.round(stemX)}px`);
      el.style.setProperty('--tail-y', `${Math.round(stemY)}px`);
      el.style.setProperty('--stem-x', `${Math.round(stemX)}px`);
      el.style.setProperty('--stem-y', `${Math.round(stemY)}px`);
      el.style.setProperty('--stem-h', `${Math.round(len)}px`);
      el.style.setProperty('--stem-r', `${deg.toFixed(1)}deg`);
      el.style.setProperty('--dot-x', `${Math.round(dotX)}px`);
      el.style.setProperty('--dot-y', `${Math.round(dotY)}px`);
    };

    groups.forEach(({ side, list }) => {
      if (!list.length) return;
      const w = list[0].w;
      const x = side === 'left' ? dock.left : dock.right - w;
      const ordered = [...list].sort((a, b) => a.ay - b.ay);
      const total = ordered.reduce((s, it) => s + it.h, 0);
      const avail = Math.max(80, dock.bottom - dock.top);
      const gap = ordered.length > 1
        ? Math.max(2, Math.min(10, (avail - total) / (ordered.length - 1)))
        : 0;
      const span = total + gap * (ordered.length - 1);
      let y = dock.top + Math.max(0, (avail - span) / 2);
      ordered.forEach((it) => { place(it, x, y, side); y += it.h + gap; });
    });
  }

  renderRouteDetail(r) {
    const box = $('#routeDetail');
    box.innerHTML = `<p>${r.desc}</p>`;
    r.stops.forEach((s, i) => {
      const site = SITE_MAP.get(s.site);
      if (!site) return;
      const d = document.createElement('div');
      d.className = 'rp-stop';
      d.innerHTML = `<span class="n" style="background:${r.color}">${i + 1}</span>
        <span class="info"><b>${site.name}</b><em>${s.year}</em><small>${s.note}</small></span>`;
      const activate = () => this.ctx.onSelectSite(s.site, { fly: true });
      d.onclick = activate;
      this.keyboardActivate(d, activate, `第 ${i + 1} 站 ${site.name}，${s.year}`);
      box.appendChild(d);
    });
    box.scrollTop = 0;
  }

  /* ================= 巡游状态 ================= */
  setTourState(st) {
    this.tour = { ...this.tour, ...st };
    const btn = $('#btnTour');
    btn.textContent = this.tour.playing ? '⏸ 暂停' : '▶ 巡游';
    btn.classList.toggle('playing', !!this.tour.playing);
    const pct = this.tour.total ? ((this.tour.index + 1) / this.tour.total) * 100 : 0;
    $('#tourProgress').style.width = `${pct}%`;
    $('#tourInfo').textContent = st.label || (this.tour.playing ? '巡游中…' : '待机');
  }

  /* ================= 课堂练习 ================= */
  bindQuiz() {
    $('#quizClose').onclick = () => this.closeQuiz();
    $('#quizQuit').onclick = () => { this.closeQuiz(); this.toast('已退出练习'); };
    $('#quizNext').onclick = () => this.nextQuestion();
    $$('#classGroup button').forEach((b) => {
      b.onclick = () => this.startQuiz(b.dataset.quiz);
    });
    this.watchQuizHeight();
  }

  closeQuiz() {
    $('#quizCard').classList.add('hidden');
    this.quiz = null;
    this.stopSpeak();
    // 先摘掉「练习卡打开」这个状态，再让地图恢复 —— 顺序反了会让 applyVisibility
    // 里的重算看到一张还开着的练习卡。
    this.ctx.onQuizCard(false);
    this.ctx.onQuizMode(false);
  }

  startQuiz(type) {
    // 区域诗词条与练习卡都停在 bottom:82px，会叠在一起
    this.hideRegionBar();
    this.closePoemModal();
    // 「练习卡打开了」与「地图全亮待点」是两件事：
    // 看图识诗两者都要，补全诗句 / 飞花令只要前者（见 ctx.onQuizMode 的说明）。
    // 早先这里只在 geo 分支调 onQuizMode(true)，顺手把 body.quiz-open 也交给了它，
    // 结果另外两种题型练习卡开着却没有 quiz-open：HUD 不隐藏、侧栏不让位。
    this.ctx.onQuizCard(true);
    if (type === 'geo') {
      const list = buildGeoQuiz(8);
      this.quiz = { type, list, index: 0, score: 0, answered: false };
      $('#quizKind').textContent = '看图识诗';
      this.ctx.onQuizMode(true);
    } else if (type === 'fill') {
      const list = buildFillQuiz(8);
      this.quiz = { type, list, index: 0, score: 0, answered: false };
      $('#quizKind').textContent = '补全诗句';
      this.ctx.onQuizMode(false);
    } else {
      this.quiz = { type: 'feihua', key: FEIHUA_KEYS[Math.floor(Math.random() * FEIHUA_KEYS.length)], found: [], hints: 0, score: 0, time: 90 };
      $('#quizKind').textContent = '飞花令';
      this.ctx.onQuizMode(false);
      this.startFeihuaTimer();
    }
    $('#quizCard').classList.remove('hidden');
    this.renderQuestion();
  }

  startFeihuaTimer() {
    clearInterval(this._ftimer);
    this._ftimer = setInterval(() => {
      if (!this.quiz || this.quiz.type !== 'feihua') { clearInterval(this._ftimer); return; }
      this.quiz.time -= 1;
      const el = $('#quizScore');
      if (el) el.textContent = `⏱ ${this.quiz.time}s　得分 ${this.quiz.score}`;
      if (this.quiz.time <= 0) {
        clearInterval(this._ftimer);
        this.renderFeihua(true);
      }
    }, 1000);
  }

  renderQuestion() {
    const q = this.quiz;
    if (!q) return;
    const body = $('#quizBody');
    const foot = $('#quizNext');
    $('#quizScore').textContent = q.type === 'feihua'
      ? `⏱ ${q.time}s　得分 ${q.score}`
      : `第 ${q.index + 1} / ${q.list.length} 题　得分 ${q.score}`;

    if (q.type === 'feihua') { this.renderFeihua(); return; }

    const cur = q.list[q.index];
    q.answered = false;
    body.innerHTML = '';

    const prompt = document.createElement('div');
    prompt.className = 'quiz-prompt';
    prompt.textContent = cur.prompt;
    body.appendChild(prompt);

    const hint = document.createElement('div');
    hint.className = 'quiz-hint';
    hint.textContent = q.type === 'geo'
      ? '请在地图上点击这句诗所写的地点，或从下方选择'
      : '请选择与上句相接的下句';
    body.appendChild(hint);

    const choices = document.createElement('div');
    choices.className = 'quiz-choices';
    (q.type === 'geo' ? cur.choices.map((c) => ({ label: c.name, id: c.id })) : cur.choices.map((c) => ({ label: c, id: c })))
      .forEach((c) => {
        const b = document.createElement('button');
        b.textContent = c.label;
        b.onclick = () => this.answerQuiz(c.id, b);
        choices.appendChild(b);
      });
    body.appendChild(choices);

    const fb = document.createElement('div');
    fb.className = 'quiz-feedback';
    fb.id = 'quizFeedback';
    body.appendChild(fb);
    foot.textContent = q.index === q.list.length - 1 ? '查看成绩 →' : '下一题 →';
  }

  /** 地图点击作答（看图识诗） */
  answerGeoByMap(siteId) {
    if (!this.quiz || this.quiz.type !== 'geo' || this.quiz.answered) return false;
    const cur = this.quiz.list[this.quiz.index];
    const btns = $$('#quizBody .quiz-choices button');
    const target = btns.find((b) => b.textContent === cur.answerName);
    this.answerQuiz(siteId, target);
    return true;
  }

  answerQuiz(id, btn) {
    const q = this.quiz;
    if (!q || q.answered) return;
    const cur = q.list[q.index];
    const correct = q.type === 'geo' ? id === cur.answer : id === cur.answer;
    q.answered = true;
    if (correct) q.score += 10;

    const btns = $$('#quizBody .quiz-choices button');
    btns.forEach((b) => {
      b.disabled = true;
      const label = b.textContent;
      const isRight = q.type === 'geo' ? label === cur.answerName : label === cur.answer;
      if (isRight) b.classList.add('right');
      else if (b === btn) b.classList.add('wrong');
    });

    const fb = $('#quizFeedback');
    fb.classList.add('show');
    fb.innerHTML = `<span class="${correct ? 'ok' : 'no'}">${correct ? '✓ 答对了' : '✗ 再想想'}</span>　${cur.explanation}`;
    $('#quizScore').textContent = `第 ${q.index + 1} / ${q.list.length} 题　得分 ${q.score}`;
    this.ctx.onQuizFeedback(correct, cur.siteId || cur.answer);
  }

  nextQuestion() {
    const q = this.quiz;
    if (!q) return;
    if (q.type === 'feihua') { this.closeQuiz(); return; }
    if (q.index >= q.list.length - 1) {
      const total = q.list.length * 10;
      this.toast(`练习结束：得分 ${q.score} / ${total}`);
      $('#quizBody').innerHTML =
        `<div class="quiz-prompt">练习结束</div><div class="quiz-hint">本次得分 <b style="color:#4fd1b0">${q.score}</b> / ${total}</div>`;
      $('#quizFeedback')?.classList.remove('show');
      $('#quizNext').textContent = '再来一轮 →';
      q.index = -1;
      return;
    }
    if (q.index === -1) { this.startQuiz(q.type); return; }
    q.index += 1;
    this.renderQuestion();
  }

  renderFeihua(over = false) {
    const q = this.quiz;
    const body = $('#quizBody');
    body.innerHTML = '';

    const key = document.createElement('div');
    key.className = 'feihua-key';
    key.textContent = q.key;
    body.appendChild(key);

    const hint = document.createElement('div');
    hint.className = 'quiz-hint';
    hint.innerHTML = `说出含有「<b style="color:#e8c07a">${q.key}</b>」字的诗句，一句 10 分` +
      (over ? '　<span style="color:#e2705a">时间到</span>' : '');
    body.appendChild(hint);

    if (!over) {
      const wrap = document.createElement('div');
      wrap.className = 'quiz-input';
      const inp = document.createElement('input');
      inp.placeholder = '输入诗句后回车，如「床前明月光」';
      inp.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
      const btn = document.createElement('button');
      btn.textContent = '接令';
      const submit = () => {
        const v = inp.value.trim();
        if (!v) return;
        if (!v.includes(q.key)) { this.toast(`诗句里要有「${q.key}」字`); return; }
        if (q.found.some((f) => f.text === v)) { this.toast('这句已经说过啦'); return; }
        const hit = linesWithChar(q.key).find((l) => l.text.includes(v.replace(/[，。？！；：、\s]/g, '')));
        q.found.push({
          text: v,
          title: hit ? hit.title : '（库外诗句）',
          author: hit ? hit.author : '',
          siteName: hit ? hit.siteName : '',
          inBank: !!hit,
        });
        q.score += hit ? 10 : 5;
        inp.value = '';
        this.renderFeihua();
        // 立即刷新得分并交还焦点：得分原本只在计时器每秒 tick 时更新，
        // 接令后要等最多 1 秒才跳数字，看起来像没计上分。
        $('#quizScore').textContent = `⏱ ${q.time}s　得分 ${q.score}`;
        $('#quizBody input')?.focus();
        this.ctx.onQuizFeedback(true, hit ? hit.siteId : null);
      };
      btn.onclick = submit;
      wrap.append(inp, btn);
      body.appendChild(wrap);
    }

    const list = document.createElement('div');
    list.className = 'feihua-list';
    q.found.forEach((f) => {
      const d = document.createElement('div');
      d.innerHTML = `${f.text}<span>${f.author ? f.author + '《' + f.title + '》' : '库外诗句'} ${f.siteName ? '· ' + f.siteName : ''}</span>`;
      list.appendChild(d);
    });
    if (!q.found.length) list.innerHTML = `<div style="border-color:rgba(255,255,255,0.15);color:rgba(242,216,216,0.4)">还没有接到诗句…</div>`;
    body.appendChild(list);

    if (over) {
      const ans = buildFeihua(q.key, 6);
      const box = document.createElement('div');
      box.className = 'feihua-list';
      box.innerHTML = `<div style="border-color:rgba(232,192,122,0.5);color:#e8c07a">参考答案：</div>` +
        ans.map((a) => `<div>${a.text}<span>${a.author}《${a.title}》 · ${a.siteName}</span></div>`).join('');
      body.appendChild(box);
      $('#quizScore').textContent = `本局得分 ${q.score}`;
    }
    $('#quizNext').textContent = over ? '关闭' : '结束本局';
  }

  /* ================= 提示 ================= */
  toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(this._tt);
    this._tt = setTimeout(() => t.classList.remove('show'), 2200);
  }

  showHoverTip(x, y, text) {
    const tip = $('#hoverTip');
    if (!text) { tip.classList.add('hidden'); return; }
    tip.textContent = text;
    tip.style.left = `${x + 14}px`;
    tip.style.top = `${y + 12}px`;
    tip.classList.remove('hidden');
  }

  /**
   * HUD 经纬度读数。decimals 由调用方按当前缩放级别给出（拉近→位数更多），
   * 默认 2 位，与历史行为一致。
   */
  updateHud(lon, lat, decimals = 2) {
    const d = Math.min(6, Math.max(0, decimals | 0));
    $('#hudLon').textContent = lon == null ? '—' : `${lon.toFixed(d)}°E`;
    $('#hudLat').textContent = lat == null ? '—' : `${lat.toFixed(d)}°N`;
  }
}
