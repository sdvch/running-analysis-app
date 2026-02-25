-- =====================================================
-- 二層判定モデル - DB マイグレーション (DOWN / ROLLBACK)
-- 作成日: 2026-02-12
-- 説明: 004_two_tier_judgment_up.sql のロールバック
-- =====================================================

-- ⚠️ 警告: このマイグレーションを実行すると、
-- 二層判定に関するすべてのデータが削除されます。
-- 本番環境では十分注意して実行してください。

-- =====================================================
-- 12. マイグレーション履歴削除
-- =====================================================

DELETE FROM migration_history WHERE version = '004';

-- =====================================================
-- 11. Row Level Security (RLS) ポリシー削除
-- =====================================================

-- === 管理者ポリシー ===
-- （特に追加したポリシーはないのでスキップ）

-- === 検定員ポリシー ===

DROP POLICY IF EXISTS reviewer_view_own_checklists ON review_checklists;
DROP POLICY IF EXISTS reviewer_submit_checklist ON review_checklists;
DROP POLICY IF EXISTS reviewer_update_review_attempts ON certification_attempts;
DROP POLICY IF EXISTS reviewer_view_review_attempts ON certification_attempts;
DROP POLICY IF EXISTS reviewer_view_assigned_tasks ON review_tasks;

-- === 受検者ポリシー ===

DROP POLICY IF EXISTS examinee_view_own_applications ON certificate_applications;
DROP POLICY IF EXISTS examinee_apply_certificate ON certificate_applications;
DROP POLICY IF EXISTS examinee_update_draft_attempts ON certification_attempts;
DROP POLICY IF EXISTS examinee_view_own_attempt_status ON certification_attempts;

-- RLS無効化
ALTER TABLE certificate_applications DISABLE ROW LEVEL SECURITY;
ALTER TABLE review_checklists DISABLE ROW LEVEL SECURITY;
ALTER TABLE review_tasks DISABLE ROW LEVEL SECURITY;

-- =====================================================
-- 10. トリガー削除
-- =====================================================

DROP TRIGGER IF EXISTS trigger_update_certificate_application_timestamp ON certificate_applications;
DROP FUNCTION IF EXISTS update_certificate_application_timestamp();

DROP TRIGGER IF EXISTS trigger_update_review_task_timestamp ON review_tasks;
DROP FUNCTION IF EXISTS update_review_task_timestamp();

-- =====================================================
-- 9. 関数削除
-- =====================================================

DROP FUNCTION IF EXISTS generate_application_id();

-- =====================================================
-- 8. ビュー削除
-- =====================================================

DROP VIEW IF EXISTS certificate_issuance_summary;
DROP VIEW IF EXISTS review_pending_list;

-- =====================================================
-- 7. 既存テーブル拡張の削除: certification_audit_logs
-- =====================================================

-- event_type制約を元に戻す（既存イベントのみ）
ALTER TABLE certification_audit_logs DROP CONSTRAINT IF EXISTS chk_event_type;

ALTER TABLE certification_audit_logs ADD CONSTRAINT chk_event_type CHECK (
  event_type IN (
    'session_started',
    'session_completed',
    'session_cancelled',
    'attempt_started',
    'attempt_completed',
    'score_calculated',
    'manual_correction_applied',
    'result_issued',
    'certificate_generated',
    'rule_updated',
    'manual_override'
  )
);

-- =====================================================
-- 6. 既存テーブル拡張の削除: certification_results
-- =====================================================

DROP INDEX IF EXISTS idx_results_decision_type;
DROP INDEX IF EXISTS idx_results_decided_by;

ALTER TABLE certification_results DROP COLUMN IF EXISTS decision_reason;
ALTER TABLE certification_results DROP COLUMN IF EXISTS decision_type;
ALTER TABLE certification_results DROP COLUMN IF EXISTS decided_by;

-- =====================================================
-- 5. 新規テーブル削除: certificate_applications
-- =====================================================

DROP INDEX IF EXISTS idx_applications_application_id;
DROP INDEX IF EXISTS idx_applications_email;
DROP INDEX IF EXISTS idx_applications_applied_at;
DROP INDEX IF EXISTS idx_applications_status;

DROP TABLE IF EXISTS certificate_applications CASCADE;

-- =====================================================
-- 4. 新規テーブル削除: review_checklists
-- =====================================================

DROP INDEX IF EXISTS idx_checklists_decided_at;
DROP INDEX IF EXISTS idx_checklists_decision;
DROP INDEX IF EXISTS idx_checklists_reviewer;
DROP INDEX IF EXISTS idx_checklists_attempt;

DROP TABLE IF EXISTS review_checklists CASCADE;

-- =====================================================
-- 3. 新規テーブル削除: review_tasks
-- =====================================================

DROP INDEX IF EXISTS idx_review_tasks_created_at;
DROP INDEX IF EXISTS idx_review_tasks_due_date;
DROP INDEX IF EXISTS idx_review_tasks_status;
DROP INDEX IF EXISTS idx_review_tasks_reviewer;

DROP TABLE IF EXISTS review_tasks CASCADE;

-- =====================================================
-- 2. 既存テーブル拡張の削除: certification_attempts
-- =====================================================

DROP INDEX IF EXISTS idx_attempts_submitted_at;
DROP INDEX IF EXISTS idx_attempts_reviewer;
DROP INDEX IF EXISTS idx_attempts_judgment_mode;
DROP INDEX IF EXISTS idx_attempts_status;

ALTER TABLE certification_attempts DROP COLUMN IF EXISTS grade_code;
ALTER TABLE certification_attempts DROP COLUMN IF EXISTS reviewer_id;
ALTER TABLE certification_attempts DROP COLUMN IF EXISTS reviewed_at;
ALTER TABLE certification_attempts DROP COLUMN IF EXISTS submitted_at;
ALTER TABLE certification_attempts DROP COLUMN IF EXISTS panning_video_url;
ALTER TABLE certification_attempts DROP COLUMN IF EXISTS fixed_video_url;
ALTER TABLE certification_attempts DROP COLUMN IF EXISTS judgment_mode;
ALTER TABLE certification_attempts DROP COLUMN IF EXISTS status;

-- =====================================================
-- 1. migration_historyテーブルの削除（必要に応じて）
-- =====================================================

-- ⚠️ 注意: このテーブルは他のマイグレーションでも使用されている可能性があるため、
-- 通常は削除しません。必要に応じてコメントアウトを解除してください。

-- DROP TABLE IF EXISTS migration_history;

-- =====================================================
-- ロールバック完了
-- =====================================================

-- 完了メッセージ（コメントのみ）
-- 二層判定モデルのロールバックが完了しました。
-- 以下を確認してください：
-- 1. certification_attemptsが元の状態に戻っているか
-- 2. 新規テーブル（review_tasks, review_checklists, certificate_applications）が削除されているか
-- 3. ビューと関数が削除されているか
-- 4. RLSポリシーが削除されているか
