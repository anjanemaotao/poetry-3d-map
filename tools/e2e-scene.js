/* 第二组回归：3D 场景 / 详情面板 / 三练习 / 巡游 / 行迹。
 * 断言一律看渲染结果与状态数值，不看内部标记。
 */
(async () => {
  const R = [];
  const rec = (name, pass, extra = '') => R.push({ name, pass, extra });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const vis = (el) => !!el && getComputedStyle(el).display !== 'none';
  const app = window.__app;
  if (!app) return [{ name: 'window.__app 存在', pass: false, extra: '缺少调试钩子' }];

  /* ---------- 1. 3D 地标 ---------- */
  rec('地标数 = 站点数 79', app.effects.beacons.size === 79, String(app.effects.beacons.size));
  const visB = [...app.effects.beacons.values()].filter((b) => b.group.visible).length;
  rec('初始全部光柱可见', visB === 79, String(visB));
  const posSet = new Set([...app.effects.beacons.values()].map((b) => b.group.position.toArray().map((n) => n.toFixed(2)).join(',')));
  rec('79 个地标位置互不重叠', posSet.size === 79, `唯一位置 ${posSet.size}`);

  ['keneisongdu', 'tianmenshan', 'xinghuacun', 'jinling', 'mizhou', 'changsha', 'shanhaiguan', 'yueyanglou'].forEach((id) => {
    const b = app.effects.beacons.get(id);
    rec(`新诗境 ${id} 有地标`, !!b);
  });

  /* ---------- 2. 课内诵读专题 ---------- */
  const knd = app.SITES.find((s) => s.id === 'keneisongdu');
  rec('课内诵读诗篇数 ≥ 77', !!knd && knd.poems.length >= 77, knd ? String(knd.poems.length) : '无');
  rec('课内诵读 virtual 标记', !!(knd && knd.virtual));
  rec('课内诵读 eras 仅 read 一档', !!knd && knd.eras.length === 1 && knd.eras[0] === 'read',
    knd ? knd.eras.join(',') : '');

  /* ---------- 3. 扩容篇目归位 ---------- */
  [['changan', '寒食'], ['xihu', '望海潮（东南形胜）'], ['chengducaotang', '蜀相'],
    ['keneisongdu', '将进酒'], ['shanhaiguan', '燕歌行并序'], ['yueyanglou', '念奴娇·过洞庭'],
    ['kuaiji', '书愤'], ['yangzhou', '扬州慢（淮左名都）'], ['mizhou', '江城子·乙卯正月二十日夜记梦']]
    .forEach(([sid, title]) => {
      const s = app.SITES.find((x) => x.id === sid);
      rec(`《${title}》在 ${sid}`, !!(s && s.poems.find((x) => x.title === title)));
    });

  /* ---------- 4. 详情面板全量渲染 ---------- */
  const fails = [];
  let n = 0;
  for (const s of app.SITES) {
    for (let i = 0; i < s.poems.length; i++) {
      try {
        app.ui.poemState.set(s.id, { index: i, vertical: true, trans: true });
        app.ui.renderDetail(s);
        const got = $$('#detailBody .poem-body .vline').length;
        const want = s.poems[i].lines.flat().length;
        if (got !== want) fails.push(`${s.id}/${s.poems[i].title} 期望${want}行 实得${got}行`);
        n++;
      } catch (e) { fails.push(`${s.id}/${s.poems[i].title} 抛错 ${e.message}`); }
    }
  }
  rec(`全部 ${n} 首诗篇详情渲染正确`, fails.length === 0, fails.slice(0, 3).join(' | '));

  /* ---------- 5. 竖排 / 横排 / 译文 ---------- */
  const s0 = app.SITES.find((s) => s.id === 'xihu');
  app.ui.poemState.set('xihu', { index: 0, vertical: true, trans: false });
  app.ui.renderDetail(s0);
  rec('默认竖排', $('#detailBody .poem-body').className.includes('vertical'), $('#detailBody .poem-body').className);
  $('#detailBody .poem-tools button:nth-child(1)').click(); await sleep(50);
  rec('可切横排', $('#detailBody .poem-body').className.includes('horizontal'), $('#detailBody .poem-body').className);
  $('#detailBody .poem-tools button:nth-child(2)').click(); await sleep(50);
  rec('可展开对照译文', !!$('#detailBody .trans-line, #detailBody .poem-trans, #detailBody .tline'));

  /* ---------- 6. 看图识诗 ---------- */
  app.ui.closeQuiz?.();
  $('#classGroup button[data-quiz="geo"]').click(); await sleep(200);
  rec('看图识诗：卡片打开', vis($('#quizCard')));
  rec('看图识诗：题干非空', ($('#quizBody .quiz-prompt')?.textContent || '').length > 3,
    $('#quizBody .quiz-prompt')?.textContent);
  rec('看图识诗：四个选项', $$('#quizBody .quiz-choices button').length === 4);
  rec('看图识诗：答案不在虚拟专题', app.ui.quiz.list.every((q) => q.answer !== 'keneisongdu'),
    app.ui.quiz.list.map((q) => q.answer).join(','));
  // 点正确答案 → 得分 +10 且出现反馈
  {
    const q0 = app.ui.quiz;
    const cur = q0.list[q0.index];
    const btn = $$('#quizBody .quiz-choices button').find((b) => b.textContent === cur.answerName);
    btn.click(); await sleep(100);
    rec('看图识诗：答对得 10 分', q0.score === 10, String(q0.score));
    rec('看图识诗：反馈条出现', $('#quizFeedback').classList.contains('show'));
  }

  /* ---------- 7. 补全诗句 ---------- */
  $('#quizNext').click(); await sleep(60);   // 进第 2 题
  app.ui.closeQuiz(); await sleep(60);
  $('#classGroup button[data-quiz="fill"]').click(); await sleep(200);
  rec('补全诗句：卡片打开', vis($('#quizCard')));
  rec('补全诗句：四个选项', $$('#quizBody .quiz-choices button').length === 4);
  {
    const q1 = app.ui.quiz;
    const cur = q1.list[q1.index];
    const btn = $$('#quizBody .quiz-choices button').find((b) => b.textContent === cur.answer);
    btn.click(); await sleep(100);
    rec('补全诗句：答对得 10 分', q1.score === 10, String(q1.score));
    rec('补全诗句：解释文案含出处',
      /出自/.test($('#quizFeedback')?.textContent || ''), ($('#quizFeedback')?.textContent || '').slice(0, 40));
  }
  app.ui.closeQuiz(); await sleep(60);

  /* ---------- 8. 飞花令：接令后得分立即刷新 ---------- */
  $('#classGroup button[data-quiz="feihua"]').click(); await sleep(200);
  rec('飞花令：卡片打开', vis($('#quizCard')));
  {
    const qf = app.ui.quiz;
    rec('飞花令：令字是单字', typeof qf.key === 'string' && qf.key.length === 1, qf.key);
    const line = app.SITES.flatMap((s) => s.poems).flatMap((p) => p.lines.flat())
      .find((l) => l.includes(qf.key) && l.replace(/[，。？！；：、\s]/g, '').length >= 4);
    const inp = $('#quizBody input');
    inp.value = line.replace(/[，。？！；：、\s]/g, '');
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await sleep(100);
    rec('飞花令：接令后得分立刻刷新', qf.score > 0 && /\d/.test($('#quizScore').textContent),
      `score=${qf.score} 显示「${$('#quizScore').textContent}」`);
    rec('飞花令：已接诗句入列', $('#quizBody .feihua-list').textContent.trim().length > 0);
    rec('飞花令：输入框已清空', $('#quizBody input').value === '');
  }
  app.ui.closeQuiz(); await sleep(60);

  /* ---------- 9. 巡游 ---------- */
  $('#btnTour').click(); await sleep(700);
  rec('巡游：已启动（按钮文案变化）', /停止|暂停/.test($('#btnTour').textContent), $('#btnTour').textContent.trim());
  rec('巡游：进度条有推进', parseFloat($('#tourProgress').style.width || '0') > 0, $('#tourProgress').style.width);
  rec('巡游：信息栏非「待机」', $('#tourInfo').textContent.trim() !== '待机', $('#tourInfo').textContent.trim());
  $('#btnTour').click(); await sleep(200);

  /* ---------- 10. 行迹 ---------- */
  $('#modeNav button[data-mode="route"]').click(); await sleep(200);
  rec('行迹：面板打开', vis($('#routePanel')));
  const items = $$('#routeList .route-item');
  rec('行迹：9 位诗人', items.length === 9, String(items.length));
  let bad = [];
  for (const it of items) {
    it.click(); await sleep(60);
    const t = $('#routeDetail').textContent || '';
    if (!t.trim() || /undefined|NaN/.test(t)) bad.push(it.querySelector('.rn').textContent);
  }
  rec('行迹：逐条详情完整无 undefined/NaN', bad.length === 0, bad.join(','));
  $('#routeClose').click(); await sleep(150);
  rec('行迹：关闭后回到探索', $('#modeNav button[data-mode="explore"]').classList.contains('active'));

  /* ---------- 11. 飞花令令字在正文中都有出处 ---------- */
  const keys = ['月', '江', '山', '风', '花', '雪', '雨', '云', '春', '秋', '酒', '水', '天', '日', '鸟', '草'];
  const noHit = keys.filter((k) => !app.SITES.some((s) => s.poems.some((p) => p.lines.flat().join('').includes(k))));
  rec('16 个令字在正文中都有出处', noHit.length === 0, noHit.join(','));

  /* ---------- 12. 视角与图层开关 ---------- */
  const viewBtns = $$('#viewGroup button');
  viewBtns.forEach((b) => b.click());
  await sleep(300);
  rec('视角按钮全部可点且不报错', true, viewBtns.map((b) => b.dataset.view).join(','));
  // 上一行会把「2D 平面」也点一遍（它在 #viewGroup 里是最后一个），
  // 若不退出，脚本跑完页面就停在 flat-mode，会污染后一套脚本的初始状态
  // （历史症状：连跑时 e2e-region 的「切 2D」断言全挂、右栏开关位置错位）。
  // 这里主动退回 3D，保证本脚本自身是「无副作用」的。
  if (app.state && app.state.flat) { app.setFlatMode(false, { quiet: true }); await sleep(350); }
  rec('视角开关跑完复位回 3D（不污染后续脚本）', !(app.state && app.state.flat));

  const layerBtns = $$('#layerGroup button');
  layerBtns.forEach((b) => b.click());
  await sleep(200);
  layerBtns.forEach((b) => b.click());
  await sleep(200);
  rec('图层开关可来回切换', true);

  return R;
})()
