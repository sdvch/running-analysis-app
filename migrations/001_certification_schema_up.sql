-- =====================================================
-- ランニング技能検定モード - DB マイグレーション (UP)
-- 作成日: 2026-02-12
-- 説明: 検定機能の新規テーブル作成（既存テーブルは変更なし）
-- =====================================================

-- =====================================================
-- 1. 級マスタテーブル (certification_grades)
-- 説明: 10級〜1級の基本情報
-- =====================================================
CREATE TABLE IF NOT EXISTS certification_grades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  grade_number INTEGER UNIQUE NOT NULL, -- 1〜10 (1級=1, 10級=10)
  grade_name VARCHAR(50) NOT NULL, -- '1級', '2級', ..., '10級'
  grade_name_en VARCHAR(50), -- 'Grade 1', 'Grade 2', ...
  description TEXT, -- 級の説明
  target_level VARCHAR(100), -- '競技者レベル', '一般ランナー'など
  pass_score INTEGER NOT NULL DEFAULT 70, -- 合格基準点（70 or 80）
  display_order INTEGER NOT NULL, -- 表示順序（1級=1, 2級=2, ...）
  is_active BOOLEAN DEFAULT true, -- 有効/無効
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  
  CONSTRAINT chk_grade_number CHECK (grade_number BETWEEN 1 AND 10),
  CONSTRAINT chk_pass_score CHECK (pass_score BETWEEN 0 AND 100)
);

CREATE INDEX idx_grades_number ON certification_grades(grade_number);
CREATE INDEX idx_grades_active ON certification_grades(is_active);

COMMENT ON TABLE certification_grades IS '技能検定の級マスタ（10級〜1級）';
COMMENT ON COLUMN certification_grades.grade_number IS '級番号（1=1級、10=10級）';
COMMENT ON COLUMN certification_grades.pass_score IS '合格基準点（70点 or 80点）';

-- =====================================================
-- 2. 採点ルールテーブル (certification_rules)
-- 説明: 級ごとの採点基準と配点
-- =====================================================
CREATE TABLE IF NOT EXISTS certification_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  grade_id UUID NOT NULL REFERENCES certification_grades(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1, -- ルールバージョン（将来の改定対応）
  
  -- 配点設定
  angle_points INTEGER NOT NULL DEFAULT 40, -- 角度評価の配点
  stride_points INTEGER NOT NULL DEFAULT 30, -- ストライド評価の配点
  contact_time_points INTEGER NOT NULL DEFAULT 20, -- 接地時間評価の配点
  hfvp_points INTEGER DEFAULT 0, -- H-FVP評価の配点（1級・2級のみ）
  technique_points INTEGER DEFAULT 10, -- テクニック評価の配点
  
  -- 採点基準（JSON）
  rule_json JSONB NOT NULL,
  /* 例:
  {
    "priority": ["angle", "stride", "contact_time", "hfvp"],
    "angle_criteria": {
      "knee_flexion_min": 90,
      "knee_flexion_max": 160,
      "hip_extension_min": 140,
      "trunk_lean_min": 0,
      "trunk_lean_max": 10
    },
    "stride_criteria": {
      "stride_length_ratio_min": 1.8,
      "stride_length_ratio_max": 2.5,
      "stride_frequency_min": 3.0,
      "stride_frequency_max": 5.0
    },
    "contact_time_criteria": {
      "contact_time_min": 0.08,
      "contact_time_max": 0.15,
      "flight_time_min": 0.10
    },
    "hfvp_criteria": {
      "f0_min": 3.5,
      "v0_min": 11.0,
      "pmax_min": 20.0,
      "drf_max": -8.0
    }
  }
  */
  
  -- メタ情報
  is_active BOOLEAN DEFAULT true,
  effective_from TIMESTAMP WITH TIME ZONE DEFAULT now(),
  effective_until TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  created_by UUID REFERENCES auth.users(id),
  
  CONSTRAINT chk_points_sum CHECK (
    angle_points + stride_points + contact_time_points + 
    COALESCE(hfvp_points, 0) + COALESCE(technique_points, 0) = 100
  ),
  CONSTRAINT uq_grade_version UNIQUE (grade_id, version)
);

CREATE INDEX idx_rules_grade ON certification_rules(grade_id);
CREATE INDEX idx_rules_active ON certification_rules(is_active);
CREATE INDEX idx_rules_effective ON certification_rules(effective_from, effective_until);

COMMENT ON TABLE certification_rules IS '級ごとの採点ルールと基準';
COMMENT ON COLUMN certification_rules.rule_json IS '採点基準の詳細（JSON形式）';
COMMENT ON COLUMN certification_rules.version IS 'ルールバージョン（改定時に増加）';

-- =====================================================
-- 3. 検定セッションテーブル (certification_sessions)
-- 説明: 検定の実施記録（1回の検定 = 1セッション）
-- =====================================================
CREATE TABLE IF NOT EXISTS certification_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- ユーザー・選手情報
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  athlete_id UUID REFERENCES athletes(id) ON DELETE SET NULL,
  athlete_name VARCHAR(100), -- スナップショット（選手情報削除時も保持）
  
  -- 検定情報
  grade_id UUID NOT NULL REFERENCES certification_grades(id),
  rule_id UUID NOT NULL REFERENCES certification_rules(id),
  
  -- 分析セッション紐付け（既存の running_analysis_sessions）
  analysis_session_id UUID REFERENCES running_analysis_sessions(id),
  
  -- セッションメタ情報
  video_file_name TEXT,
  video_duration DECIMAL(10, 3), -- 秒
  analysis_mode VARCHAR(20) DEFAULT 'panning', -- 'single' or 'panning'
  
  -- 検定実施情報
  started_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  completed_at TIMESTAMP WITH TIME ZONE,
  status VARCHAR(20) DEFAULT 'in_progress', -- 'in_progress', 'completed', 'failed', 'cancelled'
  
  -- デバイス情報
  device_info JSONB, -- ブラウザ、OS、画面サイズなど
  
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  
  CONSTRAINT chk_session_status CHECK (
    status IN ('in_progress', 'completed', 'failed', 'cancelled')
  )
);

CREATE INDEX idx_sessions_user ON certification_sessions(user_id);
CREATE INDEX idx_sessions_athlete ON certification_sessions(athlete_id);
CREATE INDEX idx_sessions_grade ON certification_sessions(grade_id);
CREATE INDEX idx_sessions_status ON certification_sessions(status);
CREATE INDEX idx_sessions_created ON certification_sessions(created_at DESC);

COMMENT ON TABLE certification_sessions IS '検定セッション（1回の検定実施記録）';
COMMENT ON COLUMN certification_sessions.status IS 'セッション状態（in_progress, completed, failed, cancelled）';

-- =====================================================
-- 4. 検定試行テーブル (certification_attempts)
-- 説明: 同じ級への複数回挑戦を記録
-- =====================================================
CREATE TABLE IF NOT EXISTS certification_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES certification_sessions(id) ON DELETE CASCADE,
  
  -- 試行情報
  attempt_number INTEGER NOT NULL DEFAULT 1, -- 1回目、2回目、...
  
  -- 姿勢推定データ
  pose_data JSONB, -- フレームごとの姿勢データ（必要に応じて保存）
  
  -- 生データ
  raw_metrics JSONB,
  /* 例:
  {
    "angles": {
      "frames": [
        {"frame": 0, "knee_left": 120, "knee_right": 125, "hip_left": 150, "trunk": 5},
        ...
      ],
      "average": {"knee": 122, "hip": 148, "trunk": 5}
    },
    "stride": {
      "stride_length": 2.1,
      "stride_frequency": 4.2,
      "height_ratio": 2.0
    },
    "contact_time": {
      "average": 0.12,
      "min": 0.10,
      "max": 0.14
    },
    "hfvp": {
      "f0": 3.8,
      "v0": 11.5,
      "pmax": 22.0,
      "drf": -7.5
    }
  }
  */
  
  -- タイムスタンプ
  started_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  completed_at TIMESTAMP WITH TIME ZONE,
  
  CONSTRAINT uq_session_attempt UNIQUE (session_id, attempt_number)
);

CREATE INDEX idx_attempts_session ON certification_attempts(session_id);

COMMENT ON TABLE certification_attempts IS '検定試行記録（同じ級への複数回挑戦）';
COMMENT ON COLUMN certification_attempts.raw_metrics IS '生の測定データ（JSON形式）';

-- =====================================================
-- 5. 採点結果テーブル (certification_scores)
-- 説明: 項目別の採点結果
-- =====================================================
CREATE TABLE IF NOT EXISTS certification_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id UUID NOT NULL REFERENCES certification_attempts(id) ON DELETE CASCADE,
  
  -- 項目別得点
  angle_score DECIMAL(5, 2) NOT NULL DEFAULT 0, -- 角度評価の得点（0-40）
  stride_score DECIMAL(5, 2) NOT NULL DEFAULT 0, -- ストライド評価の得点（0-30）
  contact_time_score DECIMAL(5, 2) NOT NULL DEFAULT 0, -- 接地時間評価の得点（0-20）
  hfvp_score DECIMAL(5, 2), -- H-FVP評価の得点（0-10、1級・2級のみ）
  technique_score DECIMAL(5, 2), -- テクニック評価の得点（0-10）
  
  -- 項目別の詳細評価（JSON）
  angle_details JSONB,
  /* 例:
  {
    "knee_flexion": {"value": 125, "min": 90, "max": 160, "score": 9.5},
    "hip_extension": {"value": 145, "min": 140, "max": 180, "score": 8.0},
    "trunk_lean": {"value": 5, "min": 0, "max": 10, "score": 10.0}
  }
  */
  stride_details JSONB,
  contact_time_details JSONB,
  hfvp_details JSONB,
  technique_details JSONB,
  
  -- 総合得点
  total_score DECIMAL(5, 2) GENERATED ALWAYS AS (
    angle_score + stride_score + contact_time_score + 
    COALESCE(hfvp_score, 0) + COALESCE(technique_score, 0)
  ) STORED,
  
  -- 計算メタ情報
  calculation_version VARCHAR(20) DEFAULT '1.0.0',
  calculated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  
  CONSTRAINT chk_angle_score CHECK (angle_score BETWEEN 0 AND 40),
  CONSTRAINT chk_stride_score CHECK (stride_score BETWEEN 0 AND 30),
  CONSTRAINT chk_contact_score CHECK (contact_time_score BETWEEN 0 AND 20),
  CONSTRAINT chk_hfvp_score CHECK (hfvp_score IS NULL OR hfvp_score BETWEEN 0 AND 20),
  CONSTRAINT chk_technique_score CHECK (technique_score IS NULL OR technique_score BETWEEN 0 AND 10)
);

CREATE INDEX idx_scores_attempt ON certification_scores(attempt_id);
CREATE INDEX idx_scores_total ON certification_scores(total_score DESC);

COMMENT ON TABLE certification_scores IS '項目別採点結果';
COMMENT ON COLUMN certification_scores.total_score IS '総合得点（自動計算）';

-- =====================================================
-- 6. 検定結果テーブル (certification_results)
-- 説明: 最終的な合否判定結果
-- =====================================================
CREATE TABLE IF NOT EXISTS certification_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES certification_sessions(id) ON DELETE CASCADE,
  attempt_id UUID NOT NULL REFERENCES certification_attempts(id) ON DELETE CASCADE,
  score_id UUID NOT NULL REFERENCES certification_scores(id) ON DELETE CASCADE,
  
  -- 合否判定
  is_passed BOOLEAN NOT NULL,
  pass_threshold INTEGER NOT NULL, -- 合格基準点（70 or 80）
  total_score DECIMAL(5, 2) NOT NULL,
  score_difference DECIMAL(5, 2) GENERATED ALWAYS AS (
    total_score - pass_threshold
  ) STORED, -- 合格ラインとの差分
  
  -- 順位・ランキング
  rank_in_grade INTEGER, -- 同じ級内での順位
  percentile DECIMAL(5, 2), -- パーセンタイル（上位何%）
  
  -- 改善アドバイス
  feedback_json JSONB,
  /* 例:
  {
    "strengths": ["膝の角度が理想的", "ストライドが安定"],
    "weaknesses": ["接地時間がやや長い"],
    "recommendations": [
      "プライオメトリクストレーニングで接地時間を短縮",
      "ドリル練習でストライド長を維持しつつ接地時間を改善"
    ]
  }
  */
  
  -- 認定情報
  certificate_number VARCHAR(50) UNIQUE, -- 認定証番号（合格時のみ）
  certificate_issued_at TIMESTAMP WITH TIME ZONE, -- 認定証発行日時
  certificate_expires_at TIMESTAMP WITH TIME ZONE, -- 認定証有効期限
  certificate_url TEXT, -- 認定証PDF URL
  
  -- タイムスタンプ
  evaluated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  
  CONSTRAINT uq_session_result UNIQUE (session_id)
);

CREATE INDEX idx_results_session ON certification_results(session_id);
CREATE INDEX idx_results_passed ON certification_results(is_passed);
CREATE INDEX idx_results_score ON certification_results(total_score DESC);
CREATE INDEX idx_results_certificate ON certification_results(certificate_number);
CREATE INDEX idx_results_evaluated ON certification_results(evaluated_at DESC);

COMMENT ON TABLE certification_results IS '検定結果（合否判定）';
COMMENT ON COLUMN certification_results.certificate_number IS '認定証番号（合格時のみ発行）';

-- =====================================================
-- 7. 検定監査ログテーブル (certification_audit_logs)
-- 説明: 不正防止・トラブルシューティング用
-- =====================================================
CREATE TABLE IF NOT EXISTS certification_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES certification_sessions(id) ON DELETE SET NULL,
  
  -- イベント情報
  event_type VARCHAR(50) NOT NULL, -- 'session_started', 'score_calculated', 'result_issued', etc.
  event_data JSONB, -- イベント詳細データ
  
  -- ユーザー情報
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ip_address INET,
  user_agent TEXT,
  
  -- タイムスタンプ
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  
  CONSTRAINT chk_event_type CHECK (
    event_type IN (
      'session_started', 'session_completed', 'session_cancelled',
      'attempt_started', 'attempt_completed',
      'score_calculated', 'result_issued', 'certificate_generated',
      'rule_updated', 'manual_override'
    )
  )
);

CREATE INDEX idx_audit_session ON certification_audit_logs(session_id);
CREATE INDEX idx_audit_user ON certification_audit_logs(user_id);
CREATE INDEX idx_audit_event ON certification_audit_logs(event_type);
CREATE INDEX idx_audit_created ON certification_audit_logs(created_at DESC);

COMMENT ON TABLE certification_audit_logs IS '検定実施の監査ログ';
COMMENT ON COLUMN certification_audit_logs.event_type IS 'イベント種別';

-- =====================================================
-- 8. Row Level Security (RLS) 設定
-- =====================================================

-- certification_grades: 全ユーザー閲覧可能
ALTER TABLE certification_grades ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow read access to all users" ON certification_grades
  FOR SELECT USING (true);

-- certification_rules: 全ユーザー閲覧可能
ALTER TABLE certification_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow read access to all users" ON certification_rules
  FOR SELECT USING (true);

-- certification_sessions: 自分のセッションのみ閲覧・作成可能
ALTER TABLE certification_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own sessions" ON certification_sessions
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can create own sessions" ON certification_sessions
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own sessions" ON certification_sessions
  FOR UPDATE USING (auth.uid() = user_id);

-- certification_attempts: セッションオーナーのみアクセス可能
ALTER TABLE certification_attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own attempts" ON certification_attempts
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM certification_sessions
      WHERE certification_sessions.id = certification_attempts.session_id
        AND certification_sessions.user_id = auth.uid()
    )
  );
CREATE POLICY "Users can create own attempts" ON certification_attempts
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM certification_sessions
      WHERE certification_sessions.id = certification_attempts.session_id
        AND certification_sessions.user_id = auth.uid()
    )
  );

-- certification_scores: セッションオーナーのみ閲覧可能
ALTER TABLE certification_scores ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own scores" ON certification_scores
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM certification_attempts
      JOIN certification_sessions ON certification_sessions.id = certification_attempts.session_id
      WHERE certification_attempts.id = certification_scores.attempt_id
        AND certification_sessions.user_id = auth.uid()
    )
  );

-- certification_results: セッションオーナーのみ閲覧可能
ALTER TABLE certification_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own results" ON certification_results
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM certification_sessions
      WHERE certification_sessions.id = certification_results.session_id
        AND certification_sessions.user_id = auth.uid()
    )
  );

-- certification_audit_logs: 管理者のみ閲覧可能
ALTER TABLE certification_audit_logs ENABLE ROW LEVEL SECURITY;
-- 管理者権限は別途定義が必要（ここでは省略）

-- =====================================================
-- 9. トリガー関数（updated_at自動更新）
-- =====================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_certification_grades_updated_at
  BEFORE UPDATE ON certification_grades
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_certification_rules_updated_at
  BEFORE UPDATE ON certification_rules
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_certification_sessions_updated_at
  BEFORE UPDATE ON certification_sessions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- 10. ビュー作成（よく使うクエリを簡素化）
-- =====================================================

-- 検定結果サマリービュー
CREATE OR REPLACE VIEW certification_results_summary AS
SELECT
  r.id,
  r.session_id,
  s.user_id,
  s.athlete_name,
  g.grade_number,
  g.grade_name,
  r.total_score,
  r.is_passed,
  r.pass_threshold,
  r.score_difference,
  r.certificate_number,
  r.evaluated_at,
  sc.angle_score,
  sc.stride_score,
  sc.contact_time_score,
  sc.hfvp_score,
  sc.technique_score
FROM certification_results r
JOIN certification_sessions s ON s.id = r.session_id
JOIN certification_grades g ON g.id = s.grade_id
JOIN certification_scores sc ON sc.id = r.score_id
ORDER BY r.evaluated_at DESC;

COMMENT ON VIEW certification_results_summary IS '検定結果サマリー（よく使う情報を結合）';

-- ユーザー別検定履歴ビュー
CREATE OR REPLACE VIEW user_certification_history AS
SELECT
  s.user_id,
  s.athlete_name,
  g.grade_number,
  g.grade_name,
  COUNT(*) as attempt_count,
  MAX(CASE WHEN r.is_passed THEN r.total_score END) as best_passed_score,
  MAX(r.total_score) as best_score,
  SUM(CASE WHEN r.is_passed THEN 1 ELSE 0 END) as passed_count,
  MAX(CASE WHEN r.is_passed THEN r.evaluated_at END) as last_passed_at
FROM certification_sessions s
JOIN certification_grades g ON g.id = s.grade_id
LEFT JOIN certification_results r ON r.session_id = s.id
WHERE s.status = 'completed'
GROUP BY s.user_id, s.athlete_name, g.grade_number, g.grade_name
ORDER BY s.user_id, g.grade_number;

COMMENT ON VIEW user_certification_history IS 'ユーザー別検定履歴（級ごとの合格状況）';

-- =====================================================
-- マイグレーション完了
-- =====================================================
-- バージョン管理用のメタテーブルにレコード追加
INSERT INTO public.schema_migrations (version, description)
VALUES ('001', 'Create certification schema')
ON CONFLICT (version) DO NOTHING;

-- メタテーブルが存在しない場合は作成
CREATE TABLE IF NOT EXISTS public.schema_migrations (
  version VARCHAR(10) PRIMARY KEY,
  description TEXT,
  applied_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);
