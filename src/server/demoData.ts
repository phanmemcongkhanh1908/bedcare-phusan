import {
  DEFAULT_ADMIN_ID,
  DEFAULT_ADMIN_PASSWORD,
  DEFAULT_ADMIN_USERNAME,
} from '../utils/userAccountRules';
import { hashPassword, verifyPassword } from './crypto';
import type { BedcareCluster } from './p2pCluster';

export function ensureDefaultAdminAccount(cluster: BedcareCluster) {
  const node = cluster.getActiveNode();
  const existing = node.db
    .prepare('SELECT id, username, password_hash, full_name, role, department_id, status FROM users WHERE LOWER(username) = ? OR id = ?')
    .get(DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_ID) as
    | {
        id: string;
        username: string;
        password_hash: string;
        full_name: string;
        role: string;
        department_id: string | null;
        status: string;
      }
    | undefined;

  if (!existing) {
    cluster.commitStandardEvent(node.deviceId, DEFAULT_ADMIN_ID, 'USER_UPSERT', 'USER', DEFAULT_ADMIN_ID, {
      id: DEFAULT_ADMIN_ID,
      username: DEFAULT_ADMIN_USERNAME,
      password_hash: hashPassword(DEFAULT_ADMIN_PASSWORD),
      full_name: 'Quản trị viên Hệ thống (Mặc định)',
      role: 'SUPER_ADMIN',
      department_id: null,
      status: 'ACTIVE',
    });
    return;
  }

  const needsRoleOrStatusFix =
    existing.role !== 'SUPER_ADMIN' ||
    existing.status !== 'ACTIVE' ||
    existing.department_id !== null;
  const hasLegacyDemoPassword = verifyPassword('Admin@2026', existing.password_hash);

  if (needsRoleOrStatusFix || hasLegacyDemoPassword) {
    if (existing.status !== 'ACTIVE') {
      for (const n of cluster.nodes.values()) {
        n.db.prepare("UPDATE users SET status = 'ACTIVE', role = 'SUPER_ADMIN', department_id = NULL WHERE id = ?").run(existing.id);
      }
    }
    cluster.commitStandardEvent(node.deviceId, existing.id, 'USER_UPSERT', 'USER', existing.id, {
      id: existing.id,
      username: DEFAULT_ADMIN_USERNAME,
      password_hash: hasLegacyDemoPassword ? hashPassword(DEFAULT_ADMIN_PASSWORD) : '',
      full_name: existing.full_name || 'Quản trị viên Hệ thống (Mặc định)',
      role: 'SUPER_ADMIN',
      department_id: null,
      status: 'ACTIVE',
    });
  }
}

export function seedDemoClusterIfEmpty(cluster: BedcareCluster) {
  const node = cluster.getActiveNode();
  const userCount = (node.db.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c;
  if (userCount > 0) {
    ensureDefaultAdminAccount(cluster);
    return;
  }

  const now = new Date();
  const iso = (offsetHours: number) => new Date(now.getTime() + offsetHours * 3600 * 1000).toISOString();

  // 1. Seed Departments first (referenced by users.department_id)
  const departments = [
    { id: 'dept-san-a', code: 'SANA', name: 'Khoa Sản A', description: 'Chăm sóc và lưu trú sản phụ sau sinh thường & sinh mổ', his_dept_code: 'K15', planned_bhyt_beds: 5, max_bhyt_overage_pct: 120, status: 'ACTIVE' },
    { id: 'dept-san-b', code: 'SANB', name: 'Khoa Sản B (Dịch vụ)', description: 'Khu phòng giường nội trú sản khoa tiêu chuẩn dịch vụ', his_dept_code: 'K15B', planned_bhyt_beds: 2, max_bhyt_overage_pct: 120, status: 'ACTIVE' },
    { id: 'dept-phu-khoa', code: 'PHUKHOA', name: 'Khoa Phụ Khoa', description: 'Lưu trú nội trú sản phụ khoa và hậu phẫu', his_dept_code: 'K16', planned_bhyt_beds: 5, max_bhyt_overage_pct: 120, status: 'ACTIVE' },
    { id: 'dept-noi-tong-hop', code: 'NOITH', name: 'Khoa Nội Tổng Hợp', description: 'Lưu trú nội trú tổng hợp và theo dõi trong ngày', his_dept_code: 'K01', planned_bhyt_beds: 4, max_bhyt_overage_pct: 120, status: 'ACTIVE' },
    { id: 'dept-hoi-suc', code: 'HSSM', name: 'Khoa Hồi sức Sau mổ', description: 'Theo dõi sát bệnh nhân hậu phẫu và hồi sức giường bệnh', his_dept_code: 'K18', planned_bhyt_beds: 2, max_bhyt_overage_pct: 110, status: 'ACTIVE' },
  ];
  for (const d of departments) {
    cluster.commitStandardEvent(node.deviceId, 'usr-superadmin', 'DEPARTMENT_UPSERT', 'DEPARTMENT', d.id, d);
  }

  // 2. Seed RBAC Users (scrypt hashed, never plaintext)
  const users = [
    {
      id: DEFAULT_ADMIN_ID,
      username: DEFAULT_ADMIN_USERNAME,
      password_hash: hashPassword(DEFAULT_ADMIN_PASSWORD),
      full_name: 'Quản trị viên Hệ thống (Mặc định)',
      role: 'SUPER_ADMIN',
      department_id: null,
      status: 'ACTIVE',
    },
    {
      id: 'usr-superadmin',
      username: 'superadmin',
      password_hash: hashPassword('Bedcare@2026'),
      full_name: 'Nguyễn Quản Trị Tối Cao',
      role: 'SUPER_ADMIN',
      department_id: null,
      status: 'ACTIVE',
    },
    {
      id: 'usr-cashier',
      username: 'thuvienphi',
      password_hash: hashPassword('Vienphi@2026'),
      full_name: 'Lê Thị Thu Ngân',
      role: 'CASHIER',
      department_id: null,
      his_permission: 'SYNC_AND_MAP',
      status: 'ACTIVE',
    },
    {
      id: 'usr-ward-san-a',
      username: 'khoasana',
      password_hash: hashPassword('Khoasan@2026'),
      full_name: 'BS. Phạm Thị Lan Anh',
      role: 'WARD_STAFF',
      department_id: 'dept-san-a',
      his_permission: 'NONE',
      status: 'ACTIVE',
    },
    {
      id: 'usr-ward-phukhoa',
      username: 'khoaphukhoa',
      password_hash: hashPassword('Phukhoa@2026'),
      full_name: 'ĐD. Vũ Hoàng Mai',
      role: 'WARD_STAFF',
      department_id: 'dept-phu-khoa',
      his_permission: 'NONE',
      status: 'ACTIVE',
    },
    {
      id: 'usr-exec',
      username: 'lanhdao',
      password_hash: hashPassword('Lanhdao@2026'),
      full_name: 'TS.BS. Hoàng Văn Giám Đốc',
      role: 'EXECUTIVE',
      department_id: null,
      his_permission: 'VIEW',
      status: 'ACTIVE',
    },
  ];

  for (const u of users) {
    cluster.commitStandardEvent(node.deviceId, 'usr-superadmin', 'USER_UPSERT', 'USER', u.id, u);
  }

  // 3. Seed Room Standards (including AC, TV, Fan, Guest Chair, Bathroom types)
  const standards = [
    { id: 'std-1bed', name: 'Phòng 1 giường', code: 'CAP_1', category: 'CAPACITY', description: 'Phòng đơn riêng tư 1 giường', attributes: {}, is_default: 1 },
    { id: 'std-2bed', name: 'Phòng 2 giường', code: 'CAP_2', category: 'CAPACITY', description: 'Phòng đôi 2 giường tiêu chuẩn', attributes: {}, is_default: 1 },
    { id: 'std-4bed', name: 'Phòng 4 giường', code: 'CAP_4', category: 'CAPACITY', description: 'Phòng tiêu chuẩn 4 giường', attributes: {}, is_default: 1 },
    { id: 'std-wc-in', name: 'Toilet trong', code: 'WC_IN', category: 'TOILET', description: 'Nhà vệ sinh khép kín trong phòng', attributes: { toilet_type: 'INTERNAL' }, is_default: 1 },
    { id: 'std-wc-out', name: 'Toilet ngoài (dùng chung)', code: 'WC_OUT', category: 'TOILET', description: 'Nhà vệ sinh dùng chung ngoài hành lang', attributes: { toilet_type: 'EXTERNAL_SHARED' }, is_default: 1 },
    { id: 'std-ac', name: 'Có máy lạnh', code: 'AM_AC', category: 'CUSTOM', description: 'Trang bị điều hòa nhiệt độ hai chiều', attributes: { has_ac: true }, is_default: 1 },
    { id: 'std-tv', name: 'Có Tivi (TV)', code: 'AM_TV', category: 'CUSTOM', description: 'Trang bị Tivi giải trí trong phòng', attributes: { has_tv: true }, is_default: 1 },
    { id: 'std-fan', name: 'Có máy quạt', code: 'AM_FAN', category: 'CUSTOM', description: 'Trang bị quạt treo tường / quạt đứng', attributes: { has_fan: true }, is_default: 1 },
    { id: 'std-chair', name: 'Có ghế bố người nhà', code: 'AM_CHAIR', category: 'CUSTOM', description: 'Trang bị ghế bố nghỉ ngơi cho thân nhân', attributes: { has_guest_chair: true }, is_default: 1 },
    { id: 'std-service', name: 'Phòng dịch vụ', code: 'TYPE_SVC', category: 'SERVICE', description: 'Trang bị tiện ích dịch vụ chất lượng cao', attributes: { has_ac: true, has_tv: true, has_guest_chair: true, toilet_type: 'INTERNAL' }, is_default: 1 },
    { id: 'std-normal', name: 'Phòng thường', code: 'TYPE_STD', category: 'SERVICE', description: 'Phòng nội trú tiêu chuẩn BHYT', attributes: { has_fan: true, toilet_type: 'EXTERNAL_SHARED' }, is_default: 1 },
  ];
  for (const s of standards) {
    cluster.commitStandardEvent(node.deviceId, 'usr-superadmin', 'ROOM_STANDARD_UPSERT', 'ROOM_STANDARD', s.id, s);
  }

  // 3b. Seed Bed Types & Pricing
  const bedTypes = [
    { id: 'bt-std', code: 'GTH', name: 'Giường tiêu chuẩn BHYT', daily_price: 220000, hourly_price: 35000, description: 'Giường nội trú tiêu chuẩn áp dụng BHYT', status: 'ACTIVE' },
    { id: 'bt-svc', code: 'GDV', name: 'Giường dịch vụ', daily_price: 650000, hourly_price: 95000, description: 'Giường phòng dịch vụ đầy đủ tiện nghi', status: 'ACTIVE' },
    { id: 'bt-vip', code: 'GVIP', name: 'Giường VIP / Bao phòng', daily_price: 1500000, hourly_price: 200000, description: 'Giường phòng VIP hỗ trợ bao trọn phòng', status: 'ACTIVE' },
    { id: 'bt-obs', code: 'GTD', name: 'Giường theo dõi đặc biệt', daily_price: 480000, hourly_price: 75000, description: 'Giường theo dõi sát sau phẫu thuật / thủ thuật', status: 'ACTIVE' },
  ];
  for (const bt of bedTypes) {
    cluster.commitStandardEvent(node.deviceId, 'usr-superadmin', 'BED_TYPE_UPSERT', 'BED_TYPE', bt.id, bt);
  }

  // 4. Seed Diagnosis Configs
  const diagnoses = [
    { id: 'diag-sinhthuong', name: 'Sinh thường', default_days: 3, description: 'Thời gian lưu viện dự kiến sinh thường' },
    { id: 'diag-sinhmo', name: 'Sinh mổ', default_days: 7, description: 'Thời gian lưu viện dự kiến phẫu thuật lấy thai' },
    { id: 'diag-phukhoa', name: 'Phụ khoa', default_days: 5, description: 'Lưu trú nội trú phụ khoa' },
    { id: 'diag-chosinh', name: 'Nằm chờ sinh', default_days: 2, description: 'Theo dõi chuyển dạ và chờ sinh' },
    { id: 'diag-trongngay', name: 'Theo dõi trong ngày', default_days: 1, description: 'Lưu viện theo dõi trong ngày' },
    { id: 'diag-khac', name: 'Khác', default_days: 4, description: 'Nhóm chẩn đoán nội trú khác' },
  ];
  for (const diag of diagnoses) {
    cluster.commitStandardEvent(node.deviceId, 'usr-superadmin', 'DIAGNOSIS_CONFIG_UPSERT', 'DIAGNOSIS', diag.id, diag);
  }

  // 5. Seed Rooms & Beds
  const rooms = [
    {
      id: 'room-a101', department_id: 'dept-san-a', code: 'A101', name: 'Phòng A101', floor: 'Tầng 1',
      capacity: 1, toilet_type: 'INTERNAL', room_type: 'SERVICE', is_service: 1,
      standard_ids: ['std-1bed', 'std-wc-in', 'std-ac', 'std-tv', 'std-chair', 'std-service'],
    },
    {
      id: 'room-a102', department_id: 'dept-san-a', code: 'A102', name: 'Phòng A102', floor: 'Tầng 1',
      capacity: 2, toilet_type: 'INTERNAL', room_type: 'SERVICE', is_service: 1,
      standard_ids: ['std-2bed', 'std-wc-in', 'std-ac', 'std-tv', 'std-service'],
    },
    {
      id: 'room-a103', department_id: 'dept-san-a', code: 'A103', name: 'Phòng A103', floor: 'Tầng 1',
      capacity: 4, toilet_type: 'EXTERNAL', room_type: 'STANDARD', is_service: 0,
      standard_ids: ['std-4bed', 'std-wc-out', 'std-fan', 'std-normal'],
    },
    {
      id: 'room-b201', department_id: 'dept-san-b', code: 'B201', name: 'Phòng B201', floor: 'Tầng 2',
      capacity: 2, toilet_type: 'INTERNAL', room_type: 'VIP', is_service: 1,
      standard_ids: ['std-2bed', 'std-wc-in', 'std-ac', 'std-tv', 'std-chair', 'std-service'],
    },
    {
      id: 'room-p301', department_id: 'dept-phu-khoa', code: 'P301', name: 'Phòng P301', floor: 'Tầng 3',
      capacity: 2, toilet_type: 'INTERNAL', room_type: 'STANDARD', is_service: 0,
      standard_ids: ['std-2bed', 'std-wc-in', 'std-fan', 'std-normal'],
    },
    {
      id: 'room-p302', department_id: 'dept-phu-khoa', code: 'P302', name: 'Phòng P302', floor: 'Tầng 3',
      capacity: 4, toilet_type: 'EXTERNAL', room_type: 'STANDARD', is_service: 0,
      standard_ids: ['std-4bed', 'std-wc-out', 'std-fan', 'std-normal'],
    },
    {
      id: 'room-n401', department_id: 'dept-noi-tong-hop', code: 'N401', name: 'Phòng N401', floor: 'Tầng 4',
      capacity: 2, toilet_type: 'INTERNAL', room_type: 'STANDARD', is_service: 0,
      standard_ids: ['std-2bed', 'std-wc-in', 'std-fan', 'std-normal'],
    },
    {
      id: 'room-h501', department_id: 'dept-hoi-suc', code: 'H501', name: 'Phòng H501', floor: 'Tầng 5',
      capacity: 2, toilet_type: 'INTERNAL', room_type: 'SERVICE', is_service: 1,
      standard_ids: ['std-2bed', 'std-wc-in', 'std-ac', 'std-service'],
    },
    {
      id: 'room-c101', department_id: 'dept-noi-tong-hop', code: 'C101', name: 'Phòng Cách ly C101', floor: 'Tầng 4',
      capacity: 2, toilet_type: 'INTERNAL', room_type: 'ISOLATION', is_service: 1,
      standard_ids: ['std-2bed', 'std-wc-in', 'std-ac', 'std-service'],
    },
  ];

  const bedIds: Record<string, string> = {};
  const deptHisCodeMap = Object.fromEntries(departments.map((d) => [d.id, d.his_dept_code]));
  const initialHisMappings: Array<Record<string, unknown>> = [];
  for (const r of rooms) {
    cluster.commitStandardEvent(node.deviceId, 'usr-superadmin', 'ROOM_UPSERT', 'ROOM', r.id, r);
    const bt = r.room_type === 'VIP' ? bedTypes[2] : r.is_service ? bedTypes[1] : bedTypes[0];
    const hisDept = deptHisCodeMap[r.department_id] || 'K00';
    for (let i = 1; i <= r.capacity; i++) {
      const bCode = `${r.code}-G0${i}`;
      const bId = `bed-${r.code.toLowerCase()}-${i}`;
      bedIds[bCode] = bId;
      cluster.commitStandardEvent(node.deviceId, 'usr-superadmin', 'BED_UPSERT', 'BED', bId, {
        id: bId,
        room_id: r.id,
        department_id: r.department_id,
        bed_type_id: bt.id,
        daily_price: bt.daily_price,
        code: bCode,
        name: `Giường 0${i} - ${r.name}`,
        status: 'VACANT',
      });
      if (bCode !== 'C101-G02') {
        initialHisMappings.push({
          bed_id: bId,
          his_dept_code: hisDept,
          his_room_code: r.code,
          his_bed_code: `HIS-${hisDept}-${bCode}`,
          his_bed_type_code:
            r.department_id === 'dept-hoi-suc'
              ? 'H1'
              : r.room_type === 'VIP' || r.room_type === 'SERVICE'
                ? 'DV'
                : 'H2',
          bhyt_max_daily_price: bt.daily_price,
          allow_shared_bed: r.room_type === 'STANDARD' ? 1 : 0,
          notes: 'Ánh xạ chuẩn danh mục KCB HIS ↔ BEDCARE',
          updated_by: 'usr-admin',
        });
      }
    }
  }
  cluster.commitStandardEvent(node.deviceId, 'usr-superadmin', 'HIS_BED_MAPPING_UPSERT', 'HIS_MAPPING', 'batch-init', {
    mappings: initialHisMappings,
  });

  // Maintenance bed example
  cluster.commitStandardEvent(node.deviceId, 'usr-admin', 'BED_STATUS_CHANGE', 'BED', bedIds['P302-G04'], {
    bed_id: bedIds['P302-G04'],
    status: 'MAINTENANCE',
    notes: 'Sửa thanh chắn giường định kỳ',
  });

  // 6. Seed Sample Admissions (synthetic Vietnamese names)
  const sampleAdmissions = [
    {
      id: 'adm-demo-1',
      admission_code: 'HS-2026-0001',
      patient_id: 'pat-demo-1',
      patient_code: 'BN-DEMO-001',
      his_record_code: 'HIS-99001',
      patient_name: 'Nguyễn Thị Hương (Mẫu)',
      date_of_birth: '1994-05-12',
      phone: '0901000001',
      diagnosis_group: 'Sinh mổ',
      department_id: 'dept-san-a',
      room_id: 'room-a101',
      bed_id: bedIds['A101-G01'],
      is_whole_room: false,
      hospital_admitted_at: iso(-96),
      bed_assigned_at: iso(-96),
      expected_discharge_at: iso(72),
      calculation_method: 'CALENDAR_DAYS',
      triage_priority: 'NORMAL',
      vitals_alert: '',
      medication_deadline_at: iso(6),
      status: 'ACTIVE',
      notes: 'Hậu phẫu ổn định',
      confirmed_by: 'usr-ward-san-a',
      confirmed_by_name: 'BS. Phạm Thị Lan Anh',
    },
    {
      id: 'adm-demo-2',
      admission_code: 'HS-2026-0002',
      patient_id: 'pat-demo-2',
      patient_code: 'BN-DEMO-002',
      his_record_code: 'HIS-99002',
      patient_name: 'Trần Ngọc Minh Châu (Mẫu)',
      date_of_birth: '1996-08-21',
      phone: '0901000002',
      diagnosis_group: 'Sinh thường',
      department_id: 'dept-san-a',
      room_id: 'room-a102',
      bed_id: bedIds['A102-G01'],
      is_whole_room: false,
      hospital_admitted_at: iso(-64),
      bed_assigned_at: iso(-64),
      expected_discharge_at: iso(8), // Due soon!
      calculation_method: 'CALENDAR_DAYS',
      triage_priority: 'HIGH',
      vitals_alert: 'Dự kiến xuất viện sớm · Chuẩn bị kế hoạch vệ sinh & phân bổ giường mới',
      medication_deadline_at: iso(1.5),
      status: 'ACTIVE',
      notes: 'Dự kiến xuất viện trong hôm nay',
      confirmed_by: 'usr-ward-san-a',
      confirmed_by_name: 'BS. Phạm Thị Lan Anh',
    },
    {
      id: 'adm-demo-3',
      admission_code: 'HS-2026-0003',
      patient_id: 'pat-demo-3',
      patient_code: 'BN-DEMO-003',
      his_record_code: 'HIS-99003',
      patient_name: 'Phạm Thu Thảo (Mẫu)',
      date_of_birth: '1991-02-14',
      phone: '0901000003',
      diagnosis_group: 'Phụ khoa',
      department_id: 'dept-phu-khoa',
      room_id: 'room-p301',
      bed_id: bedIds['P301-G01'],
      is_whole_room: false,
      hospital_admitted_at: iso(-144),
      bed_assigned_at: iso(-144),
      expected_discharge_at: iso(-24), // Overdue 1 day!
      calculation_method: 'CALENDAR_DAYS',
      triage_priority: 'CRITICAL',
      vitals_alert: 'Quá hạn trả giường · Cần rà soát gia hạn hoặc giải phóng giường',
      medication_deadline_at: iso(-0.5),
      status: 'ACTIVE',
      notes: 'Cần đánh giá gia hạn thêm ngày lưu trú',
      confirmed_by: 'usr-ward-phukhoa',
      confirmed_by_name: 'ĐD. Vũ Hoàng Mai',
    },
    {
      id: 'adm-demo-4',
      admission_code: 'HS-2026-0004',
      patient_id: 'pat-demo-4',
      patient_code: 'BN-DEMO-004',
      his_record_code: 'HIS-99004',
      patient_name: 'Lê Bảo Ngọc (Mẫu)',
      date_of_birth: '1995-11-03',
      phone: '0901000004',
      diagnosis_group: 'Sinh mổ',
      department_id: 'dept-san-b',
      room_id: 'room-b201',
      bed_id: bedIds['B201-G01'],
      is_whole_room: true, // Whole room exclusive!
      hospital_admitted_at: iso(-48),
      bed_assigned_at: iso(-48),
      expected_discharge_at: iso(120),
      calculation_method: 'CALENDAR_DAYS',
      triage_priority: 'NORMAL',
      vitals_alert: '',
      medication_deadline_at: iso(5),
      status: 'ACTIVE',
      notes: 'Gia đình đăng ký bao trọn phòng B201',
      confirmed_by: 'usr-admin',
      confirmed_by_name: 'Trần Minh Quản Lý',
    },
    {
      id: 'adm-demo-5',
      admission_code: 'HS-2026-0005',
      patient_id: 'pat-demo-7',
      patient_code: 'BN-DEMO-007',
      his_record_code: 'HIS-99007',
      patient_name: 'Nguyễn Minh Phương (Mẫu)',
      date_of_birth: '1989-07-19',
      phone: '0901000007',
      diagnosis_group: 'Sinh mổ',
      department_id: 'dept-hoi-suc',
      room_id: 'room-h501',
      bed_id: bedIds['H501-G01'],
      is_whole_room: false,
      hospital_admitted_at: iso(-18),
      bed_assigned_at: iso(-18),
      expected_discharge_at: iso(3),
      calculation_method: 'CALENDAR_DAYS',
      triage_priority: 'CRITICAL',
      vitals_alert: 'Sắp đến giờ trả giường · Ưu tiên chuyển về khoa nội trú nếu còn lưu trú',
      medication_deadline_at: iso(0.75),
      status: 'ACTIVE',
      notes: 'Hậu phẫu giờ thứ 18',
      confirmed_by: 'usr-admin',
      confirmed_by_name: 'Trần Minh Quản Lý',
    },
    {
      id: 'adm-demo-6',
      admission_code: 'HS-2026-0006',
      patient_id: 'pat-demo-8',
      patient_code: 'BN-DEMO-008',
      his_record_code: 'HIS-99008',
      patient_name: 'Hoàng Thanh Trúc (Mẫu)',
      date_of_birth: '1992-03-25',
      phone: '0901000008',
      diagnosis_group: 'Phụ khoa',
      department_id: 'dept-hoi-suc',
      room_id: 'room-h501',
      bed_id: bedIds['H501-G02'],
      is_whole_room: false,
      hospital_admitted_at: iso(-12),
      bed_assigned_at: iso(-12),
      expected_discharge_at: iso(18),
      calculation_method: 'CALENDAR_DAYS',
      triage_priority: 'HIGH',
      vitals_alert: 'Chờ điều chuyển từ Hồi sức sang khoa nội trú phù hợp',
      medication_deadline_at: iso(1.5),
      status: 'ACTIVE',
      notes: 'Đang theo dõi hồi sức sau mổ',
      confirmed_by: 'usr-admin',
      confirmed_by_name: 'Trần Minh Quản Lý',
    },
  ];

  for (const adm of sampleAdmissions) {
    cluster.commitStandardEvent(node.deviceId, adm.confirmed_by, 'ADMISSION_CONFIRM', 'ADMISSION', adm.id, adm);
  }

  // Sample extension on adm-demo-1
  cluster.commitStandardEvent(node.deviceId, 'usr-ward-san-a', 'BED_EXTEND', 'ADMISSION', 'adm-demo-1', {
    id: 'ext-demo-1',
    admission_id: 'adm-demo-1',
    patient_id: 'pat-demo-1',
    patient_name: 'Nguyễn Thị Hương (Mẫu)',
    bed_id: bedIds['A101-G01'],
    bed_code: 'A101-G01',
    old_expected_discharge_at: iso(48),
    new_expected_discharge_at: iso(72),
    reason: 'Theo dõi thêm vết mổ sau sinh',
    performed_by: 'usr-ward-san-a',
    performed_by_name: 'BS. Phạm Thị Lan Anh',
    performed_at: iso(-12),
  });

  // 7. Sample Pending Cleaning Bed (A103-G04)
  cluster.commitStandardEvent(node.deviceId, 'usr-ward-san-a', 'ADMISSION_CONFIRM', 'ADMISSION', 'adm-demo-discharged', {
    id: 'adm-demo-discharged',
    admission_code: 'HS-2026-0000',
    patient_id: 'pat-demo-0',
    patient_code: 'BN-DEMO-000',
    his_record_code: 'HIS-99000',
    patient_name: 'Đỗ Thị Kim Anh (Mẫu)',
    date_of_birth: '1993-04-10',
    phone: '0901000000',
    diagnosis_group: 'Theo dõi trong ngày',
    department_id: 'dept-san-a',
    room_id: 'room-a103',
    bed_id: bedIds['A103-G04'],
    is_whole_room: false,
    hospital_admitted_at: iso(-28),
    bed_assigned_at: iso(-28),
    expected_discharge_at: iso(-4),
    calculation_method: 'CALENDAR_DAYS',
    status: 'ACTIVE',
    notes: 'Đã xuất viện',
    confirmed_by: 'usr-ward-san-a',
    confirmed_by_name: 'BS. Phạm Thị Lan Anh',
  });
  cluster.commitStandardEvent(node.deviceId, 'usr-ward-san-a', 'BED_DISCHARGE', 'ADMISSION', 'adm-demo-discharged', {
    admission_id: 'adm-demo-discharged',
    actual_discharge_at: iso(-2),
    performed_by: 'usr-ward-san-a',
    cleaning_log_id: 'cln-demo-1',
    notes: 'Đã trả giường, chờ vệ sinh khử khuẩn',
  });

  // 8. Sample Registration Form A (Unknown Dept - Waitlist) & Form B (Known Dept - Reserved)
  cluster.commitStandardEvent(node.deviceId, 'usr-cashier', 'REGISTRATION_CREATE', 'REGISTRATION', 'reg-demo-1', {
    id: 'reg-demo-1',
    registration_code: 'DK-2026-001',
    patient_id: 'pat-demo-5',
    patient_code: 'BN-DEMO-005',
    his_record_code: 'HIS-99005',
    patient_name: 'Võ Thị Thanh Hà (Mẫu)',
    date_of_birth: '1997-09-18',
    phone: '0901000005',
    diagnosis_group: 'Sinh thường',
    expected_admission_date: iso(4),
    expected_discharge_date: iso(76),
    desired_standard_ids: ['std-1bed', 'std-wc-in'],
    registration_mode: 'UNKNOWN_DEPT',
    department_id: null,
    reservation_type: 'WAITLIST',
    status: 'WAITING',
    notes: 'Khách yêu cầu phòng 1 giường có toilet trong, chờ phân bổ khoa',
    created_by: 'usr-cashier',
    created_by_name: 'Lê Thị Thu Ngân',
  });

  cluster.commitStandardEvent(node.deviceId, 'usr-cashier', 'REGISTRATION_CREATE', 'REGISTRATION', 'reg-demo-2', {
    id: 'reg-demo-2',
    registration_code: 'DK-2026-002',
    patient_id: 'pat-demo-6',
    patient_code: 'BN-DEMO-006',
    his_record_code: 'HIS-99006',
    patient_name: 'Bùi Thị Mỹ Linh (Mẫu)',
    date_of_birth: '1992-12-01',
    phone: '0901000006',
    diagnosis_group: 'Nằm chờ sinh',
    expected_admission_date: iso(2),
    expected_discharge_date: iso(50),
    desired_standard_ids: ['std-2bed', 'std-wc-in', 'std-service'],
    registration_mode: 'KNOWN_DEPT',
    department_id: 'dept-san-a',
    room_id: 'room-a102',
    bed_id: bedIds['A102-G02'],
    reservation_type: 'SINGLE_BED',
    status: 'RESERVED',
    notes: 'Đã giữ chỗ giường A102-G02 tại quầy thu viện phí',
    created_by: 'usr-cashier',
    created_by_name: 'Lê Thị Thu Ngân',
  });

  cluster.commitStandardEvent(node.deviceId, 'usr-cashier', 'RESERVATION_CREATE', 'RESERVATION', 'res-demo-1', {
    id: 'res-demo-1',
    registration_id: 'reg-demo-2',
    patient_id: 'pat-demo-6',
    patient_name: 'Bùi Thị Mỹ Linh (Mẫu)',
    department_id: 'dept-san-a',
    room_id: 'room-a102',
    bed_id: bedIds['A102-G02'],
    is_whole_room: false,
    locked_bed_ids: [bedIds['A102-G02']],
    start_time: iso(-1),
    expires_at: iso(11),
    status: 'ACTIVE',
    notes: 'Giữ chỗ thủ công 12 giờ',
    created_by: 'usr-cashier',
    created_by_name: 'Lê Thị Thu Ngân',
  });

  // 9. Historical completed stays & cleanings (so 48h/7d forecast & bed history have real discharged baseline while freeing beds to VACANT)
  const historicalStays = [
    {
      id: 'adm-hist-1',
      admission_code: 'HS-2026-H01',
      patient_id: 'pat-hist-1',
      patient_code: 'BN-HIST-001',
      his_record_code: 'HIS-88001',
      patient_name: 'Trịnh Ngọc Hân (Mẫu)',
      date_of_birth: '1993-06-14',
      phone: '0902000001',
      diagnosis_group: 'Sinh thường',
      department_id: 'dept-san-a',
      room_id: 'room-a103',
      bed_id: bedIds['A103-G02'],
      hospital_admitted_at: iso(-120),
      bed_assigned_at: iso(-120),
      expected_discharge_at: iso(-48),
      actual_discharge_at: iso(-44),
      clnId: 'cln-hist-1',
    },
    {
      id: 'adm-hist-2',
      admission_code: 'HS-2026-H02',
      patient_id: 'pat-hist-2',
      patient_code: 'BN-HIST-002',
      his_record_code: 'HIS-88002',
      patient_name: 'Đinh Thảo Vy (Mẫu)',
      date_of_birth: '1990-10-22',
      phone: '0902000002',
      diagnosis_group: 'Phụ khoa',
      department_id: 'dept-phu-khoa',
      room_id: 'room-p302',
      bed_id: bedIds['P302-G01'],
      hospital_admitted_at: iso(-150),
      bed_assigned_at: iso(-150),
      expected_discharge_at: iso(-30),
      actual_discharge_at: iso(-28),
      clnId: 'cln-hist-2',
    },
    {
      id: 'adm-hist-3',
      admission_code: 'HS-2026-H03',
      patient_id: 'pat-hist-3',
      patient_code: 'BN-HIST-003',
      his_record_code: 'HIS-88003',
      patient_name: 'Lý Gia Bảo (Mẫu)',
      date_of_birth: '1988-01-19',
      phone: '0902000003',
      diagnosis_group: 'Theo dõi trong ngày',
      department_id: 'dept-noi-tong-hop',
      room_id: 'room-n401',
      bed_id: bedIds['N401-G01'],
      hospital_admitted_at: iso(-54),
      bed_assigned_at: iso(-54),
      expected_discharge_at: iso(-30),
      actual_discharge_at: iso(-26),
      clnId: 'cln-hist-3',
    },
  ];
  for (const h of historicalStays) {
    cluster.commitStandardEvent(node.deviceId, 'usr-admin', 'ADMISSION_CONFIRM', 'ADMISSION', h.id, {
      id: h.id,
      admission_code: h.admission_code,
      patient_id: h.patient_id,
      patient_code: h.patient_code,
      his_record_code: h.his_record_code,
      patient_name: h.patient_name,
      date_of_birth: h.date_of_birth,
      phone: h.phone,
      diagnosis_group: h.diagnosis_group,
      department_id: h.department_id,
      room_id: h.room_id,
      bed_id: h.bed_id,
      is_whole_room: false,
      hospital_admitted_at: h.hospital_admitted_at,
      bed_assigned_at: h.bed_assigned_at,
      expected_discharge_at: h.expected_discharge_at,
      calculation_method: 'CALENDAR_DAYS',
      status: 'ACTIVE',
      notes: 'Hồ sơ lịch sử mẫu',
      confirmed_by: 'usr-admin',
      confirmed_by_name: 'Trần Minh Quản Lý',
    });
    cluster.commitStandardEvent(node.deviceId, 'usr-admin', 'BED_DISCHARGE', 'ADMISSION', h.id, {
      admission_id: h.id,
      actual_discharge_at: h.actual_discharge_at,
      performed_by: 'usr-admin',
      cleaning_log_id: h.clnId,
      notes: 'Đã trả giường hoàn tất lưu trú',
    });
    cluster.commitStandardEvent(node.deviceId, 'usr-admin', 'CLEANING_COMPLETE', 'CLEANING', h.clnId, {
      cleaning_log_id: h.clnId,
      bed_id: h.bed_id,
      performed_by: 'usr-admin',
      performed_by_name: 'Trần Minh Quản Lý',
      notes: 'Đã khử khuẩn hoàn tất',
    });
  }

  // 10. Extra Registrations (for rich customer demand & room-standard trend analytics)
  const extraRegistrations = [
    {
      id: 'reg-demo-3',
      registration_code: 'DK-2026-003',
      patient_id: 'pat-demo-9',
      patient_code: 'BN-DEMO-009',
      his_record_code: 'HIS-99009',
      patient_name: 'Phan Thị Thu Trang (Mẫu)',
      date_of_birth: '1995-04-11',
      phone: '0901000009',
      diagnosis_group: 'Sinh mổ',
      expected_admission_date: iso(6),
      expected_discharge_date: iso(174),
      desired_standard_ids: ['std-1bed', 'std-wc-in', 'std-ac', 'std-service'],
      registration_mode: 'KNOWN_DEPT',
      department_id: 'dept-san-a',
      reservation_type: 'WAITLIST',
      status: 'WAITING',
      notes: 'Ưu tiên phòng 1 giường dịch vụ có máy lạnh',
    },
    {
      id: 'reg-demo-4',
      registration_code: 'DK-2026-004',
      patient_id: 'pat-demo-10',
      patient_code: 'BN-DEMO-010',
      his_record_code: 'HIS-99010',
      patient_name: 'Ngô Minh Anh (Mẫu)',
      date_of_birth: '1996-11-28',
      phone: '0901000010',
      diagnosis_group: 'Sinh mổ',
      expected_admission_date: iso(14),
      expected_discharge_date: iso(182),
      desired_standard_ids: ['std-1bed', 'std-wc-in', 'std-ac', 'std-tv'],
      registration_mode: 'KNOWN_DEPT',
      department_id: 'dept-hoi-suc',
      reservation_type: 'WHOLE_ROOM',
      status: 'WAITING',
      notes: 'Gia đình mong muốn bao trọn phòng 1 giường có máy lạnh',
    },
    {
      id: 'reg-demo-5',
      registration_code: 'DK-2026-005',
      patient_id: 'pat-demo-11',
      patient_code: 'BN-DEMO-011',
      his_record_code: 'HIS-99011',
      patient_name: 'Đoàn Hải Yến (Mẫu)',
      date_of_birth: '1993-02-07',
      phone: '0901000011',
      diagnosis_group: 'Sinh thường',
      expected_admission_date: iso(18),
      expected_discharge_date: iso(90),
      desired_standard_ids: ['std-ac', 'std-wc-in', 'std-service'],
      registration_mode: 'UNKNOWN_DEPT',
      department_id: null,
      reservation_type: 'WAITLIST',
      status: 'WAITING',
      notes: 'Đặt trước phòng máy lạnh & toilet trong',
    },
  ];
  for (const reg of extraRegistrations) {
    cluster.commitStandardEvent(node.deviceId, 'usr-cashier', 'REGISTRATION_CREATE', 'REGISTRATION', reg.id, {
      ...reg,
      created_by: 'usr-cashier',
      created_by_name: 'Lê Thị Thu Ngân',
    });
  }

  // 11. Transfer Requests Queue (1 overdue > 30 minutes + 1 recent request for delay alert demo)
  cluster.commitStandardEvent(node.deviceId, 'usr-admin', 'TRANSFER_REQUEST_CREATE', 'TRANSFER_REQUEST', 'trq-demo-overdue', {
    id: 'trq-demo-overdue',
    admission_id: 'adm-demo-6',
    patient_id: 'pat-demo-8',
    patient_name: 'Hoàng Thanh Trúc (Mẫu)',
    from_department_id: 'dept-hoi-suc',
    from_room_id: 'room-h501',
    from_bed_id: bedIds['H501-G02'],
    to_department_id: 'dept-phu-khoa',
    to_room_id: 'room-p302',
    to_bed_id: bedIds['P302-G01'],
    reason: 'Hạ mức hậu phẫu chuyển về khoa Phụ Khoa theo dõi tiếp',
    requested_by: 'usr-admin',
    requested_by_name: 'Trần Minh Quản Lý',
    requested_at: new Date(now.getTime() - 48 * 60 * 1000).toISOString(),
    notes: 'Cần điều phối cáng chuyển khoa ngay (đã chờ > 30 phút)',
  });

  cluster.commitStandardEvent(node.deviceId, 'usr-ward-san-a', 'TRANSFER_REQUEST_CREATE', 'TRANSFER_REQUEST', 'trq-demo-recent', {
    id: 'trq-demo-recent',
    admission_id: 'adm-demo-2',
    patient_id: 'pat-demo-2',
    patient_name: 'Trần Ngọc Minh Châu (Mẫu)',
    from_department_id: 'dept-san-a',
    from_room_id: 'room-a102',
    from_bed_id: bedIds['A102-G01'],
    to_department_id: 'dept-san-a',
    to_room_id: 'room-a103',
    to_bed_id: bedIds['A103-G02'],
    reason: 'Nhường giường dịch vụ cho sản phụ đăng ký giữ chỗ kế tiếp',
    requested_by: 'usr-ward-san-a',
    requested_by_name: 'BS. Phạm Thị Lan Anh',
    requested_at: new Date(now.getTime() - 10 * 60 * 1000).toISOString(),
    notes: 'Yêu cầu chuyển cùng tầng trong Khoa Sản A',
  });

  cluster.commitStandardEvent(node.deviceId, 'usr-superadmin', 'SYSTEM_CONFIG_UPDATE', 'CONFIG', 'system', {
    configs: { demo_mode_active: 'true' },
  });
}

export function clearDemoOperationalData(cluster: BedcareCluster, actorUserId: string) {
  for (const node of cluster.nodes.values()) {
    node.db.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;');
    try {
      const opsTables = [
        'cleaning_logs',
        'transfer_requests',
        'bed_transfers',
        'bed_extensions',
        'admissions',
        'reservations',
        'registrations',
        'patients',
        'pending_requests',
        'conflicts',
        'his_import_logs',
      ];
      for (const t of opsTables) {
        node.db.exec(`DELETE FROM ${t}`);
      }
      node.db.exec("UPDATE rooms SET exclusive_locked = 0, exclusive_lock_id = NULL");
      node.db.exec("UPDATE beds SET status = 'VACANT', current_admission_id = NULL, current_reservation_id = NULL WHERE status != 'INACTIVE'");
      node.db.prepare("INSERT OR REPLACE INTO system_configs (key, value, updated_at) VALUES ('demo_mode_active', 'false', ?)").run(new Date().toISOString());
      node.db.exec('COMMIT; PRAGMA foreign_keys = ON;');
    } catch (e) {
      node.db.exec('ROLLBACK; PRAGMA foreign_keys = ON;');
      throw e;
    }
  }
  const active = cluster.getActiveNode();
  cluster.commitStandardEvent(active.deviceId, actorUserId, 'SYSTEM_CONFIG_UPDATE', 'CONFIG', 'system', {
    configs: { demo_mode_active: 'false' },
    audit_action: 'CLEAR_DEMO_DATA',
    audit_details: 'Đã xóa toàn bộ dữ liệu bệnh nhân/lượt sử dụng mẫu trước khi vận hành thực tế',
  });
}
