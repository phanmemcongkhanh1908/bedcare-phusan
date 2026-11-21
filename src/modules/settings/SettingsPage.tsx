import {
  AirVent,
  Armchair,
  Bath,
  BedDouble,
  Building2,
  Contrast,
  DoorOpen,
  Fan,
  Plus,
  Settings2,
  SlidersHorizontal,
  Tv,
} from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { HIGH_CONTRAST_EVENT } from '../../App';
import { ConfirmModal } from '../../components/ConfirmModal';
import { apiFetch } from '../../services/api';
import type {
  Bed,
  BedType,
  Department,
  DiagnosisConfig,
  Room,
  RoomStandard,
  RoomStandardAttributes,
  UserRole,
} from '../../types/bedcare';
import { formatDateTimeVN } from '../../utils/formatters';

interface SettingsPageProps {
  userRole: UserRole;
  onNotify: (msg: string, type?: 'success' | 'error') => void;
  onDataChanged: () => void;
}

type AdminTab = 'departments' | 'rooms' | 'bed_types' | 'standards' | 'system';

export function SettingsPage({ userRole, onNotify, onDataChanged }: SettingsPageProps) {
  const [activeTab, setActiveTab] = useState<AdminTab>('departments');

  // Shared catalogs
  const [departments, setDepartments] = useState<Department[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [beds, setBeds] = useState<Bed[]>([]);
  const [bedTypes, setBedTypes] = useState<BedType[]>([]);
  const [standards, setStandards] = useState<RoomStandard[]>([]);

  // System settings & audit
  const [configs, setConfigs] = useState<Record<string, string>>({});
  const [diagnoses, setDiagnoses] = useState<DiagnosisConfig[]>([]);
  const [auditLogs, setAuditLogs] = useState<Array<Record<string, unknown>>>([]);
  const [newDiagName, setNewDiagName] = useState('');
  const [newDiagDays, setNewDiagDays] = useState(3);
  const [confirmClearDemo, setConfirmClearDemo] = useState(false);
  const [highContrast, setHighContrast] = useState<boolean>(
    () => typeof window !== 'undefined' && localStorage.getItem('bedcare_high_contrast') === 'true'
  );

  const toggleHighContrast = () => {
    const next = !highContrast;
    setHighContrast(next);
    localStorage.setItem('bedcare_high_contrast', String(next));
    document.documentElement.classList.toggle('high-contrast', next);
    window.dispatchEvent(new CustomEvent(HIGH_CONTRAST_EVENT));
    onNotify(next ? 'Đã bật Chế độ tương phản cao (High Contrast Mode).' : 'Đã tắt Chế độ tương phản cao.');
  };

  // Department form
  const [editingDeptId, setEditingDeptId] = useState<string | null>(null);
  const [deptCode, setDeptCode] = useState('');
  const [deptName, setDeptName] = useState('');
  const [deptDesc, setDeptDesc] = useState('');
  const [deptStatus, setDeptStatus] = useState<'ACTIVE' | 'INACTIVE'>('ACTIVE');

  // Room form
  const [roomFilterDept, setRoomFilterDept] = useState('');
  const [editingRoomId, setEditingRoomId] = useState<string | null>(null);
  const [roomDeptId, setRoomDeptId] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [roomName, setRoomName] = useState('');
  const [roomFloor, setRoomFloor] = useState('Tầng 1');
  const [roomCapacity, setRoomCapacity] = useState(2);
  const [roomToiletType, setRoomToiletType] = useState<'INTERNAL' | 'EXTERNAL'>('INTERNAL');
  const [roomType, setRoomType] = useState<'STANDARD' | 'SERVICE' | 'VIP' | 'ISOLATION'>('STANDARD');
  const [roomStandardIds, setRoomStandardIds] = useState<string[]>([]);

  // Bed Type form
  const [editingBtId, setEditingBtId] = useState<string | null>(null);
  const [btCode, setBtCode] = useState('');
  const [btName, setBtName] = useState('');
  const [btDailyPrice, setBtDailyPrice] = useState(250000);
  const [btHourlyPrice, setBtHourlyPrice] = useState(40000);
  const [btDesc, setBtDesc] = useState('');
  const [btStatus, setBtStatus] = useState<'ACTIVE' | 'INACTIVE'>('ACTIVE');

  // Bed per room form
  const [bedFilterRoom, setBedFilterRoom] = useState('');
  const [editingBedId, setEditingBedId] = useState<string | null>(null);
  const [bedRoomId, setBedRoomId] = useState('');
  const [bedCode, setBedCode] = useState('');
  const [bedName, setBedName] = useState('');
  const [bedTypeId, setBedTypeId] = useState('');
  const [bedPrice, setBedPrice] = useState(0);

  // Room Standard form
  const [editingStdId, setEditingStdId] = useState<string | null>(null);
  const [stdCode, setStdCode] = useState('');
  const [stdName, setStdName] = useState('');
  const [stdCategory, setStdCategory] = useState<'CAPACITY' | 'TOILET' | 'SERVICE' | 'CUSTOM'>('CUSTOM');
  const [stdDesc, setStdDesc] = useState('');
  const [stdAttrs, setStdAttrs] = useState<RoomStandardAttributes>({
    has_ac: false,
    has_tv: false,
    has_fan: false,
    has_guest_chair: false,
    toilet_type: 'NONE',
  });

  const load = async () => {
    try {
      const [settingsRes, deptRes, roomRes, bedRes, btRes, stdRes] = await Promise.all([
        apiFetch<{ configs: Record<string, string>; diagnoses: DiagnosisConfig[]; auditLogs: Array<Record<string, unknown>> }>('/settings'),
        apiFetch<Department[]>('/departments'),
        apiFetch<Room[]>('/rooms'),
        apiFetch<Bed[]>('/beds'),
        apiFetch<BedType[]>('/bed-types'),
        apiFetch<RoomStandard[]>('/room-standards'),
      ]);
      setConfigs(settingsRes.configs);
      setDiagnoses(settingsRes.diagnoses);
      setAuditLogs(settingsRes.auditLogs);
      setDepartments(deptRes);
      setRooms(roomRes);
      setBeds(bedRes);
      setBedTypes(btRes);
      setStandards(stdRes);

      if (!roomDeptId && deptRes.length > 0) setRoomDeptId(deptRes[0].id);
      if (!bedRoomId && roomRes.length > 0) setBedRoomId(roomRes[0].id);
      if (!bedTypeId && btRes.length > 0) {
        setBedTypeId(btRes[0].id);
        setBedPrice(btRes[0].daily_price);
      }
    } catch (e) {
      onNotify((e as Error).message, 'error');
    }
  };

  useEffect(() => {
    load();
  }, []);

  // --- Department Handlers ---
  const handleSaveDepartment = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await apiFetch('/departments', {
        method: 'POST',
        body: JSON.stringify({
          id: editingDeptId || undefined,
          code: deptCode,
          name: deptName,
          description: deptDesc,
          status: deptStatus,
        }),
      });
      onNotify(editingDeptId ? 'Đã cập nhật danh mục khoa.' : 'Đã thêm khoa mới.');
      setEditingDeptId(null);
      setDeptCode('');
      setDeptName('');
      setDeptDesc('');
      setDeptStatus('ACTIVE');
      await load();
      onDataChanged();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  };

  // --- Room Handlers ---
  const handleSaveRoom = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await apiFetch('/rooms', {
        method: 'POST',
        body: JSON.stringify({
          id: editingRoomId || undefined,
          department_id: roomDeptId,
          code: roomCode,
          name: roomName,
          floor: roomFloor,
          capacity: Number(roomCapacity),
          toilet_type: roomToiletType,
          room_type: roomType,
          is_service: roomType === 'SERVICE' || roomType === 'VIP',
          standard_ids: roomStandardIds,
        }),
      });
      onNotify(editingRoomId ? 'Đã cập nhật cấu hình phòng.' : 'Đã tạo phòng mới và sinh giường tự động.');
      setEditingRoomId(null);
      setRoomCode('');
      setRoomName('');
      setRoomStandardIds([]);
      await load();
      onDataChanged();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  };

  // --- Bed Type Handlers ---
  const handleSaveBedType = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await apiFetch('/bed-types', {
        method: 'POST',
        body: JSON.stringify({
          id: editingBtId || undefined,
          code: btCode,
          name: btName,
          daily_price: Number(btDailyPrice),
          hourly_price: Number(btHourlyPrice),
          description: btDesc,
          status: btStatus,
        }),
      });
      onNotify(editingBtId ? 'Đã cập nhật loại giường & giá giường.' : 'Đã thêm loại giường mới.');
      setEditingBtId(null);
      setBtCode('');
      setBtName('');
      setBtDesc('');
      await load();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  };

  // --- Bed per Room Handlers ---
  const handleSaveBed = async (e: FormEvent) => {
    e.preventDefault();
    const rm = rooms.find((r) => r.id === bedRoomId);
    if (!rm) return;
    try {
      await apiFetch('/beds', {
        method: 'POST',
        body: JSON.stringify({
          id: editingBedId || undefined,
          room_id: rm.id,
          department_id: rm.department_id,
          bed_type_id: bedTypeId || null,
          daily_price: Number(bedPrice),
          code: bedCode,
          name: bedName,
        }),
      });
      onNotify(editingBedId ? `Đã cập nhật giường ${bedCode}.` : `Đã thêm giường ${bedCode}.`);
      setEditingBedId(null);
      setBedCode('');
      setBedName('');
      await load();
      onDataChanged();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  };

  // --- Room Standard Handlers ---
  const handleSaveStandard = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await apiFetch('/room-standards', {
        method: 'POST',
        body: JSON.stringify({
          id: editingStdId || undefined,
          code: stdCode,
          name: stdName,
          category: stdCategory,
          description: stdDesc,
          attributes: stdAttrs,
        }),
      });
      onNotify(editingStdId ? 'Đã cập nhật tiêu chuẩn phòng.' : 'Đã thêm tiêu chuẩn phòng mới.');
      setEditingStdId(null);
      setStdCode('');
      setStdName('');
      setStdDesc('');
      setStdAttrs({ has_ac: false, has_tv: false, has_fan: false, has_guest_chair: false, toilet_type: 'NONE' });
      await load();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  };

  // --- System Config Handlers ---
  const handleSaveConfigs = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await apiFetch('/settings/configs', {
        method: 'POST',
        body: JSON.stringify({ configs }),
      });
      onNotify('Đã lưu cấu hình hệ thống (không tự động sửa các lượt đang nằm hiện tại).');
      await load();
      onDataChanged();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  };

  const handleUpsertDiagnosis = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await apiFetch('/settings/diagnoses', {
        method: 'POST',
        body: JSON.stringify({ name: newDiagName, default_days: Number(newDiagDays) }),
      });
      onNotify(`Đã lưu cấu hình nhóm chẩn đoán ${newDiagName}.`);
      setNewDiagName('');
      await load();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  };

  const handleUpdateDiagDays = async (d: DiagnosisConfig, days: number) => {
    if (days < 1) return;
    try {
      await apiFetch('/settings/diagnoses', {
        method: 'POST',
        body: JSON.stringify({ id: d.id, name: d.name, default_days: days, description: d.description }),
      });
      onNotify(`Đã cập nhật ${d.name} -> ${days} ngày dự kiến.`);
      await load();
    } catch (err) {
      onNotify((err as Error).message, 'error');
    }
  };

  const handleClearDemo = async () => {
    try {
      await apiFetch('/settings/clear-demo-data', { method: 'POST' });
      onNotify('Đã xóa sạch dữ liệu demo nghiệp vụ. Hệ thống sẵn sàng vận hành thực tế.');
      setConfirmClearDemo(false);
      await load();
      onDataChanged();
    } catch (err) {
      onNotify((err as Error).message, 'error');
      setConfirmClearDemo(false);
    }
  };

  const tabs: Array<{ id: AdminTab; label: string; icon: typeof Building2 }> = [
    { id: 'departments', label: 'Khoa / Khu vực', icon: Building2 },
    { id: 'rooms', label: 'Phòng theo khoa', icon: DoorOpen },
    { id: 'bed_types', label: 'Loại giường & Giá giường', icon: BedDouble },
    { id: 'standards', label: 'Tiêu chuẩn phòng', icon: SlidersHorizontal },
    { id: 'system', label: 'Quy tắc & Hệ thống', icon: Settings2 },
  ];

  const filteredRooms = roomFilterDept ? rooms.filter((r) => r.department_id === roomFilterDept) : rooms;
  const filteredBeds = bedFilterRoom ? beds.filter((b) => b.room_id === bedFilterRoom) : beds;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-slate-900">Danh mục Quản trị &amp; Cấu hình hệ thống</h2>
        <p className="text-sm text-slate-500 mt-0.5">
          Quản trị tập trung danh mục khoa phòng, phòng bệnh, giường từng phòng, loại giường &amp; đơn giá, tiêu chuẩn tiện ích phòng và quy tắc hệ thống.
        </p>
      </div>

      {/* Display Accessibility: High Contrast Mode */}
      <div className="rounded-lg border border-slate-200 bg-white px-5 py-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="rounded-md border border-slate-200 bg-slate-50 p-2 shrink-0">
            <Contrast className="h-5 w-5 text-sky-800" />
          </div>
          <div>
            <div className="text-sm font-semibold text-slate-900">
              Chế độ tương phản cao (High Contrast Mode)
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              Tăng độ nét chữ, viền thẻ giường và độ tương phản bàn phím/nút bấm giúp đọc rõ trong phòng bệnh hoặc khu vực ánh sáng mạnh.
            </p>
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={highContrast}
          data-testid="high-contrast-toggle"
          onClick={toggleHighContrast}
          className={`min-h-[42px] inline-flex items-center gap-2.5 rounded-md border px-4 py-2 text-xs font-semibold transition-colors ${
            highContrast
              ? 'border-slate-900 bg-slate-900 text-white'
              : 'border-slate-300 bg-slate-50 text-slate-800 hover:bg-slate-100'
          }`}
        >
          <span>{highContrast ? 'Đang BẬT Tương phản cao' : 'Bật Chế độ tương phản cao'}</span>
        </button>
      </div>

      {/* Unified Tab Navigation */}
      <div role="tablist" aria-label="Phân hệ Danh mục Quản trị" className="flex flex-wrap gap-1.5 rounded-lg border border-slate-200 bg-white p-1.5">
        {tabs.map((t) => {
          const Icon = t.icon;
          const active = activeTab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setActiveTab(t.id)}
              className={`flex items-center gap-2 rounded-md px-3.5 py-2 text-sm font-medium transition-colors whitespace-nowrap ${
                active ? 'bg-sky-700 text-white shadow-sm' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span>{t.label}</span>
            </button>
          );
        })}
      </div>

      {/* TAB 1: DEPARTMENTS */}
      {activeTab === 'departments' && (
        <div className="space-y-5">
          <form onSubmit={handleSaveDepartment} className="rounded-lg border border-slate-200 bg-white p-5 space-y-4">
            <h3 className="text-base font-semibold text-slate-900">
              {editingDeptId ? 'Cập nhật Khoa nội trú' : 'Thêm Khoa / Khu vực mới'}
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Mã khoa *</label>
                <input
                  type="text"
                  required
                  value={deptCode}
                  onChange={(e) => setDeptCode(e.target.value)}
                  placeholder="VD: SANA"
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-mono uppercase"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Tên khoa *</label>
                <input
                  type="text"
                  required
                  value={deptName}
                  onChange={(e) => setDeptName(e.target.value)}
                  placeholder="VD: Khoa Sản A"
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Trạng thái</label>
                <select
                  value={deptStatus}
                  onChange={(e) => setDeptStatus(e.target.value as 'ACTIVE' | 'INACTIVE')}
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                >
                  <option value="ACTIVE">Đang hoạt động</option>
                  <option value="INACTIVE">Ngừng hoạt động</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Mô tả</label>
                <input
                  type="text"
                  value={deptDesc}
                  onChange={(e) => setDeptDesc(e.target.value)}
                  placeholder="Chức năng / khu nhà"
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
            </div>
            <div className="flex gap-2">
              <button type="submit" className="flex items-center gap-1.5 rounded-md bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-800">
                <Plus className="h-4 w-4" />
                <span>{editingDeptId ? 'Lưu thay đổi' : 'Thêm khoa'}</span>
              </button>
              {editingDeptId && (
                <button
                  type="button"
                  onClick={() => {
                    setEditingDeptId(null);
                    setDeptCode('');
                    setDeptName('');
                    setDeptDesc('');
                  }}
                  className="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-600"
                >
                  Hủy sửa
                </button>
              )}
            </div>
          </form>

          <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500 border-b border-slate-200">
                <tr>
                  <th className="px-4 py-2.5 text-left">Mã</th>
                  <th className="px-4 py-2.5 text-left">Tên khoa</th>
                  <th className="px-4 py-2.5 text-left">Mô tả</th>
                  <th className="px-4 py-2.5 text-right">Phòng / Giường</th>
                  <th className="px-4 py-2.5 text-center">Trạng thái</th>
                  <th className="px-4 py-2.5 text-right">Thao tác</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {departments.map((d) => (
                  <tr key={d.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2.5 font-mono font-semibold text-sky-800">{d.code}</td>
                    <td className="px-4 py-2.5 font-medium text-slate-900">{d.name}</td>
                    <td className="px-4 py-2.5 text-slate-600 text-xs">{d.description}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-700">
                      {d.total_rooms ?? 0} / {d.total_beds ?? 0}
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded border ${d.status === 'ACTIVE' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-slate-100 text-slate-500 border-slate-200'}`}>
                        {d.status === 'ACTIVE' ? 'Hoạt động' : 'Ngừng'}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <button
                        type="button"
                        onClick={() => {
                          setEditingDeptId(d.id);
                          setDeptCode(d.code);
                          setDeptName(d.name);
                          setDeptDesc(d.description);
                          setDeptStatus(d.status);
                        }}
                        className="text-xs font-medium text-sky-700 hover:underline"
                      >
                        Chỉnh sửa
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 2: ROOMS PER DEPARTMENT */}
      {activeTab === 'rooms' && (
        <div className="space-y-5">
          <form onSubmit={handleSaveRoom} className="rounded-lg border border-slate-200 bg-white p-5 space-y-4">
            <h3 className="text-base font-semibold text-slate-900">
              {editingRoomId ? 'Cập nhật thông tin Phòng bệnh' : 'Thêm Phòng bệnh mới theo Khoa'}
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Khoa nội trú *</label>
                <select value={roomDeptId} onChange={(e) => setRoomDeptId(e.target.value)} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm">
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Mã phòng *</label>
                <input type="text" required value={roomCode} onChange={(e) => setRoomCode(e.target.value)} placeholder="VD: B202" className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-mono uppercase" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Tên phòng *</label>
                <input type="text" required value={roomName} onChange={(e) => setRoomName(e.target.value)} placeholder="VD: Phòng B202" className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Tầng / Khu</label>
                <input type="text" value={roomFloor} onChange={(e) => setRoomFloor(e.target.value)} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Số giường thiết kế</label>
                <input type="number" min={1} max={12} value={roomCapacity} onChange={(e) => setRoomCapacity(Number(e.target.value))} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-mono" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Phân loại phòng</label>
                <select value={roomType} onChange={(e) => setRoomType(e.target.value as Room['room_type'])} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm">
                  <option value="STANDARD">Phòng thường (BHYT)</option>
                  <option value="SERVICE">Phòng dịch vụ</option>
                  <option value="VIP">Phòng VIP / Bao phòng</option>
                  <option value="ISOLATION">Phòng cách ly</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Toilet phòng</label>
                <select value={roomToiletType} onChange={(e) => setRoomToiletType(e.target.value as 'INTERNAL' | 'EXTERNAL')} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm">
                  <option value="INTERNAL">Toilet trong (khép kín)</option>
                  <option value="EXTERNAL">Toilet ngoài (dùng chung)</option>
                </select>
              </div>
            </div>

            <div>
              <div className="text-xs font-medium text-slate-700 mb-2">Tiêu chuẩn &amp; Tiện ích đi kèm (Máy lạnh, TV, Máy quạt, Ghế bố, Toilet...)</div>
              <div className="flex flex-wrap gap-2">
                {standards.map((s) => {
                  const checked = roomStandardIds.includes(s.id);
                  return (
                    <label
                      key={s.id}
                      className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs cursor-pointer transition-colors ${
                        checked ? 'border-sky-500 bg-sky-50 text-sky-900 font-medium' : 'border-slate-200 bg-slate-50 text-slate-700'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) =>
                          setRoomStandardIds((prev) =>
                            e.target.checked ? [...prev, s.id] : prev.filter((id) => id !== s.id)
                          )
                        }
                        className="rounded border-slate-300 text-sky-700"
                      />
                      <span>{s.name}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="flex gap-2">
              <button type="submit" className="rounded-md bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-800">
                {editingRoomId ? 'Lưu cập nhật phòng' : 'Tạo phòng & Sinh giường'}
              </button>
              {editingRoomId && (
                <button
                  type="button"
                  onClick={() => {
                    setEditingRoomId(null);
                    setRoomCode('');
                    setRoomName('');
                    setRoomStandardIds([]);
                  }}
                  className="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-600"
                >
                  Hủy sửa
                </button>
              )}
            </div>
          </form>

          <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
            <div className="px-5 py-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
              <div className="font-semibold text-sm text-slate-900">Danh sách Phòng theo Khoa ({filteredRooms.length})</div>
              <select
                value={roomFilterDept}
                onChange={(e) => setRoomFilterDept(e.target.value)}
                aria-label="Lọc danh sách phòng theo khoa"
                className="rounded-md border border-slate-300 px-3 py-1.5 text-xs"
              >
                <option value="">Tất cả khoa</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs text-slate-500 border-b border-slate-200">
                  <tr>
                    <th className="px-4 py-2.5 text-left">Phòng</th>
                    <th className="px-4 py-2.5 text-left">Khoa</th>
                    <th className="px-4 py-2.5 text-center">Giường</th>
                    <th className="px-4 py-2.5 text-left">Toilet &amp; Tiện ích</th>
                    <th className="px-4 py-2.5 text-right">Thao tác</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredRooms.map((r) => (
                    <tr key={r.id} className="hover:bg-slate-50">
                      <td className="px-4 py-2.5">
                        <span className="font-mono font-bold text-slate-900">{r.code}</span>
                        <div className="text-xs text-slate-500">{r.name} · {r.floor}</div>
                      </td>
                      <td className="px-4 py-2.5 text-slate-700">{r.department_name}</td>
                      <td className="px-4 py-2.5 text-center font-mono tabular-nums">{r.capacity}</td>
                      <td className="px-4 py-2.5">
                        <div className="text-xs text-slate-800 font-medium">
                          {r.room_type} · {r.toilet_type === 'INTERNAL' ? 'Toilet trong' : 'Toilet ngoài (dùng chung)'}
                        </div>
                        <div className="text-[11px] text-slate-500 mt-0.5">
                          {r.standard_ids
                            .map((sid) => standards.find((s) => s.id === sid)?.name)
                            .filter(Boolean)
                            .join(', ') || 'Chưa gắn tiện ích'}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <button
                          type="button"
                          onClick={() => {
                            setEditingRoomId(r.id);
                            setRoomDeptId(r.department_id);
                            setRoomCode(r.code);
                            setRoomName(r.name);
                            setRoomFloor(r.floor);
                            setRoomCapacity(r.capacity);
                            setRoomToiletType(r.toilet_type);
                            setRoomType(r.room_type);
                            setRoomStandardIds(r.standard_ids || []);
                          }}
                          className="text-xs font-medium text-sky-700 hover:underline"
                        >
                          Chỉnh sửa
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: BED TYPES, PRICING & BEDS PER ROOM */}
      {activeTab === 'bed_types' && (
        <div className="space-y-6">
          {/* Bed Types & Pricing CRUD */}
          <form onSubmit={handleSaveBedType} className="rounded-lg border border-slate-200 bg-white p-5 space-y-4">
            <h3 className="text-base font-semibold text-slate-900">
              1. Danh mục Loại giường &amp; Đơn giá giường (VNĐ)
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 items-end">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Mã loại *</label>
                <input type="text" required value={btCode} onChange={(e) => setBtCode(e.target.value)} placeholder="VD: GDV2" className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-mono uppercase" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Tên loại giường *</label>
                <input type="text" required value={btName} onChange={(e) => setBtName(e.target.value)} placeholder="VD: Giường dịch vụ đơn" className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Giá theo ngày (VNĐ) *</label>
                <input type="number" min={0} step={10000} required value={btDailyPrice} onChange={(e) => setBtDailyPrice(Number(e.target.value))} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-mono tabular-nums" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Giá theo giờ (VNĐ)</label>
                <input type="number" min={0} step={5000} value={btHourlyPrice} onChange={(e) => setBtHourlyPrice(Number(e.target.value))} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-mono tabular-nums" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Trạng thái</label>
                <select value={btStatus} onChange={(e) => setBtStatus(e.target.value as 'ACTIVE' | 'INACTIVE')} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm">
                  <option value="ACTIVE">Đang áp dụng</option>
                  <option value="INACTIVE">Ngừng áp dụng</option>
                </select>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
              <div className="md:col-span-2">
                <label className="block text-xs font-medium text-slate-700 mb-1">Mô tả chi tiết</label>
                <input type="text" value={btDesc} onChange={(e) => setBtDesc(e.target.value)} placeholder="Phạm vi áp dụng, tiện ích đi kèm..." className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
              </div>
              <div className="flex gap-2 justify-end">
                {editingBtId && (
                  <button type="button" onClick={() => { setEditingBtId(null); setBtCode(''); setBtName(''); setBtDesc(''); }} className="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-600">
                    Hủy
                  </button>
                )}
                <button type="submit" className="rounded-md bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-800">
                  {editingBtId ? 'Lưu loại giường' : 'Thêm loại giường'}
                </button>
              </div>
            </div>

            <div className="overflow-x-auto border-t border-slate-100 pt-3">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs text-slate-500 border-b border-slate-200">
                  <tr>
                    <th className="px-3 py-2 text-left">Mã</th>
                    <th className="px-3 py-2 text-left">Tên loại giường</th>
                    <th className="px-3 py-2 text-right">Đơn giá / ngày</th>
                    <th className="px-3 py-2 text-right">Đơn giá / giờ</th>
                    <th className="px-3 py-2 text-left">Mô tả</th>
                    <th className="px-3 py-2 text-right">Thao tác</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {bedTypes.map((bt) => (
                    <tr key={bt.id} className="hover:bg-slate-50">
                      <td className="px-3 py-2 font-mono font-semibold text-sky-800">{bt.code}</td>
                      <td className="px-3 py-2 font-medium text-slate-900">{bt.name}</td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums font-semibold text-emerald-700">
                        {bt.daily_price.toLocaleString('vi-VN')} đ
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-600">
                        {bt.hourly_price.toLocaleString('vi-VN')} đ
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-500">{bt.description}</td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => {
                            setEditingBtId(bt.id);
                            setBtCode(bt.code);
                            setBtName(bt.name);
                            setBtDailyPrice(bt.daily_price);
                            setBtHourlyPrice(bt.hourly_price);
                            setBtDesc(bt.description);
                            setBtStatus(bt.status);
                          }}
                          className="text-xs font-medium text-sky-700 hover:underline"
                        >
                          Sửa giá / thông tin
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </form>

          {/* Beds per Room + Price assignment */}
          <form onSubmit={handleSaveBed} className="rounded-lg border border-slate-200 bg-white p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-base font-semibold text-slate-900">
                2. Danh mục Giường từng Phòng &amp; Gán Loại giường / Giá giường
              </h3>
              <select
                value={bedFilterRoom}
                onChange={(e) => setBedFilterRoom(e.target.value)}
                aria-label="Lọc giường theo phòng"
                className="rounded-md border border-slate-300 px-3 py-1.5 text-xs"
              >
                <option value="">Tất cả phòng ({beds.length} giường)</option>
                {rooms.map((r) => (
                  <option key={r.id} value={r.id}>{r.name} ({r.department_name})</option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 items-end">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Phòng *</label>
                <select value={bedRoomId} onChange={(e) => setBedRoomId(e.target.value)} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm">
                  {rooms.map((r) => (
                    <option key={r.id} value={r.id}>{r.name} · {r.department_name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Mã giường *</label>
                <input type="text" required value={bedCode} onChange={(e) => setBedCode(e.target.value)} placeholder="VD: B201-G03" className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-mono uppercase" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Tên giường *</label>
                <input type="text" required value={bedName} onChange={(e) => setBedName(e.target.value)} placeholder="VD: Giường 03 - Phòng B201" className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Loại giường</label>
                <select
                  value={bedTypeId}
                  onChange={(e) => {
                    const nextId = e.target.value;
                    setBedTypeId(nextId);
                    const matched = bedTypes.find((x) => x.id === nextId);
                    if (matched) setBedPrice(matched.daily_price);
                  }}
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                >
                  <option value="">-- Chọn loại giường --</option>
                  {bedTypes.map((bt) => (
                    <option key={bt.id} value={bt.id}>{bt.name} ({bt.daily_price.toLocaleString('vi-VN')}đ)</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Giá riêng/ngày (VNĐ)</label>
                <input type="number" min={0} step={10000} value={bedPrice} onChange={(e) => setBedPrice(Number(e.target.value))} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-mono tabular-nums" />
              </div>
            </div>
            <div className="flex gap-2">
              <button type="submit" className="rounded-md bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-800">
                {editingBedId ? 'Lưu cập nhật giường' : 'Thêm giường vào phòng'}
              </button>
              {editingBedId && (
                <button type="button" onClick={() => { setEditingBedId(null); setBedCode(''); setBedName(''); }} className="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-600">
                  Hủy sửa
                </button>
              )}
            </div>

            <div className="overflow-x-auto max-h-80 border-t border-slate-100 pt-3">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs text-slate-500 border-b border-slate-200">
                  <tr>
                    <th className="px-3 py-2 text-left">Mã giường</th>
                    <th className="px-3 py-2 text-left">Phòng / Khoa</th>
                    <th className="px-3 py-2 text-left">Loại giường</th>
                    <th className="px-3 py-2 text-right">Đơn giá / ngày</th>
                    <th className="px-3 py-2 text-right">Thao tác</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredBeds.map((b) => (
                    <tr key={b.id} className="hover:bg-slate-50">
                      <td className="px-3 py-2 font-mono font-bold text-slate-900">{b.code}</td>
                      <td className="px-3 py-2 text-xs text-slate-700">{b.room_name} · {b.department_name}</td>
                      <td className="px-3 py-2 text-xs text-slate-800">{b.bed_type_name || 'Chưa phân loại'}</td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums font-semibold text-slate-900">
                        {(b.daily_price ?? 0).toLocaleString('vi-VN')} đ
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => {
                            setEditingBedId(b.id);
                            setBedRoomId(b.room_id);
                            setBedCode(b.code);
                            setBedName(b.name);
                            setBedTypeId(b.bed_type_id || '');
                            setBedPrice(b.daily_price ?? 0);
                          }}
                          className="text-xs font-medium text-sky-700 hover:underline"
                        >
                          Sửa loại / giá
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </form>
        </div>
      )}

      {/* TAB 4: ROOM STANDARDS & AMENITY ATTRIBUTES */}
      {activeTab === 'standards' && (
        <div className="space-y-5">
          <form onSubmit={handleSaveStandard} className="rounded-lg border border-slate-200 bg-white p-5 space-y-4">
            <h3 className="text-base font-semibold text-slate-900">
              {editingStdId ? 'Cập nhật Tiêu chuẩn phòng' : 'Thêm Tiêu chuẩn phòng & Tiện ích mới'}
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Mã tiêu chuẩn *</label>
                <input type="text" required value={stdCode} onChange={(e) => setStdCode(e.target.value)} placeholder="VD: VIP_FULL" className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-mono uppercase" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Tên tiêu chuẩn *</label>
                <input type="text" required value={stdName} onChange={(e) => setStdName(e.target.value)} placeholder="VD: Phòng máy lạnh + TV + Toilet trong" className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Nhóm phân loại</label>
                <select value={stdCategory} onChange={(e) => setStdCategory(e.target.value as RoomStandard['category'])} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm">
                  <option value="SERVICE">Gói dịch vụ</option>
                  <option value="TOILET">Tiêu chuẩn Toilet</option>
                  <option value="CAPACITY">Sức chứa giường</option>
                  <option value="CUSTOM">Tiện ích phòng (AC, TV, Quạt, Ghế bố)</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Mô tả</label>
                <input type="text" value={stdDesc} onChange={(e) => setStdDesc(e.target.value)} placeholder="Ghi chú trang thiết bị" className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
              </div>
            </div>

            <div className="rounded-md border border-slate-100 bg-slate-50/70 p-4 space-y-3">
              <div className="text-xs font-semibold text-slate-700">Thuộc tính trang thiết bị &amp; vệ sinh đi kèm</div>
              <div className="flex flex-wrap gap-4 items-center text-xs">
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" checked={Boolean(stdAttrs.has_ac)} onChange={(e) => setStdAttrs({ ...stdAttrs, has_ac: e.target.checked })} />
                  <AirVent className="h-3.5 w-3.5 text-sky-700" />
                  <span>Có máy lạnh (AC)</span>
                </label>
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" checked={Boolean(stdAttrs.has_tv)} onChange={(e) => setStdAttrs({ ...stdAttrs, has_tv: e.target.checked })} />
                  <Tv className="h-3.5 w-3.5 text-sky-700" />
                  <span>Có Tivi (TV)</span>
                </label>
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" checked={Boolean(stdAttrs.has_fan)} onChange={(e) => setStdAttrs({ ...stdAttrs, has_fan: e.target.checked })} />
                  <Fan className="h-3.5 w-3.5 text-teal-700" />
                  <span>Có máy quạt</span>
                </label>
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" checked={Boolean(stdAttrs.has_guest_chair)} onChange={(e) => setStdAttrs({ ...stdAttrs, has_guest_chair: e.target.checked })} />
                  <Armchair className="h-3.5 w-3.5 text-amber-700" />
                  <span>Có ghế bố người nhà</span>
                </label>
                <div className="flex items-center gap-2">
                  <Bath className="h-3.5 w-3.5 text-slate-600" />
                  <span>Loại Toilet:</span>
                  <select
                    value={stdAttrs.toilet_type || 'NONE'}
                    onChange={(e) => setStdAttrs({ ...stdAttrs, toilet_type: e.target.value as RoomStandardAttributes['toilet_type'] })}
                    className="rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                  >
                    <option value="NONE">Không quy định</option>
                    <option value="INTERNAL">Toilet trong (khép kín)</option>
                    <option value="EXTERNAL_SHARED">Toilet ngoài (dùng chung)</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="flex gap-2">
              <button type="submit" className="rounded-md bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-800">
                {editingStdId ? 'Lưu tiêu chuẩn' : 'Thêm tiêu chuẩn phòng'}
              </button>
              {editingStdId && (
                <button
                  type="button"
                  onClick={() => {
                    setEditingStdId(null);
                    setStdCode('');
                    setStdName('');
                    setStdDesc('');
                  }}
                  className="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-600"
                >
                  Hủy sửa
                </button>
              )}
            </div>
          </form>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {standards.map((s) => {
              const attrs = s.attributes || {};
              return (
                <div key={s.id} className="rounded-lg border border-slate-200 bg-white p-4 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <span className="font-mono text-xs font-semibold text-sky-700">{s.code}</span>
                      <h4 className="text-sm font-semibold text-slate-900">{s.name}</h4>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingStdId(s.id);
                        setStdCode(s.code);
                        setStdName(s.name);
                        setStdCategory(s.category);
                        setStdDesc(s.description);
                        setStdAttrs(attrs);
                      }}
                      className="text-xs font-medium text-sky-700 hover:underline shrink-0"
                    >
                      Sửa
                    </button>
                  </div>
                  <p className="text-xs text-slate-500">{s.description}</p>
                  <div className="flex flex-wrap gap-1.5 pt-1 text-[11px]">
                    {attrs.has_ac && <span className="rounded bg-sky-50 text-sky-800 border border-sky-200 px-1.5 py-0.5">Máy lạnh</span>}
                    {attrs.has_tv && <span className="rounded bg-sky-50 text-sky-800 border border-sky-200 px-1.5 py-0.5">Tivi</span>}
                    {attrs.has_fan && <span className="rounded bg-teal-50 text-teal-800 border border-teal-200 px-1.5 py-0.5">Máy quạt</span>}
                    {attrs.has_guest_chair && <span className="rounded bg-amber-50 text-amber-800 border border-amber-200 px-1.5 py-0.5">Ghế bố</span>}
                    {attrs.toilet_type === 'INTERNAL' && <span className="rounded bg-emerald-50 text-emerald-800 border border-emerald-200 px-1.5 py-0.5">Toilet trong</span>}
                    {attrs.toilet_type === 'EXTERNAL_SHARED' && <span className="rounded bg-slate-100 text-slate-700 border border-slate-200 px-1.5 py-0.5">Toilet ngoài (dùng chung)</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* TAB 5: SYSTEM RULES & AUDIT LOGS */}
      {activeTab === 'system' && (
        <div className="space-y-6">
          <form onSubmit={handleSaveConfigs} className="rounded-lg border border-slate-200 bg-white p-6 space-y-4">
            <h3 className="text-base font-semibold text-slate-900">1. Quy tắc tính ngày giường &amp; Cảnh báo</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Phương pháp tính ngày</label>
                <select
                  value={configs.day_calculation_method || 'CALENDAR_DAYS'}
                  onChange={(e) => setConfigs({ ...configs, day_calculation_method: e.target.value })}
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                >
                  <option value="CALENDAR_DAYS">Tính theo ngày lịch</option>
                  <option value="ACTUAL_HOURS">Tính theo số giờ thực tế</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Có tính ngày nhập viện?</label>
                <select
                  value={configs.include_admission_day || 'true'}
                  onChange={(e) => setConfigs({ ...configs, include_admission_day: e.target.value })}
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                >
                  <option value="true">Có tính ngày nhập viện (ngày 1)</option>
                  <option value="false">Không tính ngày nhập viện</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Quy tắc làm tròn</label>
                <select
                  value={configs.rounding_rule || 'CEIL'}
                  onChange={(e) => setConfigs({ ...configs, rounding_rule: e.target.value })}
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                >
                  <option value="CEIL">Làm tròn lên (CEIL)</option>
                  <option value="ROUND">Làm tròn gần nhất (ROUND)</option>
                  <option value="FLOOR">Làm tròn xuống (FLOOR)</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Giờ bắt đầu tính ngày (0-23)</label>
                <input
                  type="number"
                  min={0}
                  max={23}
                  value={configs.day_start_hour || '0'}
                  onChange={(e) => setConfigs({ ...configs, day_start_hour: e.target.value })}
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-mono tabular-nums"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Cảnh báo sắp trả giường trước (giờ)</label>
                <input
                  type="number"
                  min={1}
                  max={72}
                  value={configs.due_soon_hours || '24'}
                  onChange={(e) => setConfigs({ ...configs, due_soon_hours: e.target.value })}
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-mono tabular-nums"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Thời gian giữ chỗ mặc định (giờ)</label>
                <input
                  type="number"
                  min={1}
                  max={72}
                  value={configs.reservation_hold_hours || '12'}
                  onChange={(e) => setConfigs({ ...configs, reservation_hold_hours: e.target.value })}
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-mono tabular-nums"
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-xs font-medium text-slate-700 mb-1">Endpoint API HIS bệnh viện</label>
                <input
                  type="url"
                  value={configs.his_api_url || ''}
                  onChange={(e) => setConfigs({ ...configs, his_api_url: e.target.value })}
                  placeholder="https://his.benhvien.vn/api/v1/patients"
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-mono"
                />
              </div>
              <div className="flex items-end justify-end">
                <button type="submit" className="rounded-md bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-800">
                  Lưu cấu hình
                </button>
              </div>
            </div>
          </form>

          <div className="rounded-lg border border-slate-200 bg-white p-6 space-y-4">
            <h3 className="text-base font-semibold text-slate-900">2. Thời gian nằm dự kiến theo nhóm phân loại</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {diagnoses.map((d) => (
                <div key={d.id} className="rounded-md border border-slate-200 p-3 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-slate-900 truncate">{d.name}</div>
                    <div className="text-xs text-slate-500 truncate">{d.description}</div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <input
                      type="number"
                      min={1}
                      max={60}
                      defaultValue={d.default_days}
                      onBlur={(e) => {
                        const v = Number(e.target.value);
                        if (v !== d.default_days) handleUpdateDiagDays(d, v);
                      }}
                      aria-label={`Số ngày dự kiến cho ${d.name}`}
                      className="w-16 rounded border border-slate-300 px-2 py-1 text-right text-sm font-mono tabular-nums"
                    />
                    <span className="text-xs text-slate-500">ngày</span>
                  </div>
                </div>
              ))}
            </div>

            <form onSubmit={handleUpsertDiagnosis} className="flex flex-wrap gap-3 pt-3 border-t border-slate-100 items-end">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Thêm nhóm mới</label>
                <input type="text" required value={newDiagName} onChange={(e) => setNewDiagName(e.target.value)} placeholder="VD: Hậu sản đặc biệt" className="rounded-md border border-slate-300 px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Số ngày dự kiến</label>
                <input type="number" min={1} max={60} value={newDiagDays} onChange={(e) => setNewDiagDays(Number(e.target.value))} className="w-24 rounded-md border border-slate-300 px-3 py-2 text-sm font-mono tabular-nums" />
              </div>
              <button type="submit" className="rounded-md bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-800">
                Thêm nhóm
              </button>
            </form>
          </div>

          {userRole === 'SUPER_ADMIN' && (
            <div className="rounded-lg border border-rose-200 bg-rose-50/50 p-5 flex flex-wrap items-center justify-between gap-4">
              <div>
                <h3 className="text-base font-semibold text-rose-900">Dữ liệu Demo &amp; Triển khai chính thức</h3>
                <p className="text-xs text-rose-800 mt-1">
                  Xóa toàn bộ bệnh nhân mẫu, đăng ký mẫu và lượt sử dụng mẫu trước khi đưa bệnh viện vào vận hành thật (giữ nguyên tài khoản, danh mục khoa/phòng/giường và thiết bị).
                </p>
              </div>
              <button
                type="button"
                onClick={() => setConfirmClearDemo(true)}
                className="rounded-md bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:bg-rose-700 whitespace-nowrap"
              >
                Xóa sạch dữ liệu demo
              </button>
            </div>
          )}

          <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 font-semibold text-sm text-slate-900">
              Nhật ký hoạt động hệ thống (Audit Log)
            </div>
            <div className="overflow-x-auto max-h-80">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                  <tr>
                    <th className="px-4 py-2 text-left">Thời gian</th>
                    <th className="px-4 py-2 text-left">Tài khoản</th>
                    <th className="px-4 py-2 text-left">Thiết bị</th>
                    <th className="px-4 py-2 text-left">Hành động</th>
                    <th className="px-4 py-2 text-left">Chi tiết</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {auditLogs.map((a) => (
                    <tr key={String(a.id)}>
                      <td className="px-4 py-2 font-mono text-slate-500">{formatDateTimeVN(String(a.created_at))}</td>
                      <td className="px-4 py-2 font-medium text-slate-900">{String(a.username)}</td>
                      <td className="px-4 py-2 font-mono text-slate-600">{String(a.device_id)}</td>
                      <td className="px-4 py-2 font-semibold text-sky-800">{String(a.action)}</td>
                      <td className="px-4 py-2 text-slate-700">{String(a.details)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <ConfirmModal
            open={confirmClearDemo}
            title="Xóa dữ liệu demo trước khi dùng thật"
            description="Hành động này sẽ xóa toàn bộ bệnh nhân mẫu, đăng ký mẫu, giữ chỗ mẫu và lượt nằm mẫu trên tất cả các máy trạm. Danh mục Khoa, Phòng, Giường và Tài khoản vẫn được giữ nguyên."
            danger
            confirmLabel="Xác nhận xóa dữ liệu demo"
            onConfirm={handleClearDemo}
            onCancel={() => setConfirmClearDemo(false)}
          />
        </div>
      )}
    </div>
  );
}
