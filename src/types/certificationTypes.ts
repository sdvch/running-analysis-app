// =====================================================
// ランニング技能検定モード - 型定義
// 作成日: 2026-02-12
// 説明: 検定機能の全型定義（DBスキーマと連携）
// =====================================================

// =====================================================
// 基本型
// =====================================================

/** 級番号（1〜10） */
export type GradeNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

/** 級コード（文字列） */
export type GradeCode = '1級' | '2級' | '3級' | '4級' | '5級' | '6級' | '7級' | '8級' | '9級' | '10級';

/** 合格基準点 */
export type PassThreshold = 70 | 80;

/** データ品質ランク */
export type QualityGrade = '良' | '可' | '参考';

/** 検定状態（既存のセッションステータス） */
export type CertificationStatus = 'in_progress' | 'completed' | 'failed' | 'cancelled';

/** 判定モード（二層判定用） */
export type JudgmentMode = 'AUTO_FINAL' | 'REVIEW_REQUIRED';

/** 試行ステータス（二層判定用） */
export type AttemptStatus = 
  | 'draft'                 // 下書き
  | 'submitted'             // 提出済み（2・1級）
  | 'auto_pass'             // 自動合格（10〜3級）
  | 'auto_fail'             // 自動不合格（10〜3級）
  | 'under_review'          // 審査中（2・1級）
  | 'certified_pass'        // 認定合格（2・1級）
  | 'certified_fail'        // 認定不合格（2・1級）
  | 'needs_resubmission';   // 再提出要求（2・1級）

/** 評価項目 */
export type EvaluationItem = 'angle' | 'stride' | 'contact_time' | 'hfvp' | 'technique';

// =====================================================
// 級・ルール関連
// =====================================================

/** 級マスタ */
export interface CertificationGrade {
  id: string;
  grade_number: GradeNumber;
  grade_name: GradeCode;
  grade_name_en: string;
  description: string;
  target_level: string;
  pass_score: PassThreshold;
  display_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/** 角度基準 */
export interface AngleCriteria {
  knee_flexion_min: number;
  knee_flexion_max: number;
  knee_flexion_ideal: number;
  hip_extension_min: number;
  hip_extension_ideal: number;
  trunk_lean_min: number;
  trunk_lean_max: number;
  trunk_lean_ideal: number;
}

/** ストライド基準 */
export interface StrideCriteria {
  stride_length_ratio_min: number;
  stride_length_ratio_max: number;
  stride_length_ratio_ideal: number;
  stride_frequency_min: number;
  stride_frequency_max: number;
  stride_frequency_ideal: number;
}

/** 接地時間基準 */
export interface ContactTimeCriteria {
  contact_time_min: number;
  contact_time_max: number;
  contact_time_ideal: number;
  flight_time_min?: number;
  flight_time_ideal?: number;
}

/** H-FVP基準 */
export interface HFVPCriteria {
  f0_min: number;
  f0_ideal: number;
  v0_min: number;
  v0_ideal: number;
  pmax_min: number;
  pmax_ideal: number;
  drf_min: number;
  drf_max: number;
  drf_ideal: number;
}

/** ルールJSON */
export interface RuleJSON {
  priority: EvaluationItem[];
  angle_criteria: AngleCriteria;
  stride_criteria: StrideCriteria;
  contact_time_criteria: ContactTimeCriteria;
  hfvp_criteria?: HFVPCriteria; // 1級・2級のみ
}

/** 採点ルール */
export interface CertificationRule {
  id: string;
  grade_id: string;
  version: number;
  angle_points: number;
  stride_points: number;
  contact_time_points: number;
  hfvp_points: number;
  technique_points: number;
  rule_json: RuleJSON;
  is_active: boolean;
  effective_from: string;
  effective_until: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

// =====================================================
// 測定データ
// =====================================================

/** 角度測定データ */
export interface AngleMeasurement {
  knee_left: number[];
  knee_right: number[];
  hip_left: number[];
  hip_right: number[];
  trunk: number[];
  average: {
    knee: number;
    hip: number;
    trunk: number;
  };
}

/** ストライド測定データ */
export interface StrideMeasurement {
  stride_length: number; // m
  stride_frequency: number; // Hz
  height_ratio: number; // stride_length / height
  step_count: number;
}

/** 接地時間測定データ */
export interface ContactTimeMeasurement {
  average: number; // s
  min: number;
  max: number;
  values: number[];
  flight_time_average?: number;
}

/** H-FVP測定データ */
export interface HFVPMeasurement {
  f0: number; // N/kg
  v0: number; // m/s
  pmax: number; // W/kg
  drf: number; // %/(m/s)
  rf_max: number; // %
  fv_r2: number; // F-V回帰のR²
  pos_r2: number; // 位置フィットのR²
}

/** 品質指標 */
export interface QualityMetrics {
  pose_confidence_avg: number; // 0-1
  pose_confidence_min: number;
  frame_drop_rate: number; // 0-1
  measurement_points: number;
  fv_r2: number; // F-V回帰のR²
  pos_r2: number; // 位置フィットのR²
}

/** 手動補正値 */
export interface ManualCorrection {
  item: EvaluationItem;
  original_value: number;
  corrected_value: number;
  reason: string;
  corrected_by: string;
  corrected_at: string;
}

/** 採点入力データ */
export interface ScoringInput {
  grade_code: GradeCode;
  angle_measurement: AngleMeasurement;
  stride_measurement: StrideMeasurement;
  contact_time_measurement: ContactTimeMeasurement;
  hfvp_measurement?: HFVPMeasurement; // 1級・2級のみ
  quality_metrics: QualityMetrics;
  manual_corrections?: ManualCorrection[];
}

// =====================================================
// 採点結果
// =====================================================

/** 項目別詳細評価 */
export interface ItemScoreDetail {
  raw_value: number;
  criteria_min: number;
  criteria_max: number;
  criteria_ideal: number;
  deviation: number; // 理想値からの偏差
  score: number; // 獲得点数
  max_score: number; // 配点
  percentage: number; // 得点率（%）
  is_within_range: boolean;
  is_near_threshold: boolean; // ±5%以内
  quality_adjusted: boolean; // 品質による減衰が適用されたか
}

/** 角度詳細 */
export interface AngleScoreDetails {
  knee_flexion: ItemScoreDetail;
  hip_extension: ItemScoreDetail;
  trunk_lean: ItemScoreDetail;
  overall_score: number;
  sub_scores: {
    knee: number;
    hip: number;
    trunk: number;
  };
}

/** ストライド詳細 */
export interface StrideScoreDetails {
  stride_length_ratio: ItemScoreDetail;
  stride_frequency: ItemScoreDetail;
  overall_score: number;
  sub_scores: {
    length: number;
    frequency: number;
  };
}

/** 接地時間詳細 */
export interface ContactTimeScoreDetails {
  contact_time: ItemScoreDetail;
  flight_time?: ItemScoreDetail;
  overall_score: number;
}

/** H-FVP詳細 */
export interface HFVPScoreDetails {
  f0: ItemScoreDetail;
  v0: ItemScoreDetail;
  pmax: ItemScoreDetail;
  drf: ItemScoreDetail;
  overall_score: number;
  sub_scores: {
    f0: number;
    v0: number;
    pmax: number;
    drf: number;
  };
}

/** 採点結果 */
export interface ScoringResult {
  // 項目別得点
  angle_score: number;
  stride_score: number;
  contact_time_score: number;
  hfvp_score: number;
  technique_score: number;
  
  // 詳細
  angle_details: AngleScoreDetails;
  stride_details: StrideScoreDetails;
  contact_time_details: ContactTimeScoreDetails;
  hfvp_details?: HFVPScoreDetails;
  
  // 総合
  total_score: number;
  pass_threshold: PassThreshold;
  is_passed: boolean;
  score_difference: number; // 合格ラインとの差分
  
  // 品質情報
  quality_grade: QualityGrade;
  quality_warnings: string[];
  
  // フラグ
  requires_review: boolean; // 要確認フラグ
  has_manual_corrections: boolean;
  
  // メタ情報
  calculation_version: string;
  calculated_at: string;
}

// =====================================================
// フィードバック
// =====================================================

/** 改善アドバイス */
export interface ImprovementAdvice {
  category: EvaluationItem;
  current_value: number;
  target_value: number;
  gap: number;
  priority: 'high' | 'medium' | 'low';
  recommendations: string[];
  training_methods: string[];
}

/** 評価フィードバック */
export interface EvaluationFeedback {
  strengths: string[];
  weaknesses: string[];
  improvements: ImprovementAdvice[];
  overall_comment: string;
  next_grade_requirements?: string;
}

// =====================================================
// 監査ログ
// =====================================================

/** 監査イベント種別（二層判定用の追加イベント含む） */
export type AuditEventType =
  | 'session_started'
  | 'session_completed'
  | 'session_cancelled'
  | 'attempt_started'
  | 'attempt_completed'
  | 'score_calculated'
  | 'manual_correction_applied'
  | 'result_issued'
  | 'certificate_generated'
  | 'rule_updated'
  | 'manual_override'
  // 二層判定用の追加イベント
  | 'attempt_submitted'
  | 'review_assigned'
  | 'review_started'
  | 'review_completed'
  | 'certificate_applied'
  | 'certificate_issued'
  | 'certificate_rejected'
  | 'video_uploaded'
  | 'status_changed';

/** 監査ログエントリ */
export interface AuditLogEntry {
  id: string;
  session_id: string | null;
  event_type: AuditEventType;
  event_data: Record<string, any>;
  user_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
}

/** 手動修正ログ */
export interface ManualCorrectionLog {
  item: EvaluationItem;
  field: string;
  old_value: number;
  new_value: number;
  reason: string;
  corrected_by: string;
  corrected_at: string;
}

// =====================================================
// 検定セッション
// =====================================================

/** 検定セッション */
export interface CertificationSession {
  id: string;
  user_id: string | null;
  athlete_id: string | null;
  athlete_name: string | null;
  grade_id: string;
  rule_id: string;
  analysis_session_id: string | null;
  video_file_name: string | null;
  video_duration: number | null;
  analysis_mode: 'single' | 'panning';
  started_at: string;
  completed_at: string | null;
  status: CertificationStatus;
  device_info: Record<string, any> | null;
  created_at: string;
  updated_at: string;
}

/** 検定試行（二層判定モデル対応） */
export interface CertificationAttempt {
  id: string;
  session_id: string;
  attempt_number: number;
  pose_data: Record<string, any> | null;
  raw_metrics: Record<string, any> | null;
  started_at: string;
  completed_at: string | null;
  
  // 二層判定モデルフィールド
  status?: AttemptStatus;
  judgment_mode?: JudgmentMode;
  grade_code?: string | null;
  fixed_video_url?: string | null;
  panning_video_url?: string | null;
  submitted_at?: string | null;
  reviewed_at?: string | null;
  reviewer_id?: string | null;
}

/** 検定結果 */
export interface CertificationResult {
  id: string;
  session_id: string;
  attempt_id: string;
  score_id: string;
  is_passed: boolean;
  pass_threshold: PassThreshold;
  total_score: number;
  score_difference: number;
  rank_in_grade: number | null;
  percentile: number | null;
  feedback_json: EvaluationFeedback | null;
  certificate_number: string | null;
  certificate_issued_at: string | null;
  certificate_expires_at: string | null;
  certificate_url: string | null;
  evaluated_at: string;
  created_at: string;
}

// =====================================================
// ヘルパー型
// =====================================================

/** 級番号から級コードへの変換 */
export const gradeNumberToCode = (num: GradeNumber): GradeCode => {
  return `${num}級` as GradeCode;
};

/** 級コードから級番号への変換 */
export const gradeCodeToNumber = (code: GradeCode): GradeNumber => {
  return parseInt(code.replace('級', '')) as GradeNumber;
};

/** 合格基準点の取得 */
export const getPassThreshold = (gradeNumber: GradeNumber): PassThreshold => {
  return gradeNumber <= 2 ? 80 : 70;
};

/** H-FVP評価が必要か */
export const requiresHFVP = (gradeNumber: GradeNumber): boolean => {
  return gradeNumber <= 2;
};
