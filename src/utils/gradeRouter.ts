// =====================================================
// 級別分岐ユーティリティ
// 作成日: 2026-02-12
// 説明: 級コードに基づいて判定モードとフローを決定
// =====================================================

import type { GradeCode, GradeNumber, JudgmentMode, AttemptStatus } from '../types/certificationTypes';
import { gradeCodeToNumber } from '../types/certificationTypes';

/**
 * 級コードから判定モードを決定
 * - 10級〜3級: AUTO_FINAL（自動最終判定）
 * - 2級・1級: REVIEW_REQUIRED（検定員審査必須）
 * 
 * @param gradeCode 級コード（例: "1級", "3級", "10級"）
 * @returns 判定モード
 */
export function determineJudgmentMode(gradeCode: GradeCode): JudgmentMode {
  const gradeNumber = gradeCodeToNumber(gradeCode);
  return gradeNumber <= 2 ? 'REVIEW_REQUIRED' : 'AUTO_FINAL';
}

/**
 * 判定モードから初期ステータスを決定
 * - AUTO_FINAL: 'draft'（採点後に auto_pass / auto_fail へ遷移）
 * - REVIEW_REQUIRED: 'draft'（提出後に 'submitted' → 'under_review' へ遷移）
 * 
 * @param judgmentMode 判定モード
 * @returns 初期ステータス
 */
export function getInitialStatus(judgmentMode: JudgmentMode): AttemptStatus {
  return 'draft'; // 両方とも draft から開始
}

/**
 * 自動採点後の最終ステータスを決定（AUTO_FINAL モード）
 * 
 * @param totalScore 総合得点
 * @param passThreshold 合格基準点
 * @param judgmentMode 判定モード
 * @returns 最終ステータス
 */
export function determineFinalStatus(
  totalScore: number,
  passThreshold: number,
  judgmentMode: JudgmentMode
): AttemptStatus {
  if (judgmentMode === 'REVIEW_REQUIRED') {
    // 2級・1級は自動で最終合否にはならない
    return 'submitted'; // 提出後は 'under_review' に手動で変更
  }
  
  // 10級〜3級は自動合否判定
  return totalScore >= passThreshold ? 'auto_pass' : 'auto_fail';
}

/**
 * 動画提出が必須かどうかを判定
 * 
 * @param judgmentMode 判定モード
 * @returns 必須かどうか
 */
export function requiresVideoSubmission(judgmentMode: JudgmentMode): boolean {
  return judgmentMode === 'REVIEW_REQUIRED';
}

/**
 * H-FVP評価が必要かどうかを判定
 * 
 * @param gradeCode 級コード
 * @returns 必要かどうか
 */
export function requiresHFVPEvaluation(gradeCode: GradeCode): boolean {
  const gradeNumber = gradeCodeToNumber(gradeCode);
  return gradeNumber <= 2; // 1級・2級のみ
}

/**
 * 合格証申請が可能なステータスかどうか
 * 
 * @param status 試行ステータス
 * @returns 申請可能かどうか
 */
export function canApplyCertificate(status: AttemptStatus): boolean {
  return status === 'auto_pass' || status === 'certified_pass';
}

/**
 * 再提出が可能なステータスかどうか
 * 
 * @param status 試行ステータス
 * @returns 再提出可能かどうか
 */
export function canResubmit(status: AttemptStatus): boolean {
  return status === 'needs_resubmission' || status === 'auto_fail';
}

/**
 * ステータスが最終状態（完了済み）かどうか
 * 
 * @param status 試行ステータス
 * @returns 最終状態かどうか
 */
export function isFinalStatus(status: AttemptStatus): boolean {
  return ['auto_pass', 'auto_fail', 'certified_pass', 'certified_fail'].includes(status);
}

/**
 * ステータスが審査中かどうか
 * 
 * @param status 試行ステータス
 * @returns 審査中かどうか
 */
export function isUnderReview(status: AttemptStatus): boolean {
  return status === 'under_review';
}

/**
 * 級番号から級コードに変換
 * 
 * @param gradeNumber 級番号（1〜10）
 * @returns 級コード（例: "1級"）
 */
export function gradeNumberToCode(gradeNumber: GradeNumber): GradeCode {
  return `${gradeNumber}級` as GradeCode;
}

/**
 * 受検フローの次のアクションを決定
 * 
 * @param judgmentMode 判定モード
 * @param status 現在のステータス
 * @param totalScore 総合得点（採点済みの場合）
 * @param passThreshold 合格基準点
 * @returns 次のアクション
 */
export function getNextAction(
  judgmentMode: JudgmentMode,
  status: AttemptStatus,
  totalScore?: number,
  passThreshold?: number
): {
  action: 'complete_draft' | 'submit_for_review' | 'apply_certificate' | 'view_result' | 'resubmit' | 'wait_review';
  label: string;
  description: string;
} {
  if (status === 'draft') {
    return {
      action: 'complete_draft',
      label: '受検を完了',
      description: '動画撮影と自動採点を実施してください',
    };
  }
  
  if (judgmentMode === 'AUTO_FINAL') {
    // 10級〜3級
    if (status === 'auto_pass') {
      return {
        action: 'apply_certificate',
        label: '合格証を申請',
        description: '合格おめでとうございます！合格証の申請が可能です',
      };
    }
    if (status === 'auto_fail') {
      return {
        action: 'resubmit',
        label: '再受検',
        description: '不合格でした。改善ポイントを確認して再受検してください',
      };
    }
  }
  
  if (judgmentMode === 'REVIEW_REQUIRED') {
    // 2級・1級
    if (status === 'submitted' || status === 'under_review') {
      return {
        action: 'wait_review',
        label: '審査待ち',
        description: '検定員による審査をお待ちください',
      };
    }
    if (status === 'certified_pass') {
      return {
        action: 'apply_certificate',
        label: '合格証を申請',
        description: '合格おめでとうございます！合格証の申請が可能です',
      };
    }
    if (status === 'certified_fail') {
      return {
        action: 'view_result',
        label: '結果を確認',
        description: '不合格となりました。検定員のコメントを確認してください',
      };
    }
    if (status === 'needs_resubmission') {
      return {
        action: 'resubmit',
        label: '再提出',
        description: '動画を修正して再提出してください',
      };
    }
  }
  
  return {
    action: 'view_result',
    label: '結果を確認',
    description: '受検結果を確認できます',
  };
}

/**
 * 動画提出の検証（2級・1級のみ）
 * 
 * @param fixedVideoUrl 固定カメラ動画URL
 * @param panningVideoUrl パンカメラ動画URL
 * @returns 検証結果
 */
export function validateVideoSubmission(
  fixedVideoUrl?: string | null,
  panningVideoUrl?: string | null
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  if (!fixedVideoUrl || fixedVideoUrl.trim() === '') {
    errors.push('固定カメラ動画が必須です');
  }
  
  if (!panningVideoUrl || panningVideoUrl.trim() === '') {
    errors.push('パンカメラ動画が必須です');
  }
  
  return {
    valid: errors.length === 0,
    errors,
  };
}
