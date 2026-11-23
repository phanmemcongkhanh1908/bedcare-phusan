import {
  AlertTriangle,
  ArrowRight,
  BedDouble,
  CalendarClock,
  Check,
  CheckCircle2,
  ClipboardCheck,
  Copy,
  Filter,
  LogIn,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { BedType, DiagnosisConfig, RoomStandard } from '../../types/bedcare';
import { formatDateTimeVN, toLocalDateTimeInputValue } from '../../utils/formatters';
import {
  clearServiceOutage,
  computeWsReconnectDelayMs,
  detectServiceOutage,
  getAutoSwitchFailover,
  getFailoverServerUrl,
  isServiceInOutageCooldown,
  isUsingFailoverServer,
  loadReadCache,
  recordServiceOutage,
  resolveApiUrl,
  resolveWsUrl,
  saveReadCache,
  setActiveFailoverMode,
} from '../../utils/networkResilience';

interface PublicVacantBed {
  id: string;
  code: string;
  name: string;
  bed_type_name: string;
  daily_price: number;
  hourly_price: number;
}

interface PublicRoom {
  id: string;
  department_id: string;
  code: string;
  name: string;
  floor: string;
  capacity: number;
  toilet_type: string;
  room_type: string;
  is_service: boolean;
  exclusive_locked: boolean;
  occupancy_status?: string;
  can_reserve_single_bed?: boolean;
  reserve_block_reason?: string | null;
  can_book_whole_room: boolean;
  standard_ids: string[];
  standard_names: string[];
  total_beds: number;
  vacant_beds_count: number;
  min_daily_price: number;
  vacant_beds: PublicVacantBed[];
}

interface PublicDepartment {
  id: string;
  code: string;
  name: string;
  description: string;
  total_rooms: number;
  total_beds: number;
  vacant_beds: number;
}

interface PublicAvailabilityPayload {
  generatedAt: string;
  departments: PublicDepartment[];
  rooms: PublicRoom[];
  roomStandards: RoomStandard[];
  bedTypes: BedType[];
  diagnoses: DiagnosisConfig[];
}

interface BookingResult {
  id: string;
  registration_code: string;
  status: string;
  department_name: string;
  room_name: string;
  bed_code: string;
  expected_admission_date: string;
}

interface LookupBookingStatus {
  registration_code: string;
  status: string;
  reservation_type: string;
  expected_admission_date: string;
  created_at: string;
  created_by_name: string;
  department_name: string | null;
  room_name: string | null;
  bed_code: string | null;
}

interface RecentCustomerBooking {
  code: string;
  summary: string;
  createdAt: string;
}

interface CustomerPortalPageProps {
  onGoToStaffLogin: () => void;
}

type RoomTierFilter = 'ALL' | 'STANDARD' | 'SERVICE_VIP' | 'ISOLATION' | 'WHOLE_ROOM';
type SortMode = 'PRICE_ASC' | 'VACANT_DESC' | 'PRICE_DESC';
type AdmitPreset = 'IN_2H' | 'TOMORROW_AM' | 'TOMORROW_PM' | 'CUSTOM';

const RECENT_CODES_KEY = 'bedcare_customer_recent_codes_v1';

const ROOM_TYPE_LABELS: Record<string, string> = {
  STANDARD: 'Phòng tiêu chuẩn',
  SERVICE: 'Phòng dịch vụ',
  VIP: 'Phòng VIP',
  ISOLATION: 'Phòng cách ly',
};

const BOOKING_STATUS_TEXT: Record<string, { label: string; cls: string }> = {
  WAITING: { label: 'Chờ điều phối duyệt', cls: 'bg-amber-50 text-amber-800 border-amber-200' },
  RESERVED: { label: 'Đã xác nhận giữ chỗ', cls: 'bg-sky-50 text-sky-800 border-sky-200' },
  ADMITTED: { label: 'Đã tiếp nhận vào khoa', cls: 'bg-emerald-50 text-emerald-800 border-emerald-200' },
  CANCELLED: { label: 'Đã hủy yêu cầu', cls: 'bg-rose-50 text-rose-800 border-rose-200' },
};

const QUICK_NOTE_SUGGESTIONS = [
  'Có người nhà đi cùng',
  'Ưu tiên tầng thấp dễ đi lại',
  'Cần phòng yên tĩnh',
  'Cần hỗ trợ xe đẩy khi nhập viện',
];

function computeAdmitDateFromPreset(preset: AdmitPreset): string {
  const now = new Date();
  let target = new Date(now.getTime() + 2 * 3600000);
  if (preset === 'TOMORROW_AM') {
    target = new Date(now);
    target.setDate(target.getDate() + 1);
    target.setHours(8, 0, 0, 0);
  } else if (preset === 'TOMORROW_PM') {
    target = new Date(now);
    target.setDate(target.getDate() + 1);
    target.setHours(14, 0, 0, 0);
  }
  return toLocalDateTimeInputValue(target);
}

function readRecentCodes(): RecentCustomerBooking[] {
  try {
    const raw = localStorage.getItem(RECENT_CODES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, 5) : [];
  } catch {
    return [];
  }
}

export function CustomerPortalPage({ onGoToStaffLogin }: CustomerPortalPageProps) {
  const [data, setData] = useState<PublicAvailabilityPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Navigation & filter state
  const [mobileSection, setMobileSection] = useState<'BROWSE' | 'BOOKING'>('BROWSE');
  const [searchQuery, setSearchQuery] = useState('');
  const [deptFilter, setDeptFilter] = useState(() =>
    typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('dept')?.trim() || '' : ''
  );
  const [tierFilter, setTierFilter] = useState<RoomTierFilter>('ALL');
  const [sortMode, setSortMode] = useState<SortMode>('PRICE_ASC');
  const [selectedStdIds, setSelectedStdIds] = useState<string[]>([]);
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [onlyVacant, setOnlyVacant] = useState(true);

  // Booking form state
  const [patientName, setPatientName] = useState('');
  const [phone, setPhone] = useState('');
  const [dob, setDob] = useState('1992-01-01');
  const [diagGroup, setDiagGroup] = useState('Khác');
  const [admitPreset, setAdmitPreset] = useState<AdmitPreset>('IN_2H');
  const [expectedAdmit, setExpectedAdmit] = useState(() => computeAdmitDateFromPreset('IN_2H'));
  const [bookingDeptId, setBookingDeptId] = useState('');
  const [bookingRoomId, setBookingRoomId] = useState('');
  const [bookingBedId, setBookingBedId] = useState('');
  const [bookingType, setBookingType] = useState<'WAITLIST' | 'SINGLE_BED' | 'WHOLE_ROOM'>('SINGLE_BED');
  const [showManualRoomPicker, setShowManualRoomPicker] = useState(false);
  const [showOptionalDetails, setShowOptionalDetails] = useState(false);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [bookingReceipt, setBookingReceipt] = useState<BookingResult | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);

  // Lookup tracker state
  const [recentCodes, setRecentCodes] = useState<RecentCustomerBooking[]>(() => readRecentCodes());
  const [lookupCode, setLookupCode] = useState('');
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupResult, setLookupResult] = useState<LookupBookingStatus | null>(null);
  const [lookupError, setLookupError] = useState('');

  const diagInitializedRef = useRef(false);
  const deptDeepLinkAppliedRef = useRef(false);
  const inFlightAvailabilityRef = useRef(false);
  const [cachedNoticeAt, setCachedNoticeAt] = useState<string | null>(null);

  const loadAvailability = useCallback(async (manualRefresh = false) => {
    if (inFlightAvailabilityRef.current) return;
    if (!manualRefresh && isServiceInOutageCooldown()) {
      const cached = loadReadCache<PublicAvailabilityPayload>('/public/availability');
      if (cached) {
        setData(cached.data);
        setCachedNoticeAt(cached.savedAt);
        setLoading(false);
      }
      return;
    }

    inFlightAvailabilityRef.current = true;
    setLoading(true);
    setError('');
    try {
      let res = await fetch(resolveApiUrl('/public/availability'));
      let rawText = await res.text().catch(() => '');
      let outage = detectServiceOutage({
        status: res.status,
        contentType: res.headers.get('content-type'),
        bodyText: rawText,
        retryAfterHeader: res.headers.get('retry-after'),
      });

      if (outage.isOutage && getFailoverServerUrl() && !isUsingFailoverServer() && getAutoSwitchFailover()) {
        try {
          const backupUrl = `${getFailoverServerUrl()}/api/public/availability`;
          const backupRes = await fetch(backupUrl);
          const backupText = await backupRes.text().catch(() => '');
          const backupOutage = detectServiceOutage({
            status: backupRes.status,
            contentType: backupRes.headers.get('content-type'),
            bodyText: backupText,
            retryAfterHeader: backupRes.headers.get('retry-after'),
          });
          if (!backupOutage.isOutage && backupRes.ok) {
            setActiveFailoverMode(true);
            res = backupRes;
            rawText = backupText;
            outage = backupOutage;
          }
        } catch {
          // Keep primary outage notice
        }
      }

      if (outage.isOutage) {
        recordServiceOutage(outage.reason, res.status, outage.retryAfterMs);
        throw new Error(outage.reason);
      }

      const json = (rawText ? JSON.parse(rawText) : {}) as PublicAvailabilityPayload & { error?: string };
      if (!res.ok) throw new Error(json.error || 'Không thể tải danh mục giường trống.');
      clearServiceOutage();
      saveReadCache('/public/availability', json);
      setCachedNoticeAt(null);
      setData(json);
      if (!deptDeepLinkAppliedRef.current) {
        deptDeepLinkAppliedRef.current = true;
        const urlDept =
          typeof window !== 'undefined'
            ? new URLSearchParams(window.location.search).get('dept')?.trim() || ''
            : '';
        if (urlDept) {
          const matchedDept = json.departments.find((d) => d.id === urlDept);
          if (matchedDept) {
            setDeptFilter(matchedDept.id);
            setBookingDeptId((prev) => prev || matchedDept.id);
          } else {
            setDeptFilter('');
          }
        }
      }
      if (json.diagnoses.length > 0 && !diagInitializedRef.current) {
        diagInitializedRef.current = true;
        setDiagGroup((prev) =>
          json.diagnoses.some((d) => d.name === prev) ? prev : json.diagnoses[0].name
        );
      }
    } catch (err) {
      const cached = loadReadCache<PublicAvailabilityPayload>('/public/availability');
      if (cached) {
        setData(cached.data);
        setCachedNoticeAt(cached.savedAt);
        setError(`${(err as Error).message} Đang hiển thị bảng phòng lưu tạm gần nhất.`);
      } else {
        setError((err as Error).message);
      }
    } finally {
      inFlightAvailabilityRef.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAvailability();
  }, [loadAvailability]);

  // Listen for live updates over /ws/p2p ONLY when tab is visible, with exponential backoff + max attempts
  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const clearTimers = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    };

    const connect = () => {
      if (closed) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (!navigator.onLine || isServiceInOutageCooldown()) return;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

      ws = new WebSocket(resolveWsUrl());
      ws.onopen = () => {
        attempt = 0;
      };
      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(String(evt.data)) as { type?: string };
          if (msg.type === 'CLUSTER_EVENT_SYNC') {
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
              debounceTimer = null;
              if (!closed && document.visibilityState !== 'hidden' && !isServiceInOutageCooldown()) {
                loadAvailability();
              }
            }, 800);
          }
        } catch {
          // Ignore malformed WS message
        }
      };
      ws.onclose = () => {
        ws = null;
        if (closed) return;
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
        if (!navigator.onLine || isServiceInOutageCooldown()) return;
        attempt += 1;
        const delayMs = computeWsReconnectDelayMs(attempt, {
          maxAttempts: 6,
          baseDelayMs: 4000,
          maxDelayMs: 90_000,
        });
        if (delayMs === null) return;
        timer = setTimeout(connect, delayMs);
      };
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        clearTimers();
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
          ws.close();
          ws = null;
        }
      } else {
        attempt = 0;
        connect();
      }
    };

    const onOnline = () => {
      attempt = 0;
      connect();
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('online', onOnline);
    connect();

    return () => {
      closed = true;
      clearTimers();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('online', onOnline);
      ws?.close();
    };
  }, [loadAvailability]);

  const rooms = useMemo(() => data?.rooms ?? [], [data?.rooms]);
  const departments = useMemo(() => data?.departments ?? [], [data?.departments]);
  const standards = useMemo(() => data?.roomStandards ?? [], [data?.roomStandards]);
  const deptMap = useMemo(() => Object.fromEntries(departments.map((d) => [d.id, d.name])), [departments]);

  const filteredRooms = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const list = rooms.filter((r) => {
      if (deptFilter && r.department_id !== deptFilter) return false;
      if (onlyVacant && r.vacant_beds_count === 0) return false;
      if (tierFilter === 'STANDARD' && r.room_type !== 'STANDARD') return false;
      if (tierFilter === 'SERVICE_VIP' && r.room_type !== 'SERVICE' && r.room_type !== 'VIP') return false;
      if (tierFilter === 'ISOLATION' && r.room_type !== 'ISOLATION') return false;
      if (tierFilter === 'WHOLE_ROOM' && !(r.can_book_whole_room && r.capacity > 1)) return false;
      if (selectedStdIds.length > 0 && !selectedStdIds.every((sid) => r.standard_ids.includes(sid))) {
        return false;
      }
      if (q) {
        const hay = [
          r.name,
          r.code,
          deptMap[r.department_id] || '',
          r.floor,
          ...r.standard_names,
          ...r.vacant_beds.map((b) => `${b.code} ${b.bed_type_name}`),
        ]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    return [...list].sort((a, b) => {
      if (sortMode === 'VACANT_DESC') {
        return b.vacant_beds_count - a.vacant_beds_count || a.min_daily_price - b.min_daily_price;
      }
      if (sortMode === 'PRICE_DESC') {
        return b.min_daily_price - a.min_daily_price;
      }
      const priceA = a.min_daily_price > 0 ? a.min_daily_price : Number.MAX_SAFE_INTEGER;
      const priceB = b.min_daily_price > 0 ? b.min_daily_price : Number.MAX_SAFE_INTEGER;
      return priceA - priceB || b.vacant_beds_count - a.vacant_beds_count;
    });
  }, [rooms, deptFilter, onlyVacant, tierFilter, selectedStdIds, searchQuery, deptMap, sortMode]);

  const activeFilterCount =
    (deptFilter ? 1 : 0) +
    (tierFilter !== 'ALL' ? 1 : 0) +
    selectedStdIds.length +
    (searchQuery.trim() ? 1 : 0) +
    (!onlyVacant ? 1 : 0);

  const resetAllFilters = () => {
    setDeptFilter('');
    setTierFilter('ALL');
    setSelectedStdIds([]);
    setSearchQuery('');
    setOnlyVacant(true);
  };

  const selectedRoomObj = useMemo(() => rooms.find((r) => r.id === bookingRoomId) || null, [rooms, bookingRoomId]);
  const selectedBedObj = useMemo(
    () => selectedRoomObj?.vacant_beds.find((b) => b.id === bookingBedId) || null,
    [selectedRoomObj, bookingBedId]
  );

  const wholeRoomDailyEstimate = useMemo(() => {
    if (!selectedRoomObj) return 0;
    return selectedRoomObj.vacant_beds.reduce((sum, b) => sum + b.daily_price, 0);
  }, [selectedRoomObj]);

  const selectBedForBooking = (room: PublicRoom, bed: PublicVacantBed) => {
    setBookingDeptId(room.department_id);
    setBookingRoomId(room.id);
    setBookingBedId(bed.id);
    setBookingType('SINGLE_BED');
    setShowManualRoomPicker(false);
    setSubmitError('');
    setBookingReceipt(null);
    if (window.innerWidth >= 1024) {
      document.getElementById('cp-name')?.focus();
    }
  };

  const selectWholeRoomForBooking = (room: PublicRoom) => {
    setBookingDeptId(room.department_id);
    setBookingRoomId(room.id);
    setBookingBedId('');
    setBookingType('WHOLE_ROOM');
    setShowManualRoomPicker(false);
    setSubmitError('');
    setBookingReceipt(null);
    if (window.innerWidth >= 1024) {
      document.getElementById('cp-name')?.focus();
    }
  };

  const switchToWaitlistAssist = (deptId = '') => {
    setBookingType('WAITLIST');
    setBookingDeptId(deptId || deptFilter || '');
    setBookingRoomId('');
    setBookingBedId('');
    setShowManualRoomPicker(false);
    setMobileSection('BOOKING');
    setTimeout(() => {
      document.getElementById('cp-name')?.focus();
    }, 80);
  };

  const handleSelectAdmitPreset = (preset: AdmitPreset) => {
    setAdmitPreset(preset);
    if (preset !== 'CUSTOM') {
      setExpectedAdmit(computeAdmitDateFromPreset(preset));
    }
  };

  const appendQuickNote = (snippet: string) => {
    setNotes((prev) => {
      const clean = prev.trim();
      if (!clean) return snippet;
      if (clean.toLowerCase().includes(snippet.toLowerCase())) return prev;
      return `${clean}; ${snippet}`;
    });
  };

  const formRooms = rooms.filter(
    (r) =>
      (!bookingDeptId || r.department_id === bookingDeptId) &&
      r.vacant_beds_count > 0 &&
      (bookingType === 'WHOLE_ROOM' ? r.can_book_whole_room : r.can_reserve_single_bed !== false)
  );

  const handleSubmitBooking = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitError('');

    const cleanPhone = phone.replace(/\s+/g, '');
    const phoneDigits = cleanPhone.replace(/\D/g, '');
    if (phoneDigits.length < 8 || phoneDigits.length > 15) {
      setSubmitError('Vui lòng nhập số điện thoại liên hệ hợp lệ (8–15 chữ số).');
      return;
    }

    const parsedAdmitDate = new Date(expectedAdmit);
    if (!expectedAdmit || Number.isNaN(parsedAdmitDate.getTime())) {
      setSubmitError('Vui lòng chọn ngày giờ dự kiến nhập viện hợp lệ.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(resolveApiUrl('/public/bookings'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          patient_name: patientName,
          phone: cleanPhone,
          date_of_birth: dob,
          diagnosis_group: diagGroup,
          expected_admission_date: parsedAdmitDate.toISOString(),
          desired_standard_ids: selectedStdIds,
          department_id: bookingDeptId || null,
          room_id: bookingType === 'WAITLIST' ? null : bookingRoomId || null,
          bed_id: bookingType === 'SINGLE_BED' ? bookingBedId || null : null,
          booking_type: bookingType,
          notes,
        }),
      });
      const rawText = await res.text().catch(() => '');
      const outage = detectServiceOutage({
        status: res.status,
        contentType: res.headers.get('content-type'),
        bodyText: rawText,
        retryAfterHeader: res.headers.get('retry-after'),
      });
      if (outage.isOutage) {
        recordServiceOutage(outage.reason, res.status, outage.retryAfterMs);
        throw new Error(`${outage.reason} Quý khách vui lòng thử lại sau hoặc gọi trực tiếp quầy Tiếp nhận bệnh viện.`);
      }
      const json = (rawText ? JSON.parse(rawText) : {}) as BookingResult & { error?: string };
      if (!res.ok) throw new Error(json.error || 'Không thể gửi đăng ký.');

      setBookingReceipt(json);
      setLookupCode(json.registration_code);
      setCopiedCode(false);

      const summary = [json.department_name, json.room_name, json.bed_code].filter(Boolean).join(' · ');
      const updatedRecent = [
        { code: json.registration_code, summary, createdAt: new Date().toISOString() },
        ...recentCodes.filter((x) => x.code !== json.registration_code),
      ].slice(0, 5);
      setRecentCodes(updatedRecent);
      try {
        localStorage.setItem(RECENT_CODES_KEY, JSON.stringify(updatedRecent));
      } catch {
        // Ignore storage errors
      }

      setPatientName('');
      setPhone('');
      setNotes('');
      await loadAvailability(true);
    } catch (err) {
      setSubmitError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const fetchLookupCode = async (codeToLookup: string) => {
    const clean = codeToLookup.trim();
    if (!clean) return;
    setLookupCode(clean);
    setLookupLoading(true);
    setLookupError('');
    setLookupResult(null);
    try {
      const res = await fetch(resolveApiUrl(`/public/bookings/${encodeURIComponent(clean)}`));
      const rawText = await res.text().catch(() => '');
      const outage = detectServiceOutage({
        status: res.status,
        contentType: res.headers.get('content-type'),
        bodyText: rawText,
        retryAfterHeader: res.headers.get('retry-after'),
      });
      if (outage.isOutage) {
        recordServiceOutage(outage.reason, res.status, outage.retryAfterMs);
        throw new Error(outage.reason);
      }
      const json = (rawText ? JSON.parse(rawText) : {}) as LookupBookingStatus & { error?: string };
      if (!res.ok) throw new Error(json.error || 'Không tìm thấy mã đăng ký.');
      setLookupResult(json);
    } catch (err) {
      setLookupError((err as Error).message);
    } finally {
      setLookupLoading(false);
    }
  };

  const handleLookupBooking = async (e: FormEvent) => {
    e.preventDefault();
    await fetchLookupCode(lookupCode);
  };

  const handleCopyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
    } catch {
      // Ignore clipboard permission errors
    }
  };

  const totalVacantHospital = departments.reduce((sum, d) => sum + d.vacant_beds, 0);
  const totalOperationalHospital = departments.reduce((sum, d) => sum + d.total_beds, 0);
  const allPrices = rooms.map((r) => r.min_daily_price).filter((p) => p > 0);
  const lowestDailyPrice = allPrices.length > 0 ? Math.min(...allPrices) : 0;

  const hasExplicitSelection =
    (bookingType === 'SINGLE_BED' && Boolean(selectedBedObj && selectedRoomObj)) ||
    (bookingType === 'WHOLE_ROOM' && Boolean(selectedRoomObj));

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 pb-20 lg:pb-8">
      {/* Compact 1-row Top Bar (~56px) */}
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="h-8 w-8 rounded-lg bg-sky-800 text-white flex items-center justify-center font-bold text-xs shrink-0">
              BC
            </div>
            <span className="font-bold text-sm sm:text-base text-slate-900 truncate">
              <span className="sm:hidden">Đặt giường BEDCARE</span>
              <span className="hidden sm:inline">Cổng Đặt giường BEDCARE</span>
            </span>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => {
                clearServiceOutage();
                loadAvailability(true);
              }}
              aria-label="Làm mới danh sách phòng trống"
              className="min-h-[40px] inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">Làm mới</span>
            </button>
            <button
              type="button"
              onClick={onGoToStaffLogin}
              aria-label="Đăng nhập Nhân viên"
              className="min-h-[40px] inline-flex items-center gap-1.5 rounded-md bg-sky-800 px-3 sm:px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-sky-900 whitespace-nowrap"
            >
              <LogIn className="h-3.5 w-3.5" />
              <span className="sm:hidden">Nhân viên</span>
              <span className="hidden sm:inline">Đăng nhập Nhân viên</span>
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-4 sm:py-6 space-y-4">
        {/* Compact Scannable Summary Strip — keeps rooms immediately above the fold */}
        <section className="rounded-xl border border-slate-200 bg-white px-4 py-3.5 sm:px-5 sm:py-4 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div className="space-y-1">
            <h1 className="text-lg sm:text-xl font-bold text-slate-900 text-balance">
              Chọn phòng &amp; gửi yêu cầu đặt giường trực tuyến
            </h1>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600">
              <span className="inline-flex items-center gap-1 text-emerald-700 font-medium">
                <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
                Số liệu cập nhật trực tiếp từ khoa nội trú
              </span>
              <span aria-hidden="true" className="text-slate-300">·</span>
              <span>Chạm 1 lần vào giường để đặt trước</span>
              <span aria-hidden="true" className="text-slate-300">·</span>
              <span>Thu viện phí xác nhận qua điện thoại</span>
            </div>
          </div>

          <div className="flex items-center gap-5 border-t md:border-t-0 pt-2.5 md:pt-0 border-slate-100 shrink-0 text-xs">
            <div>
              <div className="text-slate-500">Giường trống</div>
              <div className="font-mono tabular-nums text-base sm:text-lg font-bold text-emerald-700">
                {totalVacantHospital}/{totalOperationalHospital}
              </div>
            </div>
            <div className="h-7 w-px bg-slate-200" aria-hidden="true" />
            <div>
              <div className="text-slate-500">Đơn giá từ</div>
              <div className="font-mono tabular-nums text-base sm:text-lg font-bold text-slate-900">
                {lowestDailyPrice > 0 ? `${lowestDailyPrice.toLocaleString('vi-VN')}đ/ngày` : '—'}
              </div>
            </div>
            <div className="h-7 w-px bg-slate-200" aria-hidden="true" />
            <div>
              <div className="text-slate-500">Quy mô</div>
              <div className="font-mono tabular-nums text-base sm:text-lg font-bold text-slate-900">
                {departments.length} khoa
              </div>
            </div>
          </div>
        </section>

        {/* Mobile 2-tab Switcher (Browse vs Form/Lookup) */}
        <div className="lg:hidden grid grid-cols-2 gap-1 p-1 bg-slate-200/70 rounded-lg" role="tablist" aria-label="Chuyển đổi danh sách phòng và phiếu đặt">
          <button
            type="button"
            role="tab"
            aria-selected={mobileSection === 'BROWSE'}
            onClick={() => setMobileSection('BROWSE')}
            className={`min-h-[44px] rounded-md text-xs font-semibold transition-colors ${
              mobileSection === 'BROWSE' ? 'bg-white text-sky-900 shadow-sm' : 'text-slate-600'
            }`}
          >
            1. Xem phòng trống ({filteredRooms.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mobileSection === 'BOOKING'}
            onClick={() => setMobileSection('BOOKING')}
            className={`min-h-[44px] rounded-md text-xs font-semibold transition-colors ${
              mobileSection === 'BOOKING' ? 'bg-white text-sky-900 shadow-sm' : 'text-slate-600'
            }`}
          >
            2. Đặt giường {hasExplicitSelection ? '(Đã chọn ✓)' : '& Tra cứu'}
          </button>
        </div>

        {(error || cachedNoticeAt) && (
          <div
            role="alert"
            className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 flex flex-wrap items-center justify-between gap-3"
          >
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-700 shrink-0 mt-0.5" />
              <div>
                <div>{error || 'Đang hiển thị bảng phòng lưu tạm gần nhất.'}</div>
                {cachedNoticeAt && (
                  <div className="text-xs text-amber-800 mt-0.5">
                    Dữ liệu đệm cập nhật lúc {formatDateTimeVN(cachedNoticeAt)}.
                  </div>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                clearServiceOutage();
                loadAvailability(true);
              }}
              className="rounded-md border border-amber-300 bg-white px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-100"
            >
              Thử tải lại
            </button>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
          {/* Left Column: High-Scannability Catalog & 1-Tap Room/Bed Picker (7 cols) */}
          <div className={`lg:col-span-7 space-y-3.5 ${mobileSection === 'BOOKING' ? 'hidden lg:block' : 'block'}`}>
            {/* 1-Row Scrollable Department Tabs */}
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1" role="tablist" aria-label="Lọc theo khoa điều trị">
              <button
                type="button"
                role="tab"
                aria-selected={deptFilter === ''}
                onClick={() => setDeptFilter('')}
                className={`min-h-[40px] shrink-0 whitespace-nowrap rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors ${
                  deptFilter === ''
                    ? 'border-sky-700 bg-sky-800 text-white'
                    : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                }`}
              >
                Tất cả các khoa ({totalVacantHospital})
              </button>
              {departments.map((d) => {
                const isSelected = deptFilter === d.id;
                const noRoomLeft = d.vacant_beds === 0;
                return (
                  <button
                    key={d.id}
                    type="button"
                    role="tab"
                    aria-selected={isSelected}
                    onClick={() => setDeptFilter(d.id)}
                    className={`min-h-[40px] shrink-0 whitespace-nowrap rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors flex items-center gap-1.5 ${
                      isSelected
                        ? 'border-sky-700 bg-sky-800 text-white font-semibold'
                        : noRoomLeft
                          ? 'border-slate-200 bg-slate-100/70 text-slate-400 hover:text-slate-600'
                          : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    <span>{d.name}</span>
                    <span
                      className={`font-mono tabular-nums ${
                        isSelected ? 'text-sky-100' : noRoomLeft ? 'text-slate-400' : 'text-emerald-700 font-semibold'
                      }`}
                    >
                      ({d.vacant_beds}/{d.total_beds})
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Unified Search + Tier Filter + Sort Toolbar */}
            <div className="rounded-xl border border-slate-200 bg-white p-3.5 space-y-2.5">
              <div className="flex flex-col sm:flex-row gap-2">
                <div className="relative flex-1">
                  <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="search"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Tìm tên phòng, mã giường, tiện nghi (VD: máy lạnh, C101)..."
                    aria-label="Tìm phòng hoặc tiện nghi"
                    className="w-full min-h-[40px] rounded-lg border border-slate-200 bg-slate-50 pl-9 pr-8 py-1.5 text-xs sm:text-sm focus:bg-white focus:border-sky-600 focus:outline-none"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={() => setSearchQuery('')}
                      aria-label="Xóa từ khóa tìm kiếm"
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-700"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <select
                    aria-label="Sắp xếp danh sách phòng"
                    value={sortMode}
                    onChange={(e) => setSortMode(e.target.value as SortMode)}
                    className="min-h-[40px] rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700"
                  >
                    <option value="PRICE_ASC">Giá: Thấp → Cao</option>
                    <option value="VACANT_DESC">Nhiều giường trống nhất</option>
                    <option value="PRICE_DESC">Giá: Cao → Thấp</option>
                  </select>

                  <button
                    type="button"
                    onClick={() => setShowAdvancedFilters((v) => !v)}
                    aria-expanded={showAdvancedFilters}
                    className={`min-h-[40px] inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors ${
                      showAdvancedFilters || selectedStdIds.length > 0
                        ? 'border-sky-600 bg-sky-50 text-sky-800'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    <SlidersHorizontal className="h-3.5 w-3.5" />
                    <span>Tiện nghi{selectedStdIds.length > 0 ? ` (${selectedStdIds.length})` : ''}</span>
                  </button>
                </div>
              </div>

              {/* Room Tier Segmented Quick Filter + Count */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1 overflow-x-auto pb-0.5">
                  {[
                    { id: 'ALL', label: 'Tất cả' },
                    { id: 'STANDARD', label: 'Tiêu chuẩn (BHYT)' },
                    { id: 'SERVICE_VIP', label: 'Dịch vụ / VIP' },
                    { id: 'ISOLATION', label: 'Cách ly' },
                    { id: 'WHOLE_ROOM', label: 'Bao trọn phòng' },
                  ].map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setTierFilter(item.id as RoomTierFilter)}
                      className={`min-h-[34px] shrink-0 whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                        tierFilter === item.id
                          ? 'bg-sky-100 text-sky-900 font-semibold'
                          : 'text-slate-600 hover:bg-slate-100'
                      }`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>

                <div className="flex items-center gap-3 text-xs">
                  <label className="inline-flex items-center gap-1.5 text-slate-600 cursor-pointer whitespace-nowrap">
                    <input
                      type="checkbox"
                      checked={onlyVacant}
                      onChange={(e) => setOnlyVacant(e.target.checked)}
                      className="rounded border-slate-300"
                    />
                    <span>Chỉ hiện còn trống</span>
                  </label>
                  <span className="font-mono tabular-nums text-slate-500 whitespace-nowrap">
                    {filteredRooms.length} phòng
                  </span>
                </div>
              </div>

              {/* Collapsible Amenity Checklist */}
              {showAdvancedFilters && (
                <div className="border-t border-slate-100 pt-2.5 space-y-2">
                  <div className="flex items-center justify-between text-xs text-slate-600">
                    <span className="inline-flex items-center gap-1.5 font-medium">
                      <Filter className="h-3.5 w-3.5 text-sky-700" />
                      Chọn nhiều tiện nghi mong muốn:
                    </span>
                    {activeFilterCount > 0 && (
                      <button
                        type="button"
                        onClick={resetAllFilters}
                        className="text-sky-700 hover:underline font-medium"
                      >
                        Đặt lại bộ lọc
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {standards.map((s) => {
                      const active = selectedStdIds.includes(s.id);
                      return (
                        <button
                          key={s.id}
                          type="button"
                          onClick={() =>
                            setSelectedStdIds((prev) =>
                              prev.includes(s.id) ? prev.filter((x) => x !== s.id) : [...prev, s.id]
                            )
                          }
                          className={`min-h-[34px] rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                            active
                              ? 'border-sky-700 bg-sky-700 text-white'
                              : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
                          }`}
                        >
                          {s.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Room & Bed Cards */}
            {loading ? (
              <div className="space-y-3">
                <div className="h-40 rounded-xl border border-slate-200 bg-white animate-pulse" />
                <div className="h-40 rounded-xl border border-slate-200 bg-white animate-pulse" />
              </div>
            ) : filteredRooms.length === 0 ? (
              <div className="rounded-xl border border-slate-200 bg-white p-6 text-center space-y-3">
                <div className="text-sm font-medium text-slate-700">
                  Không có phòng trống khớp bộ lọc hiện tại.
                </div>
                <p className="text-xs text-slate-500 max-w-md mx-auto">
                  Quý khách có thể xem tất cả các phòng còn trống khác hoặc gửi yêu cầu để điều phối viên tự động sắp xếp phòng phù hợp nhất ngay khi có giường.
                </p>
                <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                  {activeFilterCount > 0 && (
                    <button
                      type="button"
                      onClick={resetAllFilters}
                      className="min-h-[40px] rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                    >
                      Xóa bộ lọc ({activeFilterCount})
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => switchToWaitlistAssist(deptFilter)}
                    className="min-h-[40px] rounded-lg bg-sky-800 px-4 py-2 text-xs font-semibold text-white hover:bg-sky-900"
                  >
                    Nhờ khoa tự xếp giường phù hợp
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {filteredRooms.map((room) => {
                  const wholeRoomPrice = room.vacant_beds.reduce((sum, b) => sum + b.daily_price, 0);
                  const isWholeSelected = bookingRoomId === room.id && bookingType === 'WHOLE_ROOM';
                  return (
                    <article
                      key={room.id}
                      className={`rounded-xl border bg-white p-4 sm:p-5 space-y-3 transition-colors ${
                        bookingRoomId === room.id ? 'border-sky-600 ring-1 ring-sky-200' : 'border-slate-200'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3 border-b border-slate-100 pb-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                            <h2 className="text-base font-bold text-slate-900">{room.name}</h2>
                            <span className="text-xs font-medium text-sky-800">
                              {ROOM_TYPE_LABELS[room.room_type] || room.room_type}
                            </span>
                          </div>
                          <div className="text-xs text-slate-500 mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                            <span className="font-medium text-slate-700">{deptMap[room.department_id] || ''}</span>
                            <span aria-hidden="true">·</span>
                            <span>{room.floor}</span>
                            <span aria-hidden="true">·</span>
                            <span>{room.capacity} giường</span>
                            <span aria-hidden="true">·</span>
                            <span>{room.toilet_type === 'INTERNAL' ? 'Toilet riêng trong phòng' : 'Toilet dùng chung'}</span>
                          </div>
                        </div>

                        <div className="text-right shrink-0">
                          <div className="font-mono tabular-nums text-sm font-bold text-slate-900">
                            {room.min_daily_price > 0
                              ? `${room.min_daily_price.toLocaleString('vi-VN')}đ/ngày`
                              : 'Liên hệ giá'}
                          </div>
                          <div
                            className={`text-xs font-mono tabular-nums font-semibold mt-0.5 ${
                              room.vacant_beds_count > 0 ? 'text-emerald-700' : 'text-slate-400'
                            }`}
                          >
                            Còn {room.vacant_beds_count}/{room.total_beds} giường
                          </div>
                        </div>
                      </div>

                      {room.standard_names.length > 0 && (
                        <p className="text-xs text-slate-600 leading-relaxed">
                          <span className="text-slate-500">Tiện nghi: </span>
                          <span className="font-medium text-slate-800">{room.standard_names.join(' · ')}</span>
                        </p>
                      )}

                      {room.vacant_beds.length > 0 ? (
                        room.can_reserve_single_bed === false ? (
                          <div className="space-y-2 pt-1">
                            <div className="rounded-lg border border-sky-200 bg-sky-50/70 px-3.5 py-2.5 text-xs text-sky-900 flex flex-wrap items-center justify-between gap-2">
                              <span>
                                Phòng hiện có {room.vacant_beds_count} giường trống nhưng đã có sản phụ đang nằm điều trị nên không nhận đặt giữ lẻ trực tuyến.
                              </span>
                              <button
                                type="button"
                                onClick={() => switchToWaitlistAssist(room.department_id)}
                                className="font-semibold text-sky-800 hover:underline whitespace-nowrap"
                              >
                                Nhờ khoa xếp giường tương đương →
                              </button>
                            </div>
                          </div>
                        ) : (
                        <div className="space-y-2">
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            {room.vacant_beds.map((bed) => {
                              const isPicked = bookingBedId === bed.id && bookingType === 'SINGLE_BED';
                              return (
                                <button
                                  key={bed.id}
                                  type="button"
                                  onClick={() => selectBedForBooking(room, bed)}
                                  className={`min-h-[52px] text-left rounded-lg border px-3.5 py-2.5 transition-colors flex items-center justify-between gap-3 ${
                                    isPicked
                                      ? 'border-sky-700 bg-sky-50 ring-2 ring-sky-200'
                                      : 'border-slate-200 bg-slate-50/60 hover:border-emerald-400 hover:bg-emerald-50/50'
                                  }`}
                                >
                                  <div className="min-w-0">
                                    <div className="flex items-center gap-1.5">
                                      <BedDouble
                                        className={`h-4 w-4 shrink-0 ${isPicked ? 'text-sky-700' : 'text-emerald-700'}`}
                                      />
                                      <span className="font-mono text-sm font-bold text-slate-900">{bed.code}</span>
                                    </div>
                                    <div className="text-xs text-slate-600 truncate mt-0.5">{bed.bed_type_name}</div>
                                  </div>
                                  <div className="text-right shrink-0">
                                    <div className="font-mono tabular-nums text-xs font-bold text-slate-900">
                                      {bed.daily_price.toLocaleString('vi-VN')}đ/ngày
                                    </div>
                                    <div
                                      className={`text-xs font-semibold mt-0.5 ${
                                        isPicked ? 'text-sky-800' : 'text-emerald-700'
                                      }`}
                                    >
                                      {isPicked ? 'Đang chọn ✓' : 'Chọn giường'}
                                    </div>
                                  </div>
                                </button>
                              );
                            })}
                          </div>

                          {room.can_book_whole_room && room.capacity > 1 && (
                            <button
                              type="button"
                              onClick={() => selectWholeRoomForBooking(room)}
                              className={`w-full min-h-[44px] rounded-lg border px-3.5 py-2 text-xs font-semibold transition-colors flex items-center justify-between gap-2 ${
                                isWholeSelected
                                  ? 'border-amber-700 bg-amber-600 text-white'
                                  : 'border-amber-300 bg-amber-50/70 text-amber-900 hover:bg-amber-100'
                              }`}
                            >
                              <span>
                                {isWholeSelected
                                  ? `✓ Đã chọn bao trọn ${room.name} (${room.capacity} giường)`
                                  : `Bao trọn cả ${room.name} (${room.capacity} giường riêng tư)`}
                              </span>
                              {wholeRoomPrice > 0 && (
                                <span className="font-mono tabular-nums shrink-0">
                                  {wholeRoomPrice.toLocaleString('vi-VN')}đ/ngày
                                </span>
                              )}
                            </button>
                          )}
                        </div>
                        )
                      ) : (
                        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 pt-1">
                          <span>Phòng hiện đang kín giường hoặc chờ vệ sinh.</span>
                          <button
                            type="button"
                            onClick={() => switchToWaitlistAssist(room.department_id)}
                            className="font-semibold text-sky-700 hover:underline"
                          >
                            Đăng ký chờ phòng trống khoa này →
                          </button>
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </div>

          {/* Right Column: Minimalist Booking Form + Receipt + Lookup (5 cols) */}
          <div className={`lg:col-span-5 space-y-4 lg:sticky lg:top-20 ${mobileSection === 'BROWSE' ? 'hidden lg:block' : 'block'}`}>
            <form
              id="customer-booking-form"
              onSubmit={handleSubmitBooking}
              className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5 space-y-4 shadow-sm"
            >
              <div className="flex items-start justify-between gap-2 border-b border-slate-100 pb-3">
                <div>
                  <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
                    <CalendarClock className="h-4 w-4 text-sky-700" />
                    <span>Thông tin đặt giường</span>
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Chỉ cần nhập Họ tên &amp; Số điện thoại để hoàn tất trong 30 giây.
                  </p>
                </div>
              </div>

              {bookingReceipt && (
                <div role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 space-y-2 text-xs text-emerald-950">
                  <div className="flex items-center gap-1.5 font-bold text-sm text-emerald-900">
                    <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
                    <span>Đã tiếp nhận yêu cầu đặt giường!</span>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2 bg-white rounded-md border border-emerald-200 px-3 py-2">
                    <div>
                      <span className="text-slate-500">Mã phiếu: </span>
                      <strong className="font-mono text-sm text-sky-900">{bookingReceipt.registration_code}</strong>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleCopyCode(bookingReceipt.registration_code)}
                      className="inline-flex items-center gap-1 text-xs font-semibold text-sky-800 hover:underline"
                    >
                      {copiedCode ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
                      <span>{copiedCode ? 'Đã sao chép' : 'Sao chép mã'}</span>
                    </button>
                  </div>
                  <div>
                    Khoa/Phòng: <strong>{bookingReceipt.department_name}</strong>
                    {bookingReceipt.room_name ? ` · ${bookingReceipt.room_name}` : ''}
                    {bookingReceipt.bed_code ? ` · ${bookingReceipt.bed_code}` : ''}
                  </div>
                  <div className="text-emerald-800">
                    Thu viện phí đã nhận thông tin và sẽ gọi xác nhận giữ chỗ qua số điện thoại của quý khách.
                  </div>
                </div>
              )}

              {submitError && (
                <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs text-rose-800">
                  {submitError}
                </div>
              )}

              {/* Visual Selected Bed/Room Summary Box (Eliminates repetitive dropdown selection!) */}
              <div
                className={`rounded-lg border p-3.5 space-y-2 ${
                  hasExplicitSelection
                    ? 'border-sky-200 bg-sky-50/70'
                    : 'border-slate-200 bg-slate-50'
                }`}
              >
                {bookingType === 'SINGLE_BED' && selectedBedObj && selectedRoomObj ? (
                  <div className="flex items-start justify-between gap-2">
                    <div className="space-y-0.5">
                      <div className="text-[11px] font-semibold text-sky-800">Vị trí đã chọn</div>
                      <div className="text-sm font-bold text-slate-900">
                        {selectedRoomObj.name} · <span className="font-mono">{selectedBedObj.code}</span>
                      </div>
                      <div className="text-xs text-slate-600">
                        {deptMap[selectedRoomObj.department_id]} · {selectedBedObj.bed_type_name}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-mono tabular-nums text-sm font-bold text-sky-900">
                        {selectedBedObj.daily_price.toLocaleString('vi-VN')}đ/ngày
                      </div>
                      <button
                        type="button"
                        onClick={() => setShowManualRoomPicker((v) => !v)}
                        className="text-xs font-semibold text-sky-700 hover:underline mt-0.5"
                      >
                        {showManualRoomPicker ? 'Thu gọn' : 'Đổi giường'}
                      </button>
                    </div>
                  </div>
                ) : bookingType === 'WHOLE_ROOM' && selectedRoomObj ? (
                  <div className="flex items-start justify-between gap-2">
                    <div className="space-y-0.5">
                      <div className="text-[11px] font-semibold text-amber-800">Bao trọn toàn phòng</div>
                      <div className="text-sm font-bold text-slate-900">
                        {selectedRoomObj.name} ({selectedRoomObj.capacity} giường)
                      </div>
                      <div className="text-xs text-slate-600">{deptMap[selectedRoomObj.department_id]}</div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-mono tabular-nums text-sm font-bold text-amber-900">
                        {wholeRoomDailyEstimate.toLocaleString('vi-VN')}đ/ngày
                      </div>
                      <button
                        type="button"
                        onClick={() => setShowManualRoomPicker((v) => !v)}
                        className="text-xs font-semibold text-sky-700 hover:underline mt-0.5"
                      >
                        {showManualRoomPicker ? 'Thu gọn' : 'Đổi phòng'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="text-xs font-semibold text-slate-800">
                        {bookingType === 'WAITLIST'
                          ? 'Nhờ điều phối viên xếp phòng phù hợp'
                          : 'Chưa chọn giường cụ thể'}
                      </div>
                      <div className="text-xs text-slate-500">
                        Chạm chọn trực tiếp 1 giường ở danh sách, hoặc để khoa chủ động sắp xếp.
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowManualRoomPicker((v) => !v)}
                      className="text-xs font-semibold text-sky-700 hover:underline shrink-0"
                    >
                      {showManualRoomPicker ? 'Ẩn chọn nhanh' : 'Chọn tại đây'}
                    </button>
                  </div>
                )}

                {/* Collapsible Manual Dept/Room/Bed Override (Hidden by default when bed clicked!) */}
                {showManualRoomPicker && (
                  <div className="border-t border-slate-200/80 pt-3 space-y-2.5">
                    <div className="grid grid-cols-3 gap-1 p-1 bg-white border border-slate-200 rounded-lg text-xs">
                      {[
                        { id: 'SINGLE_BED', label: '1 giường' },
                        { id: 'WHOLE_ROOM', label: 'Bao phòng' },
                        { id: 'WAITLIST', label: 'Nhờ xếp' },
                      ].map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => {
                            setBookingType(t.id as typeof bookingType);
                            if (t.id === 'WAITLIST') {
                              setBookingRoomId('');
                              setBookingBedId('');
                            } else if (t.id === 'WHOLE_ROOM') {
                              setBookingBedId('');
                            }
                          }}
                          className={`min-h-[34px] rounded-md font-medium px-2 transition-colors ${
                            bookingType === t.id ? 'bg-sky-800 text-white' : 'text-slate-600 hover:bg-slate-50'
                          }`}
                        >
                          {t.label}
                        </button>
                      ))}
                    </div>

                    <select
                      aria-label="Khoa dự kiến"
                      value={bookingDeptId}
                      onChange={(e) => {
                        setBookingDeptId(e.target.value);
                        setBookingRoomId('');
                        setBookingBedId('');
                      }}
                      className="w-full min-h-[40px] rounded-md border border-slate-300 px-2.5 py-1.5 text-xs bg-white"
                    >
                      <option value="">-- Nhờ điều phối chọn khoa phù hợp --</option>
                      {departments.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name} ({d.vacant_beds} giường trống)
                        </option>
                      ))}
                    </select>

                    {bookingType !== 'WAITLIST' && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <select
                          aria-label="Phòng mong muốn"
                          value={bookingRoomId}
                          onChange={(e) => {
                            setBookingRoomId(e.target.value);
                            setBookingBedId('');
                          }}
                          className="w-full min-h-[40px] rounded-md border border-slate-300 px-2.5 py-1.5 text-xs bg-white"
                        >
                          <option value="">-- Chọn phòng trống --</option>
                          {formRooms
                            .filter((r) => (bookingType === 'WHOLE_ROOM' ? r.can_book_whole_room : true))
                            .map((r) => (
                              <option key={r.id} value={r.id}>
                                {r.name} ({r.vacant_beds_count} trống)
                              </option>
                            ))}
                        </select>
                        {bookingType === 'SINGLE_BED' && (
                          <select
                            aria-label="Giường mong muốn"
                            value={bookingBedId}
                            onChange={(e) => setBookingBedId(e.target.value)}
                            className="w-full min-h-[40px] rounded-md border border-slate-300 px-2.5 py-1.5 text-xs bg-white"
                          >
                            <option value="">-- Bất kỳ giường trống --</option>
                            {(selectedRoomObj?.vacant_beds ?? []).map((b) => (
                              <option key={b.id} value={b.id}>
                                {b.code} ({b.daily_price.toLocaleString('vi-VN')}đ)
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Essential Inputs Only */}
              <div className="space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="cp-name" className="block text-xs font-medium text-slate-700 mb-1">
                      Họ và tên bệnh nhân *
                    </label>
                    <input
                      id="cp-name"
                      type="text"
                      required
                      value={patientName}
                      onChange={(e) => setPatientName(e.target.value)}
                      placeholder="VD: Nguyễn Thị Minh Anh"
                      className="w-full min-h-[44px] rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-sky-600 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label htmlFor="cp-phone" className="block text-xs font-medium text-slate-700 mb-1">
                      Số điện thoại *
                    </label>
                    <input
                      id="cp-phone"
                      type="tel"
                      required
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      placeholder="090xxxxxxx"
                      className="w-full min-h-[44px] rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-sky-600 focus:outline-none"
                    />
                  </div>
                </div>

                {/* 1-Tap Arrival Time Presets */}
                <div>
                  <span className="block text-xs font-medium text-slate-700 mb-1">
                    Thời gian dự kiến nhập viện *
                  </span>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                    {[
                      { id: 'IN_2H', label: 'Trong 2 giờ' },
                      { id: 'TOMORROW_AM', label: 'Sáng mai 8h' },
                      { id: 'TOMORROW_PM', label: 'Chiều mai 14h' },
                      { id: 'CUSTOM', label: 'Chọn giờ khác' },
                    ].map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => handleSelectAdmitPreset(opt.id as AdmitPreset)}
                        className={`min-h-[38px] rounded-md border px-2 py-1 text-xs font-medium transition-colors whitespace-nowrap ${
                          admitPreset === opt.id
                            ? 'border-sky-700 bg-sky-50 text-sky-900 font-semibold'
                            : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  {admitPreset === 'CUSTOM' && (
                    <input
                      id="cp-admit"
                      aria-label="Ngày giờ dự kiến nhập viện"
                      type="datetime-local"
                      required
                      value={expectedAdmit}
                      onChange={(e) => setExpectedAdmit(e.target.value)}
                      className="mt-2 w-full min-h-[44px] rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="cp-diag" className="block text-xs font-medium text-slate-700 mb-1">
                      Nhu cầu điều trị
                    </label>
                    <select
                      id="cp-diag"
                      value={diagGroup}
                      onChange={(e) => setDiagGroup(e.target.value)}
                      className="w-full min-h-[44px] rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white"
                    >
                      {(data?.diagnoses ?? [{ id: 'default', name: 'Khác', default_days: 3 }]).map((d) => (
                        <option key={d.id} value={d.name}>{d.name}</option>
                      ))}
                    </select>
                  </div>

                  <div className="flex items-end">
                    <button
                      type="button"
                      onClick={() => setShowOptionalDetails((v) => !v)}
                      aria-expanded={showOptionalDetails}
                      className="w-full min-h-[44px] rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100 text-left flex items-center justify-between"
                    >
                      <span>Ngày sinh &amp; Yêu cầu thêm</span>
                      <span className="text-sky-700 font-semibold">
                        {showOptionalDetails ? 'Thu gọn' : 'Mở rộng'}
                      </span>
                    </button>
                  </div>
                </div>

                {showOptionalDetails && (
                  <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-3 space-y-2.5">
                    <div>
                      <label htmlFor="cp-dob" className="block text-xs font-medium text-slate-700 mb-1">
                        Ngày sinh bệnh nhân
                      </label>
                      <input
                        id="cp-dob"
                        type="date"
                        value={dob}
                        onChange={(e) => setDob(e.target.value)}
                        className="w-full min-h-[40px] rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm"
                      />
                    </div>
                    <div>
                      <label htmlFor="cp-notes" className="block text-xs font-medium text-slate-700 mb-1">
                        Ghi chú nhanh cho nhân viên bệnh viện
                      </label>
                      <div className="flex flex-wrap gap-1.5 mb-2">
                        {QUICK_NOTE_SUGGESTIONS.map((s) => (
                          <button
                            key={s}
                            type="button"
                            onClick={() => appendQuickNote(s)}
                            className="min-h-[30px] rounded border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-700 hover:border-sky-400 hover:text-sky-800"
                          >
                            + {s}
                          </button>
                        ))}
                      </div>
                      <input
                        id="cp-notes"
                        type="text"
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                        placeholder="Nhập thêm yêu cầu riêng (nếu có)..."
                        className="w-full min-h-[40px] rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm"
                      />
                    </div>
                  </div>
                )}
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="w-full min-h-[46px] inline-flex items-center justify-center gap-2 rounded-lg bg-sky-800 px-4 py-2.5 text-sm font-semibold text-white hover:bg-sky-900 disabled:opacity-60 transition-colors"
              >
                <span>
                  {submitting
                    ? 'Đang gửi yêu cầu...'
                    : bookingType === 'SINGLE_BED' && selectedBedObj
                      ? `Gửi yêu cầu đặt ${selectedBedObj.code}`
                      : bookingType === 'WHOLE_ROOM' && selectedRoomObj
                        ? `Gửi yêu cầu bao ${selectedRoomObj.name}`
                        : 'Gửi đăng ký đặt giường'}
                </span>
                <ArrowRight className="h-4 w-4" />
              </button>
            </form>

            {/* Lookup Tracker + 1-Tap Recent Bookings */}
            <form onSubmit={handleLookupBooking} className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5 space-y-3">
              <div className="flex items-center gap-2 text-sm font-bold text-slate-900">
                <ClipboardCheck className="h-4 w-4 text-teal-700" />
                <span>Tra cứu trạng thái phiếu đặt giường</span>
              </div>

              {recentCodes.length > 0 && (
                <div className="space-y-1">
                  <div className="text-[11px] text-slate-500">Phiếu vừa đặt trên thiết bị này (chạm để kiểm tra):</div>
                  <div className="flex flex-wrap gap-1.5">
                    {recentCodes.map((rc) => (
                      <button
                        key={rc.code}
                        type="button"
                        onClick={() => fetchLookupCode(rc.code)}
                        className="min-h-[32px] rounded-md border border-sky-200 bg-sky-50 px-2.5 py-1 text-xs font-mono font-semibold text-sky-900 hover:bg-sky-100"
                      >
                        {rc.code}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    value={lookupCode}
                    onChange={(e) => setLookupCode(e.target.value)}
                    placeholder="Nhập mã DK-KH-..."
                    className="w-full min-h-[44px] rounded-lg border border-slate-300 pl-9 pr-3 py-2 text-sm font-mono uppercase"
                  />
                </div>
                <button
                  type="submit"
                  disabled={lookupLoading || !lookupCode.trim()}
                  className="min-h-[44px] rounded-lg border border-slate-300 bg-slate-50 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                >
                  {lookupLoading ? 'Đang tìm...' : 'Tra cứu'}
                </button>
              </div>
              {lookupError && <div className="text-xs text-rose-700">{lookupError}</div>}
              {lookupResult && (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3.5 space-y-1.5 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono font-bold text-slate-900">{lookupResult.registration_code}</span>
                    <span
                      className={`rounded border px-2 py-0.5 font-semibold ${
                        (BOOKING_STATUS_TEXT[lookupResult.status] ?? BOOKING_STATUS_TEXT.WAITING).cls
                      }`}
                    >
                      {(BOOKING_STATUS_TEXT[lookupResult.status] ?? BOOKING_STATUS_TEXT.WAITING).label}
                    </span>
                  </div>
                  <div className="text-slate-700">
                    Khoa/Giường: <strong>{lookupResult.department_name || 'Chờ điều phối khoa'}</strong>
                    {lookupResult.room_name ? ` · ${lookupResult.room_name}` : ''}
                    {lookupResult.bed_code ? ` · ${lookupResult.bed_code}` : ''}
                  </div>
                  <div className="text-slate-500 font-mono">
                    Dự kiến nhập: {formatDateTimeVN(lookupResult.expected_admission_date)}
                  </div>
                </div>
              )}
            </form>
          </div>
        </div>
      </main>

      {/* Mobile Compact Sticky Bottom CTA when browsing rooms (< 60px, respects 15% cap) */}
      {mobileSection === 'BROWSE' && (
        <div className="lg:hidden fixed bottom-0 inset-x-0 z-30 border-t border-slate-200 bg-white/95 backdrop-blur-sm px-4 py-2.5 flex items-center justify-between gap-3">
          <div className="min-w-0">
            {bookingType === 'SINGLE_BED' && selectedBedObj && selectedRoomObj ? (
              <>
                <div className="text-xs font-bold text-slate-900 truncate">
                  {selectedBedObj.code} · {selectedRoomObj.name}
                </div>
                <div className="text-[11px] font-mono text-emerald-700 font-semibold">
                  {selectedBedObj.daily_price.toLocaleString('vi-VN')}đ/ngày
                </div>
              </>
            ) : bookingType === 'WHOLE_ROOM' && selectedRoomObj ? (
              <>
                <div className="text-xs font-bold text-slate-900 truncate">
                  Bao {selectedRoomObj.name} ({selectedRoomObj.capacity} giường)
                </div>
                <div className="text-[11px] font-mono text-amber-700 font-semibold">
                  {wholeRoomDailyEstimate.toLocaleString('vi-VN')}đ/ngày
                </div>
              </>
            ) : (
              <>
                <div className="text-xs font-semibold text-slate-800 truncate">Chưa chọn giường cụ thể</div>
                <div className="text-[11px] text-slate-500">Chạm vào giường ở trên để đặt</div>
              </>
            )}
          </div>

          <button
            type="button"
            onClick={() => {
              if (!hasExplicitSelection) {
                switchToWaitlistAssist();
              } else {
                setMobileSection('BOOKING');
                setTimeout(() => document.getElementById('cp-name')?.focus(), 80);
              }
            }}
            className="min-h-[42px] shrink-0 inline-flex items-center gap-1.5 rounded-lg bg-sky-800 px-4 py-2 text-xs font-semibold text-white hover:bg-sky-900 whitespace-nowrap"
          >
            <span>{hasExplicitSelection ? 'Điền thông tin' : 'Nhờ khoa xếp'}</span>
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
