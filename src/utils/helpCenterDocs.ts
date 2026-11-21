import type { ScreenId } from '../components/LayoutShell';

export type HelpCategoryId =
  | 'ALL'
  | 'BED_COORDINATION'
  | 'ADMISSIONS_TRANSFERS'
  | 'DISCHARGE_CLEANING'
  | 'CATALOG_ADMIN'
  | 'P2P_CONSENSUS';

export interface HelpCategoryMeta {
  id: HelpCategoryId;
  label: string;
}

export interface HelpArticle {
  id: string;
  category: Exclude<HelpCategoryId, 'ALL'>;
  title: string;
  summary: string;
  keywords: string[];
  roles: string[];
  relatedScreen: ScreenId;
  relatedScreenLabel: string;
  steps: string[];
  tips: string[];
}

export const HELP_CATEGORIES: HelpCategoryMeta[] = [
  { id: 'ALL', label: 'Tất cả' },
  { id: 'BED_COORDINATION', label: 'Điều phối Giường' },
  { id: 'ADMISSIONS_TRANSFERS', label: 'Tiếp nhận & Điều chuyển' },
  { id: 'DISCHARGE_CLEANING', label: 'Xuất viện & Vệ sinh' },
  { id: 'CATALOG_ADMIN', label: 'Danh mục Quản trị' },
  { id: 'P2P_CONSENSUS', label: 'Đồng thuận P2P & Phân quyền' },
];

export const HELP_ARTICLES: HelpArticle[] = [
  {
    id: 'help-admissions',
    category: 'ADMISSIONS_TRANSFERS',
    title: 'Tiếp nhận bệnh nhân & Cấp giường chính thức (Admissions)',
    summary:
      'Hướng dẫn xác nhận tiếp nhận từ hồ sơ đăng ký trước hoặc nhập trực tiếp tại khoa nội trú, cấp giường đơn hoặc khóa bao trọn phòng qua đồng thuận P2P.',
    keywords: [
      'admission',
      'admissions',
      'tiếp nhận',
      'nhập khoa',
      'cấp giường',
      'bao phòng',
      'đăng ký trước',
    ],
    roles: ['Nhân viên khoa nội trú', 'Admin hệ thống', 'Super Admin'],
    relatedScreen: 'admissions',
    relatedScreenLabel: 'Tiếp nhận',
    steps: [
      'Mở mục Theo dõi Bệnh nhân → Tiếp nhận trên thanh điều hướng bên trái.',
      'Chọn một hồ sơ đăng ký trước ở danh sách bên trái (nếu bệnh nhân đã đăng ký/giữ chỗ tại quầy Thu viện phí) để tự động điền thông tin, hoặc nhập trực tiếp mã bệnh nhân, họ tên và nhóm chẩn đoán.',
      'Chọn Khoa nội trú, Phòng và Giường khả dụng (chỉ giường Trống hoặc giường Đang giữ chỗ đúng của hồ sơ mới được chọn).',
      'Đánh dấu tùy chọn "Khóa bao trọn phòng này" nếu bệnh nhân sử dụng toàn bộ phòng riêng; hệ thống sẽ tự động khóa các giường phụ cùng phòng.',
      'Kiểm tra hoặc điều chỉnh Ngày dự kiến trả giường rồi nhấn "Xác nhận tiếp nhận & Cấp giường" để máy trạm ghi nhận qua Raft Quorum.',
    ],
    tips: [
      'Nhân viên khoa nội trú chỉ được phép tiếp nhận bệnh nhân vào đúng khoa được phân quyền.',
      'Nếu mạng P2P bị phân vùng không đủ quorum, hồ sơ sẽ tạm lưu ở trạng thái Chờ xác nhận và tự đối chiếu khi đồng bộ lại.',
    ],
  },
  {
    id: 'help-transfers',
    category: 'ADMISSIONS_TRANSFERS',
    title: 'Điều chuyển giường bệnh giữa các phòng / khoa (Transfers)',
    summary:
      'Quy trình chuyển bệnh nhân đang nằm sang giường mới cùng khoa hoặc khác khoa, tự động giải phóng giường cũ sang Chờ vệ sinh và gỡ khóa bao phòng.',
    keywords: [
      'transfer',
      'transfers',
      'điều chuyển',
      'chuyển giường',
      'chuyển khoa',
      'đổi phòng',
    ],
    roles: ['Nhân viên khoa nội trú', 'Admin hệ thống', 'Super Admin'],
    relatedScreen: 'transfers',
    relatedScreenLabel: 'Điều chuyển giường',
    steps: [
      'Mở mục Theo dõi Bệnh nhân → Điều chuyển giường.',
      'Chọn bệnh nhân đang nằm cần chuyển giường từ danh sách "Lượt nằm hiện tại".',
      'Chọn Khoa đích, Phòng đích và Giường trống đích (hệ thống chỉ liệt kê các giường đang ở trạng thái Trống sẵn sàng).',
      'Nhập lý do điều chuyển rõ ràng (ví dụ: chuyển phòng dịch vụ, cách ly, hoặc phối hợp theo dõi chuyên khoa).',
      'Nhấn "Xác nhận điều chuyển giường". Giường cũ tự động chuyển sang trạng thái Chờ vệ sinh và nếu phòng cũ đang bao trọn sẽ được giải phóng ngay.',
    ],
    tips: [
      'Mọi giao dịch điều chuyển đều được ghi vào Lịch sử giường (Bed History) và nhật ký bất biến để phục vụ bàn giao ca.',
      'Chờ nhân viên vệ sinh hoàn tất khử khuẩn giường cũ trước khi tiếp nhận bệnh nhân mới vào giường đó.',
    ],
  },
  {
    id: 'help-reservations-locks',
    category: 'ADMISSIONS_TRANSFERS',
    title: 'Giữ chỗ giường, Bao trọn phòng & Quy tắc khóa phòng Đang sử dụng',
    summary:
      'Cách giữ chỗ 1 giường hoặc bao trọn cả phòng tại quầy thu viện phí/khoa, cùng quy tắc validation chặn giữ chỗ khi phòng đã có giường chiếm dụng.',
    keywords: [
      'reservation',
      'giữ chỗ',
      'bao trọn phòng',
      'exclusive',
      'chặn giữ chỗ',
      'đăng ký trước',
    ],
    roles: ['Nhân viên thu viện phí', 'Nhân viên khoa nội trú', 'Admin hệ thống'],
    relatedScreen: 'reservations',
    relatedScreenLabel: 'Giữ chỗ giường/phòng',
    steps: [
      'Mở Theo dõi Bệnh nhân → Đăng ký trước (để tạo hồ sơ + giữ chỗ) hoặc Giữ chỗ giường/phòng.',
      'Chọn hình thức "Giữ 1 giường cụ thể" hoặc "Bao trọn toàn bộ phòng" (chỉ áp dụng khi toàn bộ giường trong phòng đang Trống).',
      'Lưu ý quy tắc validation: nếu phòng đã có ít nhất 1 giường ở trạng thái Đã chiếm dụng (Đang sử dụng), trạng thái phòng tự động chuyển sang "Phòng đang sử dụng" và thao tác giữ chỗ giường khác trong phòng đó sẽ bị chặn để tránh xung đột.',
      'Khi bệnh nhân nhập khoa không sử dụng chỗ giữ nữa, nhấn "Hủy giữ chỗ" hoặc "+6 giờ" gia hạn hạn giữ.',
    ],
    tips: [
      'Với phòng bao trọn (như phòng VIP B201), các giường phụ sẽ hiển thị "Khóa bao phòng · <Tên bệnh nhân>" thay vì trạng thái sẵn sàng phục vụ.',
    ],
  },
  {
    id: 'help-bed-map-conflicts',
    category: 'BED_COORDINATION',
    title: 'Sơ đồ giường, Cảnh báo Xung đột trạng thái & Sửa xung đột hàng loạt',
    summary:
      'Theo dõi 8 trạng thái giường chuẩn, phát hiện phòng có trạng thái mâu thuẫn với giường, xem Lịch sử giường và In phiếu đầu giường (Print Bedcard).',
    keywords: [
      'bed map',
      'sơ đồ giường',
      'conflicting status',
      'xung đột trạng thái',
      'sửa xung đột',
      'batch fix',
      'bedcard',
      'in phiếu',
      'lịch sử giường',
    ],
    roles: ['Tất cả vai trò'],
    relatedScreen: 'beds',
    relatedScreenLabel: 'Sơ đồ giường bệnh',
    steps: [
      'Mở Điều phối Giường bệnh → Sơ đồ giường bệnh để quan sát toàn bộ phòng và giường theo từng khoa.',
      'Nếu có phòng xuất hiện biểu tượng tam giác cảnh báo và nhãn "Xung đột trạng thái (Conflicting Status)" bên cạnh mã phòng (ví dụ phòng đang có giường sử dụng nhưng giường khác vẫn giữ chỗ), nhấn nút "Sửa xung đột hàng loạt" ở thanh công cụ phía trên để đồng bộ lại trạng thái hợp lệ.',
      'Nhấn trực tiếp vào bất kỳ thẻ giường nào để mở hộp thoại chi tiết: xem thông tin bệnh nhân, chuyển tab "Lịch sử giường" để xem dòng thời gian lượt nằm, hoặc nhấn "In phiếu đầu giường" để in bảng thông tin chuẩn CSS Print.',
      'Khi giường trống gặp sự cố kỹ thuật, quản trị hoặc nhân viên khoa có thể chuyển trạng thái giường sang Bảo trì hoặc Ngừng hoạt động.',
    ],
    tips: [
      'Giường đang Đã chiếm dụng hoặc Đang giữ chỗ được bảo vệ, không thể chuyển thủ công sang Bảo trì trước khi trả giường hoặc hủy giữ.',
    ],
  },
  {
    id: 'help-dashboard-ml-triage',
    category: 'BED_COORDINATION',
    title: 'Tổng quan công suất, Công suất tới hạn (>90%), Dự báo ML 4h & Triage Priority',
    summary:
      'Đọc các chỉ số công suất toàn viện, khoa vượt ngưỡng 90%, mô hình dự báo trống giường 4 giờ tới và bảng phân màu ưu tiên bệnh nhân đang nằm.',
    keywords: [
      'dashboard',
      'tổng quan',
      'công suất',
      '90%',
      'critical capacity',
      'dự báo',
      '4 giờ',
      'triage',
      'ưu tiên',
    ],
    roles: ['Tất cả vai trò'],
    relatedScreen: 'dashboard',
    relatedScreenLabel: 'Tổng quan công suất',
    steps: [
      'Truy cập Điều phối Giường bệnh → Tổng quan công suất ngay sau khi đăng nhập.',
      'Kiểm tra khu vực "Cảnh báo Công suất tới hạn (> 90%)": nếu có khoa vượt 90%, nhấn nút "Mở sơ đồ giường" trên thẻ khoa đó để điều phối nhanh.',
      'Theo dõi khu vực "Dự báo giường trống trong 4 giờ tới" (tính từ ALOS thực nghiệm, lịch trả giường dự kiến và các giường đang vệ sinh) để chuẩn bị tiếp nhận ca mới từ Danh sách chờ.',
      'Theo dõi "Phân loại Ưu tiên (Triage Priority)" với 3 mức Khẩn cấp (đỏ), Ưu tiên cao (vàng) và Ổn định (xanh) dựa trên dấu hiệu cảnh báo, mốc dùng thuốc/chăm sóc và hạn trả giường.',
    ],
    tips: [
      'Công thức công suất chỉ tính trên Giường hoạt động (tự động loại trừ giường Bảo trì và Ngừng hoạt động).',
    ],
  },
  {
    id: 'help-inpatients-handover',
    category: 'ADMISSIONS_TRANSFERS',
    title: 'Theo dõi Bệnh nhân đang nằm, Gia hạn ngày giường & Xuất bàn giao ca (CSV/PDF)',
    summary:
      'Quản lý danh sách bệnh nhân đang lưu trú, gia hạn ngày dự kiến trả giường và xuất tệp CSV/PDF phục vụ bàn giao giữa các ca trực.',
    keywords: [
      'inpatients',
      'bệnh nhân đang nằm',
      'handover',
      'bàn giao',
      'export',
      'csv',
      'pdf',
      'gia hạn',
      'extension',
    ],
    roles: ['Nhân viên khoa nội trú', 'Thu viện phí', 'Admin', 'Lãnh đạo'],
    relatedScreen: 'inpatients',
    relatedScreenLabel: 'Bệnh nhân đang nằm',
    steps: [
      'Mở Theo dõi Bệnh nhân → Bệnh nhân đang nằm và dùng bộ lọc theo khoa hoặc ô tìm kiếm nhanh để lọc đúng danh sách ca trực.',
      'Nhấn "Xuất CSV bàn giao" hoặc "Xuất PDF bàn giao" để tải bảng tổng hợp danh sách bệnh nhân đang lọc kèm khoa, phòng, giường, chẩn đoán và ngày dự kiến trả.',
      'Nếu bệnh nhân cần nằm thêm so với dự kiến, chuyển sang Theo dõi Bệnh nhân → Gia hạn ngày giường để cập nhật hạn trả mới và lưu lý do gia hạn bất biến.',
    ],
    tips: [
      'Lịch sử gia hạn không thể xóa hoặc sửa lùi, giúp tính đúng số ngày giường và đồng bộ cảnh báo quá hạn.',
    ],
  },
  {
    id: 'help-discharge-cleaning',
    category: 'DISCHARGE_CLEANING',
    title: 'Xuất viện, Trả giường & Quy trình Vệ sinh khử khuẩn giường',
    summary:
      'Hoàn tất lượt sử dụng giường khi bệnh nhân xuất viện và chuyển trạng thái qua Vệ sinh giường để đưa giường quay lại phục vụ an toàn.',
    keywords: [
      'discharge',
      'xuất viện',
      'trả giường',
      'cleaning',
      'vệ sinh',
      'khử khuẩn',
    ],
    roles: ['Nhân viên khoa nội trú', 'Admin hệ thống', 'Super Admin'],
    relatedScreen: 'discharge',
    relatedScreenLabel: 'Xuất viện',
    steps: [
      'Mở Theo dõi Bệnh nhân → Xuất viện, chọn bệnh nhân đủ điều kiện trả giường và nhấn "Xác nhận trả giường".',
      'Sau khi trả giường, giường tự động chuyển sang trạng thái Chờ vệ sinh và hệ thống sinh một phiếu vệ sinh tương ứng (đồng thời giải phóng phòng bao trọn nếu có).',
      'Chuyển sang Điều phối Giường bệnh → Vệ sinh giường, nhấn "Bắt đầu vệ sinh" (giường chuyển Đang vệ sinh) và sau khi khử khuẩn xong nhấn "Hoàn tất vệ sinh".',
      'Giường ngay lập tức trở về trạng thái Trống (Sẵn sàng phục vụ) trên Sơ đồ giường bệnh.',
    ],
    tips: [
      'Bộ phận Thu viện phí không được phép trả giường hộ nhân viên khoa nội trú để đảm bảo kiểm soát an toàn giường bệnh thực tế.',
    ],
  },
  {
    id: 'help-admin-catalog',
    category: 'CATALOG_ADMIN',
    title: 'Cấu hình Danh mục Quản trị (Khoa, Phòng, Loại giường, Giá & Tiêu chuẩn phòng)',
    summary:
      'Quản trị tập trung cơ cấu khoa phòng, sinh giường tự động theo phòng, đơn giá loại giường và các tiện ích tiêu chuẩn phòng (AC, TV, quạt, ghế bố, toilet).',
    keywords: [
      'danh mục quản trị',
      'settings',
      'cấu hình',
      'khoa',
      'phòng',
      'loại giường',
      'giá giường',
      'tiêu chuẩn phòng',
      'máy lạnh',
      'toilet',
    ],
    roles: ['Admin hệ thống', 'Super Admin'],
    relatedScreen: 'settings',
    relatedScreenLabel: 'Danh mục Quản trị',
    steps: [
      'Mở Quản trị Hệ thống → Danh mục Quản trị.',
      'Tab Khoa / Khu vực: thêm mới hoặc cập nhật mã khoa, tên khoa và trạng thái hoạt động.',
      'Tab Phòng theo khoa: khai báo phòng thuộc khoa, số giường quy mô (tự động sinh giường) và gắn kết hợp nhiều Tiêu chuẩn phòng.',
      'Tab Loại giường & Giá giường: định nghĩa đơn giá theo ngày / giờ cho từng loại giường (BHYT, Dịch vụ, VIP, Theo dõi đặc biệt) và gán loại giường + giá riêng cho từng giường trong phòng.',
      'Tab Tiêu chuẩn phòng: cấu hình thuộc tính chi tiết gồm Có máy lạnh (AC), Có Tivi (TV), Có máy quạt, Có ghế bố người nhà và Loại Toilet (Toilet trong khép kín / Toilet ngoài dùng chung).',
    ],
    tips: [
      'Tab Quy tắc & Hệ thống cho phép đổi phương pháp tính ngày giường (theo ngày lịch hoặc giờ thực tế) và xem nhật ký kiểm toán bất biến.',
    ],
  },
  {
    id: 'help-p2p-consensus',
    category: 'P2P_CONSENSUS',
    title: 'Đồng thuận P2P Raft Quorum, Phân vùng mạng & Sao lưu SQLite',
    summary:
      'Cách hệ thống Local-first P2P chống cấp trùng giường giữa nhiều máy trạm, xử lý khi mất kết nối và sao lưu/phục hồi dữ liệu mã hóa.',
    keywords: [
      'p2p',
      'raft',
      'quorum',
      'đồng bộ',
      'đồng thuận',
      'phân vùng',
      'sao lưu',
      'backup',
      'restore',
      'thiết bị',
    ],
    roles: ['Admin hệ thống', 'Super Admin', 'Nhân viên khoa nội trú'],
    relatedScreen: 'sync',
    relatedScreenLabel: 'Đồng bộ & Đồng thuận',
    steps: [
      'Mỗi thao tác cấp giường, giữ chỗ hoặc bao phòng đi qua đề xuất Raft Quorum để bảo đảm chỉ 1 máy trạm thắng khi tranh chấp cùng một giường.',
      'Mở Quản trị Hệ thống → Đồng bộ & Đồng thuận để theo dõi nhật ký sự kiện đã ký Ed25519, mô phỏng ngắt kết nối máy trạm và đối chiếu hợp nhất khi trực tuyến lại.',
      'Mở Quản trị Hệ thống → Sao lưu & Phục hồi để tạo bản sao lưu mã hóa cục bộ định kỳ hoặc khôi phục trạng thái hệ thống khi cần.',
    ],
    tips: [
      'Khi có xung đột từ phân vùng mạng, sử dụng tab Xung đột để rà soát và giữ nguyên nguyên tắc chỉ 1 lượt hợp lệ được cấp giường.',
    ],
  },
];

export function normalizeSearchText(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .trim();
}

export function filterHelpArticles(
  articles: HelpArticle[],
  query: string,
  category: HelpCategoryId
): HelpArticle[] {
  const normalizedQuery = normalizeSearchText(query);
  const terms = normalizedQuery ? normalizedQuery.split(/\s+/).filter(Boolean) : [];

  return articles.filter((article) => {
    if (category !== 'ALL' && article.category !== category) {
      return false;
    }
    if (terms.length === 0) {
      return true;
    }
    const haystack = normalizeSearchText(
      [
        article.title,
        article.summary,
        article.relatedScreenLabel,
        ...article.keywords,
        ...article.roles,
        ...article.steps,
        ...article.tips,
      ].join(' ')
    );
    return terms.every((term) => haystack.includes(term));
  });
}

export function getCategoryCounts(
  articles: HelpArticle[],
  query: string
): Record<HelpCategoryId, number> {
  const counts: Record<HelpCategoryId, number> = {
    ALL: 0,
    BED_COORDINATION: 0,
    ADMISSIONS_TRANSFERS: 0,
    DISCHARGE_CLEANING: 0,
    CATALOG_ADMIN: 0,
    P2P_CONSENSUS: 0,
  };
  const matchingAll = filterHelpArticles(articles, query, 'ALL');
  counts.ALL = matchingAll.length;
  for (const item of matchingAll) {
    counts[item.category]++;
  }
  return counts;
}
