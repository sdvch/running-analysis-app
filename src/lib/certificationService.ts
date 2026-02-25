// =====================================================
// ランニング技能検定モード - Supabase サービス層
// 作成日: 2026-02-12
// 説明: 検定機能のDB操作（CRUD、監査ログ）
// =====================================================

import { supabase } from './supabaseClient';
import type {
  CertificationGrade,
  CertificationRule,
  CertificationSession,
  CertificationAttempt,
  CertificationResult,
  ScoringResult,
  AuditLogEntry,
  AuditEventType,
  ManualCorrectionLog,
  GradeCode,
} from '../types/certificationTypes';

// =====================================================
// 級・ルール取得
// =====================================================

/**
 * 全級のマスタデータを取得
 */
export async function fetchAllGrades(): Promise<CertificationGrade[]> {
  const { data, error } = await supabase
    .from('certification_grades')
    .select('*')
    .eq('is_active', true)
    .order('display_order', { ascending: true });

  if (error) {
    console.error('[CertificationService] Failed to fetch grades:', error);
    throw new Error('級マスタの取得に失敗しました');
  }

  return data || [];
}

/**
 * 指定級のマスタデータを取得
 */
export async function fetchGradeByCode(gradeCode: GradeCode): Promise<CertificationGrade | null> {
  const { data, error } = await supabase
    .from('certification_grades')
    .select('*')
    .eq('grade_name', gradeCode)
    .eq('is_active', true)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      // Not found
      return null;
    }
    console.error('[CertificationService] Failed to fetch grade:', error);
    throw new Error('級マスタの取得に失敗しました');
  }

  return data;
}

/**
 * 指定級の有効な採点ルールを取得
 */
export async function fetchRuleByGradeId(gradeId: string): Promise<CertificationRule | null> {
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from('certification_rules')
    .select('*')
    .eq('grade_id', gradeId)
    .eq('is_active', true)
    .lte('effective_from', now)
    .or(`effective_until.is.null,effective_until.gte.${now}`)
    .order('version', { ascending: false })
    .limit(1)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      // Not found
      return null;
    }
    console.error('[CertificationService] Failed to fetch rule:', error);
    throw new Error('採点ルールの取得に失敗しました');
  }

  return data;
}

// =====================================================
// 検定セッション
// =====================================================

/**
 * 検定セッションを開始
 */
export async function createSession(params: {
  userId: string | null;
  athleteId: string | null;
  athleteName: string | null;
  gradeCode: GradeCode;
  analysisMode: 'single' | 'panning';
  videoFileName?: string;
  videoDuration?: number;
  deviceInfo?: Record<string, any>;
}): Promise<CertificationSession> {
  // 級とルールを取得
  const grade = await fetchGradeByCode(params.gradeCode);
  if (!grade) {
    throw new Error(`級が見つかりません: ${params.gradeCode}`);
  }

  const rule = await fetchRuleByGradeId(grade.id);
  if (!rule) {
    throw new Error(`有効な採点ルールが見つかりません: ${params.gradeCode}`);
  }

  const { data, error } = await supabase
    .from('certification_sessions')
    .insert({
      user_id: params.userId,
      athlete_id: params.athleteId,
      athlete_name: params.athleteName,
      grade_id: grade.id,
      rule_id: rule.id,
      analysis_mode: params.analysisMode,
      video_file_name: params.videoFileName || null,
      video_duration: params.videoDuration || null,
      status: 'in_progress',
      device_info: params.deviceInfo || null,
    })
    .select()
    .single();

  if (error) {
    console.error('[CertificationService] Failed to create session:', error);
    throw new Error('検定セッションの作成に失敗しました');
  }

  // 監査ログ記録
  await logAuditEvent({
    sessionId: data.id,
    eventType: 'session_started',
    eventData: {
      grade_code: params.gradeCode,
      analysis_mode: params.analysisMode,
    },
    userId: params.userId,
  });

  return data;
}

/**
 * 検定セッションを完了
 */
export async function completeSession(
  sessionId: string,
  userId: string | null
): Promise<void> {
  const { error } = await supabase
    .from('certification_sessions')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
    })
    .eq('id', sessionId);

  if (error) {
    console.error('[CertificationService] Failed to complete session:', error);
    throw new Error('検定セッションの完了に失敗しました');
  }

  await logAuditEvent({
    sessionId,
    eventType: 'session_completed',
    eventData: {},
    userId,
  });
}

/**
 * 検定セッションをキャンセル
 */
export async function cancelSession(
  sessionId: string,
  userId: string | null
): Promise<void> {
  const { error } = await supabase
    .from('certification_sessions')
    .update({
      status: 'cancelled',
    })
    .eq('id', sessionId);

  if (error) {
    console.error('[CertificationService] Failed to cancel session:', error);
    throw new Error('検定セッションのキャンセルに失敗しました');
  }

  await logAuditEvent({
    sessionId,
    eventType: 'session_cancelled',
    eventData: {},
    userId,
  });
}

// =====================================================
// 検定試行
// =====================================================

/**
 * 検定試行を開始
 */
export async function createAttempt(params: {
  sessionId: string;
  attemptNumber: number;
}): Promise<CertificationAttempt> {
  const { data, error } = await supabase
    .from('certification_attempts')
    .insert({
      session_id: params.sessionId,
      attempt_number: params.attemptNumber,
    })
    .select()
    .single();

  if (error) {
    console.error('[CertificationService] Failed to create attempt:', error);
    throw new Error('検定試行の作成に失敗しました');
  }

  return data;
}

/**
 * 検定試行を完了（測定データを保存）
 */
export async function completeAttempt(params: {
  attemptId: string;
  poseData: Record<string, any>;
  rawMetrics: Record<string, any>;
}): Promise<void> {
  const { error } = await supabase
    .from('certification_attempts')
    .update({
      pose_data: params.poseData,
      raw_metrics: params.rawMetrics,
      completed_at: new Date().toISOString(),
    })
    .eq('id', params.attemptId);

  if (error) {
    console.error('[CertificationService] Failed to complete attempt:', error);
    throw new Error('検定試行の完了に失敗しました');
  }
}

// =====================================================
// 採点結果
// =====================================================

/**
 * 採点結果を保存
 */
export async function saveScore(params: {
  sessionId: string;
  attemptId: string;
  scoringResult: ScoringResult;
  userId: string | null;
}): Promise<string> {
  const { scoringResult } = params;

  // 1. 採点詳細をcertification_scoresに保存
  const { data: scoreData, error: scoreError } = await supabase
    .from('certification_scores')
    .insert({
      attempt_id: params.attemptId,
      angle_score: scoringResult.angle_score,
      stride_score: scoringResult.stride_score,
      contact_time_score: scoringResult.contact_time_score,
      hfvp_score: scoringResult.hfvp_score,
      technique_score: scoringResult.technique_score,
      total_score: scoringResult.total_score,
      score_details: {
        angle_details: scoringResult.angle_details,
        stride_details: scoringResult.stride_details,
        contact_time_details: scoringResult.contact_time_details,
        hfvp_details: scoringResult.hfvp_details || null,
      },
      quality_grade: scoringResult.quality_grade,
      quality_warnings: scoringResult.quality_warnings,
      requires_review: scoringResult.requires_review,
      has_manual_corrections: scoringResult.has_manual_corrections,
      calculation_version: scoringResult.calculation_version,
    })
    .select()
    .single();

  if (scoreError) {
    console.error('[CertificationService] Failed to save score:', scoreError);
    throw new Error('採点結果の保存に失敗しました');
  }

  // 2. 監査ログ記録
  await logAuditEvent({
    sessionId: params.sessionId,
    eventType: 'score_calculated',
    eventData: {
      total_score: scoringResult.total_score,
      quality_grade: scoringResult.quality_grade,
      requires_review: scoringResult.requires_review,
    },
    userId: params.userId,
  });

  return scoreData.id;
}

/**
 * 検定結果を保存（合否判定含む）
 */
export async function saveResult(params: {
  sessionId: string;
  attemptId: string;
  scoreId: string;
  scoringResult: ScoringResult;
  userId: string | null;
}): Promise<CertificationResult> {
  const { scoringResult } = params;

  const { data, error } = await supabase
    .from('certification_results')
    .insert({
      session_id: params.sessionId,
      attempt_id: params.attemptId,
      score_id: params.scoreId,
      is_passed: scoringResult.is_passed,
      pass_threshold: scoringResult.pass_threshold,
      total_score: scoringResult.total_score,
      score_difference: scoringResult.score_difference,
      evaluated_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) {
    console.error('[CertificationService] Failed to save result:', error);
    throw new Error('検定結果の保存に失敗しました');
  }

  // 監査ログ記録
  await logAuditEvent({
    sessionId: params.sessionId,
    eventType: 'result_issued',
    eventData: {
      is_passed: scoringResult.is_passed,
      total_score: scoringResult.total_score,
      score_difference: scoringResult.score_difference,
    },
    userId: params.userId,
  });

  return data;
}

// =====================================================
// 監査ログ
// =====================================================

/**
 * 監査ログを記録
 */
export async function logAuditEvent(params: {
  sessionId: string | null;
  eventType: AuditEventType;
  eventData: Record<string, any>;
  userId: string | null;
}): Promise<void> {
  const { error } = await supabase
    .from('certification_audit_logs')
    .insert({
      session_id: params.sessionId,
      event_type: params.eventType,
      event_data: params.eventData,
      user_id: params.userId,
      ip_address: null, // TODO: IPアドレス取得
      user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
    });

  if (error) {
    console.error('[CertificationService] Failed to log audit event:', error);
    // 監査ログの失敗は致命的ではないのでエラーをスローしない
  }
}

/**
 * 手動補正ログを記録
 */
export async function logManualCorrection(params: {
  sessionId: string;
  corrections: ManualCorrectionLog[];
  userId: string | null;
}): Promise<void> {
  await logAuditEvent({
    sessionId: params.sessionId,
    eventType: 'manual_correction_applied',
    eventData: {
      corrections: params.corrections,
    },
    userId: params.userId,
  });
}

// =====================================================
// 検定履歴取得
// =====================================================

/**
 * ユーザーの検定履歴を取得
 */
export async function fetchUserCertificationHistory(
  userId: string
): Promise<any[]> {
  const { data, error } = await supabase
    .from('user_certification_history')
    .select('*')
    .eq('user_id', userId)
    .order('session_started_at', { ascending: false });

  if (error) {
    console.error('[CertificationService] Failed to fetch history:', error);
    throw new Error('検定履歴の取得に失敗しました');
  }

  return data || [];
}

// =====================================================
// エクスポート
// =====================================================

export const CertificationService = {
  // 級・ルール
  fetchAllGrades,
  fetchGradeByCode,
  fetchRuleByGradeId,

  // セッション
  createSession,
  completeSession,
  cancelSession,

  // 試行
  createAttempt,
  completeAttempt,

  // 採点・結果
  saveScore,
  saveResult,

  // 監査
  logAuditEvent,
  logManualCorrection,

  // 履歴
  fetchUserCertificationHistory,
};

export default CertificationService;
