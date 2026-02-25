// =====================================================
// 合格証申請コンポーネント
// 作成日: 2026-02-12
// 説明: 合格者が合格証を申請するフォーム
// =====================================================

import React, { useState } from 'react';
import type { GradeCode } from '../../types/certificationTypes';
import type { CertificateApplicationInput } from '../../types/reviewTypes';

interface CertificateApplicationProps {
  attemptId: string;
  gradeCode: GradeCode;
  onSubmit: (application: CertificateApplicationInput) => Promise<void>;
  onCancel: () => void;
}

export const CertificateApplication: React.FC<CertificateApplicationProps> = ({
  attemptId,
  gradeCode,
  onSubmit,
  onCancel,
}) => {
  const [formData, setFormData] = useState<CertificateApplicationInput>({
    attempt_id: attemptId,
    full_name: '',
    display_name: '',
    birth_date: '',
    affiliation: '',
    email: '',
    phone: '',
    postal_code: '',
    address: '',
    grade_code: gradeCode,
  });

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (!formData.full_name.trim()) {
      newErrors.full_name = '氏名は必須です';
    }
    if (!formData.display_name.trim()) {
      newErrors.display_name = '表記名は必須です';
    }
    if (!formData.birth_date) {
      newErrors.birth_date = '生年月日は必須です';
    }
    if (!formData.email.trim()) {
      newErrors.email = 'メールアドレスは必須です';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      newErrors.email = 'メールアドレスの形式が正しくありません';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!validate()) return;

    setIsSubmitting(true);
    try {
      await onSubmit(formData);
    } catch (error) {
      console.error('申請エラー:', error);
      setErrors({ submit: '申請に失敗しました。もう一度お試しください。' });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleChange = (field: keyof CertificateApplicationInput, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    if (errors[field]) {
      setErrors((prev) => ({ ...prev, [field]: '' }));
    }
  };

  return (
    <div style={{ padding: '20px', maxWidth: '700px', margin: '0 auto', backgroundColor: '#ffffff', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
      <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold', color: '#1e293b', marginBottom: '10px', textAlign: 'center' }}>
        🎓 合格証申請
      </h2>
      <p style={{ fontSize: '0.9rem', color: '#64748b', marginBottom: '30px', textAlign: 'center' }}>
        {gradeCode}の合格証を申請します。必要事項を入力してください。
      </p>

      {errors.submit && (
        <div style={{ padding: '10px', backgroundColor: '#fee2e2', borderRadius: '6px', border: '1px solid #ef4444', marginBottom: '20px' }}>
          <div style={{ color: '#dc2626', fontSize: '0.9rem' }}>⚠️ {errors.submit}</div>
        </div>
      )}

      <form onSubmit={handleSubmit}>
        {/* 氏名 */}
        <div style={{ marginBottom: '20px' }}>
          <label style={{ display: 'block', fontSize: '0.9rem', fontWeight: '600', color: '#475569', marginBottom: '8px' }}>
            氏名（本名） *
          </label>
          <input
            type="text"
            value={formData.full_name}
            onChange={(e) => handleChange('full_name', e.target.value)}
            placeholder="山田 太郎"
            style={{
              width: '100%',
              padding: '10px',
              border: `1px solid ${errors.full_name ? '#ef4444' : '#cbd5e1'}`,
              borderRadius: '6px',
              fontSize: '0.95rem',
            }}
          />
          {errors.full_name && <div style={{ color: '#ef4444', fontSize: '0.8rem', marginTop: '4px' }}>{errors.full_name}</div>}
        </div>

        {/* 表記名 */}
        <div style={{ marginBottom: '20px' }}>
          <label style={{ display: 'block', fontSize: '0.9rem', fontWeight: '600', color: '#475569', marginBottom: '8px' }}>
            表記名（証明書に印字される名前） *
          </label>
          <input
            type="text"
            value={formData.display_name}
            onChange={(e) => handleChange('display_name', e.target.value)}
            placeholder="Yamada Taro"
            style={{
              width: '100%',
              padding: '10px',
              border: `1px solid ${errors.display_name ? '#ef4444' : '#cbd5e1'}`,
              borderRadius: '6px',
              fontSize: '0.95rem',
            }}
          />
          {errors.display_name && <div style={{ color: '#ef4444', fontSize: '0.8rem', marginTop: '4px' }}>{errors.display_name}</div>}
        </div>

        {/* 生年月日 */}
        <div style={{ marginBottom: '20px' }}>
          <label style={{ display: 'block', fontSize: '0.9rem', fontWeight: '600', color: '#475569', marginBottom: '8px' }}>
            生年月日 *
          </label>
          <input
            type="date"
            value={formData.birth_date}
            onChange={(e) => handleChange('birth_date', e.target.value)}
            style={{
              width: '100%',
              padding: '10px',
              border: `1px solid ${errors.birth_date ? '#ef4444' : '#cbd5e1'}`,
              borderRadius: '6px',
              fontSize: '0.95rem',
            }}
          />
          {errors.birth_date && <div style={{ color: '#ef4444', fontSize: '0.8rem', marginTop: '4px' }}>{errors.birth_date}</div>}
        </div>

        {/* 所属 */}
        <div style={{ marginBottom: '20px' }}>
          <label style={{ display: 'block', fontSize: '0.9rem', fontWeight: '600', color: '#475569', marginBottom: '8px' }}>
            所属（任意）
          </label>
          <input
            type="text"
            value={formData.affiliation || ''}
            onChange={(e) => handleChange('affiliation', e.target.value)}
            placeholder="〇〇大学 陸上部"
            style={{
              width: '100%',
              padding: '10px',
              border: '1px solid #cbd5e1',
              borderRadius: '6px',
              fontSize: '0.95rem',
            }}
          />
        </div>

        {/* メールアドレス */}
        <div style={{ marginBottom: '20px' }}>
          <label style={{ display: 'block', fontSize: '0.9rem', fontWeight: '600', color: '#475569', marginBottom: '8px' }}>
            メールアドレス *
          </label>
          <input
            type="email"
            value={formData.email}
            onChange={(e) => handleChange('email', e.target.value)}
            placeholder="example@example.com"
            style={{
              width: '100%',
              padding: '10px',
              border: `1px solid ${errors.email ? '#ef4444' : '#cbd5e1'}`,
              borderRadius: '6px',
              fontSize: '0.95rem',
            }}
          />
          {errors.email && <div style={{ color: '#ef4444', fontSize: '0.8rem', marginTop: '4px' }}>{errors.email}</div>}
        </div>

        {/* 電話番号 */}
        <div style={{ marginBottom: '20px' }}>
          <label style={{ display: 'block', fontSize: '0.9rem', fontWeight: '600', color: '#475569', marginBottom: '8px' }}>
            電話番号（任意）
          </label>
          <input
            type="tel"
            value={formData.phone || ''}
            onChange={(e) => handleChange('phone', e.target.value)}
            placeholder="090-1234-5678"
            style={{
              width: '100%',
              padding: '10px',
              border: '1px solid #cbd5e1',
              borderRadius: '6px',
              fontSize: '0.95rem',
            }}
          />
        </div>

        {/* ボタン */}
        <div style={{ display: 'flex', gap: '10px', marginTop: '30px' }}>
          <button
            type="button"
            onClick={onCancel}
            disabled={isSubmitting}
            style={{
              flex: 1,
              padding: '12px',
              backgroundColor: '#e2e8f0',
              color: '#475569',
              border: 'none',
              borderRadius: '8px',
              fontSize: '1rem',
              fontWeight: 'bold',
              cursor: isSubmitting ? 'not-allowed' : 'pointer',
            }}
          >
            キャンセル
          </button>
          <button
            type="submit"
            disabled={isSubmitting}
            style={{
              flex: 2,
              padding: '12px',
              backgroundColor: isSubmitting ? '#94a3b8' : '#10b981',
              color: 'white',
              border: 'none',
              borderRadius: '8px',
              fontSize: '1rem',
              fontWeight: 'bold',
              cursor: isSubmitting ? 'not-allowed' : 'pointer',
              boxShadow: '0 2px 4px rgba(0, 0, 0, 0.1)',
            }}
          >
            {isSubmitting ? '申請中...' : '📮 申請する'}
          </button>
        </div>
      </form>
    </div>
  );
};
