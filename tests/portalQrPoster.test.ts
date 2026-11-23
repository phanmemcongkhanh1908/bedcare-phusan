import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPublicPortalQrUrl,
  formatPortalDisplayUrl,
  isLocalhostOrigin,
  POSTER_TEMPLATES,
  POSTER_THEMES,
  resolvePosterTemplate,
  resolvePosterTheme,
  sanitizePosterConfig,
  type PortalQrPosterConfig,
} from '../src/utils/portalQrPoster';

test('buildPublicPortalQrUrl builds clean root customer portal URL and strips hash', () => {
  const url = buildPublicPortalQrUrl({
    originOrBaseUrl: 'https://bedcare-phusan.onrender.com/#old-section',
  });
  assert.equal(url, 'https://bedcare-phusan.onrender.com/?portal=customer');
});

test('buildPublicPortalQrUrl appends &dept=<id> when departmentId is given and clears it when empty', () => {
  const withDept = buildPublicPortalQrUrl({
    originOrBaseUrl: 'https://bedcare.benhvien.vn/app?portal=staff&dept=old',
    departmentId: 'dept-san-1',
  });
  assert.equal(withDept, 'https://bedcare.benhvien.vn/app?portal=customer&dept=dept-san-1');

  const withoutDept = buildPublicPortalQrUrl({
    originOrBaseUrl: 'https://bedcare.benhvien.vn/?portal=customer&dept=dept-san-1',
    departmentId: '   ',
  });
  assert.equal(withoutDept, 'https://bedcare.benhvien.vn/?portal=customer');
});

test('buildPublicPortalQrUrl rejects empty, malformed, and non-http(s) URLs', () => {
  assert.throws(() => buildPublicPortalQrUrl({ originOrBaseUrl: '   ' }), /nhập địa chỉ/i);
  assert.throws(() => buildPublicPortalQrUrl({ originOrBaseUrl: 'not-a-url' }), /không hợp lệ/i);
  assert.throws(
    () => buildPublicPortalQrUrl({ originOrBaseUrl: 'javascript:alert(1)' }),
    /http:\/\/ hoặc https:\/\//i
  );
});

test('isLocalhostOrigin detects localhost, 127.0.0.1, 0.0.0.0 accurately', () => {
  assert.equal(isLocalhostOrigin('http://localhost:3000/?portal=customer'), true);
  assert.equal(isLocalhostOrigin('http://127.0.0.1:8080'), true);
  assert.equal(isLocalhostOrigin('http://0.0.0.0:3000'), true);
  assert.equal(isLocalhostOrigin('https://bedcare-phusan.onrender.com'), false);
  assert.equal(isLocalhostOrigin('invalid-url'), false);
});

test('formatPortalDisplayUrl strips scheme and trailing root slash cleanly', () => {
  assert.equal(
    formatPortalDisplayUrl('https://bedcare-phusan.onrender.com/?portal=customer'),
    'bedcare-phusan.onrender.com?portal=customer'
  );
  assert.equal(
    formatPortalDisplayUrl('https://hospital.vn/bedcare?portal=customer&dept=d1'),
    'hospital.vn/bedcare?portal=customer&dept=d1'
  );
});

test('resolvePosterTemplate and resolvePosterTheme return matching specs and safe fallbacks', () => {
  for (const tpl of POSTER_TEMPLATES) {
    assert.equal(resolvePosterTemplate(tpl.id).id, tpl.id);
  }
  assert.equal(resolvePosterTemplate('UNKNOWN' as never).id, 'A4_POSTER');

  for (const theme of POSTER_THEMES) {
    assert.equal(resolvePosterTheme(theme.id).id, theme.id);
  }
  assert.equal(resolvePosterTheme('UNKNOWN' as never).id, 'CLINICAL_NAVY');
});

test('sanitizePosterConfig trims fields and supplies Vietnamese defaults when blank', () => {
  const blank: PortalQrPosterConfig = {
    baseUrl: 'https://bedcare.vn',
    departmentId: '',
    departmentName: '',
    hospitalName: '   ',
    headline: '',
    subtitle: '  ',
    hotline: '  1900 1234  ',
    scanCta: '',
    templateId: 'A5_DESK_PAIR',
    themeId: 'MATERNITY_TEAL',
    errorCorrectionLevel: 'H',
    showSteps: true,
  };
  const sanitized = sanitizePosterConfig(blank);
  assert.equal(sanitized.hospitalName, 'BỆNH VIỆN CHUYÊN KHOA PHỤ SẢN');
  assert.equal(sanitized.headline, 'ĐẶT GIƯỜNG BỆNH TRỰC TUYẾN');
  assert.match(sanitized.subtitle, /Xem phòng trống/i);
  assert.equal(sanitized.hotline, '1900 1234');
  assert.match(sanitized.scanCta, /QUÉT MÃ QR/i);
});
