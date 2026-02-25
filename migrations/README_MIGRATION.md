# ランニング技能検定モード - DB マイグレーション手順

## 📋 概要

このマイグレーションは、既存の Running Analysis App に**技能検定モード**を追加するためのデータベース変更です。

**重要**: 既存テーブル（`athletes`, `running_analysis_sessions` 等）には一切変更を加えません。

---

## 🎯 作成されるテーブル

### 新規テーブル（7つ）

| テーブル名 | 説明 | レコード数（初期） |
|-----------|------|------------------|
| `certification_grades` | 級マスタ（10級〜1級） | 10件 |
| `certification_rules` | 採点ルール（級ごと） | 10件 |
| `certification_sessions` | 検定セッション | 0件 |
| `certification_attempts` | 検定試行記録 | 0件 |
| `certification_scores` | 項目別採点結果 | 0件 |
| `certification_results` | 合否判定結果 | 0件 |
| `certification_audit_logs` | 監査ログ | 0件 |

### ビュー（2つ）

- `certification_results_summary`: 検定結果サマリー
- `user_certification_history`: ユーザー別検定履歴

---

## 🔧 実行方法

### 前提条件

- Supabase プロジェクトへのアクセス権限
- PostgreSQL クライアント（psql または Supabase Dashboard）
- データベース接続情報

### 方法1: Supabase Dashboard（推奨）

1. **Supabase Dashboard にログイン**
   ```
   https://app.supabase.com/project/[YOUR_PROJECT_ID]
   ```

2. **SQL Editor を開く**
   - 左メニューから「SQL Editor」を選択
   - 「New query」をクリック

3. **マイグレーション実行**
   
   **Step 1: スキーマ作成**
   ```sql
   -- 001_certification_schema_up.sql の内容をコピー&ペースト
   -- [Run] をクリック
   ```
   
   **Step 2: 初期データ投入**
   ```sql
   -- 002_seed_certification_rules.sql の内容をコピー&ペースト
   -- [Run] をクリック
   ```

4. **実行結果確認**
   ```sql
   -- 級マスタを確認
   SELECT * FROM certification_grades ORDER BY grade_number;
   
   -- 採点ルールを確認
   SELECT 
     g.grade_name,
     g.pass_score,
     r.angle_points,
     r.stride_points,
     r.contact_time_points,
     r.hfvp_points
   FROM certification_grades g
   JOIN certification_rules r ON r.grade_id = g.id
   ORDER BY g.grade_number;
   ```

### 方法2: psql コマンドライン

```bash
# Supabase接続情報を環境変数に設定
export PGHOST="your-project.supabase.co"
export PGPORT="5432"
export PGDATABASE="postgres"
export PGUSER="postgres"
export PGPASSWORD="your-password"

# マイグレーション実行
cd /home/user/webapp/migrations

# Step 1: スキーマ作成
psql -f 001_certification_schema_up.sql

# Step 2: 初期データ投入
psql -f 002_seed_certification_rules.sql
```

---

## ✅ 動作確認

### 1. テーブル作成確認

```sql
-- 全テーブルが存在することを確認
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name LIKE 'certification_%'
ORDER BY table_name;

-- 期待される結果: 7つのテーブル
-- certification_attempts
-- certification_audit_logs
-- certification_grades
-- certification_results
-- certification_rules
-- certification_scores
-- certification_sessions
```

### 2. 初期データ確認

```sql
-- 級マスタのレコード数
SELECT COUNT(*) as grade_count FROM certification_grades;
-- 期待値: 10

-- 採点ルールのレコード数
SELECT COUNT(*) as rule_count FROM certification_rules;
-- 期待値: 10

-- 1級・2級のH-FVP評価配点を確認
SELECT 
  g.grade_name,
  r.hfvp_points
FROM certification_grades g
JOIN certification_rules r ON r.grade_id = g.id
WHERE g.grade_number IN (1, 2);
-- 期待値: 1級=20点, 2級=15点
```

### 3. RLS（Row Level Security）確認

```sql
-- RLSが有効化されているか確認
SELECT 
  tablename,
  rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename LIKE 'certification_%';
-- 全テーブルで rowsecurity = true であることを確認
```

### 4. ビュー動作確認

```sql
-- ビューが作成されているか確認
SELECT table_name
FROM information_schema.views
WHERE table_schema = 'public'
  AND table_name LIKE 'certification_%';

-- 期待される結果: 2つのビュー
-- certification_results_summary
-- user_certification_history
```

---

## 🔄 ロールバック手順

### ⚠️ 警告

**この操作を実行すると、全ての検定データが完全に削除されます。**

本番環境では必ずバックアップを取得してください。

### ロールバック実行

```bash
# psql の場合
psql -f 003_certification_schema_down.sql

# または Supabase Dashboard の SQL Editor で実行
```

### ロールバック後の確認

```sql
-- 検定テーブルが存在しないことを確認
SELECT COUNT(*)
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name LIKE 'certification_%';
-- 期待値: 0
```

---

## 📊 既存データへの影響

### ✅ 影響なし（安全）

以下の既存テーブルは**一切変更されません**：

- `athletes` - 選手情報
- `running_analysis_sessions` - 分析セッション
- `three_phase_angles` - 3相角度データ
- その他の既存テーブル

### 📌 外部キー関係

検定テーブルは以下の既存テーブルを参照しますが、**既存データに変更はありません**：

```
certification_sessions
  ├── user_id → auth.users (参照のみ)
  ├── athlete_id → athletes (参照のみ)
  └── analysis_session_id → running_analysis_sessions (参照のみ)
```

**削除時の挙動**:
- `ON DELETE SET NULL`: 既存データが削除されても検定データは保持される
- `ON DELETE CASCADE`: 検定データ同士の整合性を保つ

---

## 🔒 セキュリティ設定

### Row Level Security (RLS)

全ての検定テーブルで RLS が有効化されています：

| テーブル | アクセスポリシー |
|---------|----------------|
| `certification_grades` | 全ユーザー読み取り可能 |
| `certification_rules` | 全ユーザー読み取り可能 |
| `certification_sessions` | 自分のセッションのみ読み書き可能 |
| `certification_attempts` | 自分の試行のみ読み書き可能 |
| `certification_scores` | 自分の採点のみ閲覧可能 |
| `certification_results` | 自分の結果のみ閲覧可能 |
| `certification_audit_logs` | 管理者のみ閲覧可能 |

### 認証チェック

```sql
-- 現在のユーザーIDを確認
SELECT auth.uid();

-- 自分の検定履歴のみ取得できることを確認
SELECT * FROM certification_sessions
WHERE user_id = auth.uid();
```

---

## 📈 パフォーマンス最適化

### インデックス

以下のインデックスが自動作成されます：

```sql
-- よく使うクエリ用
idx_grades_number (certification_grades)
idx_rules_grade (certification_rules)
idx_sessions_user (certification_sessions)
idx_sessions_grade (certification_sessions)
idx_results_score (certification_results)
idx_results_certificate (certification_results)
```

### 推奨クエリパターン

```sql
-- ✅ 良い例: インデックスを使用
SELECT * FROM certification_sessions
WHERE user_id = 'xxx' AND grade_id = 'yyy';

-- ✅ 良い例: ビューを使用
SELECT * FROM certification_results_summary
WHERE user_id = auth.uid()
ORDER BY evaluated_at DESC
LIMIT 10;

-- ❌ 悪い例: フルスキャン
SELECT * FROM certification_results
WHERE to_char(evaluated_at, 'YYYY-MM-DD') = '2026-02-12';
-- → evaluated_at にインデックスがあるので、範囲検索を使う
```

---

## 🐛 トラブルシューティング

### エラー1: 権限不足

```
ERROR: permission denied for table certification_grades
```

**解決方法**:
```sql
-- Supabase の postgres ユーザーで実行
GRANT ALL ON ALL TABLES IN SCHEMA public TO postgres;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO postgres;
```

### エラー2: テーブル既存

```
ERROR: relation "certification_grades" already exists
```

**解決方法**:
```sql
-- 既存のテーブルを削除してから再実行
-- ⚠️ データが失われます
\i 003_certification_schema_down.sql
\i 001_certification_schema_up.sql
```

### エラー3: 外部キー制約違反

```
ERROR: foreign key constraint fails
```

**解決方法**:
```sql
-- 参照先のテーブル（athletes, auth.users）が存在することを確認
SELECT tablename FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('athletes');

SELECT tablename FROM pg_tables
WHERE schemaname = 'auth'
  AND tablename = 'users';
```

---

## 📝 次のステップ

### フロントエンド実装

このマイグレーション完了後、以下の実装を進めます：

1. **型定義**: `src/types/certificationTypes.ts`
2. **採点ロジック**: `src/lib/certificationService.ts`
3. **UI コンポーネント**: `src/components/Certification/`
4. **App.tsx 統合**: 検定モード分岐追加

### データベース拡張

将来的に以下の機能を追加する場合：

- 認定証PDF生成: `certification_results.certificate_url`
- ランキング機能: `certification_results.rank_in_grade`
- 団体検定: 新テーブル `certification_organizations`

---

## 📞 サポート

問題が発生した場合は、以下の情報と共に報告してください：

1. Supabase プロジェクトID
2. 実行したSQLスクリプト名
3. エラーメッセージ全文
4. PostgreSQL バージョン（`SELECT version();`）

---

**マイグレーション完了おめでとうございます！🎉**
