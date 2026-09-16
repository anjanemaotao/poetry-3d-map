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
    this.bindRegionBar();
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

  buildSiteList() {
    const box = $('#siteList');
    box.innerHTML = '';
    this.ctx.sites.forEach((s) => {
      const row = document.createElement('div');
      row.className = 'site-row';
      row.dataset.id = s.id;
      row.innerHTML = `<span class="dot" style="background:${ERA_HEX[s.era]}"></span>
        <span class="rn">${s.name}</span><span class="rs">${s.sub.split('·').slice(-1)[0]}</span>`;
      row.onclick = () => this.ctx.onSelectSite(s.id, { fly: true });
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
          d.onclick = () => {
            hide();
            this.ctx.onSelectSite(r.id, { fly: true, poemId: r.poemId, keyword: k });
          };
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
   */
  bindPanels() {
    this.panels = { left: $('#leftPanel'), right: $('#rightPanel') };
    const spec = [
      { key: 'left', btn: $('#toggleLeft'), cls: 'hide-left', closed: '›', open: '‹' },
      { key: 'right', btn: $('#toggleRight'), cls: 'hide-right', closed: '‹', open: '›' },
    ];

    spec.forEach(({ key, btn, cls, closed, open }) => {
      btn.onclick = () => {
        const hidden = document.body.classList.toggle(cls);
        this.panels[key].classList.toggle('collapsed', hidden);
        btn.querySelector('.pt-arrow').textContent = hidden ? closed : open;
        this.syncPanelToggles();
        this.ctx.onPanelChange();
      };
    });

    window.addEventListener('resize', () => this.syncPanelToggles());

    // 窄屏默认收起左栏，把地图让出来
    if (window.innerWidth <= 860) {
      document.body.classList.add('hide-left');
      this.panels.left.classList.add('collapsed');
      $('#toggleLeft').querySelector('.pt-arrow').textContent = '›';
    }
    this.syncPanelToggles();
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
    const cls = key === 'left' ? 'hide-left' : 'hide-right';
    if (!document.body.classList.contains(cls)) return;
    document.body.classList.remove(cls);
    this.panels[key].classList.remove('collapsed');
    const btn = key === 'left' ? $('#toggleLeft') : $('#toggleRight');
    btn.querySelector('.pt-arrow').textContent = key === 'left' ? '‹' : '›';
    this.syncPanelToggles();
    this.ctx.onPanelChange();
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
        if (mode !== 'route') this.ctx.onClearRoute();
        this.hideRegionBar();
        this.syncPanelToggles();
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
      <div class="d-sub">${poem.dynasty} · ${poem.author}${site ? ' · 收录于「' + site.name + '」' : ''}</div>`;
    body.appendChild(head);
    body.appendChild(this.buildPoemCard(poem, st, { modal: true, siteName: site ? site.name : '' }));

    body.scrollTop = 0;
    $('#poemModal').classList.remove('hidden');
  }

  closePoemModal() { $('#poemModal').classList.add('hidden'); }

  isPoemModalOpen() { return !$('#poemModal').classList.contains('hidden'); }

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
  bindRoutes() {
    const box = $('#routeList');
    box.innerHTML = '';
    ROUTES.forEach((r) => {
      const d = document.createElement('div');
      d.className = 'route-item';
      d.dataset.id = r.id;
      d.innerHTML = `<div class="rn" style="color:${r.color}">${r.name}</div>
        <div class="rt">${r.title}</div><div class="rc">行迹 ${r.stops.length} 站</div>`;
      d.onclick = () => {
        $$('#routeList .route-item').forEach((x) => x.classList.toggle('on', x === d));
        this.renderRouteDetail(r);
        this.ctx.onBuildRoute(r);
      };
      box.appendChild(d);
    });
    $('#routeClose').onclick = () => this.exitRouteMode();
  }

  /**
   * 退出行迹模式。
   * 面板、左栏、顶部模式按钮、地图上的行迹线与站点聚焦是同一件事的五个侧面，
   * 必须一起复位 —— 分散在三处各写一遍，迟早漏掉一个（比如只关了面板、
   * 地图上却还留着只显示行迹站点的聚焦状态）。
   */
  exitRouteMode() {
    $('#routePanel').classList.add('hidden');
    document.getElementById('leftPanel').style.display = '';
    $$('#modeNav button').forEach((x) => x.classList.toggle('active', x.dataset.mode === 'explore'));
    $$('#routeList .route-item').forEach((x) => x.classList.remove('on'));
    $('#routeDetail').innerHTML = '';
    this.syncPanelToggles();
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
      d.onclick = () => this.ctx.onSelectSite(s.site, { fly: true });
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

  updateHud(lon, lat) {
    $('#hudLon').textContent = lon == null ? '—' : `${lon.toFixed(2)}°E`;
    $('#hudLat').textContent = lat == null ? '—' : `${lat.toFixed(2)}°N`;
  }
}
