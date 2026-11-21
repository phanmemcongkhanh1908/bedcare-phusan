import type { DatabaseSync } from 'node:sqlite';

export interface SignedEvent {
  event_id: string;
  sequence_no: number;
  lamport_clock: number;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: string;
  device_id: string;
  user_id: string;
  signature: string;
  verified: number;
  consensus_status: 'CONFIRMED' | 'PENDING_QUORUM' | 'REJECTED';
  created_at: string;
}

function nullIfEmpty(val: unknown): string | null {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  return s.length > 0 ? s : null;
}

function resolveOrCreatePatient(
  db: DatabaseSync,
  params: {
    patientId: string;
    patientCode: string;
    hisRecordCode?: string;
    patientName: string;
    dateOfBirth: string;
    gender?: string;
    phone?: string;
    now: string;
  }
): string {
  const cleanCode = String(params.patientCode || '').trim() || params.patientId;
  const existingByCode = db
    .prepare('SELECT id FROM patients WHERE patient_code = ?')
    .get(cleanCode) as { id: string } | undefined;

  if (existingByCode) {
    db.prepare(
      `UPDATE patients
       SET full_name = COALESCE(NULLIF(?, ''), full_name),
           phone = COALESCE(NULLIF(?, ''), phone),
           his_record_code = COALESCE(NULLIF(?, ''), his_record_code),
           updated_at = ?
       WHERE id = ?`
    ).run(params.patientName || '', params.phone || '', params.hisRecordCode || '', params.now, existingByCode.id);
    return existingByCode.id;
  }

  const existingById = db
    .prepare('SELECT id FROM patients WHERE id = ?')
    .get(params.patientId) as { id: string } | undefined;
  if (existingById) return existingById.id;

  db.prepare(
    `INSERT INTO patients (id, patient_code, his_record_code, full_name, date_of_birth, gender, phone, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    params.patientId,
    cleanCode,
    params.hisRecordCode ?? '',
    params.patientName,
    params.dateOfBirth || '1990-01-01',
    params.gender ?? 'Nữ',
    params.phone ?? '',
    params.now,
    params.now
  );
  return params.patientId;
}

function syncRoomOccupancyStatus(db: DatabaseSync, roomId: string, now: string) {
  const room = db.prepare('SELECT exclusive_locked FROM rooms WHERE id = ?').get(roomId) as
    | { exclusive_locked: number }
    | undefined;
  if (!room) return;
  const beds = db.prepare('SELECT status FROM beds WHERE room_id = ?').all(roomId) as Array<{ status: string }>;
  let nextStatus = 'AVAILABLE';
  if (room.exclusive_locked) {
    nextStatus = 'EXCLUSIVE';
  } else if (beds.some((b) => b.status === 'OCCUPIED')) {
    nextStatus = 'IN_USE';
  } else if (beds.some((b) => b.status === 'RESERVED' || b.status === 'PENDING_CONFIRMATION')) {
    nextStatus = 'PARTIAL_RESERVED';
  }
  db.prepare('UPDATE rooms SET occupancy_status = ?, updated_at = ? WHERE id = ?').run(nextStatus, now, roomId);
}

/**
 * Deterministic, idempotent event applier for a node's local SQLite DB.
 * Ensures zero database-file overwriting: every peer converges via signed events.
 */
export function applyEventToLocalDb(db: DatabaseSync, event: SignedEvent): { applied: boolean; duplicate: boolean } {
  const existing = db.prepare('SELECT event_id FROM events WHERE event_id = ?').get(event.event_id);
  if (existing) {
    return { applied: false, duplicate: true };
  }

  const p = JSON.parse(event.payload);
  const now = event.created_at;

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `INSERT INTO events (event_id, sequence_no, lamport_clock, event_type, aggregate_type, aggregate_id, payload, device_id, user_id, signature, verified, consensus_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      event.event_id,
      event.sequence_no,
      event.lamport_clock,
      event.event_type,
      event.aggregate_type,
      event.aggregate_id,
      event.payload,
      event.device_id,
      event.user_id,
      event.signature,
      event.verified,
      event.consensus_status,
      event.created_at
    );

    switch (event.event_type) {
      case 'DEPARTMENT_UPSERT': {
        db.prepare(
          `INSERT INTO departments (id, code, name, description, his_dept_code, planned_bhyt_beds, max_bhyt_overage_pct, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             code=excluded.code,
             name=excluded.name,
             description=excluded.description,
             his_dept_code=COALESCE(NULLIF(excluded.his_dept_code, ''), departments.his_dept_code),
             planned_bhyt_beds=CASE WHEN excluded.planned_bhyt_beds > 0 THEN excluded.planned_bhyt_beds ELSE departments.planned_bhyt_beds END,
             max_bhyt_overage_pct=CASE WHEN excluded.max_bhyt_overage_pct >= 100 THEN excluded.max_bhyt_overage_pct ELSE departments.max_bhyt_overage_pct END,
             status=excluded.status,
             updated_at=excluded.updated_at`
        ).run(
          p.id,
          p.code,
          p.name,
          p.description ?? '',
          String(p.his_dept_code ?? '').trim().toUpperCase(),
          Number(p.planned_bhyt_beds ?? 0),
          Number(p.max_bhyt_overage_pct ?? 120),
          p.status ?? 'ACTIVE',
          p.created_at ?? now,
          now
        );
        break;
      }

      case 'DEPARTMENT_HIS_QUOTA_UPDATE': {
        db.prepare(
          `UPDATE departments
           SET his_dept_code = ?, planned_bhyt_beds = ?, max_bhyt_overage_pct = ?, updated_at = ?
           WHERE id = ?`
        ).run(
          String(p.his_dept_code ?? '').trim().toUpperCase(),
          Math.max(0, Number(p.planned_bhyt_beds ?? 0)),
          Math.max(100, Number(p.max_bhyt_overage_pct ?? 120)),
          now,
          p.department_id
        );
        break;
      }

      case 'ROOM_STANDARD_UPSERT': {
        db.prepare(
          `INSERT INTO room_standards (id, name, code, category, description, attributes, is_default, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name=excluded.name, code=excluded.code, category=excluded.category, description=excluded.description, attributes=excluded.attributes, status=excluded.status`
        ).run(
          p.id,
          p.name,
          p.code,
          p.category,
          p.description ?? '',
          JSON.stringify(p.attributes ?? {}),
          p.is_default ?? 0,
          p.status ?? 'ACTIVE',
          p.created_at ?? now
        );
        break;
      }

      case 'BED_TYPE_UPSERT': {
        db.prepare(
          `INSERT INTO bed_types (id, code, name, daily_price, hourly_price, description, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET code=excluded.code, name=excluded.name, daily_price=excluded.daily_price, hourly_price=excluded.hourly_price, description=excluded.description, status=excluded.status, updated_at=excluded.updated_at`
        ).run(
          p.id,
          p.code,
          p.name,
          Number(p.daily_price ?? 0),
          Number(p.hourly_price ?? 0),
          p.description ?? '',
          p.status ?? 'ACTIVE',
          p.created_at ?? now,
          now
        );
        break;
      }

      case 'ROOM_UPSERT': {
        db.prepare(
          `INSERT INTO rooms (id, department_id, code, name, floor, capacity, toilet_type, room_type, is_service, standard_ids, exclusive_locked, exclusive_lock_id, occupancy_status, status, notes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET department_id=excluded.department_id, code=excluded.code, name=excluded.name, floor=excluded.floor, capacity=excluded.capacity, toilet_type=excluded.toilet_type, room_type=excluded.room_type, is_service=excluded.is_service, standard_ids=excluded.standard_ids, status=excluded.status, notes=excluded.notes, updated_at=excluded.updated_at`
        ).run(
          p.id, p.department_id, p.code, p.name, p.floor ?? 'Tầng 1', p.capacity ?? 1,
          p.toilet_type ?? 'INTERNAL', p.room_type ?? 'STANDARD', p.is_service ?? 0,
          JSON.stringify(p.standard_ids ?? []), p.exclusive_locked ?? 0, nullIfEmpty(p.exclusive_lock_id),
          p.occupancy_status ?? 'AVAILABLE', p.status ?? 'ACTIVE', p.notes ?? '', p.created_at ?? now, now
        );
        // Keep child beds synchronized when room department_id changes
        db.prepare('UPDATE beds SET department_id = ?, updated_at = ? WHERE room_id = ? AND department_id != ?').run(
          p.department_id,
          now,
          p.id,
          p.department_id
        );
        break;
      }

      case 'ROOM_DELETE': {
        db.prepare('DELETE FROM rooms WHERE id = ?').run(p.id);
        break;
      }

      case 'BED_UPSERT': {
        const cleanBedTypeId = nullIfEmpty(p.bed_type_id);
        db.prepare(
          `INSERT INTO beds (id, room_id, department_id, bed_type_id, daily_price, code, name, status, current_admission_id, current_reservation_id, notes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET room_id=excluded.room_id, department_id=excluded.department_id, bed_type_id=excluded.bed_type_id, daily_price=excluded.daily_price, code=excluded.code, name=excluded.name, status=excluded.status, notes=excluded.notes, updated_at=excluded.updated_at`
        ).run(
          p.id, p.room_id, p.department_id, cleanBedTypeId, Number(p.daily_price ?? 0),
          p.code, p.name, p.status ?? 'VACANT',
          nullIfEmpty(p.current_admission_id), nullIfEmpty(p.current_reservation_id), p.notes ?? '', p.created_at ?? now, now
        );
        syncRoomOccupancyStatus(db, p.room_id, now);
        break;
      }

      case 'BED_DELETE': {
        const bedRow = db.prepare('SELECT room_id FROM beds WHERE id = ?').get(p.id) as { room_id: string } | undefined;
        db.prepare('DELETE FROM beds WHERE id = ?').run(p.id);
        if (bedRow) syncRoomOccupancyStatus(db, bedRow.room_id, now);
        break;
      }

      case 'BED_STATUS_CHANGE': {
        db.prepare('UPDATE beds SET status = ?, notes = COALESCE(?, notes), updated_at = ? WHERE id = ?').run(
          p.status, p.notes ?? null, now, p.bed_id
        );
        const bedRow = db.prepare('SELECT room_id FROM beds WHERE id = ?').get(p.bed_id) as { room_id: string } | undefined;
        if (bedRow) syncRoomOccupancyStatus(db, bedRow.room_id, now);
        break;
      }

      case 'PATIENT_UPSERT': {
        db.prepare(
          `INSERT INTO patients (id, patient_code, his_record_code, full_name, date_of_birth, gender, phone, identity_number, address, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET his_record_code=excluded.his_record_code, full_name=excluded.full_name, phone=excluded.phone, address=excluded.address, updated_at=excluded.updated_at`
        ).run(
          p.id, p.patient_code, p.his_record_code ?? '', p.full_name, p.date_of_birth,
          p.gender ?? 'Nữ', p.phone ?? '', p.identity_number ?? '', p.address ?? '', p.created_at ?? now, now
        );
        break;
      }

      case 'REGISTRATION_CREATE': {
        const resolvedPatientId = resolveOrCreatePatient(db, {
          patientId: p.patient_id,
          patientCode: p.patient_code,
          hisRecordCode: p.his_record_code,
          patientName: p.patient_name,
          dateOfBirth: p.date_of_birth,
          gender: p.gender,
          phone: p.phone,
          now,
        });

        db.prepare(
          `INSERT INTO registrations (id, registration_code, patient_id, patient_code, his_record_code, patient_name, date_of_birth, phone, diagnosis_group, expected_admission_date, expected_discharge_date, desired_standard_ids, registration_mode, department_id, room_id, bed_id, reservation_type, status, notes, created_by, created_by_name, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          p.id, p.registration_code, resolvedPatientId, p.patient_code, p.his_record_code ?? '',
          p.patient_name, p.date_of_birth, p.phone ?? '', p.diagnosis_group,
          p.expected_admission_date, p.expected_discharge_date,
          JSON.stringify(p.desired_standard_ids ?? []), p.registration_mode,
          nullIfEmpty(p.department_id), nullIfEmpty(p.room_id), nullIfEmpty(p.bed_id),
          p.reservation_type ?? 'NONE', p.status ?? 'WAITING', p.notes ?? '',
          p.created_by, p.created_by_name, now, now
        );
        break;
      }

      case 'REGISTRATION_CANCEL': {
        db.prepare("UPDATE registrations SET status = 'CANCELLED', notes = CASE WHEN ? != '' THEN ? ELSE notes END, updated_at = ? WHERE id = ?").run(
          p.notes ?? '',
          p.notes ?? '',
          now,
          p.registration_id
        );
        break;
      }

      case 'RESERVATION_CREATE': {
        const resolvedPatientId = resolveOrCreatePatient(db, {
          patientId: p.patient_id,
          patientCode: p.patient_code ?? p.patient_id,
          hisRecordCode: p.his_record_code,
          patientName: p.patient_name,
          dateOfBirth: p.date_of_birth ?? '1990-01-01',
          gender: p.gender,
          phone: p.phone,
          now,
        });

        const cleanRegId = nullIfEmpty(p.registration_id);
        const cleanBedId = nullIfEmpty(p.bed_id);

        db.prepare(
          `INSERT INTO reservations (id, registration_id, patient_id, patient_name, department_id, room_id, bed_id, is_whole_room, locked_bed_ids, start_time, expires_at, status, notes, created_by, created_by_name, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          p.id, cleanRegId, resolvedPatientId, p.patient_name,
          p.department_id, p.room_id, cleanBedId, p.is_whole_room ? 1 : 0,
          JSON.stringify(p.locked_bed_ids ?? []), p.start_time, p.expires_at,
          p.status ?? 'ACTIVE', p.notes ?? '', p.created_by, p.created_by_name, now, now
        );

        if (cleanRegId) {
          db.prepare('UPDATE registrations SET status = ?, department_id = ?, room_id = ?, bed_id = ?, reservation_type = ?, updated_at = ? WHERE id = ?').run(
            p.status === 'PENDING_CONFIRMATION' ? 'PENDING_CONFIRMATION' : 'RESERVED',
            p.department_id, p.room_id, cleanBedId,
            p.is_whole_room ? 'WHOLE_ROOM' : 'SINGLE_BED',
            now, cleanRegId
          );
        }

        const bedStatus = p.status === 'PENDING_CONFIRMATION' ? 'PENDING_CONFIRMATION' : 'RESERVED';
        if (p.is_whole_room) {
          db.prepare('UPDATE rooms SET exclusive_locked = 1, exclusive_lock_id = ?, updated_at = ? WHERE id = ?').run(p.id, now, p.room_id);
          for (const bid of (p.locked_bed_ids ?? [])) {
            db.prepare('UPDATE beds SET status = ?, current_reservation_id = ?, updated_at = ? WHERE id = ?').run(bedStatus, p.id, now, bid);
          }
        } else if (cleanBedId) {
          db.prepare('UPDATE beds SET status = ?, current_reservation_id = ?, updated_at = ? WHERE id = ?').run(bedStatus, p.id, now, cleanBedId);
        }
        syncRoomOccupancyStatus(db, p.room_id, now);
        break;
      }

      case 'RESERVATION_EXTEND': {
        db.prepare('UPDATE reservations SET expires_at = ?, notes = ?, updated_at = ? WHERE id = ?').run(
          p.expires_at, p.notes ?? '', now, p.reservation_id
        );
        break;
      }

      case 'RESERVATION_CANCEL': {
        const res = db.prepare('SELECT * FROM reservations WHERE id = ?').get(p.reservation_id) as Record<string, unknown> | undefined;
        if (res) {
          db.prepare('UPDATE reservations SET status = ?, updated_at = ? WHERE id = ?').run('CANCELLED', now, p.reservation_id);
          if (res.is_whole_room) {
            db.prepare('UPDATE rooms SET exclusive_locked = 0, exclusive_lock_id = NULL, updated_at = ? WHERE id = ?').run(now, res.room_id as string);
            const lockedBeds = JSON.parse((res.locked_bed_ids as string) || '[]') as string[];
            for (const bid of lockedBeds) {
              db.prepare("UPDATE beds SET status = 'VACANT', current_reservation_id = NULL, updated_at = ? WHERE id = ? AND status IN ('RESERVED', 'PENDING_CONFIRMATION')").run(now, bid);
            }
          } else if (res.bed_id) {
            db.prepare("UPDATE beds SET status = 'VACANT', current_reservation_id = NULL, updated_at = ? WHERE id = ? AND status IN ('RESERVED', 'PENDING_CONFIRMATION')").run(now, res.bed_id as string);
          }
          if (res.registration_id) {
            db.prepare("UPDATE registrations SET status = 'WAITING', bed_id = NULL, room_id = NULL, reservation_type = 'NONE', updated_at = ? WHERE id = ? AND status IN ('RESERVED', 'PENDING_CONFIRMATION')").run(now, res.registration_id as string);
          }
          syncRoomOccupancyStatus(db, res.room_id as string, now);
        }
        break;
      }

      case 'ADMISSION_CONFIRM': {
        const resolvedPatientId = resolveOrCreatePatient(db, {
          patientId: p.patient_id,
          patientCode: p.patient_code,
          hisRecordCode: p.his_record_code,
          patientName: p.patient_name,
          dateOfBirth: p.date_of_birth,
          gender: p.gender,
          phone: p.phone,
          now,
        });

        const cleanRegId = nullIfEmpty(p.registration_id);
        const cleanRsvId = nullIfEmpty(p.reservation_id);

        db.prepare(
          `INSERT INTO admissions (id, admission_code, registration_id, reservation_id, patient_id, patient_code, his_record_code, patient_name, date_of_birth, phone, diagnosis_group, department_id, room_id, bed_id, is_whole_room, hospital_admitted_at, bed_assigned_at, expected_discharge_at, calculation_method, extension_count, triage_priority, vitals_alert, medication_deadline_at, status, notes, confirmed_by, confirmed_by_name, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          p.id, p.admission_code, cleanRegId, cleanRsvId,
          resolvedPatientId, p.patient_code, p.his_record_code ?? '', p.patient_name,
          p.date_of_birth, p.phone ?? '', p.diagnosis_group, p.department_id, p.room_id, p.bed_id,
          p.is_whole_room ? 1 : 0, p.hospital_admitted_at, p.bed_assigned_at, p.expected_discharge_at,
          p.calculation_method ?? 'CALENDAR_DAYS',
          p.triage_priority ?? 'NORMAL',
          p.vitals_alert ?? '',
          nullIfEmpty(p.medication_deadline_at),
          p.status ?? 'ACTIVE', p.notes ?? '',
          p.confirmed_by, p.confirmed_by_name, now, now
        );

        const targetBedStatus = p.status === 'PENDING_CONFIRMATION' ? 'PENDING_CONFIRMATION' : 'OCCUPIED';
        db.prepare('UPDATE beds SET status = ?, current_admission_id = ?, current_reservation_id = NULL, updated_at = ? WHERE id = ?').run(
          targetBedStatus, p.id, now, p.bed_id
        );

        if (p.is_whole_room) {
          db.prepare('UPDATE rooms SET exclusive_locked = 1, exclusive_lock_id = ?, updated_at = ? WHERE id = ?').run(p.id, now, p.room_id);
          const roomBeds = db.prepare('SELECT id FROM beds WHERE room_id = ? AND id != ?').all(p.room_id, p.bed_id) as Array<{ id: string }>;
          for (const rb of roomBeds) {
            db.prepare('UPDATE beds SET status = ?, current_reservation_id = ?, updated_at = ? WHERE id = ?').run(
              p.status === 'PENDING_CONFIRMATION' ? 'PENDING_CONFIRMATION' : 'RESERVED',
              p.id, now, rb.id
            );
          }
        }

        if (cleanRsvId) {
          db.prepare("UPDATE reservations SET status = 'CONVERTED', updated_at = ? WHERE id = ?").run(now, cleanRsvId);
        }
        if (cleanRegId) {
          db.prepare("UPDATE registrations SET status = 'ADMITTED', department_id = ?, room_id = ?, bed_id = ?, updated_at = ? WHERE id = ?").run(
            p.department_id, p.room_id, p.bed_id, now, cleanRegId
          );
        }
        syncRoomOccupancyStatus(db, p.room_id, now);
        break;
      }

      case 'BED_EXTEND': {
        db.prepare(
          `INSERT INTO bed_extensions (id, admission_id, patient_id, patient_name, bed_id, bed_code, old_expected_discharge_at, new_expected_discharge_at, reason, performed_by, performed_by_name, performed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          p.id, p.admission_id, p.patient_id, p.patient_name, p.bed_id, p.bed_code,
          p.old_expected_discharge_at, p.new_expected_discharge_at, p.reason,
          p.performed_by, p.performed_by_name, p.performed_at ?? now
        );
        db.prepare(
          'UPDATE admissions SET expected_discharge_at = ?, extension_count = extension_count + 1, updated_at = ? WHERE id = ?'
        ).run(p.new_expected_discharge_at, now, p.admission_id);
        break;
      }

      case 'TRANSFER_REQUEST_CREATE': {
        db.prepare(
          `INSERT INTO transfer_requests (id, admission_id, patient_id, patient_name, from_department_id, from_room_id, from_bed_id, to_department_id, to_room_id, to_bed_id, reason, status, requested_by, requested_by_name, requested_at, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?)`
        ).run(
          p.id,
          p.admission_id,
          p.patient_id,
          p.patient_name,
          p.from_department_id,
          p.from_room_id,
          p.from_bed_id,
          p.to_department_id,
          p.to_room_id,
          p.to_bed_id,
          p.reason,
          p.requested_by,
          p.requested_by_name,
          p.requested_at ?? now,
          p.notes ?? ''
        );
        break;
      }

      case 'TRANSFER_REQUEST_CANCEL': {
        db.prepare(
          "UPDATE transfer_requests SET status = 'CANCELLED', completed_by = ?, completed_by_name = ?, completed_at = ?, notes = CASE WHEN ? != '' THEN ? ELSE notes END WHERE id = ? AND status = 'PENDING'"
        ).run(
          p.performed_by ?? null,
          p.performed_by_name ?? null,
          now,
          p.notes ?? '',
          p.notes ?? '',
          p.transfer_request_id
        );
        break;
      }

      case 'BED_TRANSFER': {
        db.prepare(
          `INSERT INTO bed_transfers (id, admission_id, patient_id, patient_name, from_department_id, from_room_id, from_bed_id, to_department_id, to_room_id, to_bed_id, reason, performed_by, performed_by_name, performed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          p.id, p.admission_id, p.patient_id, p.patient_name,
          p.from_department_id, p.from_room_id, p.from_bed_id,
          p.to_department_id, p.to_room_id, p.to_bed_id,
          p.reason, p.performed_by, p.performed_by_name, p.performed_at ?? now
        );

        // Old bed goes to PENDING_CLEANING
        db.prepare("UPDATE beds SET status = 'PENDING_CLEANING', current_admission_id = NULL, updated_at = ? WHERE id = ?").run(now, p.from_bed_id);
        db.prepare(
          `INSERT INTO cleaning_logs (id, bed_id, room_id, department_id, admission_id, status, requested_at, notes)
           VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?)`
        ).run(p.cleaning_log_id, p.from_bed_id, p.from_room_id, p.from_department_id, p.admission_id, now, 'Chuyển giường bệnh nhân');

        // Release whole-room lock on old room if applicable
        if (p.was_whole_room) {
          db.prepare('UPDATE rooms SET exclusive_locked = 0, exclusive_lock_id = NULL, updated_at = ? WHERE id = ?').run(now, p.from_room_id);
          db.prepare("UPDATE beds SET status = 'VACANT', current_reservation_id = NULL, updated_at = ? WHERE room_id = ? AND id != ? AND current_reservation_id = ?").run(
            now, p.from_room_id, p.from_bed_id, p.admission_id
          );
        }

        // New bed becomes OCCUPIED
        db.prepare("UPDATE beds SET status = 'OCCUPIED', current_admission_id = ?, current_reservation_id = NULL, updated_at = ? WHERE id = ?").run(
          p.admission_id, now, p.to_bed_id
        );
        db.prepare(
          'UPDATE admissions SET department_id = ?, room_id = ?, bed_id = ?, is_whole_room = 0, updated_at = ? WHERE id = ?'
        ).run(p.to_department_id, p.to_room_id, p.to_bed_id, now, p.admission_id);

        // Complete matching pending transfer request if linked or matching admission
        if (p.transfer_request_id) {
          db.prepare(
            "UPDATE transfer_requests SET status = 'COMPLETED', completed_by = ?, completed_by_name = ?, completed_at = ? WHERE id = ? AND status = 'PENDING'"
          ).run(p.performed_by, p.performed_by_name, p.performed_at ?? now, p.transfer_request_id);
        } else {
          db.prepare(
            "UPDATE transfer_requests SET status = 'COMPLETED', completed_by = ?, completed_by_name = ?, completed_at = ? WHERE admission_id = ? AND status = 'PENDING'"
          ).run(p.performed_by, p.performed_by_name, p.performed_at ?? now, p.admission_id);
        }

        syncRoomOccupancyStatus(db, p.from_room_id, now);
        syncRoomOccupancyStatus(db, p.to_room_id, now);
        break;
      }

      case 'BED_DISCHARGE': {
        const adm = db.prepare('SELECT * FROM admissions WHERE id = ?').get(p.admission_id) as Record<string, unknown> | undefined;
        if (adm) {
          db.prepare(
            "UPDATE admissions SET status = 'DISCHARGED', actual_discharge_at = ?, discharged_by = ?, updated_at = ? WHERE id = ?"
          ).run(p.actual_discharge_at ?? now, p.performed_by, now, p.admission_id);

          db.prepare("UPDATE beds SET status = 'PENDING_CLEANING', current_admission_id = NULL, updated_at = ? WHERE id = ?").run(
            now, adm.bed_id as string
          );

          // Cancel any open pending transfer requests for this discharged stay
          db.prepare(
            "UPDATE transfer_requests SET status = 'CANCELLED', completed_by = ?, completed_at = ?, notes = 'Tự động đóng do bệnh nhân đã xuất viện' WHERE admission_id = ? AND status = 'PENDING'"
          ).run(p.performed_by, now, p.admission_id);

          // If room was exclusively locked for this admission, release the remaining beds
          if (adm.is_whole_room) {
            db.prepare('UPDATE rooms SET exclusive_locked = 0, exclusive_lock_id = NULL, updated_at = ? WHERE id = ?').run(now, adm.room_id as string);
            db.prepare("UPDATE beds SET status = 'VACANT', current_reservation_id = NULL, updated_at = ? WHERE room_id = ? AND id != ? AND current_reservation_id = ?").run(
              now, adm.room_id as string, adm.bed_id as string, p.admission_id
            );
          }

          db.prepare(
            `INSERT INTO cleaning_logs (id, bed_id, room_id, department_id, admission_id, status, requested_at, notes)
             VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?)`
          ).run(p.cleaning_log_id, adm.bed_id as string, adm.room_id as string, adm.department_id as string, p.admission_id, now, p.notes ?? 'Trả giường sau lưu trú');
          syncRoomOccupancyStatus(db, adm.room_id as string, now);
        }
        break;
      }

      case 'CLEANING_START': {
        db.prepare("UPDATE cleaning_logs SET status = 'IN_PROGRESS', started_at = ?, assigned_to = ? WHERE id = ?").run(
          now, p.performed_by_name, p.cleaning_log_id
        );
        db.prepare("UPDATE beds SET status = 'CLEANING', updated_at = ? WHERE id = ?").run(now, p.bed_id);
        break;
      }

      case 'CLEANING_COMPLETE': {
        db.prepare(
          "UPDATE cleaning_logs SET status = 'COMPLETED', completed_at = ?, completed_by = ?, completed_by_name = ?, notes = COALESCE(?, notes) WHERE id = ?"
        ).run(now, p.performed_by, p.performed_by_name, p.notes ?? null, p.cleaning_log_id);
        db.prepare("UPDATE beds SET status = 'VACANT', updated_at = ? WHERE id = ? AND status IN ('PENDING_CLEANING', 'CLEANING')").run(
          now, p.bed_id
        );
        const bedRow = db.prepare('SELECT room_id FROM beds WHERE id = ?').get(p.bed_id) as { room_id: string } | undefined;
        if (bedRow) syncRoomOccupancyStatus(db, bedRow.room_id, now);
        break;
      }

      case 'ROOM_CONFLICTS_BATCH_FIX': {
        const allRooms = db.prepare('SELECT id, exclusive_locked, exclusive_lock_id FROM rooms').all() as Array<{
          id: string;
          exclusive_locked: number;
          exclusive_lock_id: string | null;
        }>;
        const activeWholeAdmIds = new Set(
          (db.prepare("SELECT id FROM admissions WHERE status = 'ACTIVE' AND is_whole_room = 1").all() as Array<{ id: string }>).map((r) => r.id)
        );
        const activeWholeRsvIds = new Set(
          (db.prepare("SELECT id FROM reservations WHERE status = 'ACTIVE' AND is_whole_room = 1").all() as Array<{ id: string }>).map((r) => r.id)
        );
        const activeAdmIds = new Set(
          (db.prepare("SELECT id FROM admissions WHERE status = 'ACTIVE'").all() as Array<{ id: string }>).map((r) => r.id)
        );

        for (const r of allRooms) {
          if (r.exclusive_locked) {
            const validLock = Boolean(
              r.exclusive_lock_id && (activeWholeAdmIds.has(r.exclusive_lock_id) || activeWholeRsvIds.has(r.exclusive_lock_id))
            );
            if (!validLock) {
              db.prepare('UPDATE rooms SET exclusive_locked = 0, exclusive_lock_id = NULL, updated_at = ? WHERE id = ?').run(now, r.id);
              db.prepare("UPDATE beds SET status = 'VACANT', current_reservation_id = NULL, updated_at = ? WHERE room_id = ? AND status = 'RESERVED'").run(now, r.id);
            } else {
              db.prepare("UPDATE beds SET status = 'RESERVED', current_reservation_id = ?, updated_at = ? WHERE room_id = ? AND status = 'VACANT'").run(
                r.exclusive_lock_id,
                now,
                r.id
              );
            }
          }

          db.prepare("UPDATE beds SET current_admission_id = NULL, current_reservation_id = NULL, updated_at = ? WHERE room_id = ? AND status = 'VACANT' AND (current_admission_id IS NOT NULL OR current_reservation_id IS NOT NULL)").run(now, r.id);
          const occBeds = db.prepare("SELECT id, current_admission_id FROM beds WHERE room_id = ? AND status = 'OCCUPIED'").all(r.id) as Array<{
            id: string;
            current_admission_id: string | null;
          }>;
          for (const ob of occBeds) {
            if (!ob.current_admission_id || !activeAdmIds.has(ob.current_admission_id)) {
              db.prepare("UPDATE beds SET status = 'VACANT', current_admission_id = NULL, updated_at = ? WHERE id = ?").run(now, ob.id);
            }
          }

          const refreshedRoom = db.prepare('SELECT exclusive_locked FROM rooms WHERE id = ?').get(r.id) as { exclusive_locked: number };
          if (!refreshedRoom.exclusive_locked) {
            const hasOccupied = db.prepare("SELECT 1 FROM beds WHERE room_id = ? AND status = 'OCCUPIED' LIMIT 1").get(r.id);
            if (hasOccupied) {
              const reservedBeds = db.prepare("SELECT id, current_reservation_id FROM beds WHERE room_id = ? AND status = 'RESERVED'").all(r.id) as Array<{
                id: string;
                current_reservation_id: string | null;
              }>;
              for (const rb of reservedBeds) {
                if (rb.current_reservation_id) {
                  db.prepare("UPDATE reservations SET status = 'CANCELLED', notes = CASE WHEN notes = '' THEN 'Hủy tự động do xung đột phòng đang sử dụng' ELSE notes || ' | Hủy tự động do xung đột phòng đang sử dụng' END, updated_at = ? WHERE id = ? AND status = 'ACTIVE'").run(now, rb.current_reservation_id);
                  db.prepare("UPDATE registrations SET status = 'WAITING', bed_id = NULL, room_id = NULL, reservation_type = 'NONE', updated_at = ? WHERE bed_id = ? AND status = 'RESERVED'").run(now, rb.id);
                }
                db.prepare("UPDATE beds SET status = 'VACANT', current_reservation_id = NULL, updated_at = ? WHERE id = ?").run(now, rb.id);
              }
            }
          }

          syncRoomOccupancyStatus(db, r.id, now);
        }
        break;
      }

      case 'DIAGNOSIS_CONFIG_UPSERT': {
        db.prepare(
          `INSERT INTO diagnosis_configs (id, name, default_days, description, is_active, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name=excluded.name, default_days=excluded.default_days, description=excluded.description, is_active=excluded.is_active, updated_at=excluded.updated_at`
        ).run(p.id, p.name, p.default_days, p.description ?? '', p.is_active ?? 1, now);
        break;
      }

      case 'SYSTEM_CONFIG_UPDATE': {
        for (const [k, v] of Object.entries(p.configs as Record<string, string>)) {
          db.prepare(
            'INSERT INTO system_configs (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at'
          ).run(k, String(v), now);
        }
        break;
      }

      case 'USER_UPSERT': {
        const isDefaultAdmin =
          p.id === 'usr-admin' || String(p.username ?? '').trim().toLowerCase() === 'admin';
        const effectiveRole = isDefaultAdmin ? 'SUPER_ADMIN' : p.role;
        const storedHisPerm =
          effectiveRole === 'SUPER_ADMIN' || effectiveRole === 'ADMIN'
            ? 'FULL'
            : (p.his_permission ?? 'NONE');
        db.prepare(
          `INSERT INTO users (id, username, password_hash, full_name, role, department_id, his_permission, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             full_name=excluded.full_name,
             role=excluded.role,
             department_id=excluded.department_id,
             his_permission=excluded.his_permission,
             status=excluded.status,
             password_hash=COALESCE(NULLIF(excluded.password_hash, ''), users.password_hash),
             updated_at=excluded.updated_at`
        ).run(
          p.id,
          isDefaultAdmin ? 'admin' : p.username,
          p.password_hash ?? '',
          p.full_name,
          effectiveRole,
          isDefaultAdmin ? null : nullIfEmpty(p.department_id),
          storedHisPerm,
          isDefaultAdmin ? 'ACTIVE' : (p.status ?? 'ACTIVE'),
          p.created_at ?? now,
          now
        );
        break;
      }

      case 'USER_STATUS_CHANGE': {
        db.prepare("UPDATE users SET status = ?, updated_at = ? WHERE id = ? AND LOWER(username) != 'admin' AND id != 'usr-admin'").run(
          p.status,
          now,
          p.user_id
        );
        break;
      }

      case 'USER_PASSWORD_RESET': {
        db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(
          p.password_hash,
          now,
          p.user_id
        );
        break;
      }

      case 'USER_DELETE': {
        db.prepare("DELETE FROM users WHERE id = ? AND id != 'usr-admin' AND LOWER(username) != 'admin'").run(p.user_id);
        break;
      }

      case 'DEVICE_UPSERT': {
        db.prepare(
          `INSERT INTO devices (device_id, node_name, department_id, public_key, status, is_coordinator, last_seen_at, paired_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(device_id) DO UPDATE SET node_name=excluded.node_name, department_id=excluded.department_id, status=excluded.status, is_coordinator=excluded.is_coordinator, last_seen_at=excluded.last_seen_at`
        ).run(
          p.device_id, p.node_name, nullIfEmpty(p.department_id), p.public_key,
          p.status ?? 'TRUSTED', p.is_coordinator ?? 0, now, p.paired_at ?? now
        );
        break;
      }

      case 'DEVICE_REVOKE': {
        db.prepare("UPDATE devices SET status = 'REVOKED', is_coordinator = 0, last_seen_at = ? WHERE device_id = ?").run(
          now, p.target_device_id
        );
        break;
      }

      case 'HIS_IMPORT_LOG': {
        db.prepare(
          `INSERT INTO his_import_logs (id, file_name, total_rows, imported_rows, duplicate_rows, error_rows, performed_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(p.id, p.file_name, p.total_rows, p.imported_rows, p.duplicate_rows, p.error_rows, p.performed_by, now);
        break;
      }

      case 'HIS_BED_MAPPING_UPSERT': {
        const items = Array.isArray(p.mappings) ? p.mappings : [p];
        const stmt = db.prepare(
          `INSERT INTO his_bed_mappings (bed_id, his_dept_code, his_room_code, his_bed_code, his_bed_type_code, bhyt_max_daily_price, allow_shared_bed, notes, updated_by, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(bed_id) DO UPDATE SET
             his_dept_code=excluded.his_dept_code,
             his_room_code=excluded.his_room_code,
             his_bed_code=excluded.his_bed_code,
             his_bed_type_code=excluded.his_bed_type_code,
             bhyt_max_daily_price=excluded.bhyt_max_daily_price,
             allow_shared_bed=excluded.allow_shared_bed,
             notes=excluded.notes,
             updated_by=excluded.updated_by,
             updated_at=excluded.updated_at`
        );
        for (const item of items) {
          if (!item?.bed_id) continue;
          stmt.run(
            item.bed_id,
            String(item.his_dept_code ?? '').trim().toUpperCase(),
            String(item.his_room_code ?? '').trim().toUpperCase(),
            String(item.his_bed_code ?? '').trim().toUpperCase(),
            String(item.his_bed_type_code ?? 'H2').trim().toUpperCase(),
            Number(item.bhyt_max_daily_price ?? 0),
            item.allow_shared_bed ? 1 : 0,
            String(item.notes ?? ''),
            String(item.updated_by ?? event.user_id),
            now
          );
        }
        break;
      }

      case 'HIS_ASSIGNMENTS_SYNC': {
        const rows = Array.isArray(p.rows) ? p.rows : [];
        if (p.replace_snapshot !== false) {
          db.exec('DELETE FROM his_bed_assignments');
        }
        const stmt = db.prepare(
          `INSERT INTO his_bed_assignments (
             id, batch_id, his_assignment_id, his_record_code, patient_code, patient_name,
             date_of_birth, bhyt_card_no, his_dept_code, his_room_code, his_bed_code,
             his_bed_type_code, bed_ratio, bed_days_billed, admitted_at, discharged_at,
             status, source_system, synced_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        for (const r of rows) {
          stmt.run(
            r.id,
            p.batch_id,
            r.his_assignment_id,
            r.his_record_code,
            r.patient_code,
            r.patient_name,
            r.date_of_birth ?? '1990-01-01',
            r.bhyt_card_no ?? '',
            r.his_dept_code,
            r.his_room_code ?? '',
            r.his_bed_code,
            r.his_bed_type_code ?? 'H2',
            Number(r.bed_ratio ?? 1.0),
            Number(r.bed_days_billed ?? 1.0),
            r.admitted_at,
            nullIfEmpty(r.discharged_at),
            r.status ?? 'ACTIVE',
            p.source_system ?? 'HIS_API',
            p.synced_at ?? now
          );
        }
        break;
      }

      case 'HIS_AUDIT_RESOLVE': {
        if (p.unresolve) {
          db.prepare('DELETE FROM his_audit_resolutions WHERE issue_key = ?').run(p.issue_key);
        } else {
          db.prepare(
            `INSERT INTO his_audit_resolutions (issue_key, category, severity, resolution_note, resolved_by, resolved_by_name, resolved_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(issue_key) DO UPDATE SET
               resolution_note=excluded.resolution_note,
               resolved_by=excluded.resolved_by,
               resolved_by_name=excluded.resolved_by_name,
               resolved_at=excluded.resolved_at`
          ).run(
            p.issue_key,
            p.category ?? 'IRRATIONAL_ASSIGNMENT',
            p.severity ?? 'HIGH',
            p.resolution_note ?? '',
            p.resolved_by ?? event.user_id,
            p.resolved_by_name ?? '',
            now
          );
        }
        break;
      }

      default:
        break;
    }

    if (p.audit_action) {
      db.prepare(
        `INSERT INTO audit_logs (id, user_id, username, device_id, action, entity_type, entity_id, details, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        `aud-${event.event_id}`, event.user_id, p.actor_username ?? event.user_id,
        event.device_id, p.audit_action, event.aggregate_type, event.aggregate_id,
        p.audit_details ?? event.event_type, now
      );
    }

    db.exec('COMMIT');
    return { applied: true, duplicate: false };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
