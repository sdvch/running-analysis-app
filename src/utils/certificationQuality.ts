// =====================================================
// ランニング技能検定モード - 品質ゲート判定
// 作成日: 2026-02-12
// 説明: データ品質による採点減衰処理
// =====================================================

import type { QualityMetrics, QualityGrade } from '../types/certificationTypes';

// =====================================================
// 品質基準定義
// =====================================================

/** 品質基準 */
interface QualityThresholds {
  pose_confidence_min: number;
  frame_drop_max: number;
  fv_r2_min: number;
  pos_r2_min: number;
  measurement_points_min: number;
}

/** 品質ランク別の基準 */
const QUALITY_THRESHOLDS: Record<QualityGrade, QualityThresholds> = {
  '良': {
    pose_confidence_min: 0.80,
    frame_drop_max: 0.05,
    fv_r2_min: 0.90,
    pos_r2_min: 0.95,
    measurement_points_min: 5,
  },
  '可': {
    pose_confidence_min: 0.70,
    frame_drop_max: 0.10,
    fv_r2_min: 0.80,
    pos_r2_min: 0.90,
    measurement_points_min: 4,
  },
  '参考': {
    pose_confidence_min: 0.60,
    frame_drop_max: 0.20,
    fv_r2_min: 0.70,
    pos_r2_min: 0.80,
    measurement_points_min: 3,
  },
};

// =====================================================
// 品質評価関数
// =====================================================

/**
 * 品質ランクを判定
 */
export function evaluateQualityGrade(metrics: QualityMetrics): QualityGrade {
  const { pose_confidence_avg, frame_drop_rate, fv_r2, pos_r2, measurement_points } = metrics;
  
  // 良
  if (
    pose_confidence_avg >= QUALITY_THRESHOLDS['良'].pose_confidence_min &&
    frame_drop_rate <= QUALITY_THRESHOLDS['良'].frame_drop_max &&
    fv_r2 >= QUALITY_THRESHOLDS['良'].fv_r2_min &&
    pos_r2 >= QUALITY_THRESHOLDS['良'].pos_r2_min &&
    measurement_points >= QUALITY_THRESHOLDS['良'].measurement_points_min
  ) {
    return '良';
  }
  
  // 可
  if (
    pose_confidence_avg >= QUALITY_THRESHOLDS['可'].pose_confidence_min &&
    frame_drop_rate <= QUALITY_THRESHOLDS['可'].frame_drop_max &&
    fv_r2 >= QUALITY_THRESHOLDS['可'].fv_r2_min &&
    pos_r2 >= QUALITY_THRESHOLDS['可'].pos_r2_min &&
    measurement_points >= QUALITY_THRESHOLDS['可'].measurement_points_min
  ) {
    return '可';
  }
  
  // 参考
  return '参考';
}

/**
 * 品質警告メッセージを生成
 */
export function generateQualityWarnings(metrics: QualityMetrics): string[] {
  const warnings: string[] = [];
  
  if (metrics.pose_confidence_avg < 0.80) {
    warnings.push(
      `姿勢推定の信頼度が低い（平均: ${(metrics.pose_confidence_avg * 100).toFixed(1)}%）`
    );
  }
  
  if (metrics.pose_confidence_min < 0.60) {
    warnings.push(
      `一部フレームの姿勢推定精度が著しく低い（最低: ${(metrics.pose_confidence_min * 100).toFixed(1)}%）`
    );
  }
  
  if (metrics.frame_drop_rate > 0.10) {
    warnings.push(
      `フレームドロップ率が高い（${(metrics.frame_drop_rate * 100).toFixed(1)}%）`
    );
  }
  
  if (metrics.fv_r2 < 0.90) {
    warnings.push(
      `H-FVP回帰の決定係数が低い（R² = ${metrics.fv_r2.toFixed(3)}）、H-FVP評価は参考値`
    );
  }
  
  if (metrics.pos_r2 < 0.95) {
    warnings.push(
      `位置フィットの決定係数が低い（R² = ${metrics.pos_r2.toFixed(3)}）`
    );
  }
  
  if (metrics.measurement_points < 5) {
    warnings.push(
      `測定ポイント数が少ない（${metrics.measurement_points}点）、より多くの測定点を推奨`
    );
  }
  
  return warnings;
}

/**
 * H-FVP評価の減衰係数を計算
 * 
 * @param qualityGrade 品質ランク
 * @param fvR2 F-V回帰のR²
 * @returns 減衰係数（0.0〜1.0）
 */
export function calculateHFVPDecayFactor(qualityGrade: QualityGrade, fvR2: number): number {
  // 品質ランク別の基本係数
  const baseFactors: Record<QualityGrade, number> = {
    '良': 1.0,  // 減衰なし
    '可': 0.7,  // 30%減衰
    '参考': 0.0, // H-FVP評価なし
  };
  
  let factor = baseFactors[qualityGrade];
  
  // R²による追加減衰（可の場合のみ）
  if (qualityGrade === '可') {
    if (fvR2 < 0.85) {
      factor *= 0.8; // さらに20%減衰
    } else if (fvR2 < 0.80) {
      factor = 0.0; // R²が0.80未満はH-FVP評価なし
    }
  }
  
  return Math.max(0, Math.min(1, factor));
}

/**
 * 品質による全体的な減衰係数を計算
 * 
 * @param qualityGrade 品質ランク
 * @returns 減衰係数（0.0〜1.0）
 */
export function calculateOverallDecayFactor(qualityGrade: QualityGrade): number {
  const factors: Record<QualityGrade, number> = {
    '良': 1.0,  // 減衰なし
    '可': 0.95, // 5%減衰
    '参考': 0.85, // 15%減衰
  };
  
  return factors[qualityGrade];
}

/**
 * 品質ゲート通過判定
 * 
 * @param metrics 品質指標
 * @returns 品質ゲート通過か
 */
export function passesQualityGate(metrics: QualityMetrics): boolean {
  const grade = evaluateQualityGrade(metrics);
  return grade === '良' || grade === '可';
}

/**
 * 品質情報のサマリーを生成
 */
export function generateQualitySummary(metrics: QualityMetrics): string {
  const grade = evaluateQualityGrade(metrics);
  const warnings = generateQualityWarnings(metrics);
  
  let summary = `データ品質: ${grade}\n`;
  
  if (warnings.length > 0) {
    summary += '\n警告事項:\n';
    warnings.forEach(w => {
      summary += `  • ${w}\n`;
    });
  }
  
  if (grade === '参考') {
    summary += '\n※ データ品質が低いため、H-FVP評価は行われません。\n';
    summary += '※ 採点結果は参考値として扱ってください。\n';
  }
  
  return summary;
}

/**
 * 品質指標の検証
 */
export function validateQualityMetrics(metrics: QualityMetrics): string[] {
  const errors: string[] = [];
  
  if (metrics.pose_confidence_avg < 0 || metrics.pose_confidence_avg > 1) {
    errors.push('pose_confidence_avg は 0〜1 の範囲である必要があります');
  }
  
  if (metrics.pose_confidence_min < 0 || metrics.pose_confidence_min > 1) {
    errors.push('pose_confidence_min は 0〜1 の範囲である必要があります');
  }
  
  if (metrics.frame_drop_rate < 0 || metrics.frame_drop_rate > 1) {
    errors.push('frame_drop_rate は 0〜1 の範囲である必要があります');
  }
  
  if (metrics.fv_r2 < 0 || metrics.fv_r2 > 1) {
    errors.push('fv_r2 は 0〜1 の範囲である必要があります');
  }
  
  if (metrics.pos_r2 < 0 || metrics.pos_r2 > 1) {
    errors.push('pos_r2 は 0〜1 の範囲である必要があります');
  }
  
  if (metrics.measurement_points < 0) {
    errors.push('measurement_points は 0 以上である必要があります');
  }
  
  return errors;
}
