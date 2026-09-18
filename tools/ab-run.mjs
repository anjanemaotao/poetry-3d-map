/* 在页面上下文里执行「长脚本」的公共执行器（本地开发用）。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────
 * 直接 `agent-browser eval <整个脚本>` 有一个隐藏的硬上限：**单次 eval 的等待时间**。
 * 实测（本机 macOS / agent-browser 0.25.3）：
 *
 *     eval "(async()=>{await sleep(20000);return ['ok']})()"   → ✅ 21s 正常返回
 *     eval "(async()=>{await sleep(90000);return ['ok']})()"   → ❌ 2m35s 后失败
 *         ✗ Failed to read: Resource temporarily unavailable (os error 35)
 *           (after 5 retries - daemon may be busy or unresponsive)
 *
 * 注意报错文案完全指不到「脚本太长」这件事上 —— 它长得像 daemon 挂了 / 端口不通 /
 * 环境坏了。真实历史上就因此被误判过一次：e2e-region.js 断言越加越多，
 * 累计 sleep 从 ~40s 涨到 ~47s 越过了这条线，于是被当成「脚本里有 bug」排查了半天，
 * 而同一份脚本拆短跑却全绿。
 *
 * ── 办法：把「执行」和「取结果」拆成两次很短的 eval ────────────
 *   1) 派发：把脚本包一层，挂到 window 上异步跑，eval 立刻返回 'started'；
 *   2) 轮询：每隔一小段时间问一次 done 没有（每次 eval 都是毫秒级）；
 *   3) 取结果：done 之后单独取一次返回值。
 * 这样任何一次 eval 都不会逼近上限，脚本多长都不怕。
 *
 * 顺带的好处：脚本中途抛异常时，异常堆栈能原样带回来（以前只会得到
 * 「Command failed: agent-browser eval ...」，堆栈被 CLI 吞掉，只能靠二分注释定位）。
 */
import { execFileSync } from 'node:child_process';

/** agent-browser 的同步封装。maxBuffer 给大：有的脚本返回值是几百条断言的 JSON。 */
export const makeAb =
  (bin = 'agent-browser') =>
  (args) =>
    execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** 同步睡一会儿，不占 CPU（busy loop 会把 daemon 的管道打满）。 */
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const KEY = '__E2E_ASYNC__';

/**
 * 从 CLI 输出里抠出 JSON。输出是 pretty-printed JSON，可能夹带提示行，
 * 所以从首个 `{` / `[` 截到末个 `}` / `]`。
 */
function parseAny(out) {
  const s = out.trim();
  const iObj = s.indexOf('{');
  const iArr = s.indexOf('[');
  let i;
  if (iObj < 0) i = iArr;
  else if (iArr < 0) i = iObj;
  else i = Math.min(iObj, iArr);
  /* 没有括号不等于坏输出 —— 脚本可以 `return 1` / `return 'ok'`（截图、设置状态这类
     只关心「跑完了没有」的脚本就是这么写的）。此时整段就是一个合法 JSON 标量，
     直接解析即可。早期这里一律抛「输出里找不到 JSON」，把标量返回值误判成失败。 */
  if (i < 0) return JSON.parse(s);
  const j = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
  if (j < i) throw new Error('输出里找不到 JSON 结束符：\n' + s.slice(0, 400));
  return JSON.parse(s.slice(i, j + 1));
}

/** eval 一个表达式并返回其 JSON 化结果（结果为空 / 非 JSON 时返回 null）。 */
export function evalJson(ab, expr) {
  try {
    return parseAny(ab(['eval', expr]));
  } catch {
    return null;
  }
}

/** eval 一个短表达式，返回去掉首尾引号与空白的字符串。 */
export function evalText(ab, expr) {
  return ab(['eval', expr]).trim().replace(/^"(.*)"$/s, '$1');
}

/**
 * 执行一段「页面上下文脚本」并拿回它的返回值。
 *
 * @param ab        makeAb() 得到的执行器
 * @param source    脚本源码。**必须是表达式**（项目里各脚本都是 `(() => {...})()` 形式，
 *                  或 `(async () => {...})()`），因为它会被塞进 `() => (${source})` 里。
 * @param label     出错信息里显示的名字，一般传文件名
 * @param timeoutMs 整体超时（默认 5 分钟）
 * @param pollMs    轮询间隔（默认 800ms）
 * @param onTick    每轮回调，可用来打进度点（脚本卡住时能看出还活着）
 */
export function runScript(ab, source, { label = 'script', timeoutMs = 300000, pollMs = 800, onTick } = {}) {
  /* 去掉**结尾的分号**再塞进括号里。
     各脚本有的写成 `(() => {...})()`、有的写成 `(() => {...})();` —— 后者套上括号
     就成了 `( ... })(); )`，那个分号是纯语法错误（`SyntaxError: Unexpected token ';'`），
     而且报错发生在**页面里**，看起来像是脚本自己的毛病。
     实测：e2e-region.js / e2e-layout.js 结尾没分号（侥幸通过），
     e2e-zoom.js / e2e-earth.js 有分号（当场炸）。统一在这里剥掉。 */
  const src = String(source).trim().replace(/;+$/, '');

  /* 派发。`Promise.resolve().then(() => (src))` 而不是 `Promise.resolve(src)`：
     后者会**同步**求值 src，长脚本里第一段同步代码（比如逐格扫描经纬度）会在
     这次 eval 里跑完才返回，白白吃掉配额。放进 then 里就彻底异步了。 */
  const boot = `(() => {
  const K = ${JSON.stringify(KEY)};
  window[K] = { done: false, R: null, err: null };
  Promise.resolve()
    .then(() => (${src}))
    .then((R) => { window[K].R = R; window[K].done = true; })
    .catch((e) => { window[K].err = (e && (e.stack || e.message)) || String(e); window[K].done = true; });
  return 'started';
})()`;
  ab(['eval', boot]);

  const t0 = Date.now();
  for (;;) {
    /* 轮询表达式本身也怕被页面主线程挡住（脚本里有同步的重活），
       所以给它加一层：读不到就当作「还在跑」。 */
    const st = evalText(ab, `(window[${JSON.stringify(KEY)}] && window[${JSON.stringify(KEY)}].done) ? (window[${JSON.stringify(KEY)}].err ? 'E' : 'D') : 'R'`);
    if (st === 'D' || st === 'E') break;
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`${label} 超时：${timeoutMs}ms 内没跑完`);
    }
    if (onTick) onTick(Math.round((Date.now() - t0) / 1000));
    nap(pollMs);
  }

  const err = evalText(ab, `window[${JSON.stringify(KEY)}].err`);
  if (err && err !== 'null' && err !== 'undefined') {
    throw new Error(`${label} 脚本内抛出异常：\n${err}`);
  }
  const R = parseAny(ab(['eval', `window[${JSON.stringify(KEY)}].R`]));
  /* 用完就撤，免得下次导航前残留（reload 其实也会清，但显式一点更好读）。 */
  ab(['eval', `delete window[${JSON.stringify(KEY)}]; 'ok'`]);
  return { R, ms: Date.now() - t0 };
}
