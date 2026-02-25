-- =====================================================
-- ランニング技能検定モード - 初期データ投入
-- 作成日: 2026-02-12
-- 説明: 10級〜1級の基準データと採点ルールを投入
-- =====================================================

-- =====================================================
-- 1. 級マスタデータ投入 (certification_grades)
-- =====================================================

INSERT INTO certification_grades (
  grade_number, grade_name, grade_name_en, description, target_level, pass_score, display_order
) VALUES
  -- 1級・2級：競技者レベル（80点以上で合格）
  (1, '1級', 'Grade 1', '世界レベルのスプリント技術を有する', '競技者（全国大会レベル）', 80, 1),
  (2, '2級', 'Grade 2', '優れたスプリント技術を有する', '競技者（地域大会レベル）', 80, 2),
  
  -- 3級〜10級：一般ランナーレベル（70点以上で合格）
  (3, '3級', 'Grade 3', '高いスプリント技術を有する', '上級ランナー', 70, 3),
  (4, '4級', 'Grade 4', 'スプリント技術が優れている', '中上級ランナー', 70, 4),
  (5, '5級', 'Grade 5', 'スプリント技術の基礎が身についている', '中級ランナー', 70, 5),
  (6, '6級', 'Grade 6', 'スプリントの基本動作ができる', '中級ランナー', 70, 6),
  (7, '7級', 'Grade 7', 'スプリントの基本姿勢が理解できている', '初中級ランナー', 70, 7),
  (8, '8級', 'Grade 8', 'スプリントの正しいフォームを習得中', '初級ランナー', 70, 8),
  (9, '9級', 'Grade 9', 'スプリントの基礎を学んでいる', '初級ランナー', 70, 9),
  (10, '10級', 'Grade 10', 'スプリントを始めたばかり', '入門者', 70, 10)
ON CONFLICT (grade_number) DO UPDATE SET
  grade_name = EXCLUDED.grade_name,
  description = EXCLUDED.description,
  pass_score = EXCLUDED.pass_score,
  updated_at = now();

-- =====================================================
-- 2. 採点ルールデータ投入 (certification_rules)
-- =====================================================

-- 1級ルール（最高難度）
INSERT INTO certification_rules (
  grade_id, version,
  angle_points, stride_points, contact_time_points, hfvp_points, technique_points,
  rule_json, is_active, effective_from
)
SELECT
  g.id, 1,
  30, 25, 20, 20, 5,
  jsonb_build_object(
    'priority', ARRAY['angle', 'stride', 'contact_time', 'hfvp'],
    'angle_criteria', jsonb_build_object(
      'knee_flexion_min', 95,
      'knee_flexion_max', 155,
      'knee_flexion_ideal', 125,
      'hip_extension_min', 150,
      'hip_extension_ideal', 160,
      'trunk_lean_min', 0,
      'trunk_lean_max', 8,
      'trunk_lean_ideal', 5
    ),
    'stride_criteria', jsonb_build_object(
      'stride_length_ratio_min', 2.2,
      'stride_length_ratio_max', 2.6,
      'stride_length_ratio_ideal', 2.4,
      'stride_frequency_min', 4.5,
      'stride_frequency_max', 5.5,
      'stride_frequency_ideal', 5.0
    ),
    'contact_time_criteria', jsonb_build_object(
      'contact_time_min', 0.08,
      'contact_time_max', 0.11,
      'contact_time_ideal', 0.09,
      'flight_time_min', 0.10,
      'flight_time_ideal', 0.12
    ),
    'hfvp_criteria', jsonb_build_object(
      'f0_min', 4.5,
      'f0_ideal', 5.0,
      'v0_min', 12.0,
      'v0_ideal', 13.0,
      'pmax_min', 25.0,
      'pmax_ideal', 30.0,
      'drf_min', -10.0,
      'drf_max', -6.0,
      'drf_ideal', -7.5
    )
  ),
  true, now()
FROM certification_grades g
WHERE g.grade_number = 1
ON CONFLICT (grade_id, version) DO NOTHING;

-- 2級ルール
INSERT INTO certification_rules (
  grade_id, version,
  angle_points, stride_points, contact_time_points, hfvp_points, technique_points,
  rule_json, is_active, effective_from
)
SELECT
  g.id, 1,
  30, 25, 20, 15, 10,
  jsonb_build_object(
    'priority', ARRAY['angle', 'stride', 'contact_time', 'hfvp'],
    'angle_criteria', jsonb_build_object(
      'knee_flexion_min', 90,
      'knee_flexion_max', 160,
      'knee_flexion_ideal', 125,
      'hip_extension_min', 145,
      'hip_extension_ideal', 155,
      'trunk_lean_min', 0,
      'trunk_lean_max', 10,
      'trunk_lean_ideal', 5
    ),
    'stride_criteria', jsonb_build_object(
      'stride_length_ratio_min', 2.0,
      'stride_length_ratio_max', 2.5,
      'stride_length_ratio_ideal', 2.3,
      'stride_frequency_min', 4.0,
      'stride_frequency_max', 5.2,
      'stride_frequency_ideal', 4.6
    ),
    'contact_time_criteria', jsonb_build_object(
      'contact_time_min', 0.08,
      'contact_time_max', 0.12,
      'contact_time_ideal', 0.10,
      'flight_time_min', 0.09,
      'flight_time_ideal', 0.11
    ),
    'hfvp_criteria', jsonb_build_object(
      'f0_min', 4.0,
      'f0_ideal', 4.5,
      'v0_min', 11.5,
      'v0_ideal', 12.5,
      'pmax_min', 22.0,
      'pmax_ideal', 27.0,
      'drf_min', -10.0,
      'drf_max', -6.0,
      'drf_ideal', -8.0
    )
  ),
  true, now()
FROM certification_grades g
WHERE g.grade_number = 2
ON CONFLICT (grade_id, version) DO NOTHING;

-- 3級ルール（H-FVP評価なし）
INSERT INTO certification_rules (
  grade_id, version,
  angle_points, stride_points, contact_time_points, hfvp_points, technique_points,
  rule_json, is_active, effective_from
)
SELECT
  g.id, 1,
  40, 30, 20, 0, 10,
  jsonb_build_object(
    'priority', ARRAY['angle', 'stride', 'contact_time'],
    'angle_criteria', jsonb_build_object(
      'knee_flexion_min', 85,
      'knee_flexion_max', 165,
      'knee_flexion_ideal', 125,
      'hip_extension_min', 140,
      'hip_extension_ideal', 150,
      'trunk_lean_min', 0,
      'trunk_lean_max', 12,
      'trunk_lean_ideal', 6
    ),
    'stride_criteria', jsonb_build_object(
      'stride_length_ratio_min', 1.9,
      'stride_length_ratio_max', 2.4,
      'stride_length_ratio_ideal', 2.2,
      'stride_frequency_min', 3.8,
      'stride_frequency_max', 5.0,
      'stride_frequency_ideal', 4.4
    ),
    'contact_time_criteria', jsonb_build_object(
      'contact_time_min', 0.09,
      'contact_time_max', 0.13,
      'contact_time_ideal', 0.11,
      'flight_time_min', 0.08,
      'flight_time_ideal', 0.10
    )
  ),
  true, now()
FROM certification_grades g
WHERE g.grade_number = 3
ON CONFLICT (grade_id, version) DO NOTHING;

-- 4級〜10級ルール（段階的に基準を緩和）
-- 4級
INSERT INTO certification_rules (
  grade_id, version,
  angle_points, stride_points, contact_time_points, hfvp_points, technique_points,
  rule_json, is_active, effective_from
)
SELECT
  g.id, 1,
  40, 30, 20, 0, 10,
  jsonb_build_object(
    'priority', ARRAY['angle', 'stride', 'contact_time'],
    'angle_criteria', jsonb_build_object(
      'knee_flexion_min', 80,
      'knee_flexion_max', 170,
      'knee_flexion_ideal', 125,
      'hip_extension_min', 135,
      'hip_extension_ideal', 145,
      'trunk_lean_min', 0,
      'trunk_lean_max', 15,
      'trunk_lean_ideal', 7
    ),
    'stride_criteria', jsonb_build_object(
      'stride_length_ratio_min', 1.8,
      'stride_length_ratio_max', 2.3,
      'stride_length_ratio_ideal', 2.1,
      'stride_frequency_min', 3.6,
      'stride_frequency_max', 4.8,
      'stride_frequency_ideal', 4.2
    ),
    'contact_time_criteria', jsonb_build_object(
      'contact_time_min', 0.10,
      'contact_time_max', 0.14,
      'contact_time_ideal', 0.12
    )
  ),
  true, now()
FROM certification_grades g
WHERE g.grade_number = 4
ON CONFLICT (grade_id, version) DO NOTHING;

-- 5級〜10級（簡略版、必要に応じて拡張）
INSERT INTO certification_rules (
  grade_id, version,
  angle_points, stride_points, contact_time_points, hfvp_points, technique_points,
  rule_json, is_active, effective_from
)
SELECT
  g.id, 1,
  40, 30, 20, 0, 10,
  jsonb_build_object(
    'priority', ARRAY['angle', 'stride', 'contact_time'],
    'angle_criteria', jsonb_build_object(
      'knee_flexion_min', 75 + (10 - g.grade_number) * 2,
      'knee_flexion_max', 175 - (10 - g.grade_number) * 2,
      'knee_flexion_ideal', 125,
      'hip_extension_min', 130 + (10 - g.grade_number) * 2,
      'hip_extension_ideal', 140 + (10 - g.grade_number) * 2,
      'trunk_lean_min', 0,
      'trunk_lean_max', 20 - g.grade_number,
      'trunk_lean_ideal', 10 - g.grade_number / 2
    ),
    'stride_criteria', jsonb_build_object(
      'stride_length_ratio_min', 1.5 + (10 - g.grade_number) * 0.05,
      'stride_length_ratio_max', 2.0 + (10 - g.grade_number) * 0.05,
      'stride_length_ratio_ideal', 1.8 + (10 - g.grade_number) * 0.05,
      'stride_frequency_min', 3.0 + (10 - g.grade_number) * 0.1,
      'stride_frequency_max', 4.5 + (10 - g.grade_number) * 0.1,
      'stride_frequency_ideal', 3.8 + (10 - g.grade_number) * 0.1
    ),
    'contact_time_criteria', jsonb_build_object(
      'contact_time_min', 0.10 + (g.grade_number - 5) * 0.01,
      'contact_time_max', 0.15 + (g.grade_number - 5) * 0.01,
      'contact_time_ideal', 0.12 + (g.grade_number - 5) * 0.01
    )
  ),
  true, now()
FROM certification_grades g
WHERE g.grade_number BETWEEN 5 AND 10
ON CONFLICT (grade_id, version) DO NOTHING;

-- =====================================================
-- 3. 初期データ投入確認
-- =====================================================

-- 投入されたデータ件数を表示
DO $$
DECLARE
  grade_count INTEGER;
  rule_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO grade_count FROM certification_grades;
  SELECT COUNT(*) INTO rule_count FROM certification_rules;
  
  RAISE NOTICE '✅ 初期データ投入完了';
  RAISE NOTICE '   - 級マスタ: % 件', grade_count;
  RAISE NOTICE '   - 採点ルール: % 件', rule_count;
END $$;

-- =====================================================
-- 4. データ整合性チェック
-- =====================================================

-- 全ての級にルールが設定されているか確認
DO $$
DECLARE
  missing_rules INTEGER;
BEGIN
  SELECT COUNT(*) INTO missing_rules
  FROM certification_grades g
  LEFT JOIN certification_rules r ON r.grade_id = g.id AND r.is_active = true
  WHERE r.id IS NULL;
  
  IF missing_rules > 0 THEN
    RAISE WARNING '⚠️  ルール未設定の級が % 件あります', missing_rules;
  ELSE
    RAISE NOTICE '✅ 全ての級にルールが設定されています';
  END IF;
END $$;

-- =====================================================
-- 5. サンプルクエリ（動作確認用）
-- =====================================================

-- 1級・2級の基準を表示
SELECT
  g.grade_name,
  g.pass_score,
  r.angle_points,
  r.stride_points,
  r.contact_time_points,
  r.hfvp_points,
  r.technique_points,
  r.rule_json->'priority' as priority,
  r.rule_json->'hfvp_criteria'->'f0_ideal' as f0_ideal,
  r.rule_json->'hfvp_criteria'->'v0_ideal' as v0_ideal
FROM certification_grades g
JOIN certification_rules r ON r.grade_id = g.id
WHERE g.grade_number IN (1, 2)
ORDER BY g.grade_number;
