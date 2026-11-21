import {
  ArrowRight,
  BookOpen,
  CheckCircle2,
  Lightbulb,
  Search,
  ShieldCheck,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { ScreenId } from './LayoutShell';
import {
  HELP_ARTICLES,
  HELP_CATEGORIES,
  filterHelpArticles,
  getCategoryCounts,
  type HelpCategoryId,
} from '../utils/helpCenterDocs';

interface HelpCenterProps {
  open: boolean;
  onClose: () => void;
  currentScreen?: ScreenId;
  initialCategory?: HelpCategoryId;
  onNavigate?: (screen: ScreenId) => void;
}

export function HelpCenter({
  open,
  onClose,
  currentScreen,
  initialCategory = 'ALL',
  onNavigate,
}: HelpCenterProps) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<HelpCategoryId>(initialCategory);
  const [selectedId, setSelectedId] = useState<string>(HELP_ARTICLES[0].id);

  useEffect(() => {
    if (!open) return;
    setCategory(initialCategory);
    if (currentScreen) {
      const contextual = HELP_ARTICLES.find((a) => a.relatedScreen === currentScreen);
      if (contextual) {
        setSelectedId(contextual.id);
      }
    }
  }, [open, initialCategory, currentScreen]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const filteredArticles = useMemo(
    () => filterHelpArticles(HELP_ARTICLES, query, category),
    [query, category]
  );

  const categoryCounts = useMemo(() => getCategoryCounts(HELP_ARTICLES, query), [query]);

  useEffect(() => {
    if (filteredArticles.length > 0 && !filteredArticles.some((a) => a.id === selectedId)) {
      setSelectedId(filteredArticles[0].id);
    }
  }, [filteredArticles, selectedId]);

  if (!open) return null;

  const selectedArticle =
    filteredArticles.find((a) => a.id === selectedId) ?? filteredArticles[0] ?? null;

  const categoryLabelMap = Object.fromEntries(HELP_CATEGORIES.map((c) => [c.id, c.label]));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 no-print"
      role="dialog"
      aria-modal="true"
      aria-labelledby="help-center-title"
    >
      <div className="w-full max-w-5xl max-h-[88vh] flex flex-col rounded-xl border border-slate-200 bg-white shadow-xl overflow-hidden">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-4 bg-slate-50/70">
          <div className="flex items-center gap-3 min-w-0">
            <div className="h-9 w-9 rounded-lg bg-sky-100 text-sky-700 flex items-center justify-center shrink-0">
              <BookOpen className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h2 id="help-center-title" className="text-lg font-semibold text-slate-900">
                Trung tâm Hướng dẫn Vận hành BEDCARE
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Tra cứu quy trình tiếp nhận, giữ chỗ, điều chuyển giường, xuất viện, xử lý xung đột và cấu hình danh mục.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Đóng Trung tâm Hướng dẫn"
            className="rounded-md p-1.5 text-slate-400 hover:bg-slate-200/60 hover:text-slate-700 shrink-0"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Search & Categories */}
        <div className="border-b border-slate-200 px-6 py-3.5 space-y-3 bg-white">
          <div className="relative">
            <Search className="h-4 w-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Tìm quy trình (VD: tiếp nhận, điều chuyển, bao phòng, xung đột, xuất viện, giá giường...)"
              aria-label="Tìm kiếm tài liệu hướng dẫn BEDCARE"
              className="w-full rounded-lg border border-slate-300 bg-slate-50 pl-10 pr-20 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-sky-600 focus:bg-white focus:outline-none"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded px-2 py-0.5 text-xs font-medium text-slate-500 hover:bg-slate-200/70 hover:text-slate-800"
              >
                Xóa
              </button>
            )}
          </div>

          <div
            className="flex flex-wrap items-center gap-1.5"
            role="tablist"
            aria-label="Danh mục tài liệu hướng dẫn"
          >
            {HELP_CATEGORIES.map((cat) => {
              const active = category === cat.id;
              const count = categoryCounts[cat.id];
              return (
                <button
                  key={cat.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setCategory(cat.id)}
                  className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap ${
                    active
                      ? 'border-sky-700 bg-sky-700 text-white'
                      : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                  }`}
                >
                  <span>{cat.label}</span>
                  <span
                    className={`font-mono tabular-nums text-[11px] ${
                      active ? 'text-sky-100' : 'text-slate-400'
                    }`}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Body: Two-Pane Browser */}
        <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-12 overflow-hidden">
          {/* Article List */}
          <div className="md:col-span-5 border-b md:border-b-0 md:border-r border-slate-200 overflow-y-auto bg-slate-50/50 divide-y divide-slate-200/70">
            {filteredArticles.length === 0 ? (
              <div className="p-8 text-center space-y-3">
                <p className="text-sm font-medium text-slate-700">
                  Không tìm thấy tài liệu phù hợp với từ khóa &ldquo;{query}&rdquo;.
                </p>
                <p className="text-xs text-slate-500">
                  Thử tìm theo tên màn hình hoặc thao tác như: tiếp nhận, điều chuyển, giữ chỗ, vệ sinh, loại giường.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setQuery('');
                    setCategory('ALL');
                  }}
                  className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  Đặt lại bộ lọc
                </button>
              </div>
            ) : (
              filteredArticles.map((article) => {
                const isSelected = selectedArticle?.id === article.id;
                const isCurrentContext = currentScreen === article.relatedScreen;
                return (
                  <button
                    key={article.id}
                    type="button"
                    onClick={() => setSelectedId(article.id)}
                    className={`w-full text-left px-4 py-3.5 transition-colors ${
                      isSelected
                        ? 'bg-white border-l-4 border-l-sky-700'
                        : 'hover:bg-white/80 border-l-4 border-l-transparent'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-semibold text-sky-700 uppercase tracking-wide">
                        {categoryLabelMap[article.category]}
                      </span>
                      {isCurrentContext && (
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
                          Màn hình hiện tại
                        </span>
                      )}
                    </div>
                    <div className="text-sm font-semibold text-slate-900 mt-1">
                      {article.title}
                    </div>
                    <p className="text-xs text-slate-500 mt-1 line-clamp-2 leading-relaxed">
                      {article.summary}
                    </p>
                  </button>
                );
              })
            )}
          </div>

          {/* Selected Article Detail */}
          <div className="md:col-span-7 overflow-y-auto p-6 bg-white">
            {selectedArticle ? (
              <article className="space-y-5">
                <div className="space-y-2 border-b border-slate-100 pb-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="inline-flex items-center rounded border border-sky-200 bg-sky-50 px-2 py-0.5 text-xs font-semibold text-sky-800">
                      {categoryLabelMap[selectedArticle.category]}
                    </span>
                    {onNavigate && (
                      <button
                        type="button"
                        onClick={() => {
                          onNavigate(selectedArticle.relatedScreen);
                          onClose();
                        }}
                        className="inline-flex items-center gap-1.5 rounded-md bg-sky-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-800 whitespace-nowrap"
                      >
                        <span>Mở {selectedArticle.relatedScreenLabel}</span>
                        <ArrowRight className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  <h3 className="text-lg font-bold text-slate-900 leading-snug">
                    {selectedArticle.title}
                  </h3>
                  <p className="text-sm text-slate-600 leading-relaxed">
                    {selectedArticle.summary}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="inline-flex items-center gap-1 font-semibold text-slate-700">
                    <ShieldCheck className="h-3.5 w-3.5 text-slate-500" />
                    Vai trò áp dụng:
                  </span>
                  {selectedArticle.roles.map((r) => (
                    <span
                      key={r}
                      className="rounded border border-slate-200 bg-slate-50 px-2 py-0.5 text-slate-700"
                    >
                      {r}
                    </span>
                  ))}
                </div>

                <div className="space-y-2.5">
                  <h4 className="text-sm font-semibold text-slate-900">
                    Các bước thực hiện chuẩn
                  </h4>
                  <ol className="space-y-2.5">
                    {selectedArticle.steps.map((step, idx) => (
                      <li
                        key={step}
                        className="flex items-start gap-3 rounded-lg border border-slate-100 bg-slate-50/70 p-3 text-sm text-slate-700 leading-relaxed"
                      >
                        <span className="h-6 w-6 rounded-full bg-sky-700 text-white text-xs font-bold font-mono flex items-center justify-center shrink-0 mt-0.5">
                          {idx + 1}
                        </span>
                        <span>{step}</span>
                      </li>
                    ))}
                  </ol>
                </div>

                {selectedArticle.tips.length > 0 && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-4 space-y-2">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-900">
                      <Lightbulb className="h-4 w-4 text-amber-600" />
                      <span>Lưu ý vận hành &amp; kiểm soát an toàn</span>
                    </div>
                    <ul className="space-y-1.5">
                      {selectedArticle.tips.map((tip) => (
                        <li
                          key={tip}
                          className="flex items-start gap-2 text-xs text-amber-900 leading-relaxed"
                        >
                          <CheckCircle2 className="h-3.5 w-3.5 text-amber-700 shrink-0 mt-0.5" />
                          <span>{tip}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </article>
            ) : (
              <div className="h-full flex items-center justify-center text-sm text-slate-400">
                Chọn một tài liệu ở danh sách bên trái để xem chi tiết hướng dẫn.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
