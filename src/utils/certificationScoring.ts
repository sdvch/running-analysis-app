// =====================================================
// ランニング技能検定モード - 採点エンジン
// 作成日: 2026-02-12
// 説明: 検定モードの採点ロジック（品質ゲート、手動補正、監査ログ対応）
// =====================================================

import type {
  ScoringInput,
  ScoringResult,
  CertificationRule,
  ItemScoreDetail,
  AngleScoreDetails,
  StrideScoreDetails,
  ContactTimeScoreDetails,
  HFVPScoreDetails,
  QualityGrade,
  ManualCorrectionLog,
  PassThreshold,
} from '../types/certificationTypes';

import {
  requiresHFVP,
  getPassThreshold,
} from '../types/certificationTypes';

// =====================================================
// 定数
// =====================================================

/** 品質ゲート閾値 */
const QUALITY_THRESHOLDS = {
  GOOD: {
    pose_confidence: 0.7,
    frame_drop_rate: 0.1,
    fv_r2: 0.90,
  },
  ACCEPTABLE: {
    pose_confidence: 0.5,
    frame_drop_rate: 0.2,
    fv_r2: 0.80,
  },
};

/** 要確認閾値（理想値の±5%以内） */
const REVIEW_THRESHOLD_PERCENTAGE = 0.05;

/** バージョン情報 */
const SCORING_VERSION = '1.0.0';

// =====================================================
// 品質評価
// =====================================================

/**
 * データ品質を評価してランクを返す
 * @param quality 品質指標
 * @param includesHFVP H-FVP評価を含むか
 * @returns 品質ランク（良/可/参考）
 */
export function evaluateQuality(
  quality: ScoringInput['quality_metrics'],
  includesHFVP: boolean
): QualityGrade {
  const { pose_confidence_avg, frame_drop_rate, fv_r2 } = quality;

  // H-FVP評価を含む場合はF-V回帰のR²も確認
  const hfvpQualityOk = !includesHFVP || fv_r2 >= QUALITY_THRESHOLDS.GOOD.fv_r2;

  // 良: すべての指標が「良」基準を満たす
  if (
    pose_confidence_avg >= QUALITY_THRESHOLDS.GOOD.pose_confidence &&
    frame_drop_rate <= QUALITY_THRESHOLDS.GOOD.frame_drop_rate &&
    hfvpQualityOk
  ) {
    return '良';
  }

  // 可: すべての指標が「可」基準を満たす
  if (
    pose_confidence_avg >= QUALITY_THRESHOLDS.ACCEPTABLE.pose_confidence &&
    frame_drop_rate <= QUALITY_THRESHOLDS.ACCEPTABLE.frame_drop_rate &&
    (!includesHFVP || fv_r2 >= QUALITY_THRESHOLDS.ACCEPTABLE.fv_r2)
  ) {
    return '可';
  }

  // 参考: それ以外
  return '参考';
}

/**
 * 品質警告メッセージを生成
 */
export function generateQualityWarnings(
  quality: ScoringInput['quality_metrics'],
  qualityGrade: QualityGrade,
  includesHFVP: boolean
): string[] {
  const warnings: string[] = [];

  if (quality.pose_confidence_avg < QUALITY_THRESHOLDS.ACCEPTABLE.pose_confidence) {
    warnings.push(
      `姿勢認識の信頼度が低い（平均${(quality.pose_confidence_avg * 100).toFixed(1)}%）`
    );
  }

  if (quality.frame_drop_rate > QUALITY_THRESHOLDS.ACCEPTABLE.frame_drop_rate) {
    warnings.push(
      `フレームドロップ率が高い（${(quality.frame_drop_rate * 100).toFixed(1)}%）`
    );
  }

  if (includesHFVP && quality.fv_r2 < QUALITY_THRESHOLDS.ACCEPTABLE.fv_r2) {
    warnings.push(`H-FVP回帰の精度が低い（R²=${quality.fv_r2.toFixed(3)}）`);
  }

  if (qualityGrade === '参考') {
    warnings.push('⚠️ データ品質が基準を下回っています。測定を再実施してください。');
  }

  return warnings;
}

// =====================================================
// 項目別採点ユーティリティ
// =====================================================

/**
 * 単一項目のスコア計算
 * @param rawValue 実測値
 * @param criteriaMin 基準最小値
 * @param criteriaMax 基準最大値
 * @param criteriaIdeal 理想値
 * @param maxScore 配点
 * @param qualityGrade 品質ランク
 * @returns 項目別詳細評価
 */
function calculateItemScore(
  rawValue: number,
  criteriaMin: number,
  criteriaMax: number,
  criteriaIdeal: number,
  maxScore: number,
  qualityGrade: QualityGrade
): ItemScoreDetail {
  // 偏差計算
  const deviation = rawValue - criteriaIdeal;
  const deviationPercent = Math.abs(deviation / criteriaIdeal);

  // 範囲内チェック
  const isWithinRange = rawValue >= criteriaMin && rawValue <= criteriaMax;

  // 要確認フラグ（基準値の±5%以内）
  const nearMin = Math.abs(rawValue - criteriaMin) / criteriaMin <= REVIEW_THRESHOLD_PERCENTAGE;
  const nearMax = Math.abs(rawValue - criteriaMax) / criteriaMax <= REVIEW_THRESHOLD_PERCENTAGE;
  const isNearThreshold = isWithinRange && (nearMin || nearMax);

  // 基本スコア計算（理想値に近いほど高得点）
  let baseScore: number;
  if (!isWithinRange) {
    // 範囲外：0点
    baseScore = 0;
  } else {
    // 範囲内：理想値からの偏差に応じて配点
    const range = criteriaMax - criteriaMin;
    const normalizedDeviation = Math.abs(deviation) / (range / 2);
    baseScore = maxScore * (1 - normalizedDeviation * 0.5); // 最大50%減点
  }

  // 品質による減衰
  let qualityAdjusted = false;
  let finalScore = baseScore;
  if (qualityGrade === '可') {
    finalScore = baseScore * 0.9; // 10%減衰
    qualityAdjusted = true;
  } else if (qualityGrade === '参考') {
    finalScore = 0; // 参考値扱い
    qualityAdjusted = true;
  }

  // 上限クリップ
  finalScore = Math.min(Math.max(finalScore, 0), maxScore);

  return {
    raw_value: rawValue,
    criteria_min: criteriaMin,
    criteria_max: criteriaMax,
    criteria_ideal: criteriaIdeal,
    deviation,
    score: Math.round(finalScore * 100) / 100, // 小数第2位まで
    max_score: maxScore,
    percentage: (finalScore / maxScore) * 100,
    is_within_range: isWithinRange,
    is_near_threshold: isNearThreshold,
    quality_adjusted: qualityAdjusted,
  };
}

// =====================================================
// 角度採点
// =====================================================

/**
 * 角度評価の採点
 */
function scoreAngle(
  input: ScoringInput,
  rule: CertificationRule,
  qualityGrade: QualityGrade
): AngleScoreDetails {
  const { angle_measurement } = input;
  const { angle_criteria } = rule.rule_json;

  // 膝屈曲角度
  const kneeFlexion = calculateItemScore(
    angle_measurement.average.knee,
    angle_criteria.knee_flexion_min,
    angle_criteria.knee_flexion_max,
    angle_criteria.knee_flexion_ideal,
    rule.angle_points * 0.4, // 角度配点の40%
    qualityGrade
  );

  // 股関節伸展
  const hipExtension = calculateItemScore(
    angle_measurement.average.hip,
    angle_criteria.hip_extension_min,
    180, // 最大値（仮）
    angle_criteria.hip_extension_ideal,
    rule.angle_points * 0.35, // 角度配点の35%
    qualityGrade
  );

  // 体幹前傾
  const trunkLean = calculateItemScore(
    angle_measurement.average.trunk,
    angle_criteria.trunk_lean_min,
    angle_criteria.trunk_lean_max,
    angle_criteria.trunk_lean_ideal,
    rule.angle_points * 0.25, // 角度配点の25%
    qualityGrade
  );

  const overallScore = kneeFlexion.score + hipExtension.score + trunkLean.score;

  return {
    knee_flexion: kneeFlexion,
    hip_extension: hipExtension,
    trunk_lean: trunkLean,
    overall_score: Math.round(overallScore * 100) / 100,
    sub_scores: {
      knee: kneeFlexion.score,
      hip: hipExtension.score,
      trunk: trunkLean.score,
    },
  };
}

// =====================================================
// ストライド採点
// =====================================================

/**
 * ストライド評価の採点
 */
function scoreStride(
  input: ScoringInput,
  rule: CertificationRule,
  qualityGrade: QualityGrade
): StrideScoreDetails {
  const { stride_measurement } = input;
  const { stride_criteria } = rule.rule_json;

  // ストライド長比率
  const lengthRatio = calculateItemScore(
    stride_measurement.height_ratio,
    stride_criteria.stride_length_ratio_min,
    stride_criteria.stride_length_ratio_max,
    stride_criteria.stride_length_ratio_ideal,
    rule.stride_points * 0.6, // ストライド配点の60%
    qualityGrade
  );

  // ストライド頻度
  const frequency = calculateItemScore(
    stride_measurement.stride_frequency,
    stride_criteria.stride_frequency_min,
    stride_criteria.stride_frequency_max,
    stride_criteria.stride_frequency_ideal,
    rule.stride_points * 0.4, // ストライド配点の40%
    qualityGrade
  );

  const overallScore = lengthRatio.score + frequency.score;

  return {
    stride_length_ratio: lengthRatio,
    stride_frequency: frequency,
    overall_score: Math.round(overallScore * 100) / 100,
    sub_scores: {
      length: lengthRatio.score,
      frequency: frequency.score,
    },
  };
}

// =====================================================
// 接地時間採点
// =====================================================

/**
 * 接地時間評価の採点
 */
function scoreContactTime(
  input: ScoringInput,
  rule: CertificationRule,
  qualityGrade: QualityGrade
): ContactTimeScoreDetails {
  const { contact_time_measurement } = input;
  const { contact_time_criteria } = rule.rule_json;

  const contactTime = calculateItemScore(
    contact_time_measurement.average,
    contact_time_criteria.contact_time_min,
    contact_time_criteria.contact_time_max,
    contact_time_criteria.contact_time_ideal,
    rule.contact_time_points,
    qualityGrade
  );

  return {
    contact_time: contactTime,
    flight_time: undefined, // TODO: 滞空時間の評価は将来実装
    overall_score: contactTime.score,
  };
}

// =====================================================
// H-FVP採点
// =====================================================

/**
 * H-FVP評価の採点（1級・2級のみ）
 */
function scoreHFVP(
  input: ScoringInput,
  rule: CertificationRule,
  qualityGrade: QualityGrade
): HFVPScoreDetails | undefined {
  if (!input.hfvp_measurement || rule.hfvp_points === 0) {
    return undefined;
  }

  const { hfvp_measurement } = input;
  const hfvpCriteria = rule.rule_json.hfvp_criteria;

  if (!hfvpCriteria) {
    return undefined;
  }

  // H-FVP品質ゲート：R²が低い場合は減衰または0点
  let hfvpQualityGrade = qualityGrade;
  if (hfvp_measurement.fv_r2 < QUALITY_THRESHOLDS.ACCEPTABLE.fv_r2) {
    hfvpQualityGrade = '参考';
  } else if (hfvp_measurement.fv_r2 < QUALITY_THRESHOLDS.GOOD.fv_r2) {
    hfvpQualityGrade = '可';
  }

  // F0（最大推進力）
  const f0 = calculateItemScore(
    hfvp_measurement.f0,
    hfvpCriteria.f0_min,
    hfvpCriteria.f0_ideal * 1.2, // 理想値の120%を上限と仮定
    hfvpCriteria.f0_ideal,
    rule.hfvp_points * 0.3, // H-FVP配点の30%
    hfvpQualityGrade
  );

  // V0（理論最大速度）
  const v0 = calculateItemScore(
    hfvp_measurement.v0,
    hfvpCriteria.v0_min,
    hfvpCriteria.v0_ideal * 1.2,
    hfvpCriteria.v0_ideal,
    rule.hfvp_points * 0.3, // H-FVP配点の30%
    hfvpQualityGrade
  );

  // Pmax（最大パワー）
  const pmax = calculateItemScore(
    hfvp_measurement.pmax,
    hfvpCriteria.pmax_min,
    hfvpCriteria.pmax_ideal * 1.2,
    hfvpCriteria.pmax_ideal,
    rule.hfvp_points * 0.3, // H-FVP配点の30%
    hfvpQualityGrade
  );

  // DRF（力の方向性効率）
  const drf = calculateItemScore(
    hfvp_measurement.drf,
    hfvpCriteria.drf_max, // DRFは負の値なので最大=最小
    hfvpCriteria.drf_min,
    hfvpCriteria.drf_ideal,
    rule.hfvp_points * 0.1, // H-FVP配点の10%
    hfvpQualityGrade
  );

  const overallScore = f0.score + v0.score + pmax.score + drf.score;

  return {
    f0,
    v0,
    pmax,
    drf,
    overall_score: Math.round(overallScore * 100) / 100,
    sub_scores: {
      f0: f0.score,
      v0: v0.score,
      pmax: pmax.score,
      drf: drf.score,
    },
  };
}

// =====================================================
// 手動補正適用
// =====================================================

/**
 * 手動補正値を適用し、監査ログを生成
 */
function applyManualCorrections(
  input: ScoringInput
): { correctedInput: ScoringInput; logs: ManualCorrectionLog[] } {
  if (!input.manual_corrections || input.manual_corrections.length === 0) {
    return { correctedInput: input, logs: [] };
  }

  const correctedInput = { ...input };
  const logs: ManualCorrectionLog[] = [];

  for (const correction of input.manual_corrections) {
    const log: ManualCorrectionLog = {
      item: correction.item,
      field: '', // 後で設定
      old_value: correction.original_value,
      new_value: correction.corrected_value,
      reason: correction.reason,
      corrected_by: correction.corrected_by,
      corrected_at: correction.corrected_at,
    };

    // 項目別に補正を適用
    switch (correction.item) {
      case 'angle':
        // 角度補正（平均値を上書き）
        log.field = 'angle_measurement.average';
        // 実装例：特定の角度を補正（詳細は仕様次第）
        break;
      case 'stride':
        // ストライド補正
        log.field = 'stride_measurement';
        // 実装例：ストライド長または頻度を補正
        break;
      case 'contact_time':
        // 接地時間補正
        log.field = 'contact_time_measurement.average';
        correctedInput.contact_time_measurement.average = correction.corrected_value;
        break;
      case 'hfvp':
        // H-FVP補正（F0/V0/Pmaxなど個別指定が必要）
        log.field = 'hfvp_measurement';
        break;
      default:
        break;
    }

    logs.push(log);
  }

  return { correctedInput, logs };
}

// =====================================================
// メイン採点関数
// =====================================================

/**
 * 検定採点のメイン関数
 * @param input 採点入力データ
 * @param rule 採点ルール
 * @returns 採点結果
 */
export function calculateCertificationScore(
  input: ScoringInput,
  rule: CertificationRule
): ScoringResult {
  // 1. 手動補正を適用
  const { correctedInput, logs: manualLogs } = applyManualCorrections(input);

  // 2. H-FVP評価が必要か確認
  const gradeNumber = parseInt(input.grade_code.replace('級', '')) as any;
  const includesHFVP = requiresHFVP(gradeNumber);

  // 3. 品質評価
  const qualityGrade = evaluateQuality(correctedInput.quality_metrics, includesHFVP);
  const qualityWarnings = generateQualityWarnings(
    correctedInput.quality_metrics,
    qualityGrade,
    includesHFVP
  );

  // 4. 項目別採点
  const angleDetails = scoreAngle(correctedInput, rule, qualityGrade);
  const strideDetails = scoreStride(correctedInput, rule, qualityGrade);
  const contactTimeDetails = scoreContactTime(correctedInput, rule, qualityGrade);
  const hfvpDetails = includesHFVP
    ? scoreHFVP(correctedInput, rule, qualityGrade)
    : undefined;

  // 5. テクニック点（暫定：固定値）
  // TODO: 将来的には別途評価ロジックを実装
  const techniqueScore = rule.technique_points;

  // 6. 総合得点計算
  const totalScore =
    angleDetails.overall_score +
    strideDetails.overall_score +
    contactTimeDetails.overall_score +
    (hfvpDetails?.overall_score || 0) +
    techniqueScore;

  // 7. 合格判定
  const passThreshold = getPassThreshold(gradeNumber);
  const isPassed = totalScore >= passThreshold && qualityGrade !== '参考';
  const scoreDifference = totalScore - passThreshold;

  // 8. 要確認フラグ
  const requiresReview =
    angleDetails.knee_flexion.is_near_threshold ||
    angleDetails.hip_extension.is_near_threshold ||
    angleDetails.trunk_lean.is_near_threshold ||
    strideDetails.stride_length_ratio.is_near_threshold ||
    strideDetails.stride_frequency.is_near_threshold ||
    contactTimeDetails.contact_time.is_near_threshold ||
    (hfvpDetails?.f0.is_near_threshold ?? false) ||
    (hfvpDetails?.v0.is_near_threshold ?? false);

  // 9. 結果返却
  return {
    angle_score: angleDetails.overall_score,
    stride_score: strideDetails.overall_score,
    contact_time_score: contactTimeDetails.overall_score,
    hfvp_score: hfvpDetails?.overall_score || 0,
    technique_score: techniqueScore,

    angle_details: angleDetails,
    stride_details: strideDetails,
    contact_time_details: contactTimeDetails,
    hfvp_details: hfvpDetails,

    total_score: Math.round(totalScore * 100) / 100,
    pass_threshold: passThreshold,
    is_passed: isPassed,
    score_difference: Math.round(scoreDifference * 100) / 100,

    quality_grade: qualityGrade,
    quality_warnings: qualityWarnings,

    requires_review: requiresReview,
    has_manual_corrections: manualLogs.length > 0,

    calculation_version: SCORING_VERSION,
    calculated_at: new Date().toISOString(),
  };
}

// =====================================================
// エクスポート
// =====================================================

export {
  QUALITY_THRESHOLDS,
  REVIEW_THRESHOLD_PERCENTAGE,
  SCORING_VERSION,
};
