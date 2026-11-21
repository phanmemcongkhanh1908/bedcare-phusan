export interface SmartMatchAdmissionInput {
  id: string;
  patient_name: string;
  diagnosis_group: string;
  department_id: string;
  room_id: string;
  bed_id: string;
  room_floor?: string;
  room_type?: string;
  desired_standard_ids?: string[];
}

export interface SmartMatchRoomInput {
  id: string;
  department_id: string;
  code: string;
  name: string;
  floor: string;
  capacity: number;
  toilet_type: string;
  room_type: string;
  is_service: number;
  standard_ids: string[];
  exclusive_locked: number;
  status: string;
}

export interface SmartMatchBedInput {
  id: string;
  room_id: string;
  department_id: string;
  code: string;
  name: string;
  status: string;
  daily_price?: number;
}

export interface SmartBedRecommendation {
  bedId: string;
  bedCode: string;
  bedName: string;
  roomId: string;
  roomCode: string;
  roomName: string;
  roomType: string;
  floor: string;
  departmentId: string;
  departmentName: string;
  bedStatus: string;
  sanitizationStatus: 'READY_SANITIZED' | 'SANITIZING' | 'NEEDS_SANITIZATION';
  sanitizationLabel: string;
  distanceMeters: number;
  distanceLabel: string;
  departmentMatchLabel: string;
  dailyPrice: number;
  matchScore: number;
  matchReasons: string[];
}

export function parseFloorNumber(floorLabel?: string | null): number {
  if (!floorLabel) return 1;
  const m = String(floorLabel).match(/(\d+)/);
  if (m) return Number(m[1]);
  const lower = floorLabel.toLowerCase();
  if (lower.includes('trệt') || lower.includes('g')) return 0;
  return 1;
}

export function computeMovementDistance(
  fromRoom: { id: string; department_id: string; floor: string },
  toRoom: { id: string; department_id: string; floor: string }
): { distanceMeters: number; distanceLabel: string; distanceScore: number } {
  if (fromRoom.id === toRoom.id) {
    return {
      distanceMeters: 5,
      distanceLabel: 'Cùng phòng · Di chuyển tối thiểu (~5m)',
      distanceScore: 30,
    };
  }
  const f1 = parseFloorNumber(fromRoom.floor);
  const f2 = parseFloorNumber(toRoom.floor);
  const floorDiff = Math.abs(f1 - f2);
  const sameDept = fromRoom.department_id === toRoom.department_id;

  if (sameDept && floorDiff === 0) {
    return {
      distanceMeters: 18,
      distanceLabel: `Cùng khoa · Cùng ${toRoom.floor || `Tầng ${f2}`} (~18m)`,
      distanceScore: 26,
    };
  }
  if (sameDept) {
    const meters = 25 + floorDiff * 20;
    return {
      distanceMeters: meters,
      distanceLabel: `Cùng khoa · Cách ${floorDiff} tầng (~${meters}m)`,
      distanceScore: Math.max(10, 22 - floorDiff * 4),
    };
  }
  if (floorDiff === 0) {
    return {
      distanceMeters: 55,
      distanceLabel: `Liên khoa · Cùng ${toRoom.floor || `Tầng ${f2}`} (~55m)`,
      distanceScore: 14,
    };
  }
  const meters = 55 + floorDiff * 25;
  return {
    distanceMeters: meters,
    distanceLabel: `Liên khoa · Cách ${floorDiff} tầng (~${meters}m)`,
    distanceScore: Math.max(2, 12 - floorDiff * 3),
  };
}

export function rankSmartTransferBeds(params: {
  admission: SmartMatchAdmissionInput;
  rooms: SmartMatchRoomInput[];
  beds: SmartMatchBedInput[];
  deptNames: Record<string, string>;
  standardNames?: Record<string, string>;
}): { top3: SmartBedRecommendation[]; allCandidates: SmartBedRecommendation[] } {
  const roomMap = new Map(params.rooms.map((r) => [r.id, r]));
  const currentRoom = roomMap.get(params.admission.room_id) ?? {
    id: params.admission.room_id,
    department_id: params.admission.department_id,
    code: '',
    name: '',
    floor: params.admission.room_floor || 'Tầng 1',
    capacity: 1,
    toilet_type: 'INTERNAL',
    room_type: params.admission.room_type || 'STANDARD',
    is_service: 0,
    standard_ids: params.admission.desired_standard_ids || [],
    exclusive_locked: 0,
    status: 'ACTIVE',
  };

  const desiredSet = new Set(
    params.admission.desired_standard_ids && params.admission.desired_standard_ids.length > 0
      ? params.admission.desired_standard_ids
      : currentRoom.standard_ids || []
  );

  // Exclude rooms with another active occupied patient only? No, transfers to multi-bed rooms are valid unless exclusive_locked.
  const recommendations: SmartBedRecommendation[] = [];

  for (const bed of params.beds) {
    if (bed.id === params.admission.bed_id) continue;
    if (!['VACANT', 'CLEANING', 'PENDING_CLEANING'].includes(bed.status)) continue;

    const targetRoom = roomMap.get(bed.room_id);
    if (!targetRoom || targetRoom.status !== 'ACTIVE' || targetRoom.exclusive_locked) continue;

    const reasons: string[] = [];
    let score = 0;

    // 1. Department & Specialty Requirements (max 35 pts)
    const sameDept = bed.department_id === params.admission.department_id;
    let departmentMatchLabel = '';
    if (sameDept) {
      score += 35;
      departmentMatchLabel = `Đúng khoa (${params.deptNames[bed.department_id] ?? bed.department_id})`;
      reasons.push(departmentMatchLabel);
    } else {
      score += 10;
      departmentMatchLabel = `Chuyển liên khoa -> ${params.deptNames[bed.department_id] ?? bed.department_id}`;
      reasons.push(departmentMatchLabel);
    }

    // Room type & isolation compatibility (max 15 pts)
    if (currentRoom.room_type === 'ISOLATION') {
      if (targetRoom.room_type === 'ISOLATION') {
        score += 15;
        reasons.push('Đáp ứng chuẩn phòng cách ly');
      } else {
        score -= 10;
      }
    } else if (targetRoom.room_type === currentRoom.room_type) {
      score += 12;
      reasons.push(`Cùng hạng phòng (${targetRoom.room_type})`);
    } else if (targetRoom.room_type === 'SERVICE' || targetRoom.room_type === 'VIP') {
      score += 8;
      reasons.push(`Phòng tiện nghi (${targetRoom.room_type})`);
    } else if (targetRoom.room_type === 'ISOLATION') {
      // Reserve isolation rooms when not strictly needed unless no others exist
      score -= 8;
    }

    // Desired standards overlap (max 10 pts)
    if (desiredSet.size > 0 && targetRoom.standard_ids.length > 0) {
      const overlap = targetRoom.standard_ids.filter((id) => desiredSet.has(id));
      const ratio = overlap.length / desiredSet.size;
      const stdPts = Math.round(ratio * 10);
      score += stdPts;
      if (overlap.length > 0 && params.standardNames) {
        const names = overlap.slice(0, 2).map((id) => params.standardNames![id] ?? id);
        reasons.push(`Đạt chuẩn: ${names.join(', ')}`);
      }
    }

    // 2. Sanitization Status (max 30 pts)
    let sanitizationStatus: SmartBedRecommendation['sanitizationStatus'] = 'READY_SANITIZED';
    let sanitizationLabel = 'Đã vệ sinh · Sẵn sàng ngay';
    if (bed.status === 'VACANT') {
      score += 30;
      reasons.push('Giường đã vệ sinh sạch, sẵn sàng tiếp nhận ngay');
    } else if (bed.status === 'CLEANING') {
      sanitizationStatus = 'SANITIZING';
      sanitizationLabel = 'Đang vệ sinh khử khuẩn (~20-30 phút)';
      score += 12;
      reasons.push('Đang hoàn tất vệ sinh khử khuẩn');
    } else {
      sanitizationStatus = 'NEEDS_SANITIZATION';
      sanitizationLabel = 'Chờ vệ sinh (~45-60 phút)';
      score += 4;
      reasons.push('Cần vệ sinh khử khuẩn trước khi chuyển');
    }

    // 3. Physical Movement Distance (max 30 pts)
    const dist = computeMovementDistance(currentRoom, targetRoom);
    score += dist.distanceScore;
    reasons.push(dist.distanceLabel);

    const normalizedScore = Math.max(5, Math.min(100, Math.round((score / 115) * 100)));

    recommendations.push({
      bedId: bed.id,
      bedCode: bed.code,
      bedName: bed.name,
      roomId: targetRoom.id,
      roomCode: targetRoom.code,
      roomName: targetRoom.name,
      roomType: targetRoom.room_type,
      floor: targetRoom.floor,
      departmentId: bed.department_id,
      departmentName: params.deptNames[bed.department_id] ?? '',
      bedStatus: bed.status,
      sanitizationStatus,
      sanitizationLabel,
      distanceMeters: dist.distanceMeters,
      distanceLabel: dist.distanceLabel,
      departmentMatchLabel,
      dailyPrice: Number(bed.daily_price ?? 0),
      matchScore: normalizedScore,
      matchReasons: reasons,
    });
  }

  recommendations.sort((a, b) => {
    // Always rank sanitized VACANT beds above dirty ones if scores are close, then by matchScore desc, distance asc
    if (a.bedStatus === 'VACANT' && b.bedStatus !== 'VACANT') return -1;
    if (b.bedStatus === 'VACANT' && a.bedStatus !== 'VACANT') return 1;
    if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
    return a.distanceMeters - b.distanceMeters;
  });

  return {
    top3: recommendations.slice(0, 3),
    allCandidates: recommendations,
  };
}

export interface CustomerStandardTrend {
  standardId: string;
  standardName: string;
  standardCode: string;
  requestCount: number;
  requestSharePct: number;
  supplyRoomCount: number;
  supplySharePct: number;
  demandSupplyGapPct: number;
}

export interface CustomerTierChoice {
  label: string;
  count: number;
  sharePct: number;
}

export interface CustomerTrendProposal {
  id: string;
  title: string;
  evidence: string;
  recommendation: string;
  priority: 'HIGH' | 'MEDIUM' | 'INFO';
}

export interface CustomerTrendAnalytics {
  totalRegistrations: number;
  totalReservations: number;
  convertedRegistrations: number;
  waitlistConversionPct: number;
  wholeRoomPreferencePct: number;
  unknownDeptRatioPct: number;
  standardPreferences: CustomerStandardTrend[];
  reservationTypeChoices: CustomerTierChoice[];
  diagnosisDemand: CustomerTierChoice[];
  departmentDemand: Array<{
    departmentId: string;
    departmentName: string;
    requestCount: number;
    operationalBeds: number;
    demandPressurePct: number;
  }>;
  trendProposals: CustomerTrendProposal[];
}

export function analyzeCustomerRegistrationTrends(params: {
  registrations: Array<{
    id: string;
    status: string;
    diagnosis_group: string;
    registration_mode: string;
    reservation_type: string;
    department_id?: string | null;
    desired_standard_ids: string[];
  }>;
  reservations: Array<{
    id: string;
    is_whole_room: number;
    department_id: string;
    status: string;
  }>;
  admissions: Array<{
    id: string;
    diagnosis_group: string;
    department_id: string;
    is_whole_room: number;
    room_id: string;
  }>;
  rooms: Array<{
    id: string;
    department_id: string;
    room_type: string;
    is_service: number;
    standard_ids: string[];
    status: string;
  }>;
  beds: Array<{
    id: string;
    department_id: string;
    status: string;
  }>;
  roomStandards: Array<{
    id: string;
    name: string;
    code: string;
  }>;
  departments: Array<{
    id: string;
    name: string;
  }>;
}): CustomerTrendAnalytics {
  const totalRegistrations = params.registrations.length;
  const totalReservations = params.reservations.length;
  const convertedRegistrations = params.registrations.filter((r) => r.status === 'ADMITTED' || r.status === 'RESERVED').length;
  const waitlistConversionPct =
    totalRegistrations > 0 ? Math.round((convertedRegistrations / totalRegistrations) * 100) : 0;

  const wholeRoomCount =
    params.registrations.filter((r) => r.reservation_type === 'WHOLE_ROOM').length +
    params.reservations.filter((r) => Number(r.is_whole_room) === 1).length +
    params.admissions.filter((a) => Number(a.is_whole_room) === 1).length;
  const totalChoicePool = Math.max(1, totalRegistrations + totalReservations + params.admissions.length);
  const wholeRoomPreferencePct = Math.round((wholeRoomCount / totalChoicePool) * 100);

  const unknownDeptCount = params.registrations.filter((r) => r.registration_mode === 'UNKNOWN_DEPT').length;
  const unknownDeptRatioPct =
    totalRegistrations > 0 ? Math.round((unknownDeptCount / totalRegistrations) * 100) : 0;

  const activeRooms = params.rooms.filter((r) => r.status === 'ACTIVE');
  const totalActiveRooms = Math.max(1, activeRooms.length);

  // Room standards request vs inventory supply
  const stdReqCounts = new Map<string, number>();
  let totalRegWithStd = 0;
  for (const reg of params.registrations) {
    if (reg.desired_standard_ids && reg.desired_standard_ids.length > 0) {
      totalRegWithStd++;
      for (const sid of reg.desired_standard_ids) {
        stdReqCounts.set(sid, (stdReqCounts.get(sid) ?? 0) + 1);
      }
    }
  }
  const reqDenominator = Math.max(1, totalRegWithStd);

  const standardPreferences: CustomerStandardTrend[] = params.roomStandards
    .map((std) => {
      const requestCount = stdReqCounts.get(std.id) ?? 0;
      const supplyRoomCount = activeRooms.filter((r) => r.standard_ids.includes(std.id)).length;
      const requestSharePct = totalRegWithStd > 0 ? Math.round((requestCount / reqDenominator) * 100) : 0;
      const supplySharePct = Math.round((supplyRoomCount / totalActiveRooms) * 100);
      return {
        standardId: std.id,
        standardName: std.name,
        standardCode: std.code,
        requestCount,
        requestSharePct,
        supplyRoomCount,
        supplySharePct,
        demandSupplyGapPct: requestSharePct - supplySharePct,
      };
    })
    .filter((s) => s.requestCount > 0 || s.supplyRoomCount > 0)
    .sort((a, b) => b.requestCount - a.requestCount || b.demandSupplyGapPct - a.demandSupplyGapPct);

  // Reservation type choices
  const resTypeLabels: Record<string, string> = {
    WAITLIST: 'Chờ phân bổ khoa/giường',
    SINGLE_BED: 'Chọn giữ 1 giường cụ thể',
    WHOLE_ROOM: 'Chọn bao trọn cả phòng',
    NONE: 'Đăng ký thông thường (không giữ chỗ)',
  };
  const resTypeMap = new Map<string, number>();
  for (const r of params.registrations) {
    const key = resTypeLabels[r.reservation_type] ?? r.reservation_type;
    resTypeMap.set(key, (resTypeMap.get(key) ?? 0) + 1);
  }
  const reservationTypeChoices: CustomerTierChoice[] = Array.from(resTypeMap.entries())
    .map(([label, count]) => ({
      label,
      count,
      sharePct: totalRegistrations > 0 ? Math.round((count / totalRegistrations) * 100) : 0,
    }))
    .sort((a, b) => b.count - a.count);

  // Diagnosis demand
  const diagMap = new Map<string, number>();
  const combinedCases = [
    ...params.registrations.map((r) => r.diagnosis_group),
    ...params.admissions.map((a) => a.diagnosis_group),
  ];
  for (const d of combinedCases) {
    const k = d || 'Khác';
    diagMap.set(k, (diagMap.get(k) ?? 0) + 1);
  }
  const diagDenom = Math.max(1, combinedCases.length);
  const diagnosisDemand: CustomerTierChoice[] = Array.from(diagMap.entries())
    .map(([label, count]) => ({
      label,
      count,
      sharePct: Math.round((count / diagDenom) * 100),
    }))
    .sort((a, b) => b.count - a.count);

  // Department demand vs bed capacity
  const departmentDemand = params.departments
    .map((dept) => {
      const regCnt = params.registrations.filter((r) => r.department_id === dept.id).length;
      const rsvCnt = params.reservations.filter((r) => r.department_id === dept.id && r.status === 'ACTIVE').length;
      const admCnt = params.admissions.filter((a) => a.department_id === dept.id).length;
      const requestCount = regCnt + rsvCnt + admCnt;
      const operationalBeds = params.beds.filter(
        (b) => b.department_id === dept.id && b.status !== 'INACTIVE' && b.status !== 'MAINTENANCE'
      ).length;
      const demandPressurePct =
        operationalBeds > 0 ? Math.round((requestCount / operationalBeds) * 100) : 0;
      return {
        departmentId: dept.id,
        departmentName: dept.name,
        requestCount,
        operationalBeds,
        demandPressurePct,
      };
    })
    .sort((a, b) => b.demandPressurePct - a.demandPressurePct);

  // Generate concrete coordinator/management recommendations
  const trendProposals: CustomerTrendProposal[] = [];

  const undersuppliedStds = standardPreferences.filter((s) => s.requestCount > 0 && s.demandSupplyGapPct >= 15);
  if (undersuppliedStds.length > 0) {
    const topGap = undersuppliedStds[0];
    trendProposals.push({
      id: `prop-std-${topGap.standardId}`,
      title: `Nhu cầu "${topGap.standardName}" vượt tỷ lệ phòng hiện có`,
      evidence: `${topGap.requestSharePct}% hồ sơ đăng ký yêu cầu "${topGap.standardName}" (${topGap.requestCount} lượt), trong khi nguồn cung phòng đạt chuẩn này chỉ chiếm ${topGap.supplySharePct}% (${topGap.supplyRoomCount}/${totalActiveRooms} phòng).`,
      recommendation: `Đề xuất ưu tiên chuyển đổi/nâng cấp 1–2 phòng thường trống thành phòng trang bị ${topGap.standardName} để tăng tỷ lệ đáp ứng đăng ký trước.`,
      priority: 'HIGH',
    });
  }

  if (wholeRoomPreferencePct >= 15) {
    trendProposals.push({
      id: 'prop-whole-room',
      title: 'Xu hướng khách hàng chọn bao trọn phòng cao',
      evidence: `Tỷ lệ lựa chọn bao trọn phòng chiếm ${wholeRoomPreferencePct}% tổng nhu cầu đăng ký/giữ chỗ/nội trú.`,
      recommendation:
        'Nên bố trí thêm phòng đơn (1 giường) hoặc nhóm phòng 2 giường riêng biệt tại khu dịch vụ để giảm tình trạng khóa kèm giường trống lãng phí khi khách bao phòng.',
      priority: 'HIGH',
    });
  }

  if (unknownDeptRatioPct >= 30) {
    trendProposals.push({
      id: 'prop-waitlist-routing',
      title: 'Tỷ lệ đăng ký chưa xác định khoa lớn',
      evidence: `${unknownDeptRatioPct}% đăng ký trước (${unknownDeptCount}/${totalRegistrations}) ở chế độ chưa xác định khoa/phòng, cần điều phối từ Danh sách chờ.`,
      recommendation:
        'Bố trí điều phối viên quầy thu viện phí phân bổ sơ bộ theo tiêu chuẩn phòng mong muốn và dùng Smart Match ngay khi có giường trống hoàn tất vệ sinh.',
      priority: 'MEDIUM',
    });
  }

  const hotDept = departmentDemand[0];
  if (hotDept && hotDept.demandPressurePct >= 90) {
    trendProposals.push({
      id: `prop-dept-${hotDept.departmentId}`,
      title: `Áp lực đăng ký dồn cao tại ${hotDept.departmentName}`,
      evidence: `Nhu cầu ghi nhận ${hotDept.requestCount} lượt trên ${hotDept.operationalBeds} giường hoạt động (hệ số áp lực ${hotDept.demandPressurePct}%).`,
      recommendation: `Chuẩn bị phương án giường dự phòng hoặc chuyển tuyến nội bộ sang khoa cùng khối tầng khi ${hotDept.departmentName} vượt ngưỡng 90%.`,
      priority: 'HIGH',
    });
  }

  if (trendProposals.length === 0) {
    trendProposals.push({
      id: 'prop-balanced',
      title: 'Cơ cấu đăng ký & nguồn cung phòng đang cân bằng',
      evidence: `Tỷ lệ đáp ứng đăng ký đạt ${waitlistConversionPct}%, chưa ghi nhận lệch cung-cầu nghiêm trọng theo tiêu chuẩn phòng.`,
      recommendation: 'Tiếp tục duy trì quy trình vệ sinh quay vòng nhanh (< 45 phút) và theo dõi dự báo 48 giờ – 7 ngày.',
      priority: 'INFO',
    });
  }

  return {
    totalRegistrations,
    totalReservations,
    convertedRegistrations,
    waitlistConversionPct,
    wholeRoomPreferencePct,
    unknownDeptRatioPct,
    standardPreferences,
    reservationTypeChoices,
    diagnosisDemand,
    departmentDemand,
    trendProposals,
  };
}
