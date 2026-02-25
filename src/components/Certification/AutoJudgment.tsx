// =====================================================
// 自動判定コンポーネント（10級〜3級）
// 作成日: 2026-02-12
// 説明: 自動採点結果の表示とリアルタイム合否判定
// =====================================================

import React from 'react';
import type { ScoringResult, GradeCode } from '../../types/certificationTypes';
import type { AttemptStatus } from '../../types/reviewTypes';

interface AutoJudgmentProps {
  gradeCode: GradeCode;
  scoringResult: ScoringResult | null;
  status: AttemptStatus;
  onApplyCertificate?: () => void;
  onRetry?: () => void;
}

export const AutoJudgment: React.FC<AutoJudgmentProps> = ({
  gradeCode,
  scoringResult,
  status,
  onApplyCertificate,
  onRetry,
}) => {
  if (!scoringResult) {
    return (
      <div style={{ padding: '20px', textAlign: 'center', color: '#64748b' }}>
        <p>採点結果がありません。受検を完了してください。</p>
      </div>
    );
  }

  const isPassed = scoringResult.is_passed;
  const totalScore = scoringResult.total_score;
  const passThreshold = scoringResult.pass_threshold;
  const qualityGrade = scoringResult.quality_grade;

  // 合否バッジ
  const renderPassFailBadge = () => {
    if (status === 'auto_pass') {
      return (
        <div
          style={{
            display: 'inline-block',
            padding: '10px 20px',
            backgroundColor: '#10b981',
            color: 'white',
            borderRadius: '8px',
            fontSize: '1.2rem',
            fontWeight: 'bold',
            marginBottom: '20px',
          }}
        >
          ✓ 合格
        </div>
      );
    }
    if (status === 'auto_fail') {
      return (
        <div
          style={{
            display: 'inline-block',
            padding: '10px 20px',
            backgroundColor: '#ef4444',
            color: 'white',
            borderRadius: '8px',
            fontSize: '1.2rem',
            fontWeight: 'bold',
            marginBottom: '20px',
          }}
        >
          ✗ 不合格
        </div>
      );
    }
    return null;
  };

  // 品質グレード表示
  const renderQualityBadge = () => {
    let bgColor = '#10b981'; // 良
    if (qualityGrade === '可') bgColor = '#f59e0b';
    if (qualityGrade === '参考') bgColor = '#6b7280';

    return (
      <div
        style={{
          display: 'inline-block',
          padding: '4px 12px',
          backgroundColor: bgColor,
          color: 'white',
          borderRadius: '4px',
          fontSize: '0.9rem',
          fontWeight: 'bold',
          marginLeft: '10px',
        }}
      >
        品質: {qualityGrade}
      </div>
    );
  };

  // 項目別得点表示
  const renderItemScores = () => {
    const items = [
      { label: '膝屈曲角度', score: scoringResult.angle_score, maxScore: 30 },
      { label: 'ストライド', score: scoringResult.stride_score, maxScore: 25 },
      { label: '接地時間', score: scoringResult.contact_time_score, maxScore: 20 },
      { label: 'テクニック', score: scoringResult.technique_score, maxScore: 10 },
    ];

    return (
      <div style={{ marginTop: '20px' }}>
        <h3 style={{ fontSize: '1.1rem', fontWeight: 'bold', marginBottom: '10px', color: '#1e293b' }}>
          項目別得点
        </h3>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ backgroundColor: '#f1f5f9', borderBottom: '2px solid #cbd5e1' }}>
              <th style={{ padding: '10px', textAlign: 'left', fontWeight: '600', color: '#475569' }}>項目</th>
              <th style={{ padding: '10px', textAlign: 'right', fontWeight: '600', color: '#475569' }}>得点</th>
              <th style={{ padding: '10px', textAlign: 'right', fontWeight: '600', color: '#475569' }}>配点</th>
              <th style={{ padding: '10px', textAlign: 'right', fontWeight: '600', color: '#475569' }}>達成率</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, idx) => {
              const percentage = item.maxScore > 0 ? ((item.score / item.maxScore) * 100).toFixed(1) : '0.0';
              const isGood = parseFloat(percentage) >= 80;
              return (
                <tr
                  key={idx}
                  style={{
                    borderBottom: '1px solid #e2e8f0',
                    backgroundColor: idx % 2 === 0 ? '#ffffff' : '#f8fafc',
                  }}
                >
                  <td style={{ padding: '10px', color: '#334155' }}>{item.label}</td>
                  <td style={{ padding: '10px', textAlign: 'right', fontWeight: 'bold', color: isGood ? '#10b981' : '#ef4444' }}>
                    {item.score.toFixed(1)}
                  </td>
                  <td style={{ padding: '10px', textAlign: 'right', color: '#64748b' }}>{item.maxScore}</td>
                  <td style={{ padding: '10px', textAlign: 'right', color: isGood ? '#10b981' : '#ef4444' }}>
                    {percentage}%
                  </td>
                </tr>
              );
            })}
            <tr style={{ backgroundColor: '#f1f5f9', fontWeight: 'bold', borderTop: '2px solid #cbd5e1' }}>
              <td style={{ padding: '10px', color: '#1e293b' }}>合計</td>
              <td style={{ padding: '10px', textAlign: 'right', fontSize: '1.2rem', color: isPassed ? '#10b981' : '#ef4444' }}>
                {totalScore.toFixed(1)}
              </td>
              <td style={{ padding: '10px', textAlign: 'right', color: '#475569' }}>100</td>
              <td style={{ padding: '10px', textAlign: 'right', fontSize: '1.1rem', color: isPassed ? '#10b981' : '#ef4444' }}>
                {((totalScore / 100) * 100).toFixed(1)}%
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    );
  };

  // 改善ポイント表示（不合格時）
  const renderImprovementAdvice = () => {
    if (isPassed) return null;

    // 簡易的な改善ポイント（今後、フィードバック機能を実装する際に拡張）
    const improvements: string[] = [];
    
    if (scoringResult.angle_score < 24) { // 30点満点の80%未満
      improvements.push('膝屈曲角度を理想値に近づけましょう');
    }
    if (scoringResult.stride_score < 20) { // 25点満点の80%未満
      improvements.push('ストライド長とピッチのバランスを改善しましょう');
    }
    if (scoringResult.contact_time_score < 16) { // 20点満点の80%未満
      improvements.push('接地時間を短縮し、効率的な走りを目指しましょう');
    }

    if (improvements.length === 0) {
      return null;
    }

    return (
      <div style={{ marginTop: '30px', padding: '20px', backgroundColor: '#fef3c7', borderRadius: '8px', border: '1px solid #fbbf24' }}>
        <h3 style={{ fontSize: '1.1rem', fontWeight: 'bold', marginBottom: '10px', color: '#92400e' }}>
          📋 改善ポイント
        </h3>
        <ul style={{ paddingLeft: '20px', color: '#78350f' }}>
          {improvements.map((improvement, idx) => (
            <li key={idx} style={{ marginBottom: '8px', lineHeight: '1.6' }}>
              {improvement}
            </li>
          ))}
        </ul>
      </div>
    );
  };

  // アクションボタン
  const renderActionButtons = () => {
    if (status === 'auto_pass' && onApplyCertificate) {
      return (
        <div style={{ marginTop: '30px', textAlign: 'center' }}>
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
        </div>
      );
    }

    if (status === 'auto_fail' && onRetry) {
      return (
        <div style={{ marginTop: '30px', textAlign: 'center' }}>
          <button
            onClick={onRetry}
            style={{
              padding: '12px 30px',
              backgroundColor: '#3b82f6',
              color: 'white',
              border: 'none',
              borderRadius: '8px',
              fontSize: '1rem',
              fontWeight: 'bold',
              cursor: 'pointer',
              boxShadow: '0 2px 4px rgba(0, 0, 0, 0.1)',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#2563eb')}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = '#3b82f6')}
          >
            🔄 再受検する
          </button>
        </div>
      );
    }

    return null;
  };

  return (
    <div style={{ padding: '20px', maxWidth: '900px', margin: '0 auto' }}>
      {/* ヘッダー */}
      <div style={{ textAlign: 'center', marginBottom: '30px' }}>
        <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold', color: '#1e293b', marginBottom: '10px' }}>
          {gradeCode} 自動判定結果
        </h2>
        {renderPassFailBadge()}
        {renderQualityBadge()}
      </div>

      {/* 総合得点 */}
      <div
        style={{
          padding: '20px',
          backgroundColor: isPassed ? '#d1fae5' : '#fee2e2',
          borderRadius: '8px',
          border: `2px solid ${isPassed ? '#10b981' : '#ef4444'}`,
          textAlign: 'center',
          marginBottom: '20px',
        }}
      >
        <div style={{ fontSize: '0.9rem', color: '#64748b', marginBottom: '5px' }}>総合得点</div>
        <div style={{ fontSize: '2.5rem', fontWeight: 'bold', color: isPassed ? '#10b981' : '#ef4444' }}>
          {totalScore.toFixed(1)} <span style={{ fontSize: '1.2rem' }}>/ {passThreshold}</span>
        </div>
        <div style={{ fontSize: '0.9rem', color: '#64748b', marginTop: '5px' }}>
          {isPassed ? `合格基準点（${passThreshold}点）を上回りました` : `合格基準点（${passThreshold}点）に達しませんでした`}
        </div>
      </div>

      {/* 項目別得点 */}
      {renderItemScores()}

      {/* 改善ポイント（不合格時） */}
      {renderImprovementAdvice()}

      {/* アクションボタン */}
      {renderActionButtons()}
    </div>
  );
};
