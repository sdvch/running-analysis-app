-- =====================================================
-- ランニング技能検定モード - DB ロールバック (DOWN)
-- 作成日: 2026-02-12
-- 説明: 検定機能の全テーブルを削除（既存テーブルは影響なし）
-- 警告: このスクリプトを実行すると、全ての検定データが削除されます
-- =====================================================

-- =====================================================
-- 警告メッセージ
-- =====================================================
DO $$
BEGIN
  RAISE WARNING '========================================';
  RAISE WARNING '⚠️  警告: 検定データベースのロールバックを開始します';
  RAISE WARNING '⚠️  全ての検定データが削除されます';
  RAISE WARNING '⚠️  この操作は取り消せません';
  RAISE WARNING '========================================';
END $$;

-- =====================================================
-- 1. ビューを削除
-- =====================================================
DROP VIEW IF EXISTS user_certification_history CASCADE;
DROP VIEW IF EXISTS certification_results_summary CASCADE;

RAISE NOTICE '✅ ビューを削除しました';

-- =====================================================
-- 2. トリガーを削除
-- =====================================================
DROP TRIGGER IF EXISTS update_certification_grades_updated_at ON certification_grades;
DROP TRIGGER IF EXISTS update_certification_rules_updated_at ON certification_rules;
DROP TRIGGER IF EXISTS update_certification_sessions_updated_at ON certification_sessions;

-- トリガー関数を削除（他で使用していない場合）
-- DROP FUNCTION IF EXISTS update_updated_at_column() CASCADE;

RAISE NOTICE '✅ トリガーを削除しました';

-- =====================================================
-- 3. テーブルを削除（依存関係の逆順）
-- =====================================================

-- 監査ログ（依存なし）
DROP TABLE IF EXISTS certification_audit_logs CASCADE;
RAISE NOTICE '✅ certification_audit_logs を削除しました';

-- 検定結果（certification_sessions, attempts, scores に依存）
DROP TABLE IF EXISTS certification_results CASCADE;
RAISE NOTICE '✅ certification_results を削除しました';

-- 採点結果（certification_attempts に依存）
DROP TABLE IF EXISTS certification_scores CASCADE;
RAISE NOTICE '✅ certification_scores を削除しました';

-- 検定試行（certification_sessions に依存）
DROP TABLE IF EXISTS certification_attempts CASCADE;
RAISE NOTICE '✅ certification_attempts を削除しました';

-- 検定セッション（certification_grades, rules に依存）
DROP TABLE IF EXISTS certification_sessions CASCADE;
RAISE NOTICE '✅ certification_sessions を削除しました';

-- 採点ルール（certification_grades に依存）
DROP TABLE IF EXISTS certification_rules CASCADE;
RAISE NOTICE '✅ certification_rules を削除しました';

-- 級マスタ（最後に削除）
DROP TABLE IF EXISTS certification_grades CASCADE;
RAISE NOTICE '✅ certification_grades を削除しました';

-- =====================================================
-- 4. マイグレーション履歴を削除
-- =====================================================
DELETE FROM public.schema_migrations
WHERE version = '001' AND description = 'Create certification schema';

RAISE NOTICE '✅ マイグレーション履歴を削除しました';

-- =====================================================
-- 5. ロールバック完了
-- =====================================================
DO $$
BEGIN
  RAISE NOTICE '========================================';
  RAISE NOTICE '✅ ロールバック完了';
  RAISE NOTICE '✅ 全ての検定テーブルが削除されました';
  RAISE NOTICE '✅ 既存テーブル（athletes, running_analysis_sessions等）は影響を受けていません';
  RAISE NOTICE '========================================';
END $$;

-- =====================================================
-- 6. 削除されたテーブル一覧（確認用）
-- =====================================================
-- 以下のテーブルが削除されました:
-- - certification_grades (級マスタ)
-- - certification_rules (採点ルール)
-- - certification_sessions (検定セッション)
-- - certification_attempts (検定試行)
-- - certification_scores (採点結果)
-- - certification_results (検定結果)
-- - certification_audit_logs (監査ログ)
--
-- 以下のビューが削除されました:
-- - certification_results_summary
-- - user_certification_history
--
-- 以下のトリガーが削除されました:
-- - update_certification_grades_updated_at
-- - update_certification_rules_updated_at
-- - update_certification_sessions_updated_at
