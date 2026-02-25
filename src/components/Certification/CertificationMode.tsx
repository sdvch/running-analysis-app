// =====================================================
// ランニング技能検定モード - メインコンポーネント
// 作成日: 2026-02-12
// 説明: 検定モードのUI統合（Phase 4）
// =====================================================

import React, { useState, useEffect, useRef } from 'react';
import type {
  GradeCode,
  CertificationGrade,
  CertificationRule,
  ScoringInput,
  ScoringResult,
  AngleMeasurement,
  StrideMeasurement,
  ContactTimeMeasurement,
  HFVPMeasurement,
  QualityMetrics,
  ManualCorrection,
  AttemptStatus,
} from '../../types/certificationTypes';
import { calculateCertificationScore } from '../../utils/certificationScoring';
import CertificationService from '../../lib/certificationService';
import { determineJudgmentMode, determineFinalStatus, canApplyCertificate } from '../../utils/gradeRouter';
import { AutoJudgment } from './AutoJudgment';
import { ReviewRequired } from './ReviewRequired';
import { CertificateApplication } from './CertificateApplication';
import type { JudgmentMode } from '../../types/reviewTypes';
import type { CertificateApplicationInput } from '../../types/reviewTypes';

// =====================================================
// Props
// =====================================================

interface AthleteOption {
  id: string;
  full_name: string;
  gender: "male" | "female" | "other" | null;
  affiliation: string | null;
  birthdate: string | null;
  age: number | null;
  height_cm: number | null;
  weight_kg: number | null;
  current_record_s: number | null;
  target_record_s: number | null;
}

interface CertificationModeProps {
  onBack: () => void;
  athleteOptions: AthleteOption[];
  currentUser: { id: string; email: string | null } | null;
  // 測定開始時のコールバック（検定情報を保存して分析モードへ）
  onStartMeasurement?: (certInfo: {
    sessionId: string;
    attemptId: string;
    gradeCode: string;
    athleteName: string;
    evaluatorName: string;
    athleteId?: string;
  }) => void;
  // 保存された検定情報
  pendingCertification?: {
    sessionId: string;
    attemptId: string;
    gradeCode: string;
    athleteName: string;
    evaluatorName: string;
    athleteId?: string;
    measurementCompleted?: boolean;
  } | null;
  // 検定情報をクリアするコールバック
  onClearPendingCertification?: () => void;
  // 通常分析からのデータ連携
  analysisData?: {
    angle?: AngleMeasurement;
    stride?: StrideMeasurement;
    contactTime?: ContactTimeMeasurement;
    hfvp?: HFVPMeasurement;
    quality?: QualityMetrics;
  };
}

// =====================================================
// メインコンポーネント
// =====================================================

export default function CertificationMode({
  onBack,
  athleteOptions,
  currentUser,
  onStartMeasurement,
  pendingCertification,
  onClearPendingCertification,
  analysisData,
}: CertificationModeProps) {
  console.log('[CertificationMode] Component mounted/updated, analysisData:', analysisData);
  console.log('[CertificationMode] pendingCertification:', pendingCertification);
  
  // ステップ管理
  const [step, setStep] = useState<'setup' | 'analysis' | 'review' | 'result'>('setup');

  // 検定設定
  const [selectedGrade, setSelectedGrade] = useState<GradeCode | null>(null);
  const [evaluatorName, setEvaluatorName] = useState('');
  const [selectedAthleteId, setSelectedAthleteId] = useState<string | null>(null);
  const [athleteName, setAthleteteName] = useState('');
  const [measurementConditions, setMeasurementConditions] = useState('');
  
  // 検定者名を自動入力（ユーザー情報から）
  useEffect(() => {
    if (currentUser?.email) {
      console.log('[CertificationMode] Setting evaluator name:', currentUser.email);
      setEvaluatorName(currentUser.email);
    }
  }, [currentUser]);
  
  // 選手選択時に名前を設定
  useEffect(() => {
    if (selectedAthleteId) {
      const athlete = athleteOptions.find(a => a.id === selectedAthleteId);
      if (athlete) {
        console.log('[CertificationMode] Setting athlete name:', athlete.full_name);
        setAthleteteName(athlete.full_name);
      }
    }
  }, [selectedAthleteId, athleteOptions]);
  
  // stepが勝手に変更されないようにログ出力
  useEffect(() => {
    console.log('[CertificationMode] Step changed to:', step);
  }, [step]);

  // 級・ルールデータ
  const [grades, setGrades] = useState<CertificationGrade[]>([]);
  const [currentRule, setCurrentRule] = useState<CertificationRule | null>(null);

  // 採点データ
  const [scoringInput, setScoringInput] = useState<ScoringInput | null>(null);
  const [scoringResult, setScoringResult] = useState<ScoringResult | null>(null);

  // 手動補正
  const [manualCorrections, setManualCorrections] = useState<ManualCorrection[]>([]);
  const [requiresReviewItems, setRequiresReviewItems] = useState<string[]>([]);

  // セッション管理
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [attemptId, setAttemptId] = useState<string | null>(null);

  // 二層判定用
  const [judgmentMode, setJudgmentMode] = useState<JudgmentMode | null>(null);
  const [attemptStatus, setAttemptStatus] = useState<AttemptStatus>('draft');
  const [fixedVideoUrl, setFixedVideoUrl] = useState<string | null>(null);
  const [panningVideoUrl, setPanningVideoUrl] = useState<string | null>(null);
  const [showCertificateForm, setShowCertificateForm] = useState(false);

  // ローディング・エラー
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // =====================================================
  // 初期化：級マスタ取得
  // =====================================================

  useEffect(() => {
    loadGrades();
  }, []);

  // 保存された検定情報を復元（一度だけ）
  const restoredRef = useRef(false);
  useEffect(() => {
    if (pendingCertification && !restoredRef.current) {
      console.log('[CertificationMode] Restoring pending certification:', pendingCertification);
      restoredRef.current = true; // 復元済みフラグを立てる
      
      setSessionId(pendingCertification.sessionId);
      setAttemptId(pendingCertification.attemptId);
      setSelectedGrade(pendingCertification.gradeCode as GradeCode);
      setAthleteteName(pendingCertification.athleteName);
      setEvaluatorName(pendingCertification.evaluatorName);
      
      // 測定完了済みの場合は分析ステップへ、そうでなければsetupへ
      if (pendingCertification.measurementCompleted) {
        console.log('[CertificationMode] Measurement completed, going to analysis step');
        setStep('analysis');
        
        // 測定データがあれば採点を実行
        if (analysisData) {
          console.log('[CertificationMode] Analysis data available, preparing scoring...');
          prepareScoringInput();
        }
      } else {
        console.log('[CertificationMode] Measurement not completed yet, staying on setup');
        setStep('setup');
      }
    }
  }, [pendingCertification, analysisData]);

  const loadGrades = async () => {
    try {
      console.log('[CertificationMode] Loading grades...');
      const data = await CertificationService.fetchAllGrades();
      console.log('[CertificationMode] Grades loaded:', data);
      setGrades(data);
    } catch (err) {
      console.error('[CertificationMode] Failed to load grades:', err);
      setError('級マスタの取得に失敗しました。データベースマイグレーションが未実施の可能性があります。Supabase SQL Editorで migrations/001_certification_schema_up.sql を実行してください。');
    }
  };

  // =====================================================
  // Step 1: 検定設定
  // =====================================================

  const handleGradeSelect = async (gradeCode: GradeCode) => {
    setSelectedGrade(gradeCode);
    
    // 判定モードを決定
    const mode = determineJudgmentMode(gradeCode);
    setJudgmentMode(mode);
    
    try {
      const grade = await CertificationService.fetchGradeByCode(gradeCode);
      if (!grade) {
        setError('級が見つかりません');
        return;
      }
      const rule = await CertificationService.fetchRuleByGradeId(grade.id);
      if (!rule) {
        setError('有効な採点ルールが見つかりません');
        return;
      }
      setCurrentRule(rule);
    } catch (err) {
      console.error('Failed to load rule:', err);
      setError('採点ルールの取得に失敗しました');
    }
  };

  const handleStartCertification = async () => {
    if (!selectedGrade || !currentRule) {
      setError('級を選択してください');
      return;
    }

    if (!athleteName.trim()) {
      setError('受検者名を入力してください');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      // セッション作成
      const session = await CertificationService.createSession({
        userId: null, // TODO: 認証実装時に対応
        athleteId: null,
        athleteName: athleteName.trim(),
        gradeCode: selectedGrade,
        analysisMode: 'panning',
        deviceInfo: {
          userAgent: navigator.userAgent,
          evaluator: evaluatorName.trim(),
          conditions: measurementConditions.trim(),
        },
      });

      setSessionId(session.id);

      // 試行作成
      const attempt = await CertificationService.createAttempt({
        sessionId: session.id,
        attemptNumber: 1,
      });

      setAttemptId(attempt.id);

      // 分析データがあれば採点入力を準備
      if (analysisData) {
        prepareScoringInput();
        setStep('analysis');
      } else {
        // 分析データがない場合は、検定情報を保存して分析モードへ
        if (onStartMeasurement) {
          console.log('[CertificationMode] Saving certification info and switching to analysis mode');
          onStartMeasurement({
            sessionId: session.id,
            attemptId: attempt.id,
            gradeCode: selectedGrade,
            athleteName: athleteName.trim(),
            evaluatorName: evaluatorName.trim(),
            athleteId: selectedAthleteId || undefined, // 選手IDを追加
          });
        } else {
          // コールバックがない場合は従来通り分析待機画面を表示
          setStep('analysis');
        }
      }
    } catch (err) {
      console.error('Failed to start certification:', err);
      setError('検定開始に失敗しました');
    } finally {
      setIsLoading(false);
    }
  };

  // =====================================================
  // Step 2: 自動採点表示
  // =====================================================

  const prepareScoringInput = () => {
    if (!analysisData || !selectedGrade) return;

    const input: ScoringInput = {
      grade_code: selectedGrade,
      angle_measurement: analysisData.angle || createDefaultAngleMeasurement(),
      stride_measurement: analysisData.stride || createDefaultStrideMeasurement(),
      contact_time_measurement: analysisData.contactTime || createDefaultContactTimeMeasurement(),
      hfvp_measurement: analysisData.hfvp,
      quality_metrics: analysisData.quality || createDefaultQualityMetrics(),
      manual_corrections: [],
    };

    setScoringInput(input);
    executeScoring(input);
  };

  const executeScoring = (input: ScoringInput) => {
    if (!currentRule) return;

    try {
      const result = calculateCertificationScore(input, currentRule);
      setScoringResult(result);

      // 要確認項目を抽出
      const reviewItems: string[] = [];
      if (result.angle_details.knee_flexion.is_near_threshold) reviewItems.push('膝屈曲角度');
      if (result.angle_details.hip_extension.is_near_threshold) reviewItems.push('股関節伸展');
      if (result.angle_details.trunk_lean.is_near_threshold) reviewItems.push('体幹前傾');
      if (result.stride_details.stride_length_ratio.is_near_threshold) reviewItems.push('ストライド長比率');
      if (result.stride_details.stride_frequency.is_near_threshold) reviewItems.push('ストライド頻度');
      if (result.contact_time_details.contact_time.is_near_threshold) reviewItems.push('接地時間');
      if (result.hfvp_details?.f0.is_near_threshold) reviewItems.push('F0');
      if (result.hfvp_details?.v0.is_near_threshold) reviewItems.push('V0');

      setRequiresReviewItems(reviewItems);

      // 判定モードに基づいてステータスを決定（自動判定の場合）
      if (judgmentMode === 'AUTO_FINAL') {
        const finalStatus = determineFinalStatus(
          result.total_score,
          result.pass_threshold,
          judgmentMode
        );
        setAttemptStatus(finalStatus);
      } else {
        // REVIEW_REQUIRED: draft のまま（提出後に submitted へ遷移）
        setAttemptStatus('draft');
      }
    } catch (err) {
      console.error('Scoring failed:', err);
      setError('採点に失敗しました');
    }
  };

  // =====================================================
  // Step 3: 要確認・手動修正
  // =====================================================

  const handleManualCorrection = (
    item: 'angle' | 'stride' | 'contact_time' | 'hfvp',
    originalValue: number,
    correctedValue: number,
    reason: string
  ) => {
    const correction: ManualCorrection = {
      item,
      original_value: originalValue,
      corrected_value: correctedValue,
      reason,
      corrected_by: evaluatorName || '検定員',
      corrected_at: new Date().toISOString(),
    };

    const newCorrections = [...manualCorrections, correction];
    setManualCorrections(newCorrections);

    // 再採点
    if (scoringInput) {
      const updatedInput = {
        ...scoringInput,
        manual_corrections: newCorrections,
      };
      setScoringInput(updatedInput);
      executeScoring(updatedInput);
    }
  };

  const handleConfirmAndFinalize = async () => {
    if (!scoringResult || !sessionId || !attemptId) {
      setError('採点結果がありません');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      // 採点結果を保存
      const scoreId = await CertificationService.saveScore({
        sessionId,
        attemptId,
        scoringResult,
        userId: null,
      });

      // 手動補正ログを保存
      if (manualCorrections.length > 0) {
        await CertificationService.logManualCorrection({
          sessionId,
          corrections: manualCorrections.map((c) => ({
            item: c.item,
            field: c.item,
            old_value: c.original_value,
            new_value: c.corrected_value,
            reason: c.reason,
            corrected_by: c.corrected_by,
            corrected_at: c.corrected_at,
          })),
          userId: null,
        });
      }

      // 検定結果を保存
      await CertificationService.saveResult({
        sessionId,
        attemptId,
        scoreId,
        scoringResult,
        userId: null,
      });

      // セッション完了
      await CertificationService.completeSession(sessionId, null);

      setStep('result');
    } catch (err) {
      console.error('Failed to finalize certification:', err);
      setError('結果の保存に失敗しました');
    } finally {
      setIsLoading(false);
    }
  };

  // =====================================================
  // 二層判定用ハンドラー
  // =====================================================

  const handleSubmitForReview = async (fixedUrl: string, panningUrl: string) => {
    if (!attemptId) {
      setError('試行IDが見つかりません');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      // 動画URLを保存し、ステータスを submitted に更新
      // NOTE: この部分は実際のバックエンドAPIが実装されたら差し替える
      setFixedVideoUrl(fixedUrl);
      setPanningVideoUrl(panningUrl);
      setAttemptStatus('submitted');
      
      console.log('動画提出:', { fixedUrl, panningUrl, attemptId });
      alert('審査に提出しました。検定員による審査をお待ちください。');
    } catch (err) {
      console.error('Failed to submit for review:', err);
      setError('提出に失敗しました');
      throw err;
    } finally {
      setIsLoading(false);
    }
  };

  const handleApplyCertificate = () => {
    setShowCertificateForm(true);
  };

  const handleCertificateApplicationSubmit = async (application: CertificateApplicationInput) => {
    setIsLoading(true);
    setError(null);

    try {
      // NOTE: この部分は実際のバックエンドAPIが実装されたら差し替える
      console.log('合格証申請:', application);
      alert('合格証の申請を受け付けました。発行までしばらくお待ちください。');
      setShowCertificateForm(false);
    } catch (err) {
      console.error('Failed to apply certificate:', err);
      setError('申請に失敗しました');
      throw err;
    } finally {
      setIsLoading(false);
    }
  };

  const handleRetry = () => {
    // 再受検：設定画面に戻る
    setStep('setup');
    setAttemptStatus('draft');
    setScoringResult(null);
    setScoringInput(null);
    setManualCorrections([]);
    setRequiresReviewItems([]);
  };

  // =====================================================
  // Step 4: 合否結果表示
  // =====================================================

  const handleExportCSV = () => {
    if (!scoringResult || !selectedGrade) return;

    const csvRows = [
      ['検定結果', ''],
      ['級', selectedGrade],
      ['受検者', athleteName],
      ['検定員', evaluatorName],
      ['測定条件', measurementConditions],
      ['日時', new Date().toLocaleString('ja-JP')],
      ['', ''],
      ['項目', '得点', '配点', '得点率'],
      ['角度', scoringResult.angle_score.toFixed(2), currentRule?.angle_points || '', `${((scoringResult.angle_score / (currentRule?.angle_points || 1)) * 100).toFixed(1)}%`],
      ['ストライド', scoringResult.stride_score.toFixed(2), currentRule?.stride_points || '', `${((scoringResult.stride_score / (currentRule?.stride_points || 1)) * 100).toFixed(1)}%`],
      ['接地時間', scoringResult.contact_time_score.toFixed(2), currentRule?.contact_time_points || '', `${((scoringResult.contact_time_score / (currentRule?.contact_time_points || 1)) * 100).toFixed(1)}%`],
      ['H-FVP', scoringResult.hfvp_score.toFixed(2), currentRule?.hfvp_points || '', `${((scoringResult.hfvp_score / (currentRule?.hfvp_points || 1)) * 100).toFixed(1)}%`],
      ['テクニック', scoringResult.technique_score.toFixed(2), currentRule?.technique_points || '', `${((scoringResult.technique_score / (currentRule?.technique_points || 1)) * 100).toFixed(1)}%`],
      ['', ''],
      ['総合得点', scoringResult.total_score.toFixed(2)],
      ['合格基準', scoringResult.pass_threshold],
      ['判定', scoringResult.is_passed ? '合格' : '不合格'],
      ['品質', scoringResult.quality_grade],
      ['要確認', scoringResult.requires_review ? 'あり' : 'なし'],
    ];

    const csvContent = csvRows.map((row) => row.join(',')).join('\n');
    const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `certification_result_${selectedGrade}_${athleteName}_${Date.now()}.csv`;
    link.click();
  };

  // =====================================================
  // デフォルト値生成
  // =====================================================

  const createDefaultAngleMeasurement = (): AngleMeasurement => ({
    knee_left: [],
    knee_right: [],
    hip_left: [],
    hip_right: [],
    trunk: [],
    average: { knee: 0, hip: 0, trunk: 0 },
  });

  const createDefaultStrideMeasurement = (): StrideMeasurement => ({
    stride_length: 0,
    stride_frequency: 0,
    height_ratio: 0,
    step_count: 0,
  });

  const createDefaultContactTimeMeasurement = (): ContactTimeMeasurement => ({
    average: 0,
    min: 0,
    max: 0,
    values: [],
  });

  const createDefaultQualityMetrics = (): QualityMetrics => ({
    pose_confidence_avg: 0.8,
    pose_confidence_min: 0.7,
    frame_drop_rate: 0.05,
    measurement_points: 50,
    fv_r2: 0.9,
    pos_r2: 0.95,
  });

  // =====================================================
  // レンダリング
  // =====================================================

  const requiresHFVP = selectedGrade === '1級' || selectedGrade === '2級';

  console.log('[CertificationMode] Render - step:', step, 'grades:', grades.length, 'athleteOptions:', athleteOptions.length, 'currentUser:', currentUser);

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: 20 }}>
      {/* ヘッダー */}
      <div style={{ marginBottom: 24 }}>
        <button
          onClick={onBack}
          style={{
            padding: '8px 16px',
            fontSize: 14,
            cursor: 'pointer',
            borderRadius: 4,
            border: '1px solid #ccc',
            background: 'white',
          }}
        >
          ← 通常分析モードに戻る
        </button>
        <h1 style={{ marginTop: 16, fontSize: 28, fontWeight: 'bold' }}>
          🏃 ランニング技能検定モード
        </h1>
      </div>

      {/* デバッグ情報 */}
      <div style={{ padding: 10, background: '#f0f0f0', marginBottom: 16, fontSize: 12, fontFamily: 'monospace' }}>
        <div>Step: {step}</div>
        <div>Grades loaded: {grades.length}</div>
        <div>Athletes loaded: {athleteOptions.length}</div>
        <div>Current user: {currentUser?.email || 'null'}</div>
        <div>Error: {error || 'none'}</div>
      </div>

      {/* エラー表示 */}
      {error && (
        <div
          style={{
            padding: 16,
            marginBottom: 16,
            background: '#fee',
            border: '1px solid #fcc',
            borderRadius: 8,
            color: '#c33',
          }}
        >
          ⚠️ {error}
        </div>
      )}

      {/* Step 1: 検定設定 */}
      {step === 'setup' && (
        <div>
          <h2 style={{ fontSize: 20, marginBottom: 16 }}>検定設定</h2>

          {/* 級選択 */}
          <div style={{ marginBottom: 20 }}>
            <label style={{ display: 'block', marginBottom: 8, fontWeight: 'bold' }}>
              受検級 <span style={{ color: 'red' }}>*</span>
            </label>
            <select
              value={selectedGrade || ''}
              onChange={(e) => handleGradeSelect(e.target.value as GradeCode)}
              style={{
                padding: 12,
                fontSize: 16,
                borderRadius: 6,
                border: '1px solid #ccc',
                width: '100%',
                maxWidth: 300,
              }}
            >
              <option value="">選択してください</option>
              {grades.map((grade) => (
                <option key={grade.id} value={grade.grade_name}>
                  {grade.grade_name} - {grade.description}
                </option>
              ))}
            </select>
          </div>

          {/* 受検者選択 */}
          <div style={{ marginBottom: 20 }}>
            <label style={{ display: 'block', marginBottom: 8, fontWeight: 'bold' }}>
              受検者（登録済み選手から選択） <span style={{ color: 'red' }}>*</span>
            </label>
            <select
              value={selectedAthleteId || ''}
              onChange={(e) => setSelectedAthleteId(e.target.value || null)}
              style={{
                padding: 12,
                fontSize: 16,
                borderRadius: 6,
                border: '1px solid #ccc',
                width: '100%',
                maxWidth: 400,
              }}
            >
              <option value="">選択してください</option>
              {athleteOptions.map((athlete) => (
                <option key={athlete.id} value={athlete.id}>
                  {athlete.full_name} {athlete.affiliation ? `(${athlete.affiliation})` : ''}
                </option>
              ))}
            </select>
            {selectedAthleteId && athleteName && (
              <div style={{ marginTop: 8, fontSize: 14, color: '#666' }}>
                選択された受検者: {athleteName}
              </div>
            )}
          </div>

          {/* 検定員名（自動入力） */}
          <div style={{ marginBottom: 20 }}>
            <label style={{ display: 'block', marginBottom: 8, fontWeight: 'bold' }}>
              検定員（自動入力）
            </label>
            <input
              type="text"
              value={evaluatorName}
              readOnly
              style={{
                padding: 12,
                fontSize: 16,
                borderRadius: 6,
                border: '1px solid #ccc',
                width: '100%',
                maxWidth: 400,
                background: '#f5f5f5',
                cursor: 'not-allowed',
              }}
            />
            <div style={{ marginTop: 4, fontSize: 12, color: '#999' }}>
              ログイン中のユーザー情報が自動的に設定されます
            </div>
          </div>

          {/* 測定条件 */}
          <div style={{ marginBottom: 20 }}>
            <label style={{ display: 'block', marginBottom: 8, fontWeight: 'bold' }}>測定条件</label>
            <textarea
              value={measurementConditions}
              onChange={(e) => setMeasurementConditions(e.target.value)}
              placeholder="例: 屋外トラック、晴天、微風"
              rows={3}
              style={{
                padding: 12,
                fontSize: 16,
                borderRadius: 6,
                border: '1px solid #ccc',
                width: '100%',
                resize: 'vertical',
              }}
            />
          </div>

          <button
            onClick={handleStartCertification}
            disabled={!selectedGrade || !athleteName.trim() || isLoading}
            style={{
              padding: '12px 24px',
              fontSize: 16,
              fontWeight: 'bold',
              cursor: selectedGrade && athleteName.trim() && !isLoading ? 'pointer' : 'not-allowed',
              borderRadius: 8,
              border: 'none',
              background: selectedGrade && athleteName.trim() && !isLoading ? '#4CAF50' : '#ccc',
              color: 'white',
            }}
          >
            {isLoading ? '処理中...' : '検定を開始'}
          </button>
        </div>
      )}

      {/* Step 2: 分析待機 / 自動採点表示 */}
      {step === 'analysis' && !scoringResult && (
        <div style={{ textAlign: 'center', padding: 40, maxWidth: 600, margin: '0 auto' }}>
          <h2 style={{ fontSize: 24, marginBottom: 24, color: '#2196F3' }}>✅ 検定セッション作成完了</h2>
          
          <div style={{ 
            background: '#f5f5f5', 
            padding: 24, 
            borderRadius: 12,
            marginBottom: 24,
            textAlign: 'left'
          }}>
            <h3 style={{ fontSize: 18, marginBottom: 16, color: '#333' }}>📊 検定情報</h3>
            <div style={{ fontSize: 16, lineHeight: 1.8 }}>
              <div><strong>級:</strong> {selectedGrade}</div>
              <div><strong>受検者:</strong> {athleteName}</div>
              <div><strong>検定員:</strong> {evaluatorName}</div>
              <div><strong>判定方式:</strong> {judgmentMode === 'AUTO_FINAL' ? '自動判定（3〜10級）' : '審査必須（1〜2級）'}</div>
            </div>
          </div>

          <div style={{
            background: '#fff3cd',
            border: '2px solid #ffc107',
            padding: 24,
            borderRadius: 12,
            marginBottom: 24,
            textAlign: 'left'
          }}>
            <h3 style={{ fontSize: 18, marginBottom: 16, color: '#856404' }}>📝 次の手順</h3>
            <ol style={{ fontSize: 16, lineHeight: 2, paddingLeft: 24, margin: 0 }}>
              <li>下の「通常分析モードへ」ボタンをクリック</li>
              <li>動画をアップロードして測定を実施</li>
              <li>測定完了後、再度「検定モード」ボタンで戻る</li>
              <li>自動的に採点結果が表示されます</li>
            </ol>
          </div>

          <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
            <button
              onClick={onBack}
              style={{
                padding: '14px 28px',
                fontSize: 16,
                fontWeight: 'bold',
                cursor: 'pointer',
                borderRadius: 8,
                border: 'none',
                background: '#2196F3',
                color: 'white',
              }}
            >
              📊 通常分析モードへ
            </button>
            <button
              onClick={() => setStep('setup')}
              style={{
                padding: '14px 28px',
                fontSize: 16,
                cursor: 'pointer',
                borderRadius: 8,
                border: '1px solid #ccc',
                background: 'white',
                color: '#666',
              }}
            >
              ← 検定設定に戻る
            </button>
          </div>
        </div>
      )}

      {step === 'analysis' && scoringResult && (
        <div>
          <h2 style={{ fontSize: 20, marginBottom: 16 }}>自動採点結果</h2>

          {/* 品質警告 */}
          {scoringResult.quality_warnings.length > 0 && (
            <div
              style={{
                padding: 16,
                marginBottom: 16,
                background: '#fff3cd',
                border: '1px solid #ffeaa7',
                borderRadius: 8,
              }}
            >
              <strong>⚠️ 品質警告</strong>
              <ul style={{ marginTop: 8, paddingLeft: 20 }}>
                {scoringResult.quality_warnings.map((warning, idx) => (
                  <li key={idx}>{warning}</li>
                ))}
              </ul>
            </div>
          )}

          {/* 項目別得点 */}
          <div style={{ marginBottom: 24 }}>
            <h3 style={{ fontSize: 18, marginBottom: 12 }}>項目別得点</h3>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#f5f5f5' }}>
                  <th style={{ padding: 12, textAlign: 'left', border: '1px solid #ddd' }}>項目</th>
                  <th style={{ padding: 12, textAlign: 'right', border: '1px solid #ddd' }}>得点</th>
                  <th style={{ padding: 12, textAlign: 'right', border: '1px solid #ddd' }}>配点</th>
                  <th style={{ padding: 12, textAlign: 'right', border: '1px solid #ddd' }}>得点率</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style={{ padding: 12, border: '1px solid #ddd' }}>角度</td>
                  <td style={{ padding: 12, textAlign: 'right', border: '1px solid #ddd' }}>
                    {scoringResult.angle_score.toFixed(2)}
                  </td>
                  <td style={{ padding: 12, textAlign: 'right', border: '1px solid #ddd' }}>
                    {currentRule?.angle_points}
                  </td>
                  <td style={{ padding: 12, textAlign: 'right', border: '1px solid #ddd' }}>
                    {((scoringResult.angle_score / (currentRule?.angle_points || 1)) * 100).toFixed(1)}%
                  </td>
                </tr>
                <tr>
                  <td style={{ padding: 12, border: '1px solid #ddd' }}>ストライド</td>
                  <td style={{ padding: 12, textAlign: 'right', border: '1px solid #ddd' }}>
                    {scoringResult.stride_score.toFixed(2)}
                  </td>
                  <td style={{ padding: 12, textAlign: 'right', border: '1px solid #ddd' }}>
                    {currentRule?.stride_points}
                  </td>
                  <td style={{ padding: 12, textAlign: 'right', border: '1px solid #ddd' }}>
                    {((scoringResult.stride_score / (currentRule?.stride_points || 1)) * 100).toFixed(1)}%
                  </td>
                </tr>
                <tr>
                  <td style={{ padding: 12, border: '1px solid #ddd' }}>接地時間</td>
                  <td style={{ padding: 12, textAlign: 'right', border: '1px solid #ddd' }}>
                    {scoringResult.contact_time_score.toFixed(2)}
                  </td>
                  <td style={{ padding: 12, textAlign: 'right', border: '1px solid #ddd' }}>
                    {currentRule?.contact_time_points}
                  </td>
                  <td style={{ padding: 12, textAlign: 'right', border: '1px solid #ddd' }}>
                    {((scoringResult.contact_time_score / (currentRule?.contact_time_points || 1)) * 100).toFixed(1)}%
                  </td>
                </tr>
                {requiresHFVP && (
                  <tr style={{ background: '#e3f2fd' }}>
                    <td style={{ padding: 12, border: '1px solid #ddd' }}>H-FVP</td>
                    <td style={{ padding: 12, textAlign: 'right', border: '1px solid #ddd' }}>
                      {scoringResult.hfvp_score.toFixed(2)}
                    </td>
                    <td style={{ padding: 12, textAlign: 'right', border: '1px solid #ddd' }}>
                      {currentRule?.hfvp_points}
                    </td>
                    <td style={{ padding: 12, textAlign: 'right', border: '1px solid #ddd' }}>
                      {((scoringResult.hfvp_score / (currentRule?.hfvp_points || 1)) * 100).toFixed(1)}%
                    </td>
                  </tr>
                )}
                <tr>
                  <td style={{ padding: 12, border: '1px solid #ddd' }}>テクニック</td>
                  <td style={{ padding: 12, textAlign: 'right', border: '1px solid #ddd' }}>
                    {scoringResult.technique_score.toFixed(2)}
                  </td>
                  <td style={{ padding: 12, textAlign: 'right', border: '1px solid #ddd' }}>
                    {currentRule?.technique_points}
                  </td>
                  <td style={{ padding: 12, textAlign: 'right', border: '1px solid #ddd' }}>
                    {((scoringResult.technique_score / (currentRule?.technique_points || 1)) * 100).toFixed(1)}%
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* 要確認項目 */}
          {requiresReviewItems.length > 0 && (
            <div
              style={{
                padding: 16,
                marginBottom: 16,
                background: '#ffe0b2',
                border: '1px solid #ffb74d',
                borderRadius: 8,
              }}
            >
              <strong>🔍 要確認項目（基準値の±5%以内）</strong>
              <ul style={{ marginTop: 8, paddingLeft: 20 }}>
                {requiresReviewItems.map((item, idx) => (
                  <li key={idx}>{item}</li>
                ))}
              </ul>
              <p style={{ marginTop: 8, fontSize: 14 }}>
                ※ 必要に応じて手動補正を実施してください
              </p>
            </div>
          )}

          <button
            onClick={() => setStep('review')}
            style={{
              padding: '12px 24px',
              fontSize: 16,
              fontWeight: 'bold',
              cursor: 'pointer',
              borderRadius: 8,
              border: 'none',
              background: '#2196F3',
              color: 'white',
              marginRight: 12,
            }}
          >
            手動補正・確認へ進む
          </button>

          <button
            onClick={handleConfirmAndFinalize}
            disabled={isLoading}
            style={{
              padding: '12px 24px',
              fontSize: 16,
              fontWeight: 'bold',
              cursor: isLoading ? 'not-allowed' : 'pointer',
              borderRadius: 8,
              border: 'none',
              background: isLoading ? '#ccc' : '#4CAF50',
              color: 'white',
            }}
          >
            {isLoading ? '保存中...' : '補正なしで確定'}
          </button>
        </div>
      )}

      {/* Step 3: 要確認・手動修正 */}
      {step === 'review' && (
        <div>
          <h2 style={{ fontSize: 20, marginBottom: 16 }}>手動補正（オプション）</h2>
          <p style={{ marginBottom: 16, color: '#666' }}>
            測定値に問題がある場合は、理由を記載して補正値を入力してください。
          </p>

          {/* 手動補正フォーム（簡易版） */}
          <div
            style={{
              padding: 16,
              background: '#f9f9f9',
              border: '1px solid #ddd',
              borderRadius: 8,
              marginBottom: 16,
            }}
          >
            <p>手動補正機能は開発中です。現在は自動採点結果をそのまま使用します。</p>
          </div>

          <button
            onClick={handleConfirmAndFinalize}
            disabled={isLoading}
            style={{
              padding: '12px 24px',
              fontSize: 16,
              fontWeight: 'bold',
              cursor: isLoading ? 'not-allowed' : 'pointer',
              borderRadius: 8,
              border: 'none',
              background: isLoading ? '#ccc' : '#4CAF50',
              color: 'white',
            }}
          >
            {isLoading ? '保存中...' : '採点結果を確定'}
          </button>
        </div>
      )}

      {/* Step 4: 合否結果（級別分岐） */}
      {step === 'result' && scoringResult && selectedGrade && (
        <div>
          {/* 合格証申請フォーム表示 */}
          {showCertificateForm && attemptId && (
            <CertificateApplication
              attemptId={attemptId}
              gradeCode={selectedGrade}
              onSubmit={handleCertificateApplicationSubmit}
              onCancel={() => setShowCertificateForm(false)}
            />
          )}

          {/* 級別結果表示 */}
          {!showCertificateForm && judgmentMode === 'AUTO_FINAL' && (
            <AutoJudgment
              gradeCode={selectedGrade}
              scoringResult={scoringResult}
              status={attemptStatus}
              onApplyCertificate={canApplyCertificate(attemptStatus) ? handleApplyCertificate : undefined}
              onRetry={handleRetry}
            />
          )}

          {!showCertificateForm && judgmentMode === 'REVIEW_REQUIRED' && (
            <ReviewRequired
              gradeCode={selectedGrade}
              scoringResult={scoringResult}
              status={attemptStatus}
              fixedVideoUrl={fixedVideoUrl}
              panningVideoUrl={panningVideoUrl}
              onSubmitForReview={attemptStatus === 'draft' || attemptStatus === 'needs_resubmission' ? handleSubmitForReview : undefined}
              onApplyCertificate={canApplyCertificate(attemptStatus) ? handleApplyCertificate : undefined}
            />
          )}
        </div>
      )}

      {/* 旧UI（バックアップ、後で削除予定） */}
      {step === 'result' && scoringResult && false && (
        <div>
          <h2 style={{ fontSize: 20, marginBottom: 16 }}>検定結果</h2>

          {/* 合否判定バッジ */}
          <div
            style={{
              padding: 24,
              marginBottom: 24,
              background: scoringResult.is_passed ? '#d4edda' : '#f8d7da',
              border: `2px solid ${scoringResult.is_passed ? '#28a745' : '#dc3545'}`,
              borderRadius: 12,
              textAlign: 'center',
            }}
          >
            <div style={{ fontSize: 48, fontWeight: 'bold', marginBottom: 8 }}>
              {scoringResult.is_passed ? '🎉 合格' : '😢 不合格'}
            </div>
            <div style={{ fontSize: 24, fontWeight: 'bold' }}>
              総合得点: {scoringResult.total_score.toFixed(2)}点 / {scoringResult.pass_threshold}点
            </div>
            <div style={{ fontSize: 18, marginTop: 8 }}>
              {scoringResult.is_passed
                ? `合格ラインより ${scoringResult.score_difference.toFixed(2)}点 上回りました！`
                : `合格ラインまで ${Math.abs(scoringResult.score_difference).toFixed(2)}点 不足しています`}
            </div>
          </div>

          {/* 詳細内訳 */}
          <div style={{ marginBottom: 24 }}>
            <h3 style={{ fontSize: 18, marginBottom: 12 }}>詳細内訳</h3>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#f5f5f5' }}>
                  <th style={{ padding: 12, textAlign: 'left', border: '1px solid #ddd' }}>項目</th>
                  <th style={{ padding: 12, textAlign: 'right', border: '1px solid #ddd' }}>得点</th>
                  <th style={{ padding: 12, textAlign: 'right', border: '1px solid #ddd' }}>配点</th>
                  <th style={{ padding: 12, textAlign: 'right', border: '1px solid #ddd' }}>得点率</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style={{ padding: 12, border: '1px solid #ddd' }}>角度</td>
                  <td style={{ padding: 12, textAlign: 'right', border: '1px solid #ddd' }}>
                    {scoringResult.angle_score.toFixed(2)}
                  </td>
                  <td style={{ padding: 12, textAlign: 'right', border: '1px solid #ddd' }}>
                    {currentRule?.angle_points}
                  </td>
                  <td style={{ padding: 12, textAlign: 'right', border: '1px solid #ddd' }}>
                    {((scoringResult.angle_score / (currentRule?.angle_points || 1)) * 100).toFixed(1)}%
                  </td>
                </tr>
                <tr>
                  <td style={{ padding: 12, border: '1px solid #ddd' }}>ストライド</td>
                  <td style={{ padding: 12, textAlign: 'right', border: '1px solid #ddd' }}>
                    {scoringResult.stride_score.toFixed(2)}
                  </td>
                  <td style={{ padding: 12, textAlign: 'right', border: '1px solid #ddd' }}>
                    {currentRule?.stride_points}
                  </td>
                  <td style={{ padding: 12, textAlign: 'right', border: '1px solid #ddd' }}>
                    {((scoringResult.stride_score / (currentRule?.stride_points || 1)) * 100).toFixed(1)}%
                  </td>
                </tr>
                <tr>
                  <td style={{ padding: 12, border: '1px solid #ddd' }}>接地時間</td>
                  <td style={{ padding: 12, textAlign: 'right', border: '1px solid #ddd' }}>
                    {scoringResult.contact_time_score.toFixed(2)}
                  </td>
                  <td style={{ padding: 12, textAlign: 'right', border: '1px solid #ddd' }}>
                    {currentRule?.contact_time_points}
                  </td>
                  <td style={{ padding: 12, textAlign: 'right', border: '1px solid #ddd' }}>
                    {((scoringResult.contact_time_score / (currentRule?.contact_time_points || 1)) * 100).toFixed(1)}%
                  </td>
                </tr>
                {requiresHFVP && (
                  <tr style={{ background: '#e3f2fd' }}>
                    <td style={{ padding: 12, border: '1px solid #ddd' }}>H-FVP</td>
                    <td style={{ padding: 12, textAlign: 'right', border: '1px solid #ddd' }}>
                      {scoringResult.hfvp_score.toFixed(2)}
                    </td>
                    <td style={{ padding: 12, textAlign: 'right', border: '1px solid #ddd' }}>
                      {currentRule?.hfvp_points}
                    </td>
                    <td style={{ padding: 12, textAlign: 'right', border: '1px solid #ddd' }}>
                      {((scoringResult.hfvp_score / (currentRule?.hfvp_points || 1)) * 100).toFixed(1)}%
                    </td>
                  </tr>
                )}
                <tr>
                  <td style={{ padding: 12, border: '1px solid #ddd' }}>テクニック</td>
                  <td style={{ padding: 12, textAlign: 'right', border: '1px solid #ddd' }}>
                    {scoringResult.technique_score.toFixed(2)}
                  </td>
                  <td style={{ padding: 12, textAlign: 'right', border: '1px solid #ddd' }}>
                    {currentRule?.technique_points}
                  </td>
                  <td style={{ padding: 12, textAlign: 'right', border: '1px solid #ddd' }}>
                    {((scoringResult.technique_score / (currentRule?.technique_points || 1)) * 100).toFixed(1)}%
                  </td>
                </tr>
                <tr style={{ background: '#f5f5f5', fontWeight: 'bold' }}>
                  <td style={{ padding: 12, border: '1px solid #ddd' }}>合計</td>
                  <td style={{ padding: 12, textAlign: 'right', border: '1px solid #ddd' }}>
                    {scoringResult.total_score.toFixed(2)}
                  </td>
                  <td style={{ padding: 12, textAlign: 'right', border: '1px solid #ddd' }}>100</td>
                  <td style={{ padding: 12, textAlign: 'right', border: '1px solid #ddd' }}>
                    {scoringResult.total_score.toFixed(1)}%
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* 不合格理由（不合格時のみ） */}
          {!scoringResult.is_passed && (
            <div
              style={{
                padding: 16,
                marginBottom: 16,
                background: '#f8d7da',
                border: '1px solid #f5c6cb',
                borderRadius: 8,
              }}
            >
              <strong>不合格理由</strong>
              <ul style={{ marginTop: 8, paddingLeft: 20 }}>
                {scoringResult.angle_score < (currentRule?.angle_points || 0) * 0.6 && (
                  <li>角度評価が基準を下回っています</li>
                )}
                {scoringResult.stride_score < (currentRule?.stride_points || 0) * 0.6 && (
                  <li>ストライド評価が基準を下回っています</li>
                )}
                {scoringResult.contact_time_score < (currentRule?.contact_time_points || 0) * 0.6 && (
                  <li>接地時間評価が基準を下回っています</li>
                )}
                {requiresHFVP && scoringResult.hfvp_score < (currentRule?.hfvp_points || 0) * 0.6 && (
                  <li>H-FVP評価が基準を下回っています</li>
                )}
                {scoringResult.quality_grade === '参考' && (
                  <li>データ品質が基準を満たしていません（測定を再実施してください）</li>
                )}
              </ul>
            </div>
          )}

          {/* アクション */}
          <div style={{ display: 'flex', gap: 12 }}>
            <button
              onClick={handleExportCSV}
              style={{
                padding: '12px 24px',
                fontSize: 16,
                fontWeight: 'bold',
                cursor: 'pointer',
                borderRadius: 8,
                border: '1px solid #2196F3',
                background: 'white',
                color: '#2196F3',
              }}
            >
              📊 CSVエクスポート
            </button>

            <button
              onClick={onBack}
              style={{
                padding: '12px 24px',
                fontSize: 16,
                fontWeight: 'bold',
                cursor: 'pointer',
                borderRadius: 8,
                border: 'none',
                background: '#4CAF50',
                color: 'white',
              }}
            >
              通常分析モードに戻る
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
