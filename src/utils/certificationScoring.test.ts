// =====================================================
// ランニング技能検定モード - 採点エンジン テスト
// 作成日: 2026-02-12
// 説明: calculateCertificationScore のユニットテスト
// =====================================================

import { describe, it, expect } from 'vitest';
import {
  calculateCertificationScore,
  evaluateQuality,
  generateQualityWarnings,
  QUALITY_THRESHOLDS,
} from './certificationScoring';
import type {
  ScoringInput,
  CertificationRule,
  ScoringResult,
} from '../types/certificationTypes';

// =====================================================
// モックデータ生成
// =====================================================

/** 2級の採点ルール（モック） */
const mockRule2級: CertificationRule = {
  id: 'rule-2',
  grade_id: 'grade-2',
  version: 1,
  angle_points: 30,
  stride_points: 25,
  contact_time_points: 20,
  hfvp_points: 15,
  technique_points: 10,
  rule_json: {
    priority: ['angle', 'stride', 'contact_time', 'hfvp'],
    angle_criteria: {
      knee_flexion_min: 90,
      knee_flexion_max: 160,
      knee_flexion_ideal: 130,
      hip_extension_min: 145,
      hip_extension_ideal: 165,
      trunk_lean_min: 2,
      trunk_lean_max: 8,
      trunk_lean_ideal: 5,
    },
    stride_criteria: {
      stride_length_ratio_min: 2.0,
      stride_length_ratio_max: 2.5,
      stride_length_ratio_ideal: 2.3,
      stride_frequency_min: 4.0,
      stride_frequency_max: 5.0,
      stride_frequency_ideal: 4.5,
    },
    contact_time_criteria: {
      contact_time_min: 0.08,
      contact_time_max: 0.12,
      contact_time_ideal: 0.10,
    },
    hfvp_criteria: {
      f0_min: 4.0,
      f0_ideal: 5.0,
      v0_min: 11.0,
      v0_ideal: 12.0,
      pmax_min: 20.0,
      pmax_ideal: 25.0,
      drf_min: -10,
      drf_max: -6,
      drf_ideal: -8,
    },
  },
  is_active: true,
  effective_from: '2026-01-01T00:00:00Z',
  effective_until: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  created_by: null,
};

/** 5級の採点ルール（モック、H-FVPなし） */
const mockRule5級: CertificationRule = {
  id: 'rule-5',
  grade_id: 'grade-5',
  version: 1,
  angle_points: 40,
  stride_points: 30,
  contact_time_points: 20,
  hfvp_points: 0,
  technique_points: 10,
  rule_json: {
    priority: ['angle', 'stride', 'contact_time'],
    angle_criteria: {
      knee_flexion_min: 85,
      knee_flexion_max: 165,
      knee_flexion_ideal: 125,
      hip_extension_min: 140,
      hip_extension_ideal: 160,
      trunk_lean_min: 0,
      trunk_lean_max: 12,
      trunk_lean_ideal: 6,
    },
    stride_criteria: {
      stride_length_ratio_min: 1.8,
      stride_length_ratio_max: 2.4,
      stride_length_ratio_ideal: 2.1,
      stride_frequency_min: 3.5,
      stride_frequency_max: 4.8,
      stride_frequency_ideal: 4.2,
    },
    contact_time_criteria: {
      contact_time_min: 0.09,
      contact_time_max: 0.14,
      contact_time_ideal: 0.11,
    },
  },
  is_active: true,
  effective_from: '2026-01-01T00:00:00Z',
  effective_until: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  created_by: null,
};

/** 理想的な測定データ（2級合格レベル） */
function createIdealInput2級(): ScoringInput {
  return {
    grade_code: '2級',
    angle_measurement: {
      knee_left: [130, 128, 132],
      knee_right: [130, 129, 131],
      hip_left: [165, 163, 167],
      hip_right: [165, 164, 166],
      trunk: [5, 4.8, 5.2],
      average: {
        knee: 130,
        hip: 165,
        trunk: 5,
      },
    },
    stride_measurement: {
      stride_length: 4.0,
      stride_frequency: 4.5,
      height_ratio: 2.3,
      step_count: 25,
    },
    contact_time_measurement: {
      average: 0.10,
      min: 0.09,
      max: 0.11,
      values: [0.10, 0.09, 0.11, 0.10],
    },
    hfvp_measurement: {
      f0: 5.0,
      v0: 12.0,
      pmax: 25.0,
      drf: -8.0,
      rf_max: 45,
      fv_r2: 0.95,
      pos_r2: 0.98,
    },
    quality_metrics: {
      pose_confidence_avg: 0.85,
      pose_confidence_min: 0.75,
      frame_drop_rate: 0.05,
      measurement_points: 50,
      fv_r2: 0.95,
      pos_r2: 0.98,
    },
  };
}

/** 品質不足の測定データ */
function createPoorQualityInput(): ScoringInput {
  const input = createIdealInput2級();
  input.quality_metrics = {
    pose_confidence_avg: 0.40, // 低い
    pose_confidence_min: 0.30,
    frame_drop_rate: 0.25, // 高い
    measurement_points: 20,
    fv_r2: 0.70, // 低い
    pos_r2: 0.75,
  };
  return input;
}

/** 基準外の測定データ（不合格） */
function createOutOfRangeInput(): ScoringInput {
  const input = createIdealInput2級();
  // 膝が曲がりすぎ
  input.angle_measurement.average.knee = 80;
  // ストライド短すぎ
  input.stride_measurement.height_ratio = 1.5;
  // 接地時間長すぎ
  input.contact_time_measurement.average = 0.20;
  return input;
}

/** 閾値ギリギリの測定データ（要確認） */
function createNearThresholdInput(): ScoringInput {
  const input = createIdealInput2級();
  // 膝が基準最小値の近く（90 + 5% = 94.5）
  input.angle_measurement.average.knee = 94;
  return input;
}

// =====================================================
// テストスイート
// =====================================================

describe('certificationScoring', () => {
  // ===== 品質評価テスト =====
  describe('evaluateQuality', () => {
    it('良: すべての指標が良好', () => {
      const quality = {
        pose_confidence_avg: 0.85,
        pose_confidence_min: 0.75,
        frame_drop_rate: 0.05,
        measurement_points: 50,
        fv_r2: 0.95,
        pos_r2: 0.98,
      };
      expect(evaluateQuality(quality, true)).toBe('良');
    });

    it('可: 指標が可レベル', () => {
      const quality = {
        pose_confidence_avg: 0.65,
        pose_confidence_min: 0.55,
        frame_drop_rate: 0.15,
        measurement_points: 40,
        fv_r2: 0.85,
        pos_r2: 0.90,
      };
      expect(evaluateQuality(quality, true)).toBe('可');
    });

    it('参考: 指標が基準未達', () => {
      const quality = {
        pose_confidence_avg: 0.40,
        pose_confidence_min: 0.30,
        frame_drop_rate: 0.30,
        measurement_points: 20,
        fv_r2: 0.70,
        pos_r2: 0.75,
      };
      expect(evaluateQuality(quality, true)).toBe('参考');
    });

    it('H-FVP不要の場合はF-V R²を無視', () => {
      const quality = {
        pose_confidence_avg: 0.85,
        pose_confidence_min: 0.75,
        frame_drop_rate: 0.05,
        measurement_points: 50,
        fv_r2: 0.70, // 低いがH-FVP不要なので無視
        pos_r2: 0.98,
      };
      expect(evaluateQuality(quality, false)).toBe('良');
    });
  });

  describe('generateQualityWarnings', () => {
    it('品質良好の場合は警告なし', () => {
      const quality = {
        pose_confidence_avg: 0.85,
        pose_confidence_min: 0.75,
        frame_drop_rate: 0.05,
        measurement_points: 50,
        fv_r2: 0.95,
        pos_r2: 0.98,
      };
      const warnings = generateQualityWarnings(quality, '良', true);
      expect(warnings).toHaveLength(0);
    });

    it('品質不足の場合は警告あり', () => {
      const quality = {
        pose_confidence_avg: 0.40,
        pose_confidence_min: 0.30,
        frame_drop_rate: 0.30,
        measurement_points: 20,
        fv_r2: 0.70,
        pos_r2: 0.75,
      };
      const warnings = generateQualityWarnings(quality, '参考', true);
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings.some((w) => w.includes('姿勢認識'))).toBe(true);
      expect(warnings.some((w) => w.includes('フレームドロップ'))).toBe(true);
      expect(warnings.some((w) => w.includes('H-FVP回帰'))).toBe(true);
    });
  });

  // ===== 採点エンジンテスト =====
  describe('calculateCertificationScore', () => {
    // ケース1: 理想的なデータで合格
    it('ケース1: 理想的なデータで合格（2級）', () => {
      const input = createIdealInput2級();
      const result = calculateCertificationScore(input, mockRule2級);

      // 合格判定
      expect(result.is_passed).toBe(true);
      expect(result.total_score).toBeGreaterThanOrEqual(80);
      expect(result.pass_threshold).toBe(80);

      // 品質
      expect(result.quality_grade).toBe('良');
      expect(result.quality_warnings).toHaveLength(0);

      // 項目別得点
      expect(result.angle_score).toBeGreaterThan(0);
      expect(result.stride_score).toBeGreaterThan(0);
      expect(result.contact_time_score).toBeGreaterThan(0);
      expect(result.hfvp_score).toBeGreaterThan(0);
      expect(result.technique_score).toBe(10);

      // 詳細
      expect(result.angle_details.knee_flexion.is_within_range).toBe(true);
      expect(result.stride_details.stride_length_ratio.is_within_range).toBe(true);
      expect(result.contact_time_details.contact_time.is_within_range).toBe(true);
      expect(result.hfvp_details?.f0.is_within_range).toBe(true);

      // フラグ
      expect(result.requires_review).toBe(false);
      expect(result.has_manual_corrections).toBe(false);
    });

    // ケース2: 品質不足で参考値扱い（不合格）
    it('ケース2: 品質不足で参考値扱い（不合格）', () => {
      const input = createPoorQualityInput();
      const result = calculateCertificationScore(input, mockRule2級);

      // 不合格（品質「参考」は合格不可）
      expect(result.is_passed).toBe(false);
      expect(result.quality_grade).toBe('参考');
      expect(result.quality_warnings.length).toBeGreaterThan(0);

      // 採点が大幅に減点されている（参考値は0点）
      expect(result.total_score).toBeLessThan(80);
    });

    // ケース3: 基準外の値で不合格
    it('ケース3: 基準外の値で不合格', () => {
      const input = createOutOfRangeInput();
      const result = calculateCertificationScore(input, mockRule2級);

      // 不合格
      expect(result.is_passed).toBe(false);
      expect(result.total_score).toBeLessThan(80);

      // 範囲外項目は0点
      expect(result.angle_details.knee_flexion.is_within_range).toBe(false);
      expect(result.angle_details.knee_flexion.score).toBe(0);
      expect(result.stride_details.stride_length_ratio.is_within_range).toBe(false);
      expect(result.contact_time_details.contact_time.is_within_range).toBe(false);
    });

    // ケース4: 閾値ギリギリで要確認フラグ
    it('ケース4: 閾値ギリギリで要確認フラグ', () => {
      const input = createNearThresholdInput();
      const result = calculateCertificationScore(input, mockRule2級);

      // 要確認フラグ立つ
      expect(result.requires_review).toBe(true);
      expect(result.angle_details.knee_flexion.is_near_threshold).toBe(true);
    });

    // ケース5: H-FVP不要な級（5級）
    it('ケース5: H-FVP不要な級（5級）', () => {
      const input: ScoringInput = {
        grade_code: '5級',
        angle_measurement: {
          knee_left: [125],
          knee_right: [125],
          hip_left: [160],
          hip_right: [160],
          trunk: [6],
          average: {
            knee: 125,
            hip: 160,
            trunk: 6,
          },
        },
        stride_measurement: {
          stride_length: 3.5,
          stride_frequency: 4.2,
          height_ratio: 2.1,
          step_count: 20,
        },
        contact_time_measurement: {
          average: 0.11,
          min: 0.10,
          max: 0.12,
          values: [0.11],
        },
        quality_metrics: {
          pose_confidence_avg: 0.80,
          pose_confidence_min: 0.70,
          frame_drop_rate: 0.08,
          measurement_points: 40,
          fv_r2: 0.70, // 低いがH-FVP不要なので問題なし
          pos_r2: 0.90,
        },
      };

      const result = calculateCertificationScore(input, mockRule5級);

      // H-FVPなし
      expect(result.hfvp_score).toBe(0);
      expect(result.hfvp_details).toBeUndefined();

      // 品質は「良」（H-FVP R²を無視）
      expect(result.quality_grade).toBe('良');

      // 合格判定（70点以上）
      expect(result.pass_threshold).toBe(70);
      if (result.total_score >= 70) {
        expect(result.is_passed).toBe(true);
      }
    });

    // ケース6: 手動補正あり
    it('ケース6: 手動補正あり', () => {
      const input = createIdealInput2級();
      input.manual_corrections = [
        {
          item: 'contact_time',
          original_value: 0.15,
          corrected_value: 0.10,
          reason: '計測エラー修正',
          corrected_by: 'admin',
          corrected_at: '2026-02-12T10:00:00Z',
        },
      ];

      const result = calculateCertificationScore(input, mockRule2級);

      // 手動補正フラグ
      expect(result.has_manual_corrections).toBe(true);

      // 補正後の値で採点
      expect(result.contact_time_details.contact_time.raw_value).toBe(0.10);
    });

    // ケース7: H-FVP品質ゲート（F-V R²が低い）
    it('ケース7: H-FVP品質ゲート（F-V R²が低い）', () => {
      const input = createIdealInput2級();
      input.quality_metrics.fv_r2 = 0.75; // 基準未達
      input.hfvp_measurement!.fv_r2 = 0.75;

      const result = calculateCertificationScore(input, mockRule2級);

      // H-FVPが品質減衰または0点
      expect(result.hfvp_details?.f0.quality_adjusted).toBe(true);
      expect(result.hfvp_score).toBeLessThan(mockRule2級.hfvp_points);
    });

    // ケース8: 得点上限クリップ
    it('ケース8: 得点上限クリップ', () => {
      const input = createIdealInput2級();
      const result = calculateCertificationScore(input, mockRule2級);

      // 各項目の得点が配点を超えない
      expect(result.angle_score).toBeLessThanOrEqual(mockRule2級.angle_points);
      expect(result.stride_score).toBeLessThanOrEqual(mockRule2級.stride_points);
      expect(result.contact_time_score).toBeLessThanOrEqual(mockRule2級.contact_time_points);
      expect(result.hfvp_score).toBeLessThanOrEqual(mockRule2級.hfvp_points);
      expect(result.technique_score).toBeLessThanOrEqual(mockRule2級.technique_points);

      // 総合得点は100点を超えない
      expect(result.total_score).toBeLessThanOrEqual(100);
    });
  });

  // ===== 統合テスト：実際の流れ =====
  describe('統合テスト', () => {
    it('通常の検定フロー（合格）', () => {
      const input = createIdealInput2級();
      const result = calculateCertificationScore(input, mockRule2級);

      // 1. 品質チェックOK
      expect(result.quality_grade).toBe('良');

      // 2. 採点完了
      expect(result.total_score).toBeGreaterThan(0);

      // 3. 合格判定
      expect(result.is_passed).toBe(true);
      expect(result.score_difference).toBeGreaterThan(0);

      // 4. メタ情報
      expect(result.calculation_version).toBeTruthy();
      expect(result.calculated_at).toBeTruthy();
    });

    it('通常の検定フロー（不合格・再挑戦推奨）', () => {
      const input = createOutOfRangeInput();
      const result = calculateCertificationScore(input, mockRule2級);

      // 不合格
      expect(result.is_passed).toBe(false);
      expect(result.score_difference).toBeLessThan(0);

      // 改善ポイントが分かる
      expect(result.angle_details.knee_flexion.deviation).not.toBe(0);
      expect(result.stride_details.stride_length_ratio.deviation).not.toBe(0);
    });
  });
});
