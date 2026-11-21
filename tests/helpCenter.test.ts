import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HELP_ARTICLES,
  HELP_CATEGORIES,
  filterHelpArticles,
  getCategoryCounts,
  normalizeSearchText,
} from '../src/utils/helpCenterDocs';

test('normalizeSearchText strips Vietnamese diacritics and normalizes case', () => {
  assert.equal(normalizeSearchText('  Điều Chuyển Giường '), 'dieu chuyen giuong');
  assert.equal(normalizeSearchText('Tiếp nhận ĐỒNG THUẬN'), 'tiep nhan dong thuan');
});

test('filterHelpArticles finds articles by Vietnamese, diacritic-less, and English workflow keywords', () => {
  const byEnAdmission = filterHelpArticles(HELP_ARTICLES, 'admissions', 'ALL');
  assert.ok(byEnAdmission.some((a) => a.id === 'help-admissions'));

  const byViNoAccent = filterHelpArticles(HELP_ARTICLES, 'dieu chuyen', 'ALL');
  assert.ok(byViNoAccent.some((a) => a.id === 'help-transfers'));

  const byCategoryOnly = filterHelpArticles(HELP_ARTICLES, '', 'CATALOG_ADMIN');
  assert.equal(byCategoryOnly.length, 1);
  assert.equal(byCategoryOnly[0].id, 'help-admin-catalog');

  const noMatches = filterHelpArticles(HELP_ARTICLES, 'xyznonexistentworkflow123', 'ALL');
  assert.equal(noMatches.length, 0);
});

test('getCategoryCounts computes matching article counts per category', () => {
  const allCounts = getCategoryCounts(HELP_ARTICLES, '');
  assert.equal(allCounts.ALL, HELP_ARTICLES.length);

  const transferCounts = getCategoryCounts(HELP_ARTICLES, 'transfer');
  assert.ok(transferCounts.ADMISSIONS_TRANSFERS >= 1);
  assert.equal(
    transferCounts.ALL,
    transferCounts.BED_COORDINATION +
      transferCounts.ADMISSIONS_TRANSFERS +
      transferCounts.DISCHARGE_CLEANING +
      transferCounts.CATALOG_ADMIN +
      transferCounts.P2P_CONSENSUS
  );
});

test('every HelpCenter article defines valid category, actionable steps, and target screen', () => {
  const validCategories = new Set(HELP_CATEGORIES.map((c) => c.id));
  for (const article of HELP_ARTICLES) {
    assert.ok(validCategories.has(article.category));
    assert.ok(article.title.trim().length > 0);
    assert.ok(article.steps.length >= 3, `Expected >= 3 steps for ${article.id}`);
    assert.ok(article.relatedScreen.trim().length > 0);
    assert.ok(article.relatedScreenLabel.trim().length > 0);
  }
});
