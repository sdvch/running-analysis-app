// src/pages/UserAthletesPage.tsx
import React, { useEffect, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";

type Athlete = {
  id: string;
  owner_auth_user_id: string;
  full_name: string;
  full_name_kana: string | null;
  sex: string | null;
  birth_date: string | null;
  affiliation: string | null;
  notes: string | null;
  height_cm: number | null;
  weight_kg: number | null;
  current_record_s: number | null;
  target_record_s: number | null;
  created_at: string;
};

const UserAthletesPage: React.FC = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [athletes, setAthletes] = useState<Athlete[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // フォーム用
  const [name, setName] = useState("");
  const [nameKana, setNameKana] = useState("");
  const [sex, setSex] = useState("");
  const [birthDate, setBirthDate] = useState("");
  const [affiliation, setAffiliation] = useState("");
  const [notes, setNotes] = useState("");
  const [heightCm, setHeightCm] = useState("");
  const [weightKg, setWeightKg] = useState("");
  const [currentRecord, setCurrentRecord] = useState("");
  const [targetRecord, setTargetRecord] = useState("");

  const [submitting, setSubmitting] = useState(false);

  // 編集モード用：null なら「新規」、id が入っていれば「編集」
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setErrorMsg(null);

      const { data: sessionData, error: sessionError } =
        await supabase.auth.getSession();

      if (sessionError || !sessionData.session) {
        navigate("/login", { replace: true });
        return;
      }

      const authUserId = sessionData.session.user.id;

      let { data, error } = await supabase
        .from("athletes")
        .select("*")
        .eq("owner_auth_user_id", authUserId)
        .order("created_at", { ascending: false });

      // weight_kg カラムがない場合のフォールバック
      if (error && error.message.includes("weight_kg")) {
        console.warn("⚠️ weight_kg カラムが存在しないため、weight_kg なしで取得します。");
        const retry = await supabase
          .from("athletes")
          .select("id, owner_auth_user_id, full_name, full_name_kana, sex, birth_date, affiliation, notes, height_cm, current_record_s, target_record_s, created_at")
          .eq("owner_auth_user_id", authUserId)
          .order("created_at", { ascending: false });
        data = retry.data;
        error = retry.error;
      }

      if (error) {
        setErrorMsg(error.message);
      } else {
        // weight_kg がない場合は null を追加
        const athletesWithWeight = (data ?? []).map((a: any) => ({
          ...a,
          weight_kg: a.weight_kg ?? null,
        }));
        setAthletes(athletesWithWeight);
      }

      setLoading(false);
    };

    load();
  }, [navigate]);

  const toNumberOrNull = (value: string): number | null => {
    const v = value.trim();
    if (v === "") return null;
    const n = Number(v);
    return Number.isNaN(n) ? null : n;
  };

  const resetForm = () => {
    setName("");
    setNameKana("");
    setSex("");
    setBirthDate("");
    setAffiliation("");
    setNotes("");
    setHeightCm("");
    setWeightKg("");
    setCurrentRecord("");
    setTargetRecord("");
    setEditingId(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    if (!name.trim()) {
      setErrorMsg("氏名は必須です。");
      return;
    }

    setSubmitting(true);

    try {
      const { data: sessionData, error: sessionError } =
        await supabase.auth.getSession();

      if (sessionError || !sessionData.session) {
        navigate("/login", { replace: true });
        return;
      }

      const authUserId = sessionData.session.user.id;

      const payload: any = {
        owner_auth_user_id: authUserId,
        full_name: name.trim(),
        full_name_kana: nameKana.trim() || null,
        sex: sex || null,
        birth_date: birthDate || null,
        affiliation: affiliation.trim() || null,
        notes: notes.trim() || null,
        height_cm: toNumberOrNull(heightCm),
        current_record_s: toNumberOrNull(currentRecord),
        target_record_s: toNumberOrNull(targetRecord),
      };

      // weight_kg を含めてみる（カラムがない場合はエラーハンドリング）
      const weightValue = toNumberOrNull(weightKg);
      if (weightValue !== null) {
        payload.weight_kg = weightValue;
      }

      if (editingId) {
        // 既存選手の更新
        let { data, error } = await supabase
          .from("athletes")
          .update(payload)
          .eq("id", editingId)
          .select("*")
          .single();

        // weight_kg カラムが存在しない場合のフォールバック
        if (error && error.message.includes("weight_kg")) {
          console.warn("⚠️ weight_kg カラムが存在しないため、体重なしで保存します。");
          const { weight_kg, ...payloadWithoutWeight } = payload;
          const retry = await supabase
            .from("athletes")
            .update(payloadWithoutWeight)
            .eq("id", editingId)
            .select("*")
            .single();
          data = retry.data;
          error = retry.error;
          if (!error) {
            alert("✅ 選手情報を保存しました（体重データはSupabaseのテーブルにweight_kgカラムがないため保存されませんでした）");
          }
        }

        if (error) {
          setErrorMsg("選手情報の更新に失敗しました：" + error.message);
          setSubmitting(false);
          return;
        }

        setAthletes((prev) =>
          prev.map((a) => (a.id === editingId ? (data as Athlete) : a))
        );
      } else {
        // 新規登録
        let { data, error } = await supabase
          .from("athletes")
          .insert(payload)
          .select("*")
          .single();

        // weight_kg カラムが存在しない場合のフォールバック
        if (error && error.message.includes("weight_kg")) {
          console.warn("⚠️ weight_kg カラムが存在しないため、体重なしで保存します。");
          const { weight_kg, ...payloadWithoutWeight } = payload;
          const retry = await supabase
            .from("athletes")
            .insert(payloadWithoutWeight)
            .select("*")
            .single();
          data = retry.data;
          error = retry.error;
          if (!error) {
            alert("✅ 選手情報を保存しました（体重データはSupabaseのテーブルにweight_kgカラムがないため保存されませんでした）");
          }
        }

        if (error) {
          setErrorMsg("選手の登録に失敗しました：" + error.message);
          setSubmitting(false);
          return;
        }

        setAthletes((prev) => [data as Athlete, ...prev]);
      }

      resetForm();
    } catch (err: any) {
      console.error(err);
      setErrorMsg("予期せぬエラーが発生しました。");
    } finally {
      setSubmitting(false);
    }
  };

  const handleEditClick = (athlete: Athlete) => {
    setEditingId(athlete.id);
    setName(athlete.full_name);
    setNameKana(athlete.full_name_kana ?? "");
    setSex(athlete.sex ?? "");
    setBirthDate(athlete.birth_date ?? "");
    setAffiliation(athlete.affiliation ?? "");
    setNotes(athlete.notes ?? "");
    setHeightCm(athlete.height_cm != null ? String(athlete.height_cm) : "");
    setWeightKg(athlete.weight_kg != null ? String(athlete.weight_kg) : "");
    setCurrentRecord(
      athlete.current_record_s != null ? String(athlete.current_record_s) : ""
    );
    setTargetRecord(
      athlete.target_record_s != null ? String(athlete.target_record_s) : ""
    );
    // 画面上部が見えるようにスクロール
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  // ★ 追加：選手削除用
  const handleDeleteAthlete = async (athleteId: string, athleteName: string) => {
    const ok = window.confirm(
      `「${athleteName}」の選手データを削除してもよろしいですか？\n（この選手に紐づく解析データなどは別テーブルに残っている場合があります）`
    );
    if (!ok) return;

    const { error } = await supabase
      .from("athletes")
      .delete()
      .eq("id", athleteId);

    if (error) {
      console.error("選手の削除に失敗しました", error);
      alert("選手の削除に失敗しました：" + error.message);
      return;
    }

    // 一覧から削除
    setAthletes((prev) => prev.filter((a) => a.id !== athleteId));

    // もし編集中だったらフォームもリセット
    if (editingId === athleteId) {
      resetForm();
    }
  };

  if (loading) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#fff",
        }}
      >
        読み込み中です…
      </div>
    );
  }

  const isEditMode = editingId !== null;

  return (
    <div style={{ minHeight: "100vh", padding: 24 }}>
      <div style={{ maxWidth: 1200, margin: "0 auto" }}>
        {/* ヘッダー */}
        <header
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 24,
            padding: 16,
            borderRadius: 16,
            background: "rgba(255,255,255,0.96)",
            boxShadow: "0 12px 30px rgba(0,0,0,0.08)",
            border: "1px solid rgba(15,23,42,0.08)",
          }}
        >
          <div>
            <h1
              style={{
                fontSize: 22,
                marginBottom: 4,
                color: "#0f172a",
              }}
            >
              選手管理
            </h1>
            <p
              style={{
                fontSize: 13,
                color: "#4b5563",
                lineHeight: 1.5,
              }}
            >
              コーチ／サイエンティストが担当する選手を登録・管理します。
              <br />
              身長や現在の記録・目標記録もここで登録・編集できます。
            </p>
          </div>
          <Link
            to="/dashboard"
            style={{
              padding: "8px 14px",
              borderRadius: 999,
              border: "1px solid #e5e7eb",
              fontSize: 12,
              color: "#111827",
              background: "#f9fafb",
              fontWeight: 500,
            }}
          >
            ← マイページへ戻る
          </Link>
        </header>

        {/* 登録／編集フォーム */}
        <section
          style={{
            marginBottom: 24,
            padding: 16,
            borderRadius: 16,
            background: "rgba(255,255,255,0.96)",
            border: "1px solid rgba(15,23,42,0.06)",
            boxShadow: "0 12px 30px rgba(15,23,42,0.06)",
          }}
        >
          <h2
            style={{
              fontSize: 18,
              marginBottom: 4,
              color: "#111827",
            }}
          >
            {isEditMode ? "選手情報の編集" : "選手の新規登録"}
          </h2>
          <p
            style={{
              fontSize: 13,
              marginBottom: 12,
              color: "#4b5563",
            }}
          >
            {isEditMode
              ? "選手の基本情報や身長・記録を修正して「変更を保存する」を押してください。"
              : "選手名や基本情報に加えて、身長・現在の記録・目標記録も登録しておくと、解析結果の解釈や目標設定に役立ちます。"}
          </p>

          <form onSubmit={handleSubmit}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                gap: 12,
              }}
            >
              <div>
                <label style={labelStyle}>
                  氏名<span style={requiredMark}>*</span>
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  style={inputStyle}
                  required
                />
              </div>

              <div>
                <label style={labelStyle}>氏名（かな）</label>
                <input
                  type="text"
                  value={nameKana}
                  onChange={(e) => setNameKana(e.target.value)}
                  style={inputStyle}
                />
              </div>

              <div>
                <label style={labelStyle}>性別</label>
                <select
                  value={sex}
                  onChange={(e) => setSex(e.target.value)}
                  style={inputStyle}
                >
                  <option value="">選択してください</option>
                  <option value="男">男</option>
                  <option value="女">女</option>
                  <option value="その他">その他</option>
                </select>
              </div>

              <div>
                <label style={labelStyle}>生年月日</label>
                <input
                  type="date"
                  value={birthDate}
                  onChange={(e) => setBirthDate(e.target.value)}
                  style={inputStyle}
                />
              </div>

              <div>
                <label style={labelStyle}>所属（学校・チーム等）</label>
                <input
                  type="text"
                  value={affiliation}
                  onChange={(e) => setAffiliation(e.target.value)}
                  style={inputStyle}
                />
              </div>

              <div>
                <label style={labelStyle}>身長（cm）</label>
                <input
                  type="number"
                  inputMode="decimal"
                  value={heightCm}
                  onChange={(e) => setHeightCm(e.target.value)}
                  style={inputStyle}
                  placeholder="170"
                />
              </div>

              <div>
                <label style={labelStyle}>体重（kg）</label>
                <input
                  type="number"
                  inputMode="decimal"
                  value={weightKg}
                  onChange={(e) => setWeightKg(e.target.value)}
                  style={inputStyle}
                  placeholder="60"
                />
              </div>

              <div>
                <label style={labelStyle}>現在の記録（秒）</label>
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  value={currentRecord}
                  onChange={(e) => setCurrentRecord(e.target.value)}
                  style={inputStyle}
                  placeholder="12.50"
                />
              </div>

              <div>
                <label style={labelStyle}>目標記録（秒）</label>
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  value={targetRecord}
                  onChange={(e) => setTargetRecord(e.target.value)}
                  style={inputStyle}
                  placeholder="12.00"
                />
              </div>
            </div>

            <label style={{ ...labelStyle, marginTop: 12 }}>
              メモ・特記事項
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              style={{
                ...inputStyle,
                resize: "vertical",
                minHeight: 70,
              }}
            />

            {errorMsg && (
              <div
                style={{
                  marginTop: 12,
                  padding: 8,
                  borderRadius: 8,
                  background: "#fef2f2",
                  color: "#b91c1c",
                  fontSize: 12,
                }}
              >
                {errorMsg}
              </div>
            )}

            <div
              style={{
                marginTop: 16,
                display: "flex",
                gap: 8,
                alignItems: "center",
              }}
            >
              <button
                type="submit"
                disabled={submitting}
                style={{
                  padding: "10px 18px",
                  borderRadius: 999,
                  border: "none",
                  background: submitting ? "#9ca3af" : "#22c55e",
                  color: "#fff",
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: submitting ? "default" : "pointer",
                }}
              >
                {submitting
                  ? "送信中…"
                  : isEditMode
                  ? "変更を保存する"
                  : "選手を登録する"}
              </button>

              {isEditMode && (
                <button
                  type="button"
                  onClick={resetForm}
                  style={{
                    padding: "8px 14px",
                    borderRadius: 999,
                    border: "1px solid #d1d5db",
                    background: "#ffffff",
                    color: "#111827",
                    fontSize: 12,
                    cursor: "pointer",
                  }}
                >
                  キャンセル（新規登録に戻る）
                </button>
              )}
            </div>
          </form>
        </section>

        {/* 選手一覧 */}
        <section
          style={{
            padding: 16,
            borderRadius: 16,
            background: "rgba(255,255,255,0.96)",
            border: "1px solid rgba(15,23,42,0.06)",
            boxShadow: "0 12px 30px rgba(15,23,42,0.06)",
          }}
        >
          <h2
            style={{
              fontSize: 18,
              marginBottom: 8,
              color: "#111827",
            }}
          >
            登録済みの選手一覧
          </h2>

          {athletes.length === 0 ? (
            <div
              style={{
                padding: 24,
                borderRadius: 12,
                border: "1px dashed rgba(148,163,184,0.9)",
                background: "#f9fafb",
                fontSize: 13,
                color: "#4b5563",
                textAlign: "center",
              }}
            >
              まだ選手は登録されていません。
              <br />
              上のフォームから担当選手を登録してください。
            </div>
          ) : (
            <div
              style={{
                overflowX: "auto",
                borderRadius: 12,
                border: "1px solid rgba(148,163,184,0.6)",
                background: "#f9fafb",
              }}
            >
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: 12,
                  color: "#111827",
                }}
              >
                <thead>
                  <tr style={{ background: "#e5edff" }}>
                    <th style={thStyle}>登録日時</th>
                    <th style={thStyle}>氏名</th>
                    <th style={thStyle}>氏名（かな）</th>
                    <th style={thStyle}>性別</th>
                    <th style={thStyle}>生年月日</th>
                    <th style={thStyle}>所属</th>
                    <th style={thStyle}>身長(cm)</th>
                    <th style={thStyle}>体重(kg)</th>
                    <th style={thStyle}>現在の記録(s)</th>
                    <th style={thStyle}>目標記録(s)</th>
                    <th style={thStyle}>メモ</th>
                    <th style={thStyle}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {athletes.map((a) => (
                    <tr key={a.id}>
                      <td style={tdStyle}>
                        {new Date(a.created_at).toLocaleString("ja-JP")}
                      </td>
                      <td style={tdStyle}>{a.full_name}</td>
                      <td style={tdStyle}>{a.full_name_kana ?? "-"}</td>
                      <td style={tdStyle}>{a.sex ?? "-"}</td>
                      <td style={tdStyle}>{a.birth_date ?? "-"}</td>
                      <td style={tdStyle}>{a.affiliation ?? "-"}</td>
                      <td style={tdStyle}>
                        {a.height_cm != null ? `${a.height_cm}` : "-"}
                      </td>
                      <td style={tdStyle}>
                        {a.weight_kg != null ? `${a.weight_kg}` : "-"}
                      </td>
                      <td style={tdStyle}>
                        {a.current_record_s != null
                          ? `${a.current_record_s}`
                          : "-"}
                      </td>
                      <td style={tdStyle}>
                        {a.target_record_s != null
                          ? `${a.target_record_s}`
                          : "-"}
                      </td>
                      <td style={tdStyle}>{a.notes ?? "-"}</td>
                      <td style={tdStyle}>
                        <div style={{ display: "flex", gap: 6 }}>
                          <button
                            type="button"
                            onClick={() => handleEditClick(a)}
                            style={{
                              padding: "4px 10px",
                              borderRadius: 999,
                              border: "1px solid #3b82f6",
                              background: "#eff6ff",
                              color: "#1d4ed8",
                              fontSize: 11,
                              cursor: "pointer",
                            }}
                          >
                            編集
                          </button>

                          <button
                            type="button"
                            onClick={() =>
                              handleDeleteAthlete(a.id, a.full_name)
                            }
                            style={{
                              padding: "4px 10px",
                              borderRadius: 999,
                              border: "1px solid #f97373",
                              background: "#fef2f2",
                              color: "#b91c1c",
                              fontSize: 11,
                              cursor: "pointer",
                            }}
                          >
                            削除
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  marginBottom: 4,
  color: "#374151",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid #d1d5db", 
  background: "#ffffff",
  color: "#111827",
  fontSize: 13,
};

const requiredMark: React.CSSProperties = {
  color: "#f97316",
  marginLeft: 4,
};

const thStyle: React.CSSProperties = {
  padding: "8px 10px",
  borderBottom: "1px solid #cbd5f5",
  textAlign: "left",
  whiteSpace: "nowrap",
};

const tdStyle: React.CSSProperties = {
  padding: "8px 10px",
  borderBottom: "1px solid #e5e7eb",
  whiteSpace: "nowrap",
};

export default UserAthletesPage;
