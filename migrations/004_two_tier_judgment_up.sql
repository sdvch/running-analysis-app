-- =====================================================
-- 二層判定モデル - DB マイグレーション (UP)
-- 作成日: 2026-02-12
-- 説明: 10級〜3級は自動判定、2級・1級は検定員による審査を追加
-- =====================================================

-- ⚠️ 注意事項:
-- 1. 既存データを削除しない差分追加方式
-- 2. ロールバックは 005_two_tier_judgment_down.sql を使用
-- 3. 本番環境では段階的に実行し、各ステップで検証すること

-- =====================================================
-- 1. migration_historyテーブルの作成（なければ）
-- =====================================================

CREATE TABLE IF NOT EXISTS migration_history (
  id SERIAL PRIMARY KEY,
  version VARCHAR(10) NOT NULL UNIQUE,
  description TEXT NOT NULL,
  executed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  executed_by VARCHAR(255),
  CONSTRAINT chk_version_format CHECK (version ~ '^[0-9]{3}$')
);

COMMENT ON TABLE migration_history IS 'マイグレーション実行履歴';
COMMENT ON COLUMN migration_history.version IS 'マイグレーションバージョン（例: "004"）';
COMMENT ON COLUMN migration_history.description IS 'マイグレーション内容の説明';
COMMENT ON COLUMN migration_history.executed_at IS 'マイグレーション実行日時';
COMMENT ON COLUMN migration_history.executed_by IS 'マイグレーション実行者';

-- =====================================================
-- 2. 既存テーブル拡張: certification_attempts
-- =====================================================

-- 判定モード: AUTO_FINAL（10〜3級）/ REVIEW_REQUIRED（2・1級）
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'judgment_mode_enum') THEN
    CREATE TYPE judgment_mode_enum AS ENUM ('AUTO_FINAL', 'REVIEW_REQUIRED');
  END IF;
END $$;

-- 試行ステータス
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'attempt_status_enum') THEN
    CREATE TYPE attempt_status_enum AS ENUM (
      'draft',                -- 下書き（受検者が入力中）
      'submitted',            -- 提出済み（2・1級のみ、審査待ち）
      'auto_pass',            -- 自動合格（10〜3級）
      'auto_fail',            -- 自動不合格（10〜3級）
      'under_review',         -- 審査中（2・1級）
      'certified_pass',       -- 検定員認定合格（2・1級）
      'certified_fail',       -- 検定員認定不合格（2・1級）
      'needs_resubmission'    -- 再提出要求（2・1級）
    );
  END IF;
END $$;

-- 新規カラム追加
ALTER TABLE certification_attempts 
  ADD COLUMN IF NOT EXISTS status attempt_status_enum NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS judgment_mode judgment_mode_enum,
  ADD COLUMN IF NOT EXISTS grade_code VARCHAR(10),
  ADD COLUMN IF NOT EXISTS fixed_video_url TEXT,
  ADD COLUMN IF NOT EXISTS panning_video_url TEXT,
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewer_id UUID REFERENCES auth.users(id);

COMMENT ON COLUMN certification_attempts.status IS '試行ステータス: draft/submitted/auto_pass/auto_fail/under_review/certified_pass/certified_fail/needs_resubmission';
COMMENT ON COLUMN certification_attempts.judgment_mode IS '判定モード: AUTO_FINAL（10〜3級自動）/ REVIEW_REQUIRED（2・1級審査）';
COMMENT ON COLUMN certification_attempts.grade_code IS '級コード（例: "1級", "10級"）';
COMMENT ON COLUMN certification_attempts.fixed_video_url IS '固定カメラ動画URL（2・1級必須）';
COMMENT ON COLUMN certification_attempts.panning_video_url IS 'パンカメラ動画URL（2・1級必須）';
COMMENT ON COLUMN certification_attempts.submitted_at IS '提出日時（2・1級）';
COMMENT ON COLUMN certification_attempts.reviewed_at IS '審査完了日時（2・1級）';
COMMENT ON COLUMN certification_attempts.reviewer_id IS '審査担当検定員ID（2・1級）';

-- インデックス追加
CREATE INDEX IF NOT EXISTS idx_attempts_status ON certification_attempts(status);
CREATE INDEX IF NOT EXISTS idx_attempts_judgment_mode ON certification_attempts(judgment_mode);
CREATE INDEX IF NOT EXISTS idx_attempts_reviewer ON certification_attempts(reviewer_id);
CREATE INDEX IF NOT EXISTS idx_attempts_submitted_at ON certification_attempts(submitted_at);

-- =====================================================
-- 3. 新規テーブル: review_tasks（審査タスク管理）
-- =====================================================

CREATE TABLE IF NOT EXISTS review_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id UUID NOT NULL REFERENCES certification_attempts(id) ON DELETE CASCADE,
  reviewer_id UUID REFERENCES auth.users(id),
  assigned_at TIMESTAMPTZ,
  status VARCHAR(50) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'cancelled')),
  priority INTEGER NOT NULL DEFAULT 5 CHECK (priority BETWEEN 1 AND 10),
  due_date TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES auth.users(id)
);

COMMENT ON TABLE review_tasks IS '検定員審査タスク管理テーブル';
COMMENT ON COLUMN review_tasks.attempt_id IS '審査対象の試行ID';
COMMENT ON COLUMN review_tasks.reviewer_id IS '担当検定員ID';
COMMENT ON COLUMN review_tasks.assigned_at IS 'タスク割り当て日時';
COMMENT ON COLUMN review_tasks.status IS 'タスクステータス: pending/in_progress/completed/cancelled';
COMMENT ON COLUMN review_tasks.priority IS '優先度（1=最高、10=最低）';
COMMENT ON COLUMN review_tasks.due_date IS '期限日';
COMMENT ON COLUMN review_tasks.notes IS '備考（管理者メモ）';

-- インデックス追加
CREATE INDEX IF NOT EXISTS idx_review_tasks_reviewer ON review_tasks(reviewer_id);
CREATE INDEX IF NOT EXISTS idx_review_tasks_status ON review_tasks(status);
CREATE INDEX IF NOT EXISTS idx_review_tasks_due_date ON review_tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_review_tasks_created_at ON review_tasks(created_at);

-- =====================================================
-- 4. 新規テーブル: review_checklists（審査チェックリスト）
-- =====================================================

CREATE TABLE IF NOT EXISTS review_checklists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id UUID NOT NULL REFERENCES certification_attempts(id) ON DELETE CASCADE,
  reviewer_id UUID NOT NULL REFERENCES auth.users(id),
  
  -- チェック項目（2・1級共通）
  posture_alignment BOOLEAN,               -- 姿勢アライメント
  knee_angle_appropriate BOOLEAN,          -- 膝角度の適切性
  stride_consistency BOOLEAN,              -- ストライド一貫性
  ground_contact_efficiency BOOLEAN,       -- 接地効率
  arm_swing_coordination BOOLEAN,          -- 腕振り協調性
  
  -- 1級専用チェック項目
  hfvp_linearity BOOLEAN,                  -- H-FVP直線性（1級のみ）
  hfvp_r2_acceptable BOOLEAN,              -- H-FVP R²閾値達成（1級のみ）
  
  -- 総合評価
  overall_technique_score INTEGER CHECK (overall_technique_score BETWEEN 0 AND 100),
  video_quality_acceptable BOOLEAN NOT NULL DEFAULT true,
  
  -- 手動補正値（必要に応じて）
  manual_angle_correction DECIMAL(5, 2),
  manual_stride_correction DECIMAL(5, 2),
  manual_contact_correction DECIMAL(5, 2),
  manual_hfvp_correction DECIMAL(5, 2),
  
  -- 判定
  decision VARCHAR(50) NOT NULL CHECK (decision IN ('pass', 'fail', 'resubmit')),
  decision_reason TEXT NOT NULL,
  additional_comments TEXT,
  
  -- メタデータ
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  
  CONSTRAINT chk_decision_reason_length CHECK (char_length(decision_reason) >= 10)
);

COMMENT ON TABLE review_checklists IS '検定員による審査チェックリスト（2・1級）';
COMMENT ON COLUMN review_checklists.posture_alignment IS '姿勢アライメントが適切か';
COMMENT ON COLUMN review_checklists.knee_angle_appropriate IS '膝角度が適切な範囲内か';
COMMENT ON COLUMN review_checklists.stride_consistency IS 'ストライドが一貫しているか';
COMMENT ON COLUMN review_checklists.ground_contact_efficiency IS '接地時間が効率的か';
COMMENT ON COLUMN review_checklists.arm_swing_coordination IS '腕振りが協調的か';
COMMENT ON COLUMN review_checklists.hfvp_linearity IS 'H-FVPが直線的か（1級のみ）';
COMMENT ON COLUMN review_checklists.hfvp_r2_acceptable IS 'H-FVP R²が閾値以上か（1級のみ）';
COMMENT ON COLUMN review_checklists.overall_technique_score IS '総合技術点（0〜100点）';
COMMENT ON COLUMN review_checklists.video_quality_acceptable IS '動画品質が審査可能か';
COMMENT ON COLUMN review_checklists.decision IS '最終判定: pass/fail/resubmit';
COMMENT ON COLUMN review_checklists.decision_reason IS '判定理由（必須、10文字以上）';

-- インデックス追加
CREATE INDEX IF NOT EXISTS idx_checklists_attempt ON review_checklists(attempt_id);
CREATE INDEX IF NOT EXISTS idx_checklists_reviewer ON review_checklists(reviewer_id);
CREATE INDEX IF NOT EXISTS idx_checklists_decision ON review_checklists(decision);
CREATE INDEX IF NOT EXISTS idx_checklists_decided_at ON review_checklists(decided_at);

-- =====================================================
-- 5. 新規テーブル: certificate_applications（合格証申請）
-- =====================================================

CREATE TABLE IF NOT EXISTS certificate_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id UUID NOT NULL REFERENCES certification_attempts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id),
  
  -- 申請者情報
  full_name VARCHAR(100) NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  birth_date DATE NOT NULL,
  affiliation VARCHAR(200),
  email VARCHAR(255) NOT NULL,
  phone VARCHAR(50),
  postal_code VARCHAR(20),
  address TEXT,
  
  -- 申請情報
  application_id VARCHAR(50) UNIQUE,  -- 例: JRPO-2026-001234
  grade_code VARCHAR(10) NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'not_applied' CHECK (status IN ('not_applied', 'applied', 'issued', 'rejected')),
  
  -- 証明書情報
  certificate_number VARCHAR(50) UNIQUE,
  certificate_url TEXT,
  issued_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  
  -- メタデータ
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES auth.users(id),
  
  CONSTRAINT chk_email_format CHECK (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}$'),
  CONSTRAINT chk_phone_format CHECK (phone IS NULL OR phone ~ '^[0-9\-+() ]+$')
);

COMMENT ON TABLE certificate_applications IS '合格証申請テーブル';
COMMENT ON COLUMN certificate_applications.application_id IS '申請ID（例: JRPO-2026-001234）';
COMMENT ON COLUMN certificate_applications.full_name IS '氏名（本名）';
COMMENT ON COLUMN certificate_applications.display_name IS '表記名（証明書に印字される名前）';
COMMENT ON COLUMN certificate_applications.status IS '申請ステータス: not_applied/applied/issued/rejected';
COMMENT ON COLUMN certificate_applications.certificate_number IS '証明書番号';
COMMENT ON COLUMN certificate_applications.certificate_url IS '証明書PDF URL';

-- インデックス追加
CREATE INDEX IF NOT EXISTS idx_applications_status ON certificate_applications(status);
CREATE INDEX IF NOT EXISTS idx_applications_applied_at ON certificate_applications(applied_at);
CREATE INDEX IF NOT EXISTS idx_applications_email ON certificate_applications(email);
CREATE INDEX IF NOT EXISTS idx_applications_application_id ON certificate_applications(application_id);

-- =====================================================
-- 6. 既存テーブル拡張: certification_results
-- =====================================================

-- 判定方法の追加
ALTER TABLE certification_results 
  ADD COLUMN IF NOT EXISTS decision_type VARCHAR(50) CHECK (decision_type IN ('auto', 'manual', 'mixed')),
  ADD COLUMN IF NOT EXISTS decided_by UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS decision_reason TEXT;

COMMENT ON COLUMN certification_results.decision_type IS '判定方法: auto（自動）/ manual（検定員）/ mixed（自動＋検定員補正）';
COMMENT ON COLUMN certification_results.decided_by IS '判定者ID（検定員）';
COMMENT ON COLUMN certification_results.decision_reason IS '判定理由（手動判定時必須）';

-- インデックス追加
CREATE INDEX IF NOT EXISTS idx_results_decided_by ON certification_results(decided_by);
CREATE INDEX IF NOT EXISTS idx_results_decision_type ON certification_results(decision_type);

-- =====================================================
-- 7. 既存テーブル拡張: certification_audit_logs
-- =====================================================

-- event_type制約を拡張（既存イベント + 新規イベント）
ALTER TABLE certification_audit_logs DROP CONSTRAINT IF EXISTS chk_event_type;

ALTER TABLE certification_audit_logs ADD CONSTRAINT chk_event_type CHECK (
  event_type IN (
    -- 既存イベント
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
    'manual_override',
    -- 新規イベント（二層判定用）
    'attempt_submitted',
    'review_assigned',
    'review_started',
    'review_completed',
    'certificate_applied',
    'certificate_issued',
    'certificate_rejected',
    'video_uploaded',
    'status_changed'
  )
);

-- =====================================================
-- 8. ビュー作成
-- =====================================================

-- 審査待ちリスト（検定員向け）
CREATE OR REPLACE VIEW review_pending_list AS
SELECT 
  rt.id AS task_id,
  rt.reviewer_id,
  rt.assigned_at,
  rt.due_date,
  rt.priority,
  ca.id AS attempt_id,
  ca.grade_code,
  ca.status,
  ca.submitted_at,
  ca.fixed_video_url,
  ca.panning_video_url,
  u.email AS candidate_email
FROM review_tasks rt
INNER JOIN certification_attempts ca ON rt.attempt_id = ca.id
LEFT JOIN auth.users u ON ca.user_id = u.id
WHERE rt.status IN ('pending', 'in_progress')
  AND ca.status = 'under_review'
ORDER BY rt.priority ASC, rt.assigned_at ASC;

COMMENT ON VIEW review_pending_list IS '検定員向け審査待ちリスト';

-- 証明書発行サマリー（管理者向け）
CREATE OR REPLACE VIEW certificate_issuance_summary AS
SELECT 
  app.grade_code,
  COUNT(*) AS total_applications,
  SUM(CASE WHEN app.status = 'applied' THEN 1 ELSE 0 END) AS pending_count,
  SUM(CASE WHEN app.status = 'issued' THEN 1 ELSE 0 END) AS issued_count,
  SUM(CASE WHEN app.status = 'rejected' THEN 1 ELSE 0 END) AS rejected_count,
  AVG(EXTRACT(EPOCH FROM (app.issued_at - app.applied_at)) / 3600)::INTEGER AS avg_processing_hours
FROM certificate_applications app
WHERE app.status != 'not_applied'
GROUP BY app.grade_code
ORDER BY app.grade_code;

COMMENT ON VIEW certificate_issuance_summary IS '証明書発行サマリー（級別の申請状況）';

-- =====================================================
-- 9. 関数作成
-- =====================================================

-- 申請ID自動生成関数（例: JRPO-2026-001234）
CREATE OR REPLACE FUNCTION generate_application_id()
RETURNS TEXT AS $$
DECLARE
  current_year TEXT;
  next_seq INTEGER;
  new_id TEXT;
BEGIN
  current_year := EXTRACT(YEAR FROM now())::TEXT;
  
  -- 今年度の最大連番を取得
  SELECT COALESCE(MAX(
    SUBSTRING(application_id FROM 'JRPO-[0-9]{4}-([0-9]{6})')::INTEGER
  ), 0) + 1
  INTO next_seq
  FROM certificate_applications
  WHERE application_id LIKE 'JRPO-' || current_year || '-%';
  
  -- 6桁ゼロ埋め
  new_id := 'JRPO-' || current_year || '-' || LPAD(next_seq::TEXT, 6, '0');
  
  RETURN new_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION generate_application_id() IS '申請ID自動生成（例: JRPO-2026-001234）';

-- =====================================================
-- 10. トリガー作成
-- =====================================================

-- review_tasks の updated_at 自動更新
CREATE OR REPLACE FUNCTION update_review_task_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_review_task_timestamp
BEFORE UPDATE ON review_tasks
FOR EACH ROW
EXECUTE FUNCTION update_review_task_timestamp();

-- certificate_applications の updated_at 自動更新
CREATE OR REPLACE FUNCTION update_certificate_application_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_certificate_application_timestamp
BEFORE UPDATE ON certificate_applications
FOR EACH ROW
EXECUTE FUNCTION update_certificate_application_timestamp();

-- =====================================================
-- 11. Row Level Security (RLS) ポリシー
-- =====================================================

-- RLS有効化
ALTER TABLE review_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_checklists ENABLE ROW LEVEL SECURITY;
ALTER TABLE certificate_applications ENABLE ROW LEVEL SECURITY;

-- === 受検者ポリシー ===

-- 受検者は自分の試行のステータスのみ閲覧可能
CREATE POLICY examinee_view_own_attempt_status ON certification_attempts
FOR SELECT
USING (auth.uid() = user_id);

-- 受検者はdraftステータスの試行のみ更新可能
CREATE POLICY examinee_update_draft_attempts ON certification_attempts
FOR UPDATE
USING (auth.uid() = user_id AND status = 'draft');

-- 受検者は合格した試行に対して証明書申請可能
CREATE POLICY examinee_apply_certificate ON certificate_applications
FOR INSERT
WITH CHECK (
  auth.uid() = user_id 
  AND EXISTS (
    SELECT 1 FROM certification_attempts ca
    WHERE ca.id = attempt_id 
      AND ca.user_id = auth.uid()
      AND ca.status IN ('auto_pass', 'certified_pass')
  )
);

-- 受検者は自分の申請のみ閲覧可能
CREATE POLICY examinee_view_own_applications ON certificate_applications
FOR SELECT
USING (auth.uid() = user_id);

-- === 検定員ポリシー ===

-- 検定員は割り当てられたタスクのみ閲覧可能
CREATE POLICY reviewer_view_assigned_tasks ON review_tasks
FOR SELECT
USING (auth.uid() = reviewer_id);

-- 検定員は審査中の試行を閲覧可能
CREATE POLICY reviewer_view_review_attempts ON certification_attempts
FOR SELECT
USING (
  status = 'under_review' 
  AND EXISTS (
    SELECT 1 FROM review_tasks rt
    WHERE rt.attempt_id = certification_attempts.id
      AND rt.reviewer_id = auth.uid()
  )
);

-- 検定員は審査中の試行を更新可能（reviewed_atなど）
CREATE POLICY reviewer_update_review_attempts ON certification_attempts
FOR UPDATE
USING (
  status = 'under_review' 
  AND EXISTS (
    SELECT 1 FROM review_tasks rt
    WHERE rt.attempt_id = certification_attempts.id
      AND rt.reviewer_id = auth.uid()
  )
);

-- 検定員はチェックリストを提出可能
CREATE POLICY reviewer_submit_checklist ON review_checklists
FOR INSERT
WITH CHECK (
  auth.uid() = reviewer_id
  AND EXISTS (
    SELECT 1 FROM review_tasks rt
    WHERE rt.attempt_id = review_checklists.attempt_id
      AND rt.reviewer_id = auth.uid()
  )
);

-- 検定員は自分が作成したチェックリストを閲覧可能
CREATE POLICY reviewer_view_own_checklists ON review_checklists
FOR SELECT
USING (auth.uid() = reviewer_id);

-- === 管理者ポリシー ===

-- 管理者は全件アクセス可能（既存のadminロールを想定、必要に応じて追加）
-- 例: CREATE POLICY admin_full_access ON <table> FOR ALL USING (auth.jwt()->>'role' = 'admin');

-- =====================================================
-- 12. マイグレーション履歴記録
-- =====================================================

INSERT INTO migration_history (version, description, executed_by)
VALUES ('004', '二層判定モデル実装: 10級〜3級自動判定、2級・1級検定員審査', current_user)
ON CONFLICT (version) DO NOTHING;

-- =====================================================
-- マイグレーション完了
-- =====================================================

-- 完了メッセージ（コメントのみ）
-- 二層判定モデルのマイグレーションが完了しました。
-- 以下を確認してください：
-- 1. certification_attemptsに新規カラムが追加されているか
-- 2. 新規テーブル（review_tasks, review_checklists, certificate_applications）が作成されているか
-- 3. ビューと関数が作成されているか
-- 4. RLSポリシーが有効化されているか
-- 5. インデックスが作成されているか

-- テストクエリ例:
-- SELECT * FROM review_pending_list;
-- SELECT * FROM certificate_issuance_summary;
-- SELECT generate_application_id();
