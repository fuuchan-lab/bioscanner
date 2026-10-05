#!/usr/bin/env node
/* 生体スキャナー — 合成信号による検証
 *
 * index.html の「解析の核」(==CORE:BEGIN== 〜 ==CORE:END==)をそのまま取り出し、
 * 生体・非生体の合成信号に通して検出率と誤検出率を測る。アプリと同じコードを
 * 動かすので、しきい値を調整したらこれを実行して数字を確かめる。
 *
 *   node tools/verify.mjs            既定(各条件 300 試行)
 *   node tools/verify.mjs --n 1000   試行数を変える
 *   node tools/verify.mjs --seed 7   乱数の種を変える
 *   node tools/verify.mjs --diag     周期の揺らぎの分布も表示する
 *   node tools/verify.mjs --set STAB_LO=0.003,STAB_HI=0.008
 *                                    核の定数を書き換えて試す(index.html は変えない)
 *
 * 乱数は種付きなので、同じ引数なら毎回同じ数字が出る。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/* ── 引数 ── */
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] != null ? Number(argv[i + 1]) : def;
};
const TRIALS = opt("n", 300);
const SEED = opt("seed", 1);

/* ── 解析の核を読み込む ── */
const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "index.html"), "utf8");
const m = html.match(/\/\* ==CORE:BEGIN== \*\/([\s\S]*?)\/\* ==CORE:END== \*\//);
if (!m) { console.error("index.html に解析の核の印が見つかりません"); process.exit(1); }
let src = m[1];
/* --set NAME=値,... で定数の宣言を書き換える */
const setArg = argv.includes("--set") ? argv[argv.indexOf("--set") + 1] || "" : "";
for (const kv of setArg.split(",").filter(Boolean)) {
  const [name, val] = kv.split("=");
  const re = new RegExp("\\b" + name + "(\\s*)=\\s*[-\\d.e/ ]+?(?=[,;])");
  if (!re.test(src)) { console.error("定数が見つかりません: " + name); process.exit(1); }
  src = src.replace(re, name + "$1= " + val);
}
const EXPORTS = ["NBUF", "FS", "SPEC_EVERY", "detrendWindow", "rhythmOf", "trackFreq", "mechOf", "R_TRACK", "MECH_DAMP",
  "RES_STEP", "MOVE_ON", "MOVE_OFF", "noiseOfRes", "moveThr", "motionFloor", "motionNorm"];
const core = new Function(src + "\nreturn {" + EXPORTS.join(",") + "};")();
const { NBUF, FS, SPEC_EVERY, detrendWindow, rhythmOf, trackFreq, mechOf, R_TRACK, MECH_DAMP,
  RES_STEP, MOVE_ON, MOVE_OFF, noiseOfRes, moveThr, motionFloor, motionNorm } = core;
const DIAG = argv.includes("--diag");

/* ── 種付き乱数 ── */
let rs = SEED >>> 0 || 1;
const rand = () => {                     /* mulberry32 */
  rs = (rs + 0x6D2B79F5) >>> 0;
  let t = rs;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const uni = (a, b) => a + (b - a) * rand();
const gauss = () => {
  let u = 0; while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
};
/* 平均0・標準偏差 sd・時定数 tau 秒の Ornstein–Uhlenbeck 過程 */
const ou = (n, sd, tau) => {
  const a = Math.exp(-1 / (FS * tau)), b = sd * Math.sqrt(1 - a * a);
  const x = new Float64Array(n);
  let v = sd * gauss();
  for (let i = 0; i < n; i++) { v = a * v + b * gauss(); x[i] = v; }
  return x;
};

/* ── 合成信号 ──────────────────────────────────
   どれも「1セルの輝度の時系列」。振幅は輝度(0..255)の単位。
   sensor は白色のセンサーノイズの標準偏差。 */
const DUR = 40;                          /* 秒 */
const N = DUR * FS;

/* 位相を周波数の時系列から積分して波形を作る */
function fromRate(rate, amp, wave) {
  const x = new Float64Array(N);
  let ph = rand() * 2 * Math.PI;
  for (let i = 0; i < N; i++) { ph += 2 * Math.PI * rate[i] / FS; x[i] = amp[i] * wave(ph); }
  return x;
}
const addNoise = (x, sd) => { for (let i = 0; i < N; i++) x[i] += sd * gauss(); return x; };
const constArr = (v) => new Float64Array(N).fill(v);

const SCENES = {
  /* 呼吸: 15–33回/分。吸気が速く呼気が緩やかな非対称波形。
     呼吸数は数秒単位で揺らぐ(安静時でも数%〜十数%)。 */
  breath: (sensor) => {
    const f0 = uni(0.25, 0.55), cv = uni(0.04, 0.12);
    const dv = ou(N, cv, 8), am = ou(N, 0.15, 5);
    const A = uni(1.5, 6);
    const rate = dv.map((d) => f0 * (1 + d));
    const amp = am.map((a) => A * Math.max(0.2, 1 + a));
    return addNoise(fromRate(rate, amp, (p) => Math.sin(p) + 0.25 * Math.sin(2 * p + 0.6)), sensor);
  },
  /* 脈拍: 55–165回/分。呼吸に同期した揺らぎ(呼吸性洞性不整脈)と
     ゆっくりした変動を持つ。変動が 1% 程度しかない個体も含める。 */
  pulse: (sensor) => {
    const f0 = uni(0.92, 2.75);
    const rsa = uni(0.01, 0.06), fr = uni(0.2, 0.4), drift = uni(0.01, 0.04);
    const dv = ou(N, drift, 15), am = ou(N, 0.1, 5);
    const A = uni(1, 4);
    const ph0 = rand() * 6.3;
    const rate = dv.map((d, i) => f0 * (1 + d + rsa * Math.sin(2 * Math.PI * fr * i / FS + ph0)));
    const amp = am.map((a) => A * Math.max(0.2, 1 + a));
    return addNoise(fromRate(rate, amp, (p) => Math.sin(p) + 0.4 * Math.sin(2 * p + 1) + 0.15 * Math.sin(3 * p + 2)), sensor);
  },

  /* 広帯域の非生体 */
  wind: (sensor) => {                    /* 風に揺れる草木: 1/f^α の揺らぎ */
    const alpha = uni(1, 2), A = uni(2, 8);
    const x = colored(alpha);
    for (let i = 0; i < N; i++) x[i] *= A;
    return addNoise(x, sensor);
  },
  water: (sensor) => {                   /* 水面のゆらぎ: 0.5–3Hz の帯域雑音 */
    const x = bandNoise(uni(0.4, 0.8), uni(2, 3.5));
    const A = uni(2, 8);
    for (let i = 0; i < N; i++) x[i] *= A;
    return addNoise(x, sensor);
  },
  noise: (sensor) => addNoise(new Float64Array(N), sensor),

  /* 周期の一定した非生体 */
  fan: (sensor) => {                     /* 扇風機の首振り・羽の影など */
    const f = uni(0.9, 2.9), A = uni(1.5, 6);
    const am = ou(N, 0.05, 3);
    return addNoise(fromRate(constArr(f), am.map((a) => A * (1 + a)), (p) => Math.sin(p) + 0.3 * Math.sin(2 * p)), sensor);
  },
  pendulum: (sensor) => {                /* 振り子・吊るした物 */
    const f = uni(0.3, 1.0), A = uni(1.5, 6);
    const am = ou(N, 0.2, 10);
    return addNoise(fromRate(constArr(f), am.map((a) => A * Math.max(0.3, 1 + a)), Math.sin), sensor);
  },
  blink: (sensor) => {                   /* 一定周期で明滅する光 */
    const f = uni(0.3, 2.5), A = uni(2, 8);
    return addNoise(fromRate(constArr(f), constArr(A), (p) => Math.tanh(4 * Math.sin(p))), sensor);
  },
  /* 風に揺れる枝: 固有振動数を持つ減衰振動子を風が不規則に叩く。
     Q(鋭さ)が高いほど振り子に近づき、低いほど風そのものに近づく。 */
  branch: (sensor) => {
    const f = uni(0.4, 1.5), Q = uni(5, 40), A = uni(2, 8);
    const w = 2 * Math.PI * f / FS, r = Math.exp(-w / (2 * Q));
    const a1 = 2 * r * Math.cos(w), a2 = -r * r;
    const x = new Float64Array(N);
    let y1 = 0, y2 = 0;
    for (let i = -300; i < N; i++) {
      const y = a1 * y1 + a2 * y2 + gauss();
      y2 = y1; y1 = y;
      if (i >= 0) x[i] = y;
    }
    normalize(x);
    for (let i = 0; i < N; i++) x[i] *= A;
    return addNoise(x, sensor);
  }
};

function normalize(x) {
  let m = 0; for (const v of x) m += v; m /= x.length;
  let e = 0; for (let i = 0; i < x.length; i++) { x[i] -= m; e += x[i] * x[i]; }
  const s = Math.sqrt(e / x.length) || 1;
  for (let i = 0; i < x.length; i++) x[i] /= s;
}
/* 1/f^alpha の雑音(周波数領域で合成、標準偏差1) */
function colored(alpha) {
  const x = new Float64Array(N);
  for (let k = 1; k < N / 2; k++) {
    const f = k * FS / N, a = Math.pow(f, -alpha / 2), ph = rand() * 2 * Math.PI;
    for (let i = 0; i < N; i++) x[i] += a * Math.cos(2 * Math.PI * k * i / N + ph);
  }
  normalize(x);
  return x;
}
/* f1..f2 Hz の帯域雑音(標準偏差1) */
function bandNoise(f1, f2) {
  const x = new Float64Array(N);
  for (let k = 1; k < N / 2; k++) {
    const f = k * FS / N;
    if (f < f1 || f > f2) continue;
    const a = gauss(), ph = rand() * 2 * Math.PI;
    for (let i = 0; i < N; i++) x[i] += a * Math.cos(2 * Math.PI * k * i / N + ph);
  }
  normalize(x);
  return x;
}

/* ── アプリと同じ手順で1セルを解析する ──────────────
   バッファが満ちてから SPEC_EVERY ごとに直近 NBUF 点を解析し、
   周期の安定度を追跡して機械的な周期を弱める。律動スコアはアプリと同じく
   「前回×0.55 と今回の大きい方」で持つ。返すのは各評価時刻での律動スコア。 */
const EVAL_AT = [12, 30];                /* 秒。12秒 = 全帯域解析の直後、30秒 = じっくり見た後 */
const sig = new Float32Array(NBUF);
const pk = { k: 0, f: 0, prom: 0, sd: 0, r: 0 };
const st = { n: new Float32Array(1), m: new Float32Array(1), v: new Float32Array(1), t: new Float32Array(1) };

function runCell(x, sensor) {
  let rh = 0, now = 0;
  st.n[0] = 0; st.t[0] = -1e9;
  const out = { rel: NaN };
  for (let end = NBUF; end <= N; end += SPEC_EVERY, now++) {
    for (let t = 0; t < NBUF; t++) sig[t] = x[end - NBUF + t];
    detrendWindow(sig);
    rhythmOf(sig, pk);
    let r = pk.r;
    if (r >= R_TRACK) trackFreq(st, 0, pk.f, now);
    r *= 1 - MECH_DAMP * mechOf(st, 0, now);
    rh = Math.max(rh * 0.55, r);
    for (const s of EVAL_AT) if (out[s] == null && end >= s * FS) {
      out[s] = rh;
      if (s === EVAL_AT[EVAL_AT.length - 1] && st.n[0] > 10) out.rel = Math.sqrt(st.v[0]);
    }
  }
  return out;
}

/* ── 実行 ── */
const DETECT = 0.5;                      /* 律動スコアがこれ以上で「検出」とみなす */
const pct = (v) => (v * 100).toFixed(1).padStart(5) + "%";

function rate(scene, sensor, diag = DIAG) {
  const hit = Object.fromEntries(EVAL_AT.map((s) => [s, 0]));
  const rels = [];
  for (let n = 0; n < TRIALS; n++) {
    const out = runCell(SCENES[scene](sensor), sensor);
    for (const s of EVAL_AT) if (out[s] >= DETECT) hit[s]++;
    if (!isNaN(out.rel)) rels.push(out.rel);
  }
  if (diag && rels.length) {
    rels.sort((a, b) => a - b);
    const q = (p) => rels[Math.min(rels.length - 1, Math.floor(p * rels.length))].toFixed(3);
    console.log(`    ${scene} の周期の揺らぎ[ビン](観察${rels.length}件) 5%点 ${q(0.05)} / 中央 ${q(0.5)} / 95%点 ${q(0.95)}`);
  }
  return Object.fromEntries(EVAL_AT.map((s) => [s, hit[s] / TRIALS]));
}

function table(title, scenes, sensor) {
  console.log("\n" + title + `(センサーノイズ σ=${sensor})`);
  console.log("  条件        " + EVAL_AT.map((s) => (s + "秒").padStart(8)).join(""));
  const res = {};
  for (const sc of scenes) {
    res[sc] = rate(sc, sensor);
    console.log("  " + sc.padEnd(10) + "  " + EVAL_AT.map((s) => pct(res[sc][s]).padStart(8)).join(""));
  }
  return res;
}

console.log(`生体スキャナー 合成信号検証  試行 ${TRIALS} / 条件, 種 ${SEED}, 律動スコア ≥ ${DETECT} を検出とする`);
if (setArg) console.log("  定数の書き換え: " + setArg);
const bio = table("■ 生体(検出率: 高いほど良い)", ["breath", "pulse"], 0.7);
const broad = table("■ 広帯域の非生体(誤検出率: 低いほど良い)", ["wind", "water", "noise"], 0.7);
const mech = table("■ 周期の一定した非生体(誤検出率: 低いほど良い)", ["fan", "pendulum", "blink", "branch"], 0.7);

const avg = (res, s) => Object.values(res).reduce((a, r) => a + r[s], 0) / Object.keys(res).length;
console.log("\n■ まとめ");
for (const s of EVAL_AT) {
  console.log(`  ${String(s).padStart(2)}秒  生体の検出率 ${pct(avg(bio, s))}   広帯域の誤検出率 ${pct(avg(broad, s))}   周期的な非生体の誤検出率 ${pct(avg(mech, s))}`);
}

/* ── 暗所: センサーノイズを増やしていく ──────────────
   暗いほどセンサーの増幅が上がり、ノイズが大きくなる。被写体の動き(振幅)は
   同じでも見え方は悪くなるので、検出率が落ちるのは正常。見るべきは
   ノイズだけの映像で誤検出が増えないこと。 */
console.log("\n■ 暗所(センサーノイズを増やす。30秒時点)");
console.log("  σ      生体の検出率   ノイズだけの誤検出率   風の誤検出率");
for (const sensor of [0.5, 1, 2, 4, 8]) {
  const b = (rate("breath", sensor, false)[30] + rate("pulse", sensor, false)[30]) / 2;
  const nz = rate("noise", sensor, false)[30], wd = rate("wind", sensor, false)[30];
  console.log(`  ${String(sensor).padEnd(5)}  ${pct(b).padStart(10)}   ${pct(nz).padStart(18)}   ${pct(wd).padStart(12)}`);
}

/* ── 暗所: 動きの判定 ──────────────────────────────
   静止した場面を固定カメラで写したとき、フレーム間の残差はノイズだけになる。
   48×36 のセルのうち 1 割に動く被写体を置き、
     ・カメラが動いたと誤判定してバッファを捨てていた時間の割合
     ・静止したセルの動きのスコア(0 が正しい)
     ・被写体のセルの動きのスコア
   を、固定しきい値(従来)とノイズに合わせたしきい値(現在)で比べる。 */
function simMotion(sensor, adaptive) {
  const NCELL = 48 * 36, NSUB = Math.round(NCELL * 0.1), FR = 30 * FS;
  const motion = new Float64Array(NCELL), hist = new Int32Array(256);
  let gm = 0, moving = false, movingFrames = 0, nz = 0;
  for (let f = 0; f < FR; f++) {
    const thr = adaptive ? moveThr(nz) : 2.5;
    let nMove = 0;
    hist.fill(0);
    for (let i = 0; i < NCELL; i++) {
      /* 被写体: 振幅 3 の呼吸様の動き(輝度差で 1 フレームあたり平均 1 前後)に
         ノイズが乗る */
      const sub = i < NSUB ? 3 * Math.abs(Math.sin(f / FS * 2) - Math.sin((f - 1) / FS * 2)) * FS / 4 : 0;
      const res = Math.abs(sub + sensor * Math.SQRT2 * gauss());
      if (res > thr) nMove++;
      hist[res >= 25.5 ? 255 : (res / RES_STEP) | 0]++;
      motion[i] += (res - motion[i]) * 0.18;
    }
    const est = noiseOfRes(hist, NCELL);
    nz += (est - nz) * (nz ? 0.05 : 1);
    gm += (nMove / NCELL - gm) * 0.3;
    if (!moving && gm > MOVE_ON) moving = true;
    else if (moving && gm < MOVE_OFF) moving = false;
    if (moving && f > FS * 3) movingFrames++;
  }
  const floor = adaptive ? motionFloor(nz) : 0.4;
  let sStatic = 0, sSub = 0;
  for (let i = 0; i < NCELL; i++) {
    const v = motionNorm(motion[i], floor);
    if (i < NSUB) sSub += v; else sStatic += v;
  }
  return { moving: movingFrames / (FR - FS * 3), stat: sStatic / (NCELL - NSUB), sub: sSub / NSUB, nz };
}

console.log("\n■ 暗所の動きの判定(固定しきい値 → ノイズに合わせたしきい値)");
console.log("  σ      推定σ   移動と誤判定した時間        静止セルの動き          被写体の動き");
for (const sensor of [0.5, 1, 2, 4, 8]) {
  const a = simMotion(sensor, false), b = simMotion(sensor, true);
  const arrow = (x, y) => (pct(x) + " → " + pct(y)).padStart(20);
  console.log(`  ${String(sensor).padEnd(5)}  ${b.nz.toFixed(2).padStart(5)}  ${arrow(a.moving, b.moving)}  ${arrow(a.stat, b.stat)}  ${arrow(a.sub, b.sub)}`);
}
