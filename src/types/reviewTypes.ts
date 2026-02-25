// =====================================================
// 二層判定モデル - 型定義
// 作成日: 2026-02-12
// 説明: 審査フロー用の型定義
// =====================================================

// =====================================================
// 基本型定義
// =====================================================

/**
 * 判定モード
 * - AUTO_FINAL: 自動最終判定（10級〜3級）
 * - REVIEW_REQUIRED: 検定員審査必須（2級・1級）
 */
export type JudgmentMode = 'AUTO_FINAL' | 'REVIEW_REQUIRED';

/**
 * 試行ステータス
 */
export type AttemptStatus = 
  | 'draft'                 // 下書き（受検者が入力中）
  | 'submitted'             // 提出済み（2・1級のみ、審査待ち）
  | 'auto_pass'             // 自動合格（10〜3級）
  | 'auto_fail'             // 自動不合格（10〜3級）
  | 'under_review'          // 審査中（2・1級）
  | 'certified_pass'        // 検定員認定合格（2・1級）
  | 'certified_fail'        // 検定員認定不合格（2・1級）
  | 'needs_resubmission';   // 再提出要求（2・1級）

/**
 * 審査タスクステータス
 */
export type ReviewTaskStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

/**
 * 審査判定
 */
export type ReviewDecision = 'pass' | 'fail' | 'resubmit';

/**
 * 証明書申請ステータス
 */
export type CertificateApplicationStatus = 'not_applied' | 'applied' | 'issued' | 'rejected';

// =====================================================
// 審査タスク（review_tasks）
// =====================================================

export interface ReviewTask {
  id: string;
  attempt_id: string;
  reviewer_id?: string;
  assigned_at?: string;
  status: ReviewTaskStatus;
  priority: number;           // 1=最高、10=最低
  due_date?: string;
  notes?: string;
  created_at: string;
  updated_at: string;
  created_by?: string;
}

export interface ReviewTaskCreate {
  attempt_id: string;
  reviewer_id?: string;
  priority?: number;
  due_date?: string;
  notes?: string;
}

// =====================================================
// 審査チェックリスト（review_checklists）
// =====================================================

export interface ReviewChecklist {
  id: string;
  attempt_id: string;
  reviewer_id: string;
  
  // チェック項目（2・1級共通）
  posture_alignment?: boolean;           // 姿勢アライメント
  knee_angle_appropriate?: boolean;      // 膝角度の適切性
  stride_consistency?: boolean;          // ストライド一貫性
  ground_contact_efficiency?: boolean;   // 接地効率
  arm_swing_coordination?: boolean;      // 腕振り協調性
  
  // 1級専用チェック項目
  hfvp_linearity?: boolean;              // H-FVP直線性（1級のみ）
  hfvp_r2_acceptable?: boolean;          // H-FVP R²閾値達成（1級のみ）
  
  // 総合評価
  overall_technique_score?: number;      // 0〜100点
  video_quality_acceptable: boolean;     // 動画品質が審査可能か
  
  // 手動補正値（必要に応じて）
  manual_angle_correction?: number;
  manual_stride_correction?: number;
  manual_contact_correction?: number;
  manual_hfvp_correction?: number;
  
  // 判定
  decision: ReviewDecision;
  decision_reason: string;               // 必須、10文字以上
  additional_comments?: string;
  
  // メタデータ
  submitted_at: string;
  decided_at: string;
}

export interface ReviewChecklistInput {
  attempt_id: string;
  
  // チェック項目
  posture_alignment?: boolean;
  knee_angle_appropriate?: boolean;
  stride_consistency?: boolean;
  ground_contact_efficiency?: boolean;
  arm_swing_coordination?: boolean;
  hfvp_linearity?: boolean;
  hfvp_r2_acceptable?: boolean;
  
  overall_technique_score?: number;
  video_quality_acceptable: boolean;
  
  // 手動補正
  manual_angle_correction?: number;
  manual_stride_correction?: number;
  manual_contact_correction?: number;
  manual_hfvp_correction?: number;
  
  // 判定
  decision: ReviewDecision;
  decision_reason: string;
  additional_comments?: string;
}

// =====================================================
// 証明書申請（certificate_applications）
// =====================================================

export interface CertificateApplication {
  id: string;
  attempt_id: string;
  user_id: string;
  
  // 申請者情報
  full_name: string;
  display_name: string;
  birth_date: string;          // YYYY-MM-DD
  affiliation?: string;
  email: string;
  phone?: string;
  postal_code?: string;
  address?: string;
  
  // 申請情報
  application_id?: string;     // 例: JRPO-2026-001234
  grade_code: string;
  status: CertificateApplicationStatus;
  
  // 証明書情報
  certificate_number?: string;
  certificate_url?: string;
  issued_at?: string;
  expires_at?: string;
  
  // メタデータ
  applied_at: string;
  created_at: string;
  updated_at: string;
  created_by?: string;
}

export interface CertificateApplicationInput {
  attempt_id: string;
  
  // 申請者情報
  full_name: string;
  display_name: string;
  birth_date: string;
  affiliation?: string;
  email: string;
  phone?: string;
  postal_code?: string;
  address?: string;
  
  grade_code: string;
}

// =====================================================
// 審査ビュー（review_pending_list）
// =====================================================

export interface ReviewPendingItem {
  task_id: string;
  reviewer_id?: string;
  assigned_at?: string;
  due_date?: string;
  priority: number;
  attempt_id: string;
  grade_code?: string;
  status: AttemptStatus;
  submitted_at?: string;
  fixed_video_url?: string;
  panning_video_url?: string;
  candidate_email?: string;
}

// =====================================================
// 証明書発行サマリー（certificate_issuance_summary）
// =====================================================

export interface CertificateIssuanceSummary {
  grade_code: string;
  total_applications: number;
  pending_count: number;
  issued_count: number;
  rejected_count: number;
  avg_processing_hours?: number;
}

// =====================================================
// 拡張された certification_attempts
// =====================================================

export interface CertificationAttemptExtended {
  id: string;
  session_id: string;
  attempt_number: number;
  
  // 二層判定用の追加フィールド
  status: AttemptStatus;
  judgment_mode?: JudgmentMode;
  grade_code?: string;
  fixed_video_url?: string;
  panning_video_url?: string;
  submitted_at?: string;
  reviewed_at?: string;
  reviewer_id?: string;
  
  // 既存フィールド
  pose_data?: any;
  raw_metrics?: any;
  started_at: string;
  completed_at?: string;
}

// =====================================================
// ヘルパー関数
// =====================================================

/**
 * 級コードから判定モードを決定
 * @param gradeCode 級コード（例: "1級", "3級", "10級"）
 * @returns 判定モード
 */
export function getJudgmentMode(gradeCode: string): JudgmentMode {
  const gradeNumber = parseInt(gradeCode.replace('級', ''), 10);
  if (isNaN(gradeNumber)) {
    throw new Error(`Invalid grade_code: ${gradeCode}`);
  }
  return gradeNumber <= 2 ? 'REVIEW_REQUIRED' : 'AUTO_FINAL';
}

/**
 * ステータスバッジの表示色を取得
 * @param status 試行ステータス
 * @returns 色名
 */
export function getStatusColor(status: AttemptStatus): string {
  switch (status) {
    case 'draft':
      return 'gray';
    case 'submitted':
      return 'blue';
    case 'auto_pass':
    case 'certified_pass':
      return 'green';
    case 'auto_fail':
    case 'certified_fail':
      return 'red';
    case 'under_review':
      return 'yellow';
    case 'needs_resubmission':
      return 'orange';
    default:
      return 'gray';
  }
}

/**
 * ステータスの日本語ラベルを取得
 * @param status 試行ステータス
 * @returns 日本語ラベル
 */
export function getStatusLabel(status: AttemptStatus): string {
  switch (status) {
    case 'draft':
      return '下書き';
    case 'submitted':
      return '提出済み';
    case 'auto_pass':
      return '自動合格';
    case 'auto_fail':
      return '自動不合格';
    case 'under_review':
      return '審査中';
    case 'certified_pass':
      return '認定合格';
    case 'certified_fail':
      return '認定不合格';
    case 'needs_resubmission':
      return '再提出要求';
    default:
      return '不明';
  }
}

/**
 * 合格証申請が可能なステータスか判定
 * @param status 試行ステータス
 * @returns 申請可能かどうか
 */
export function canApplyCertificate(status: AttemptStatus): boolean {
  return status === 'auto_pass' || status === 'certified_pass';
}

/**
 * 動画提出が必須かどうか
 * @param judgmentMode 判定モード
 * @returns 必須かどうか
 */
export function requiresVideoSubmission(judgmentMode: JudgmentMode): boolean {
  return judgmentMode === 'REVIEW_REQUIRED';
}

/**
 * 審査判定の日本語ラベルを取得
 * @param decision 審査判定
 * @returns 日本語ラベル
 */
export function getDecisionLabel(decision: ReviewDecision): string {
  switch (decision) {
    case 'pass':
      return '合格';
    case 'fail':
      return '不合格';
    case 'resubmit':
      return '再提出';
    default:
      return '不明';
  }
}
