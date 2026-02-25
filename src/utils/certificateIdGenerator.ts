// =====================================================
// 合格証申請ID生成ユーティリティ
// 作成日: 2026-02-12
// 説明: 申請IDを生成（例: JRPO-2026-001234）
// =====================================================

/**
 * 申請IDを生成（クライアント側での仮ID生成）
 * 実際のIDはサーバー側で採番されます
 * 
 * @returns 仮申請ID（例: JRPO-2026-XXXXXX）
 */
export function generateTempApplicationId(): string {
  const year = new Date().getFullYear();
  const random = Math.floor(Math.random() * 1000000).toString().padStart(6, '0');
  return `JRPO-${year}-${random}`;
}

/**
 * 証明書番号を生成（サーバー側で生成されるべき）
 * 
 * @param gradeCode 級コード（例: "1級"）
 * @param applicationId 申請ID
 * @returns 証明書番号（例: CERT-1KYU-2026-001234）
 */
export function generateCertificateNumber(gradeCode: string, applicationId: string): string {
  const gradeEn = gradeCode.replace('級', 'KYU');
  const seq = applicationId.split('-').pop() || '000000';
  const year = new Date().getFullYear();
  return `CERT-${gradeEn}-${year}-${seq}`;
}

/**
 * 申請ID形式の検証
 * 
 * @param applicationId 申請ID
 * @returns 有効かどうか
 */
export function validateApplicationId(applicationId: string): boolean {
  const pattern = /^JRPO-\d{4}-\d{6}$/;
  return pattern.test(applicationId);
}

/**
 * 証明書番号形式の検証
 * 
 * @param certificateNumber 証明書番号
 * @returns 有効かどうか
 */
export function validateCertificateNumber(certificateNumber: string): boolean {
  const pattern = /^CERT-\d+KYU-\d{4}-\d{6}$/;
  return pattern.test(certificateNumber);
}
