# 既存データへの影響分析

## 📊 影響範囲サマリー

| カテゴリ | 影響度 | 詳細 |
|---------|-------|------|
| 既存テーブル | ✅ **影響なし** | 一切の変更なし |
| 既存データ | ✅ **影響なし** | 読み取りのみ |
| アプリケーション | ✅ **影響なし** | DB変更のみ |
| パフォーマンス | 🟡 **微影響** | 新規インデックス追加 |
| セキュリティ | ✅ **向上** | RLS追加 |

---

## 1. 既存テーブルへの影響

### ✅ 変更なし（0件）

以下のテーブルは**一切変更されません**：

```sql
-- 選手関連
athletes
profile_settings

-- 分析関連
running_analysis_sessions
three_phase_angles
step_metrics

-- 認証関連
auth.users
auth.sessions

-- その他
schema_migrations
```

### 📌 参照関係の追加

新規テーブルは既存テーブルを**参照のみ**します：

```sql
-- certification_sessions が既存テーブルを参照
ALTER TABLE certification_sessions
  ADD CONSTRAINT fk_user FOREIGN KEY (user_id)
    REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE certification_sessions
  ADD CONSTRAINT fk_athlete FOREIGN KEY (athlete_id)
    REFERENCES athletes(id) ON DELETE SET NULL;

ALTER TABLE certification_sessions
  ADD CONSTRAINT fk_analysis FOREIGN KEY (analysis_session_id)
    REFERENCES running_analysis_sessions(id) ON DELETE SET NULL;
```

**重要**: `ON DELETE SET NULL` により、既存データを削除しても検定データは保持されます。

---

## 2. データフロー図

### Before（現在）

```
┌─────────────┐
│ auth.users  │
└──────┬──────┘
       │
       ▼
┌─────────────────────────┐
│ running_analysis_sessions│
└────────┬────────────────┘
         │
         ▼
┌─────────────────┐
│ three_phase_angles│
└─────────────────┘
```

### After（マイグレーション後）

```
┌─────────────┐
│ auth.users  │◄─────────┐
└──────┬──────┘          │
       │                 │ 参照のみ
       ▼                 │
┌─────────────────────────┐    ┌──────────────────────┐
│ running_analysis_sessions│◄───│certification_sessions│
└────────┬────────────────┘    └──────────┬───────────┘
         │                              │
         ▼                              ▼
┌─────────────────┐          ┌──────────────────────┐
│ three_phase_angles│          │certification_attempts│
└─────────────────┘          └──────────┬───────────┘
                                       │
                                       ▼
                             ┌──────────────────────┐
                             │certification_scores  │
                             └──────────┬───────────┘
                                       │
                                       ▼
                             ┌──────────────────────┐
                             │certification_results │
                             └──────────────────────┘
```

**既存のデータフローは一切変更されません。**

---

## 3. パフォーマンスへの影響

### 🟡 微影響（軽微）

#### 影響内容

1. **新規インデックスの追加**
   - 検定テーブルに約20個のインデックス追加
   - ディスク容量: 初期状態で約1MB（データ0件時）

2. **RLS（Row Level Security）の追加**
   - SELECT クエリ時に権限チェックが実行される
   - 検定テーブルのみ対象、既存テーブルは無関係

#### 影響測定

```sql
-- ディスク使用量確認
SELECT
  schemaname,
  tablename,
  pg_size_pretty(pg_total_relation_size(schemaname || '.' || tablename)) AS size
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename LIKE 'certification_%'
ORDER BY pg_total_relation_size(schemaname || '.' || tablename) DESC;

-- 期待される結果（初期状態）
-- certification_sessions: 約200KB
-- certification_rules: 約150KB
-- その他: 約100KB以下
```

#### 対策

- **既存クエリの速度**: 影響なし（検定テーブルは独立）
- **バックアップ時間**: 初期状態では+1秒未満
- **データ投入後**: 月間1,000件の検定実施で約10MB増加（許容範囲）

---

## 4. アプリケーションへの影響

### ✅ 影響なし（DB変更のみ）

今回のマイグレーションは**DBのみ**の変更です。

#### フロントエンド

```typescript
// 既存コード: 一切変更なし
const { data: athletes } = await supabase
  .from('athletes')
  .select('*');

// 検定機能は別途実装（次のフェーズ）
// const { data: certifications } = await supabase
//   .from('certification_sessions')
//   .select('*');
```

#### 既存API

- `running_analysis_sessions` への書き込み: 影響なし
- `athletes` の読み取り: 影響なし
- `three_phase_angles` の保存: 影響なし

---

## 5. セキュリティへの影響

### ✅ 向上（セキュリティ強化）

#### RLSによる保護

```sql
-- ユーザーは自分の検定データのみ閲覧可能
-- 他人の検定データは完全に隔離される

-- 例: ユーザーAがユーザーBの検定結果を取得しようとしても失敗
SELECT * FROM certification_sessions
WHERE user_id = 'user-b-id'; -- 空の結果が返る（エラーではない）
```

#### 監査ログ

```sql
-- 全ての検定操作がログに記録される
SELECT
  event_type,
  user_id,
  ip_address,
  created_at
FROM certification_audit_logs
ORDER BY created_at DESC;

-- 不正操作の検出が可能
```

---

## 6. バックアップへの影響

### 📦 バックアップサイズ

#### 初期状態（データ0件）

```
検定テーブル合計: 約1MB
既存テーブル合計: 約50MB（変更なし）
---------------------------------
合計バックアップサイズ: 約51MB (+2%)
```

#### 1年後（月間1,000件の検定実施）

```
検定テーブル合計: 約120MB
既存テーブル合計: 約50MB（変更なし）
---------------------------------
合計バックアップサイズ: 約170MB (+240%)
```

#### 対策

```sql
-- 古い検定データのアーカイブ（6ヶ月以上前）
-- 必要に応じて実装
CREATE TABLE certification_results_archive AS
SELECT * FROM certification_results
WHERE evaluated_at < now() - INTERVAL '6 months';

DELETE FROM certification_results
WHERE evaluated_at < now() - INTERVAL '6 months';
```

---

## 7. ダウンタイムの有無

### ✅ ダウンタイムなし

マイグレーションは以下の理由でダウンタイム不要：

1. **新規テーブルの追加のみ**
   - 既存テーブルのロックなし
   - DDLロックは新規テーブルのみ

2. **実行時間**
   - スキーマ作成: 約5秒
   - 初期データ投入: 約1秒
   - 合計: 約6秒

3. **オンライン実行可能**
   ```sql
   -- マイグレーション中も既存機能は正常動作
   SELECT * FROM running_analysis_sessions; -- OK
   INSERT INTO athletes (...); -- OK
   ```

---

## 8. ロールバックのリスク

### ⚠️ ロールバック時の注意

#### 検定データの喪失

```sql
-- ロールバック実行前に必ずバックアップ
pg_dump -h [HOST] -U postgres -t certification_* > backup_certification.sql
```

#### 既存データへの影響

```
既存データ: 影響なし ✅
検定データ: 完全削除 ❌
```

#### ロールバック後の復旧

```bash
# バックアップから復元
psql -f backup_certification.sql

# または
\i 001_certification_schema_up.sql
\i 002_seed_certification_rules.sql
psql -f backup_certification.sql
```

---

## 9. 監視すべきメトリクス

### マイグレーション後の監視

```sql
-- 1. テーブルサイズの監視
SELECT
  tablename,
  pg_size_pretty(pg_total_relation_size('public.' || tablename)) AS size,
  n_live_tup AS row_count
FROM pg_stat_user_tables
WHERE tablename LIKE 'certification_%'
ORDER BY pg_total_relation_size('public.' || tablename) DESC;

-- 2. インデックス使用状況
SELECT
  schemaname,
  tablename,
  indexname,
  idx_scan AS index_scans,
  idx_tup_read AS tuples_read,
  idx_tup_fetch AS tuples_fetched
FROM pg_stat_user_indexes
WHERE schemaname = 'public'
  AND tablename LIKE 'certification_%'
ORDER BY idx_scan DESC;

-- 3. RLSポリシーの実行時間（Supabase Observability）
-- Dashboard > Database > Performance Insights
```

---

## 10. チェックリスト

### マイグレーション実行前

- [ ] Supabase プロジェクトのバックアップを取得
- [ ] `auth.users` テーブルが存在することを確認
- [ ] `athletes` テーブルが存在することを確認
- [ ] PostgreSQL バージョンを確認（14以上推奨）

### マイグレーション実行中

- [ ] `001_certification_schema_up.sql` を実行
- [ ] エラーがないことを確認
- [ ] `002_seed_certification_rules.sql` を実行
- [ ] 10級〜1級のデータが投入されたことを確認

### マイグレーション実行後

- [ ] テーブル作成を確認（7テーブル）
- [ ] ビュー作成を確認（2ビュー）
- [ ] RLSポリシーを確認
- [ ] インデックスを確認
- [ ] 既存機能が正常動作することを確認
  - [ ] 選手登録
  - [ ] 動画アップロード
  - [ ] 分析実行
  - [ ] 結果表示

---

## 📞 問題発生時の連絡先

### エラーレベル別の対応

| レベル | 症状 | 対応 |
|-------|------|------|
| 🟢 軽微 | 警告メッセージ | ログを確認、無視可能 |
| 🟡 中程度 | インデックス未作成 | 手動でインデックス作成 |
| 🔴 重大 | テーブル作成失敗 | ロールバックして再実行 |

### 緊急ロールバック

```bash
# 最速ロールバック（2分以内）
psql -f 003_certification_schema_down.sql

# 既存機能の動作確認
psql -c "SELECT COUNT(*) FROM running_analysis_sessions;"
```

---

## ✅ 結論

このマイグレーションは：

- ✅ **既存データに影響なし**
- ✅ **既存機能に影響なし**
- ✅ **ダウンタイムなし**
- ✅ **安全にロールバック可能**
- ✅ **パフォーマンス影響は軽微**

**安心して本番環境に適用できます。**
