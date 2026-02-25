// src/lib/hfvpMixed.ts

export type RegressionMethod = "ols" | "huber";

export interface HFVPInput {
  /** 例: [0, 5, 10, 15, 20, 25, 30, 40, 50] */
  markerDistances: number[];
  /** markerDistances と同じ長さの累積タイム[s]。先頭は通常0 */
  cumulativeTimes: number[];
  /** 体重[kg] */
  massKg: number;
}

export interface HFVPOptions {
  /** 回帰法（推奨: huber） */
  regression?: RegressionMethod;
  /** 1区間目の加速度モデル（静止開始推奨） */
  firstSegmentModel?: "fromRest" | "speedOverTime";
  /** 外れ値除外を実施 */
  removeOutliers?: boolean;
  /** MADベース閾値（通常 3.5） */
  outlierSigma?: number;
}

export interface SegmentMetrics {
  section: string;           // "0-5m" など
  startDistance: number;     // m
  endDistance: number;       // m
  distance: number;          // m
  splitTime: number;         // s
  cumulativeTime: number;    // s（区間終点）
  speed: number;             // m/s（区間平均速度）
  acceleration: number;      // m/s^2（近似）
  forceN: number;            // N
  powerW: number;            // W
  rfPercent: number;         // %（F/F0*100）
  isOutlier: boolean;        // F-v回帰上の外れ値として除外されたか
}

export interface HFVPSummary {
  f0N: number;
  f0RelNkg: number;
  v0: number;
  pmaxW: number;
  pmaxRelWkg: number;
  vmaxMeasured: number;
  tau: number;               // s
  drf: number;               // % per (m/s)
  rfMax: number;             // %（定義上100）
  fvR2: number;
  posR2: number;             // 位置フィットR²
  usedPoints: number;
  totalPoints: number;
  usedSections: string[];    // 回帰採用区間ラベル（例: ["0-5m","5-10m"]）
  excludedSections: string[]; // 除外区間ラベル（例: ["30-40m","40-50m"]）
}

export interface HFVPResult {
  summary: HFVPSummary;
  segments: SegmentMetrics[];
  quality: {
    grade: "良" | "可" | "参考";
    warnings: string[];
    isPhysicallyValid: boolean; // F0>0, V0>0, slope<0, Pmax>0 がすべて満たされているか
  };
}

/** --------- 基本ユーティリティ --------- */

const EPS = 1e-12;

const round = (v: number, digits = 3): number => {
  if (!Number.isFinite(v)) return NaN;
  const p = 10 ** digits;
  return Math.round(v * p) / p;
};

const median = (arr: number[]): number => {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
};

const madScale = (residuals: number[]): number => {
  const absRes = residuals.map((r) => Math.abs(r));
  const med = median(absRes);
  return 1.4826 * med; // 正規分布換算
};

/** [a,b,c] -> [0,a,a+b,a+b+c] */
export const toCumulative = (values: number[]): number[] => {
  const out: number[] = [0];
  let s = 0;
  for (const v of values) {
    if (!Number.isFinite(v) || v <= 0) {
      throw new Error(`toCumulative: 正の数のみ指定してください。value=${v}`);
    }
    s += v;
    out.push(s);
  }
  return out;
};

/** split距離から marker距離を作る（例: [5,5,5,5,5,5,10,10] -> [0,5,10,15,20,25,30,40,50]） */
export const buildMarkersFromSplits = (splitDistances: number[]): number[] => {
  return toCumulative(splitDistances);
};

/** --------- 回帰 --------- */

interface FitResult {
  slope: number;
  intercept: number;
  r2: number;
  residuals: number[];
  yHat: number[];
  weights: number[];
}

const weightedLinearRegression = (x: number[], y: number[], w?: number[]): FitResult => {
  if (x.length !== y.length || x.length < 2) {
    throw new Error("回帰: x,y の長さ不一致またはデータ不足");
  }

  const n = x.length;
  const ww = w ?? Array(n).fill(1);

  let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const wi = ww[i];
    const xi = x[i];
    const yi = y[i];
    sw += wi;
    sx += wi * xi;
    sy += wi * yi;
    sxx += wi * xi * xi;
    sxy += wi * xi * yi;
  }

  const denom = sw * sxx - sx * sx;
  if (Math.abs(denom) < EPS) {
    throw new Error("回帰: 分母が0に近く直線を推定できません");
  }

  const slope = (sw * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / sw;

  const yHat = x.map((xi) => intercept + slope * xi);
  const residuals = y.map((yi, i) => yi - yHat[i]);

  // 重み付きR²
  const yMean = sy / sw;
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < n; i++) {
    const wi = ww[i];
    ssRes += wi * (y[i] - yHat[i]) ** 2;
    ssTot += wi * (y[i] - yMean) ** 2;
  }
  const r2 = ssTot < EPS ? 1 : 1 - ssRes / ssTot;

  return { slope, intercept, r2, residuals, yHat, weights: ww };
};

const huberRegression = (x: number[], y: number[], k = 1.345, maxIter = 30): FitResult => {
  let weights = Array(x.length).fill(1);
  let prevSlope = Number.NaN;

  for (let iter = 0; iter < maxIter; iter++) {
    const fit = weightedLinearRegression(x, y, weights);
    const scale = madScale(fit.residuals);

    if (scale < 1e-9) return fit;

    const c = k * scale;
    weights = fit.residuals.map((r) => {
      const ar = Math.abs(r);
      return ar <= c ? 1 : c / ar;
    });

    if (Number.isFinite(prevSlope) && Math.abs(fit.slope - prevSlope) < 1e-10) {
      return fit;
    }
    prevSlope = fit.slope;
  }

  return weightedLinearRegression(x, y, weights);
};

const fitLine = (x: number[], y: number[], method: RegressionMethod): FitResult => {
  return method === "huber" ? huberRegression(x, y) : weightedLinearRegression(x, y);
};

const fitWithOptionalOutlierRemoval = (
  x: number[],
  y: number[],
  method: RegressionMethod,
  removeOutliers: boolean,
  outlierSigma: number
): { fit: FitResult; keepIdx: number[]; removedIdx: number[] } => {
  const base = fitLine(x, y, method);

  if (!removeOutliers || x.length < 4) {
    return { fit: base, keepIdx: x.map((_, i) => i), removedIdx: [] };
  }

  const scale = madScale(base.residuals);
  if (scale < 1e-9) {
    return { fit: base, keepIdx: x.map((_, i) => i), removedIdx: [] };
  }

  const th = outlierSigma * scale;
  const keepIdx: number[] = [];
  const removedIdx: number[] = [];

  for (let i = 0; i < x.length; i++) {
    if (Math.abs(base.residuals[i]) <= th) keepIdx.push(i);
    else removedIdx.push(i);
  }

  // 除外しすぎ防止
  if (keepIdx.length < 3) {
    return { fit: base, keepIdx: x.map((_, i) => i), removedIdx: [] };
  }

  const x2 = keepIdx.map((i) => x[i]);
  const y2 = keepIdx.map((i) => y[i]);
  const fit2 = fitLine(x2, y2, method);

  return { fit: fit2, keepIdx, removedIdx };
};

/** --------- メイン計算 --------- */

export const computeHFVP = (
  input: HFVPInput,
  options: HFVPOptions = {}
): HFVPResult => {
  const {
    regression = "huber",
    firstSegmentModel = "fromRest",
    removeOutliers = true,
    outlierSigma = 3.5,
  } = options;

  const { markerDistances, cumulativeTimes, massKg } = input;

  if (!Number.isFinite(massKg) || massKg <= 0) {
    throw new Error("massKg は正の数にしてください。");
  }
  if (markerDistances.length !== cumulativeTimes.length || markerDistances.length < 3) {
    throw new Error("markerDistances と cumulativeTimes は同じ長さで、3点以上必要です。");
  }

  // 先頭を0基準に正規化
  const d0 = markerDistances[0];
  const t0 = cumulativeTimes[0];
  const d = markerDistances.map((v) => v - d0);
  const t = cumulativeTimes.map((v) => v - t0);

  // 単調増加チェック
  if (Math.abs(d[0]) > 1e-9 || Math.abs(t[0]) > 1e-9) {
    throw new Error("内部正規化エラー");
  }
  for (let i = 1; i < d.length; i++) {
    if (!(d[i] > d[i - 1])) throw new Error(`距離が単調増加でありません: index=${i}`);
    if (!(t[i] > t[i - 1])) throw new Error(`累積タイムが単調増加でありません: index=${i}`);
  }

  const nSeg = d.length - 1;
  const splitDistances: number[] = [];
  const splitTimes: number[] = [];
  const speeds: number[] = [];
  const accels: number[] = [];
  const endDistances: number[] = [];

  for (let i = 0; i < nSeg; i++) {
    const sd = d[i + 1] - d[i];
    const st = t[i + 1] - t[i];

    splitDistances.push(sd);
    splitTimes.push(st);
    speeds.push(sd / st);
    endDistances.push(d[i + 1]);

    if (i === 0) {
      // 1区間目
      const a1 =
        firstSegmentModel === "fromRest"
          ? (2 * sd) / (st * st)   // 静止開始モデル
          : (sd / st) / st;        // v/t
      accels.push(a1);
    } else {
      // 中心差分
      const vi = speeds[i];
      const vPrev = speeds[i - 1];
      const ti = splitTimes[i];
      const tPrev = splitTimes[i - 1];
      const ai = (2 * (vi - vPrev)) / (ti + tPrev);
      accels.push(ai);
    }
  }

  const forces = accels.map((a) => massKg * a);
  const powers = forces.map((f, i) => f * speeds[i]);

  // ---- F-v 回帰に使う点を物理フィルタで絞る ----
  // 目的: 減速区間が混入すると F が負→回帰直線が崩れ V0 が実測速度付近に収束する問題を防ぐ
  //
  // フィルタ条件（AND）:
  //   A) a > ACCEL_EPS (閾値: 0.2 m/s²)
  //      → "ほぼゼロ"の加速度（ノイズ由来の a=+0.05 など）を除外
  //   B) v[i] >= v[i-1] - SPEED_ALLOW (許容幅: 0.10 m/s) ← 速度単調増加チェック（緩和版）
  //      → 現場ノイズで小さな上下が出ても本来使うべき点を落とさない
  //      → 明確な減速（0.10m/s超の低下）のみ除外
  //   C) i <= vmaxIdx（速度ピーク区間まで）
  //      → ピーク以降の区間を確実にカット
  const ACCEL_EPS = 0.2;    // m/s²: これ未満の加速度はノイズとして除外
  const SPEED_ALLOW = 0.10; // m/s: この幅までの速度低下は許容（ノイズ対策）

  const vmaxMeasuredRaw = Math.max(...speeds);
  const vmaxIdx = speeds.indexOf(vmaxMeasuredRaw);

  // 加速フェーズ判定（A + B + C の AND）
  const accelPhaseIdx: number[] = [];
  for (let i = 0; i < nSeg; i++) {
    const aOk = accels[i] > ACCEL_EPS;                                    // A
    const vOk = i === 0
      ? speeds[i] > 0                                                      // B: 1区間目は正であればOK
      : speeds[i] >= speeds[i - 1] - SPEED_ALLOW;                         // B: 許容幅内なら採用
    const peakOk = i <= vmaxIdx;                                           // C
    if (aOk && vOk && peakOk) accelPhaseIdx.push(i);
  }

  // 有効点数チェック: 3点未満はフォールバック（全点使用）
  const useFilteredPoints = accelPhaseIdx.length >= 3;
  const fvSpeeds = useFilteredPoints ? accelPhaseIdx.map((i) => speeds[i]) : speeds;
  const fvForces = useFilteredPoints ? accelPhaseIdx.map((i) => forces[i]) : forces;
  const excludedByPhaseIdx = useFilteredPoints
    ? speeds.map((_, i) => !accelPhaseIdx.includes(i) ? i : -1).filter((i) => i >= 0)
    : [];

  // F-v 回帰（点: 加速フェーズのみ）
  const fitFV = fitWithOptionalOutlierRemoval(
    fvSpeeds,
    fvForces,
    regression,
    removeOutliers,
    outlierSigma
  );

  // keepIdx / removedIdx を全区間インデックスに変換し直す
  const fvKeepIdxGlobal = useFilteredPoints
    ? fitFV.keepIdx.map((ki) => accelPhaseIdx[ki])
    : fitFV.keepIdx;
  const fvRemovedIdxGlobal = [
    ...excludedByPhaseIdx,
    ...(useFilteredPoints
      ? fitFV.removedIdx.map((ri) => accelPhaseIdx[ri])
      : fitFV.removedIdx),
  ];

  const slope = fitFV.fit.slope;
  const intercept = fitFV.fit.intercept; // F0
  const fvR2 = fitFV.fit.r2;

  const f0N = intercept;
  const f0RelNkg = f0N / massKg;
  const v0 = slope < 0 ? -f0N / slope : Number.NaN;
  const pmaxW = Number.isFinite(v0) ? (f0N * v0) / 4 : Number.NaN;
  const pmaxRelWkg = pmaxW / massKg;
  const vmaxMeasured = Math.max(...speeds);
  const tau = Number.isFinite(v0) && f0RelNkg > 0 ? v0 / f0RelNkg : Number.NaN;

  // ---- 健全性チェック ----
  // 物理的に意味のある推定かを検証
  // slope < 0 かつ abs(slope) > SLOPE_EPS（小さすぎるとV0が巨大化・発散する）
  // F0, V0, Pmax が有限正値であること
  const SLOPE_EPS = 1e-6; // これ未満の|slope|は「ほぼゼロ」として不正扱い
  const isPhysicallyValid =
    slope < 0 &&
    Math.abs(slope) > SLOPE_EPS &&          // 傾きが小さすぎない（V0暴走防止）
    Number.isFinite(f0N)   && f0N   > 0 &&
    Number.isFinite(v0)    && v0    > 0 &&
    Number.isFinite(pmaxW) && pmaxW > 0;

  // 位置フィットR²: x(t) = V0*(t - tau*(1-exp(-t/tau))) で実測位置を再現できるか
  let posR2 = Number.NaN;
  if (isPhysicallyValid && Number.isFinite(tau) && tau > 0) {
    const tCum = t.slice(1); // 各区間終端の累積タイム
    const xActual = d.slice(1); // 実測累積距離
    const xPred = tCum.map((tc) => v0 * (tc - tau * (1 - Math.exp(-tc / tau))));
    let ssRes = 0, ssTot = 0;
    const xMean = xActual.reduce((s, v) => s + v, 0) / xActual.length;
    for (let i = 0; i < xActual.length; i++) {
      ssRes += (xActual[i] - xPred[i]) ** 2;
      ssTot += (xActual[i] - xMean) ** 2;
    }
    posR2 = ssTot < EPS ? 1 : Math.max(0, 1 - ssRes / ssTot);
  }

  // RF（簡易） = F/F0*100
  const rfPercent = forces.map((f) => (Math.abs(f0N) > EPS ? (f / f0N) * 100 : Number.NaN));

  // DRF: RF-v の傾き（使う点はF-vで採用されたグローバルインデックスに合わせる）
  let drf = Number.NaN;
  if (fvKeepIdxGlobal.length >= 2) {
    const xv = fvKeepIdxGlobal.map((i) => speeds[i]);
    const yrf = fvKeepIdxGlobal.map((i) => rfPercent[i]);
    const fitRF = fitLine(xv, yrf, regression);
    drf = fitRF.slope; // % per (m/s)
  }

  const removedSet = new Set(fvRemovedIdxGlobal);

  const segments: SegmentMetrics[] = [];
  for (let i = 0; i < nSeg; i++) {
    segments.push({
      section: `${round(d[i], 0)}-${round(d[i + 1], 0)}m`,
      startDistance: round(d[i], 3),
      endDistance: round(d[i + 1], 3),
      distance: round(splitDistances[i], 3),
      splitTime: round(splitTimes[i], 3),
      cumulativeTime: round(t[i + 1], 3),
      speed: round(speeds[i], 3),
      acceleration: round(accels[i], 3),
      forceN: round(forces[i], 1),
      powerW: round(powers[i], 1),
      rfPercent: round(rfPercent[i], 1),
      isOutlier: removedSet.has(i),
    });
  }

  // ---- 採用区間・除外区間のラベルを生成 ----
  const usedSections   = fvKeepIdxGlobal.map((i) => `${round(d[i],0)}-${round(d[i+1],0)}m`);
  const excludedSections = fvRemovedIdxGlobal.map((i) => `${round(d[i],0)}-${round(d[i+1],0)}m`);

  const warnings: string[] = [];

  // 回帰点数チェック（少ないほど推定精度が低下する）
  if (!useFilteredPoints) {
    warnings.push(`⚠️ 加速フェーズのデータ点が3点未満のため全点で回帰しました（精度低・参考値扱い）。`);
  } else if (fvKeepIdxGlobal.length < 4) {
    warnings.push(`回帰使用点が ${fvKeepIdxGlobal.length} 点と少ないため推定精度が低めです。`);
  }

  // 健全性チェック警告（個別に理由を出す）
  if (!isPhysicallyValid) {
    if (slope >= 0)
      warnings.push("F-v回帰の傾きが正/ゼロです（V0を推定できません）。");
    else if (Math.abs(slope) <= SLOPE_EPS)
      warnings.push(`F-v回帰の傾きが極小です（|slope|=${Math.abs(slope).toExponential(2)}）。V0が発散する可能性があります。`);
    if (!Number.isFinite(f0N) || f0N <= 0)
      warnings.push("F0が負/ゼロ/非数です（データ異常の可能性）。");
    if (!Number.isFinite(v0) || v0 <= 0)
      warnings.push("V0が物理的に不正です（F-v傾きが正/極小/ゼロの可能性）。");
    if (!Number.isFinite(pmaxW) || pmaxW <= 0)
      warnings.push("Pmaxが不正です（F0またはV0の異常に起因）。");
  }

  if (fvR2 < 0.8) warnings.push(`F-v回帰のR²が低めです（${round(fvR2, 3)}）。`);
  if (Number.isFinite(posR2) && posR2 < 0.85) {
    warnings.push(`位置フィットR²が低めです（${round(posR2, 3)}）。計測ノイズの可能性があります。`);
  }
  if (fitFV.removedIdx.length > 0) {
    warnings.push(`外れ値として ${fitFV.removedIdx.length} 点を除外して再推定しました。`);
  }
  if (excludedByPhaseIdx.length > 0) {
    warnings.push(`減速/低加速区間 ${excludedByPhaseIdx.length} 点をF-v回帰から除外しました（a≤0.2 m/s² または明確な減速）。`);
  }

  // 中盤(30m以降)で負の力がある場合の警告
  const hasNegativeMidForce = segments.some((s) => s.endDistance >= 30 && s.forceN < 0);
  if (hasNegativeMidForce) warnings.push("30m以降に負の力が含まれています（減速区間混入の可能性）。");

  // V0 ≈ Vmax 警告（許容幅 0.05 m/s を持たせる）
  // V0 < Vmax - 0.05 のときだけ警告（わずかな差は許容）
  const V0_VMAX_MARGIN = 0.05; // m/s: この幅以内は許容
  if (isPhysicallyValid && v0 < vmaxMeasured - V0_VMAX_MARGIN) {
    warnings.push(`⚠️ V0（理論: ${round(v0,2)} m/s）が実測Vmax（${round(vmaxMeasured,2)} m/s）を下回っています（差: ${round(vmaxMeasured - v0, 2)} m/s）。減速区間混入またはノイズの可能性があります。`);
  }
  if (Number.isFinite(drf) && drf >= 0) {
    warnings.push("DRFが正です（通常は負値）。データ品質を確認してください。");
  }

  // ---- 品質グレード判定 ----
  // F-v R², 位置フィットR², 回帰点数, 健全性 を総合的に評価
  let grade: "良" | "可" | "参考" = "良";
  const posR2Bad  = Number.isFinite(posR2) && posR2 < 0.85;
  const posR2Warn = Number.isFinite(posR2) && posR2 < 0.92;
  if (
    !isPhysicallyValid ||
    fvR2 < 0.8 ||
    posR2Bad ||
    !useFilteredPoints ||
    fvKeepIdxGlobal.length < 3
  ) {
    grade = "参考";
  } else if (
    fvR2 < 0.9 ||
    posR2Warn ||
    fvKeepIdxGlobal.length < 4 ||
    warnings.length >= 1
  ) {
    grade = "可";
  }

  return {
    summary: {
      f0N: round(f0N, 1),
      f0RelNkg: round(f0RelNkg, 3),
      v0: round(v0, 3),
      pmaxW: round(pmaxW, 1),
      pmaxRelWkg: round(pmaxRelWkg, 3),
      vmaxMeasured: round(vmaxMeasured, 3),
      tau: round(tau, 3),
      drf: round(drf, 3),
      rfMax: 100,
      fvR2: round(fvR2, 3),
      posR2: Number.isFinite(posR2) ? round(posR2, 3) : Number.NaN,
      usedPoints: fvKeepIdxGlobal.length,
      totalPoints: speeds.length,
      usedSections,
      excludedSections,
    },
    segments,
    quality: { grade, warnings, isPhysicallyValid },
  };
};
