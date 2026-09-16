// 朝代 / 主题 / 诗人行迹 / 地域

export const DYNASTIES = [
  { id: 'xy', name: '先秦', note: '前11世纪—前221', color: '#9b8cf0' },
  { id: 'hw', name: '汉魏', note: '前202—265', color: '#5aa9d6' },
  { id: 'jn', name: '两晋南北朝', note: '265—589', color: '#49bfa8' },
  { id: 'tang', name: '唐', note: '618—907', color: '#e6a63c' },
  { id: 'song', name: '宋', note: '960—1279', color: '#e2705a' },
  { id: 'yh', name: '元明清', note: '1271—1912', color: '#b183e0' },
  // 非朝代档：教材中确实系不到具体地点的篇目集中收纳于此（见 sites-reading.js）。
  // 单列一档而不是塞进某个朝代，是为了让「课本里出现过哪些古诗词」可以直接对着清单看。
  { id: 'read', name: '课内诵读', note: '跨代专题', color: '#8fb6d6' },
];

export const THEMES = ['山水', '田园', '边塞', '送别', '思乡', '羁旅', '咏史', '咏怀', '登临', '诵读'];

export const REGIONS = [
  { id: 'north', name: '北方 · 塞外', desc: '黄河以北与河西走廊、西域，边塞诗与建安风骨的诞生地' },
  { id: 'central', name: '中原 · 华中 · 西南', desc: '长江中上游与巴蜀，山水诗、咏史诗的重镇' },
  { id: 'south', name: '江南 · 东南 · 岭南', desc: '长江下游与岭南，田园、送别与咏史的名篇之乡' },
  { id: 'read', name: '课内诵读 · 跨代专题', desc: '教材里没有明确地理出处的名篇，集中收纳，不系于一城一地' },
];

// 诗人行迹：按时间顺序排列的站点
export const ROUTES = [
  {
    id: 'libai', name: '李白', title: '仗剑去国，辞亲远游', color: '#ffd479',
    desc: '从峨眉山月到白帝城，李白一生走过大半个中国。二十五岁出蜀，四十岁入长安，五十九岁遇赦东归，足迹横跨七千里。',
    stops: [
      { site: 'emeishan', year: '724', note: '二十四岁出蜀，山月相伴' },
      { site: 'lushan', year: '725', note: '南游吴楚，望庐山瀑布' },
      { site: 'huanghelou', year: '730', note: '江夏送孟浩然下扬州' },
      { site: 'yangzhou', year: '730', note: '烟花三月下扬州' },
      { site: 'changan', year: '742', note: '奉诏入京，供奉翰林' },
      { site: 'luoyang', year: '744', note: '赐金放还，东都遇杜甫' },
      { site: 'youzhoutai', year: '752', note: '北游幽州，探安禄山虚实' },
      { site: 'jingtingshan', year: '753', note: '七游宣城，独坐敬亭山' },
      { site: 'baidicheng', year: '759', note: '流放夜郎途中遇赦，千里江陵一日还' },
    ],
  },
  {
    id: 'dufu', name: '杜甫', title: '漂泊西南天地间', color: '#8fd6c8',
    desc: '青年时望岳泰山，中年困守长安，晚年携家入蜀，在成都草堂度过最安定的一段，最终病逝于湘江舟中。',
    stops: [
      { site: 'taishan', year: '736', note: '二十四岁望岳，一览众山小' },
      { site: 'changan', year: '746', note: '困守长安十年' },
      { site: 'jianmenguan', year: '759', note: '携家入蜀，穿剑门' },
      { site: 'chengducaotang', year: '761', note: '浣花溪畔筑草堂，春夜喜雨' },
      { site: 'baidicheng', year: '766', note: '滞留夔州，登高作七律之冠' },
      { site: 'yueyanglou', year: '768', note: '出峡漂泊，登岳阳楼' },
    ],
  },
  {
    id: 'sushi', name: '苏轼', title: '一蓑烟雨任平生', color: '#ff9b7a',
    desc: '从杭州到黄州，从惠州到儋州——苏轼的贬谪路线，也是一条把苦难写成诗的路。',
    stops: [
      { site: 'yangzhou', year: '1085', note: '知扬州，竹西佳处' },
      { site: 'xihu', year: '1089', note: '知杭州，疏浚西湖筑苏堤' },
      { site: 'chibi', year: '1082', note: '贬黄州，大江东去' },
      { site: 'huizhou', year: '1094', note: '贬惠州，日啖荔枝三百颗' },
      { site: 'danzhou', year: '1097', note: '贬儋州，九死南荒吾不恨' },
    ],
  },
  {
    id: 'wangwei', name: '王维', title: '诗中有画，画中有诗', color: '#9fd08a',
    desc: '半官半隐于辋川，也曾奉使出塞。王维把山水写成了禅，把离别写成了清茶。',
    stops: [
      { site: 'changan', year: '717', note: '少年入长安，重阳忆兄弟' },
      { site: 'wangchuan', year: '740', note: '营辋川别业，山居秋暝' },
      { site: 'liangzhou', year: '737', note: '出使河西节度幕' },
      { site: 'yangguan', year: '740', note: '渭城朝雨，西出阳关无故人' },
    ],
  },
  {
    id: 'menghaoran', name: '孟浩然', title: '山水清音，布衣诗人', color: '#7ec8e3',
    desc: '一生未仕，却与李白、王维、王昌龄交好。襄阳鹿门山的隐居，吴越江湖的漫游，构成他全部的人生。',
    stops: [
      { site: 'lumen', year: '720', note: '隐居鹿门山，春眠不觉晓' },
      { site: 'huanghelou', year: '728', note: '江夏与李白相识' },
      { site: 'yangzhou', year: '728', note: '烟花三月下扬州' },
      { site: 'jiandejiang', year: '730', note: '漫游吴越，宿建德江' },
      { site: 'yueyanglou', year: '733', note: '望洞庭湖，赠张丞相' },
    ],
  },
  {
    id: 'baijuyi', name: '白居易', title: '文章合为时而著', color: '#e8c07d',
    desc: '从长安的谏官，到江州的司马，再到杭州、苏州的刺史，最后归隐洛阳香山。他的诗写尽了普通人的悲欢。',
    stops: [
      { site: 'changan', year: '807', note: '任翰林学士、左拾遗' },
      { site: 'lushan', year: '815', note: '贬江州司马，浔阳江头夜送客' },
      { site: 'xihu', year: '822', note: '任杭州刺史，钱塘湖春行' },
      { site: 'luoyang', year: '829', note: '晚年归洛阳，赏牡丹' },
    ],
  },
  {
    id: 'hanyu', name: '韩愈', title: '一封朝奏九重天', color: '#c9a0ff',
    desc: '文起八代之衰。因上《论佛骨表》被贬潮州，途经蓝关遇雪，写下最沉痛的一首七律。',
    stops: [
      { site: 'luoyang', year: '800', note: '登进士第前后往来东都' },
      { site: 'changan', year: '819', note: '上《论佛骨表》，触怒宪宗' },
      { site: 'languan', year: '819', note: '贬潮州，雪拥蓝关马不前' },
    ],
  },
  {
    id: 'xinqiji', name: '辛弃疾', title: '把吴钩看了，栏杆拍遍', color: '#ff8fa3',
    desc: '二十一岁起义抗金，南归后却屡遭闲废。他把一生未酬的壮志，全部写进了词里。',
    stops: [
      { site: 'chuzhou', year: '1172', note: '知滁州，宽政薄赋' },
      { site: 'beigushan', year: '1204', note: '知镇江府，登北固亭怀古' },
    ],
  },
  {
    id: 'luyou', name: '陆游', title: '细雨骑驴入剑门', color: '#a3d977',
    desc: '四十八岁入蜀任职，是他一生最壮阔的九年。从山阴到夔州，从剑门到成都，再东归故里。',
    stops: [
      { site: 'kuaiji', year: '1160', note: '居山阴，游山西村' },
      { site: 'baidicheng', year: '1170', note: '任夔州通判，入蜀' },
      { site: 'jianmenguan', year: '1172', note: '细雨骑驴入剑门' },
      { site: 'chengducaotang', year: '1173', note: '在成都幕府任职' },
      { site: 'kuaiji', year: '1178', note: '东归山阴，终老故园' },
    ],
  },
  {
    id: 'liuyuxi', name: '刘禹锡', title: '沉舟侧畔千帆过', color: '#5ec8f0',
    desc: '参与永贞革新，半年而败，此后二十三年贬谪在外。别人悲秋，他偏说「我言秋日胜春朝」；别人伤怀，他写下「沉舟侧畔千帆过」。',
    stops: [
      { site: 'changan', year: '805', note: '参与永贞革新，半年而败' },
      { site: 'langzhou', year: '805', note: '贬朗州司马，十年不召，作《秋词》' },
      { site: 'yueyanglou', year: '824', note: '赴和州任，途经洞庭，作《望洞庭》' },
      { site: 'qinhuai', year: '826', note: '罢和州过金陵，作《乌衣巷》《石头城》' },
      { site: 'yangzhou', year: '826', note: '与白居易扬州相逢，酬乐天见赠' },
      { site: 'luoyang', year: '830', note: '晚年居洛阳，与白居易唱和' },
    ],
  },
  {
    id: 'dumu', name: '杜牧', title: '十年一觉扬州梦', color: '#ffb570',
    desc: '宰相杜佑之孙，二十六岁进士及第。少年得意，中年却在扬州幕府消磨了十年；晚年在黄州、池州任上，把咏史写得比谁都清醒。',
    stops: [
      { site: 'changan', year: '828', note: '进士及第，又登制科，少年得意' },
      { site: 'huaqinggong', year: '831', note: '过骊山华清宫，长安回望绣成堆' },
      { site: 'yangzhou', year: '833', note: '入牛僧孺扬州幕府，十年一觉' },
      { site: 'qinhuai', year: '836', note: '夜泊秦淮，商女不知亡国恨' },
      { site: 'chibi', year: '842', note: '任黄州刺史，折戟沉沙认前朝' },
      { site: 'xinghuacun', year: '844', note: '任池州刺史，清明时节雨纷纷' },
    ],
  },
  {
    id: 'wangchangling', name: '王昌龄', title: '一片冰心在玉壶', color: '#f47c9a',
    desc: '「七绝圣手」。早年西出边塞写下《出塞》《从军行》，中年任江宁丞在芙蓉楼送别辛渐，晚岁远贬龙标，李白为他写下「我寄愁心与明月」。',
    stops: [
      { site: 'yumenguan', year: '725', note: '西北从军，秦时明月汉时关' },
      { site: 'qinghaihu', year: '728', note: '《从军行》：黄沙百战穿金甲' },
      { site: 'kuaiji', year: '735', note: '漫游吴越，作《采莲曲》' },
      { site: 'beigushan', year: '740', note: '任江宁丞，芙蓉楼送辛渐' },
      { site: 'longbiao', year: '748', note: '左迁龙标，李白遥寄此心明月' },
    ],
  },
  {
    id: 'cencan', name: '岑参', title: '忽如一夜春风来', color: '#d4e157',
    desc: '盛唐边塞诗人的代表。两度出塞，在天山北麓的轮台幕府写下最奇丽的边塞雪景——「忽如一夜春风来，千树万树梨花开」。',
    stops: [
      { site: 'changan', year: '749', note: '辞京西行，赴安西幕府' },
      { site: 'yumenguan', year: '750', note: '出玉门关，故园东望路漫漫' },
      { site: 'luntai', year: '754', note: '轮台送武判官归京，千树万树梨花开' },
    ],
  },
  {
    id: 'wanganshi', name: '王安石', title: '不畏浮云遮望眼', color: '#6ea8ff',
    desc: '年少登飞来峰，壮年入汴京主持熙宁变法，晚年罢相退居江宁半山园。一生大起大落，诗却越写越淡。',
    stops: [
      { site: 'xihu', year: '1050', note: '登飞来峰，不畏浮云遮望眼' },
      { site: 'yangzhou', year: '1068', note: '奉诏赴京，泊船瓜洲，明月何时照我还' },
      { site: 'bianjing', year: '1069', note: '熙宁变法，推行新法' },
      { site: 'jinling', year: '1076', note: '罢相退居半山园，作《梅花》《书湖阴先生壁》' },
    ],
  },
  {
    id: 'fanzhongyan', name: '范仲淹', title: '先天下之忧而忧', color: '#ffd166',
    desc: '在西北边塞写下第一首真正的宋词边塞之作，在洞庭湖畔写下「先天下之忧而忧」。为官、为将、为文，他都站在最前面。',
    stops: [
      { site: 'songjiang', year: '1034', note: '知苏州，江上往来人但爱鲈鱼美' },
      { site: 'yanzhou', year: '1040', note: '经略陕西，塞下秋来风景异' },
      { site: 'yueyanglou', year: '1046', note: '应滕子京之请，作《岳阳楼记》' },
    ],
  },
  {
    id: 'liqingzhao', name: '李清照', title: '生当作人杰', color: '#c77dff',
    desc: '济南的溪亭日暮里走出的少女词人，与赵明诚共治金石的汴京岁月，都在靖康之乱里碎尽。南渡过乌江，她写下「生当作人杰，死亦为鬼雄」。',
    stops: [
      { site: 'jinan', year: '1098', note: '少女时代居济南，溪亭日暮沉醉忘归' },
      { site: 'bianjing', year: '1101', note: '嫁赵明诚，共治金石录' },
      { site: 'wujiang', year: '1129', note: '南渡过乌江，生当作人杰' },
    ],
  },
];

// 飞花令候选令字
export const FEIHUA_KEYS = ['月', '江', '山', '风', '花', '雪', '雨', '云', '春', '秋', '酒', '水', '天', '日', '鸟', '草'];
