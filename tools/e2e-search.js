/* 浏览器端回归脚本（在页面上下文里跑，通过 agent-browser eval 注入）。
 * 重点覆盖上一轮出过假阳性的搜索下拉框：断言的是渲染结果 getComputedStyle().display，
 * 而不是 classList.contains('hidden')（那是意图，不是事实）。
 */
(() => {
  const R = [];
  const rec = (name, pass, extra = '') => R.push({ name, pass, extra });
  const box = document.querySelector('#searchResults');
  const input = document.querySelector('#searchInput');
  const clear = document.querySelector('#searchClear');
  const hiddenNow = () => getComputedStyle(box).display === 'none';
  const fire = (el, type, init = {}) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
  const realClick = (el) => { fire(el, 'pointerdown'); fire(el, 'mousedown'); fire(el, 'pointerup'); fire(el, 'mouseup'); fire(el, 'click'); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  return (async () => {
    /* ---------- 1. 搜索下拉框：10 条关闭路径 ---------- */
    const openSearch = async (kw) => {
      input.focus();
      input.value = kw;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(320);
    };

    await openSearch('月');
    rec('搜索框：输入后应展开', !hiddenNow(), box.innerHTML.length + ' chars');

    // 1) 点搜索结果项
    const first = box.querySelector('div,li,a,button');
    if (first) { realClick(first); await sleep(120); }
    rec('路径1 点结果项 → 关闭', hiddenNow());

    // 2) 点“清空”按钮
    await openSearch('月');
    realClick(clear); await sleep(120);
    rec('路径2 点清空按钮 → 关闭', hiddenNow());

    // 3) 点空白区域（搜索框之外）
    await openSearch('月');
    fire(document.body, 'pointerdown'); await sleep(120);
    rec('路径3 点空白区域 → 关闭', hiddenNow());

    // 4) 点地图画布
    await openSearch('月');
    fire(document.querySelector('#scene'), 'pointerdown'); await sleep(120);
    rec('路径4 点地图画布 → 关闭', hiddenNow());

    // 5) Esc（输入框内）
    await openSearch('月');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(120);
    rec('路径5 输入框内按 Esc → 关闭', hiddenNow());

    // 6) Esc（全局，焦点不在输入框）
    await openSearch('月');
    document.body.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(120);
    rec('路径6 全局按 Esc → 关闭', hiddenNow());

    // 7) 回车跳转后应关闭
    await openSearch('月');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(200);
    rec('路径7 回车选中 → 关闭', hiddenNow());

    // 8) 清空输入框内容后应关闭（用户反馈的场景）
    await openSearch('李白');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(320);
    rec('路径8 清空输入内容 → 关闭', hiddenNow());

    // 9) 点侧栏
    await openSearch('月');
    fire(document.querySelector('#siteList'), 'pointerdown'); await sleep(120);
    rec('路径9 点侧栏列表 → 关闭', hiddenNow());

    // 10) 点朝代筛选按钮
    await openSearch('月');
    fire(document.querySelector('#dynastyChips'), 'pointerdown'); await sleep(120);
    rec('路径10 点筛选栏 → 关闭', hiddenNow());

    // 收尾：确认搜索仍可用
    await openSearch('月');
    const n1 = box.querySelectorAll('*').length;
    rec('搜索仍可用（有关键字结果）', !hiddenNow() && n1 > 0, n1 + ' nodes');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(320);

    /* ---------- 2. 朝代筛选：新增「课内诵读」档 ---------- */
    const chips = [...document.querySelectorAll('#dynastyChips button')];
    const readChip = chips.find((b) => b.textContent === '课内诵读');
    rec('存在「课内诵读」朝代档', !!readChip);
    if (readChip) {
      realClick(readChip); await sleep(300);
      const vis = [...document.querySelectorAll('#siteList .site-row')].filter((r) => r.style.display !== 'none');
      rec('选「课内诵读」只剩 1 个诗境', vis.length === 1, vis.map((r) => r.querySelector('.rn').textContent).join(','));
      rec('且该诗境正是「课内诵读」', vis[0] && vis[0].querySelector('.rn').textContent === '课内诵读');
      realClick(readChip); await sleep(300);
    }

    /* ---------- 3. 主题筛选：新增「诵读」 ---------- */
    const tChips = [...document.querySelectorAll('#themeChips button')];
    const readTheme = tChips.find((b) => b.textContent === '诵读');
    rec('存在「诵读」主题', !!readTheme);
    if (readTheme) {
      realClick(readTheme); await sleep(300);
      const vis = [...document.querySelectorAll('#siteList .site-row')].filter((r) => r.style.display !== 'none');
      rec('选「诵读」主题只剩 1 个诗境', vis.length === 1, String(vis.length));
      realClick(readTheme); await sleep(300);
    }

    /* ---------- 4. 地域筛选：新增「课内诵读」地域 ---------- */
    const rChips = [...document.querySelectorAll('#regionChips button')];
    rec('地域栏 4 个按钮', rChips.length === 4, rChips.map((b) => b.textContent).join(','));
    if (rChips[3]) {
      realClick(rChips[3]); await sleep(300);
      const vis = [...document.querySelectorAll('#siteList .site-row')].filter((r) => r.style.display !== 'none');
      rec('选「课内诵读」地域只剩 1 个诗境', vis.length === 1, String(vis.length));
      realClick(rChips[3]); await sleep(300);
    }

    /* ---------- 5. 全部重置 ---------- */
    const reset = document.querySelector('#btnResetFilter');
    if (reset) { realClick(reset); await sleep(300); }
    const afterReset = [...document.querySelectorAll('#siteList .site-row')].filter((r) => r.style.display !== 'none');
    rec('重置后 79 个诗境全部可见', afterReset.length === 79, String(afterReset.length));

    return R;
  })();
})()
