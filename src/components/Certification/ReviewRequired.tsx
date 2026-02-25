// =====================================================
// 審査必須コンポーネント（2級・1級）
// 作成日: 2026-02-12
// 説明: 動画提出と審査待ち状態の表示
// =====================================================

import React, { useState } from 'react';
import type { ScoringResult, GradeCode } from '../../types/certificationTypes';
import type { AttemptStatus } from '../../types/reviewTypes';
import { validateVideoSubmission } from '../../utils/gradeRouter';

interface ReviewRequiredProps {
  gradeCode: GradeCode;
  scoringResult: ScoringResult | null;
  status: AttemptStatus;
  fixedVideoUrl?: string | null;
  panningVideoUrl?: string | null;
  onSubmitForReview?: (fixedVideoUrl: string, panningVideoUrl: string) => Promise<void>;
  onApplyCertificate?: () => void;
}

export const ReviewRequired: React.FC<ReviewRequiredProps> = ({
  gradeCode,
  scoringResult,
  status,
  fixedVideoUrl: initialFixedVideoUrl,
  panningVideoUrl: initialPanningVideoUrl,
  onSubmitForReview,
  onApplyCertificate,
}) => {
  const [fixedVideoUrl, setFixedVideoUrl] = useState(initialFixedVideoUrl || '');
  const [panningVideoUrl, setPanningVideoUrl] = useState(initialPanningVideoUrl || '');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  const handleSubmit = async () => {
    const validation = validateVideoSubmission(fixedVideoUrl, panningVideoUrl);
    if (!validation.valid) {
      setErrors(validation.errors);
      return;
    }

    setErrors([]);
    setIsSubmitting(true);

    try {
      if (onSubmitForReview) {
        await onSubmitForReview(fixedVideoUrl, panningVideoUrl);
      }
    } catch (error) {
      console.error('提出エラー:', error);
      setErrors(['提出に失敗しました。もう一度お試しください。']);
    } finally {
      setIsSubmitting(false);
    }
  };

  // ステータスバッジ
  const renderStatusBadge = () => {
    let bgColor = '#64748b';
    let label = '未提出';

    if (status === 'submitted' || status === 'under_review') {
      bgColor = '#f59e0b';
      label = '審査待ち';
    } else if (status === 'certified_pass') {
      bgColor = '#10b981';
      label = '認定合格';
    } else if (status === 'certified_fail') {
      bgColor = '#ef4444';
      label = '認定不合格';
    } else if (status === 'needs_resubmission') {
      bgColor = '#f97316';
      label = '再提出要求';
    }

    return (
      <div
        style={{
          display: 'inline-block',
          padding: '6px 16px',
          backgroundColor: bgColor,
          color: 'white',
          borderRadius: '6px',
          fontSize: '0.95rem',
          fontWeight: 'bold',
          marginBottom: '20px',
        }}
      >
        {label}
      </div>
    );
  };

  // 自動採点結果（参考値）
  const renderReferenceScores = () => {
    if (!scoringResult) return null;

    const totalScore = scoringResult.total_score;
    const qualityGrade = scoringResult.quality_grade;

    return (
      <div style={{ marginTop: '20px', padding: '20px', backgroundColor: '#f8fafc', borderRadius: '8px', border: '1px solid #cbd5e1' }}>
        <h3 style={{ fontSize: '1.1rem', fontWeight: 'bold', marginBottom: '10px', color: '#475569' }}>
          📊 自動採点結果（参考値）
        </h3>
        <p style={{ fontSize: '0.9rem', color: '#64748b', marginBottom: '15px' }}>
          以下は自動採点による参考値です。最終判定は検定員が動画を確認して行います。
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '10px', marginBottom: '15px' }}>
          <div style={{ padding: '10px', backgroundColor: '#ffffff', borderRadius: '6px', border: '1px solid #e2e8f0', textAlign: 'center' }}>
            <div style={{ fontSize: '0.8rem', color: '#64748b', marginBottom: '5px' }}>角度</div>
            <div style={{ fontSize: '1.2rem', fontWeight: 'bold', color: '#3b82f6' }}>
              {scoringResult.angle_score?.toFixed(1) || '0.0'}
            </div>
          </div>
          <div style={{ padding: '10px', backgroundColor: '#ffffff', borderRadius: '6px', border: '1px solid #e2e8f0', textAlign: 'center' }}>
            <div style={{ fontSize: '0.8rem', color: '#64748b', marginBottom: '5px' }}>ストライド</div>
            <div style={{ fontSize: '1.2rem', fontWeight: 'bold', color: '#3b82f6' }}>
              {scoringResult.stride_score?.toFixed(1) || '0.0'}
            </div>
          </div>
          <div style={{ padding: '10px', backgroundColor: '#ffffff', borderRadius: '6px', border: '1px solid #e2e8f0', textAlign: 'center' }}>
            <div style={{ fontSize: '0.8rem', color: '#64748b', marginBottom: '5px' }}>接地時間</div>
            <div style={{ fontSize: '1.2rem', fontWeight: 'bold', color: '#3b82f6' }}>
              {scoringResult.contact_time_score?.toFixed(1) || '0.0'}
            </div>
          </div>
          <div style={{ padding: '10px', backgroundColor: '#ffffff', borderRadius: '6px', border: '1px solid #e2e8f0', textAlign: 'center' }}>
            <div style={{ fontSize: '0.8rem', color: '#64748b', marginBottom: '5px' }}>H-FVP</div>
            <div style={{ fontSize: '1.2rem', fontWeight: 'bold', color: '#3b82f6' }}>
              {scoringResult.hfvp_score?.toFixed(1) || 'N/A'}
            </div>
          </div>
        </div>

        <div style={{ padding: '15px', backgroundColor: '#ffffff', borderRadius: '6px', border: '1px solid #e2e8f0' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '0.9rem', color: '#475569' }}>総合得点（参考）</span>
            <span style={{ fontSize: '1.5rem', fontWeight: 'bold', color: '#1e293b' }}>
              {totalScore.toFixed(1)} <span style={{ fontSize: '0.9rem', fontWeight: 'normal', color: '#64748b' }}>/ 100</span>
            </span>
          </div>
          <div style={{ marginTop: '10px', fontSize: '0.85rem', color: '#64748b' }}>
            品質グレード: <span style={{ fontWeight: 'bold', color: qualityGrade === '良' ? '#10b981' : qualityGrade === '可' ? '#f59e0b' : '#6b7280' }}>{qualityGrade}</span>
          </div>
        </div>
      </div>
    );
  };

  // 動画提出フォーム（draft または needs_resubmission 時）
  const renderVideoSubmissionForm = () => {
    if (status !== 'draft' && status !== 'needs_resubmission') return null;

    return (
      <div style={{ marginTop: '30px', padding: '20px', backgroundColor: '#ffffff', borderRadius: '8px', border: '2px solid #3b82f6' }}>
        <h3 style={{ fontSize: '1.2rem', fontWeight: 'bold', marginBottom: '15px', color: '#1e293b' }}>
          📹 動画提出（必須）
        </h3>
        <p style={{ fontSize: '0.9rem', color: '#64748b', marginBottom: '20px' }}>
          {gradeCode}の審査には、固定カメラ動画とパンカメラ動画の両方が必要です。
        </p>

        {errors.length > 0 && (
          <div style={{ padding: '10px', backgroundColor: '#fee2e2', borderRadius: '6px', border: '1px solid #ef4444', marginBottom: '20px' }}>
            {errors.map((error, idx) => (
              <div key={idx} style={{ color: '#dc2626', fontSize: '0.9rem' }}>
                ⚠️ {error}
              </div>
            ))}
          </div>
        )}

        <div style={{ marginBottom: '20px' }}>
          <label style={{ display: 'block', fontSize: '0.9rem', fontWeight: '600', color: '#475569', marginBottom: '8px' }}>
            固定カメラ動画URL *
          </label>
          <input
            type="text"
            value={fixedVideoUrl}
            onChange={(e) => setFixedVideoUrl(e.target.value)}
            placeholder="https://..."
            style={{
              width: '100%',
              padding: '10px',
              border: '1px solid #cbd5e1',
              borderRadius: '6px',
              fontSize: '0.95rem',
            }}
          />
        </div>

        <div style={{ marginBottom: '20px' }}>
          <label style={{ display: 'block', fontSize: '0.9rem', fontWeight: '600', color: '#475569', marginBottom: '8px' }}>
            パンカメラ動画URL *
          </label>
          <input
            type="text"
            value={panningVideoUrl}
            onChange={(e) => setPanningVideoUrl(e.target.value)}
            placeholder="https://..."
            style={{
              width: '100%',
              padding: '10px',
              border: '1px solid #cbd5e1',
              borderRadius: '6px',
              fontSize: '0.95rem',
            }}
          />
        </div>

        <button
          onClick={handleSubmit}
          disabled={isSubmitting}
          style={{
            padding: '12px 30px',
            backgroundColor: isSubmitting ? '#94a3b8' : '#3b82f6',
            color: 'white',
            border: 'none',
            borderRadius: '8px',
            fontSize: '1rem',
            fontWeight: 'bold',
            cursor: isSubmitting ? 'not-allowed' : 'pointer',
            boxShadow: '0 2px 4px rgba(0, 0, 0, 0.1)',
          }}
        >
          {isSubmitting ? '提出中...' : '🚀 審査に提出する'}
        </button>
      </div>
    );
  };

  // 審査待ち表示（submitted または under_review 時）
  const renderUnderReview = () => {
    if (status !== 'submitted' && status !== 'under_review') return null;

    return (
      <div style={{ marginTop: '30px', padding: '30px', backgroundColor: '#fef3c7', borderRadius: '8px', border: '2px solid #fbbf24', textAlign: 'center' }}>
        <div style={{ fontSize: '3rem', marginBottom: '15px' }}>⏳</div>
        <h3 style={{ fontSize: '1.3rem', fontWeight: 'bold', marginBottom: '10px', color: '#92400e' }}>
          審査待ち
        </h3>
        <p style={{ fontSize: '1rem', color: '#78350f', marginBottom: '20px' }}>
          検定員による動画確認と最終判定をお待ちください。
        </p>
        <div style={{ fontSize: '0.9rem', color: '#a16207', lineHeight: '1.6' }}>
          <p>提出動画:</p>
          <ul style={{ listStyle: 'none', padding: 0, marginTop: '10px' }}>
            <li>✓ 固定カメラ動画: 提出済み</li>
            <li>✓ パンカメラ動画: 提出済み</li>
          </ul>
        </div>
      </div>
    );
  };

  // 認定結果表示（certified_pass または certified_fail 時）
  const renderCertifiedResult = () => {
    if (status !== 'certified_pass' && status !== 'certified_fail') return null;

    const isPassed = status === 'certified_pass';

    return (
      <div
        style={{
          marginTop: '30px',
          padding: '30px',
          backgroundColor: isPassed ? '#d1fae5' : '#fee2e2',
          borderRadius: '8px',
          border: `2px solid ${isPassed ? '#10b981' : '#ef4444'}`,
          textAlign: 'center',
        }}
      >
        <div style={{ fontSize: '3rem', marginBottom: '15px' }}>{isPassed ? '🎉' : '😔'}</div>
        <h3 style={{ fontSize: '1.5rem', fontWeight: 'bold', marginBottom: '10px', color: isPassed ? '#065f46' : '#991b1b' }}>
          {isPassed ? '認定合格' : '認定不合格'}
        </h3>
        <p style={{ fontSize: '1rem', color: isPassed ? '#047857' : '#dc2626', marginBottom: '20px' }}>
          {isPassed
            ? '検定員による審査の結果、合格と認定されました。おめでとうございます！'
            : '検定員による審査の結果、今回は不合格となりました。'}
        </p>

        {isPassed && onApplyCertificate && (
          <button
            onClick={onApplyCertificate}
            style={{
              padding: '12px 30px',
              backgroundColor: '#10b981',
              color: 'white',
              border: 'none',
              borderRadius: '8px',
              fontSize: '1rem',
              fontWeight: 'bold',
              cursor: 'pointer',
              boxShadow: '0 2px 4px rgba(0, 0, 0, 0.1)',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#059669')}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = '#10b981')}
          >
            🎓 合格証を申請する
          </button>
        )}
      </div>
    );
  };

  return (
    <div style={{ padding: '20px', maxWidth: '900px', margin: '0 auto' }}>
      {/* ヘッダー */}
      <div style={{ textAlign: 'center', marginBottom: '30px' }}>
        <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold', color: '#1e293b', marginBottom: '10px' }}>
          {gradeCode} 検定員審査
        </h2>
        {renderStatusBadge()}
      </div>

      {/* 自動採点結果（参考値） */}
      {renderReferenceScores()}

      {/* 動画提出フォーム */}
      {renderVideoSubmissionForm()}

      {/* 審査待ち表示 */}
      {renderUnderReview()}

      {/* 認定結果表示 */}
      {renderCertifiedResult()}
    </div>
  );
};
