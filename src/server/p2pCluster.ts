import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { sanitizeBackupPrefix } from '../utils/databaseSafety';
import {
  decryptBackupPayload,
  encryptBackupPayload,
  generateDeviceKeyPair,
  hashPassword,
  sha256Hex,
  signEventData,
  verifyEventSignature,
  type EncryptedBackupEnvelope,
} from './crypto';
import { openNodeDatabase } from './db';
import { applyEventToLocalDb, type SignedEvent } from './eventApplier';

export interface NodeRuntime {
  deviceId: string;
  nodeName: string;
  departmentId: string | null;
  db: DatabaseSync;
  dbPath: string;
  publicKey: string;
  privateKey: string;
  online: boolean;
  revoked: boolean;
  isCoordinator: boolean;
  partitionGroup: string;
  lamportClock: number;
  term: number;
}

export class ConsensusConflictError extends Error {
  public readonly code: string;
  public readonly details?: Record<string, unknown>;
  constructor(message: string, code = 'CONFLICT_DOUBLE_BOOKING', details?: Record<string, unknown>) {
    super(message);
    this.name = 'ConsensusConflictError';
    this.code = code;
    this.details = details;
  }
}

export class SecurityRejectionError extends Error {
  public readonly code: string;
  constructor(message: string, code = 'SECURITY_REJECTED') {
    super(message);
    this.name = 'SecurityRejectionError';
    this.code = code;
  }
}

export class BedcareCluster {
  public nodes = new Map<string, NodeRuntime>();
  public activeNodeId: string = 'NODE-QUAY-01';
  public dataDir: string;
  private resourceMutexes = new Map<string, Promise<void>>();
  private onClusterUpdate?: () => void;

  constructor(options?: { dataDir?: string; inMemory?: boolean; onClusterUpdate?: () => void }) {
    this.dataDir = options?.dataDir ?? path.resolve(process.cwd(), 'data');
    this.onClusterUpdate = options?.onClusterUpdate;
    const inMemory = options?.inMemory ?? false;

    const initialSpecs = [
      {
        deviceId: 'NODE-QUAY-01',
        nodeName: 'Máy Quầy Thu Viện Phí 01',
        departmentId: null,
        isCoordinator: true,
      },
      {
        deviceId: 'NODE-SAN-A',
        nodeName: 'Máy Khoa Sản A',
        departmentId: 'dept-san-a',
        isCoordinator: false,
      },
      {
        deviceId: 'NODE-PHU-KHOA',
        nodeName: 'Máy Khoa Phụ Khoa',
        departmentId: 'dept-phu-khoa',
        isCoordinator: false,
      },
    ];

    const keyDir = path.join(this.dataDir, 'keys');
    if (!inMemory && !fs.existsSync(keyDir)) {
      fs.mkdirSync(keyDir, { recursive: true });
    }

    for (const spec of initialSpecs) {
      const dbPath = inMemory ? ':memory:' : path.join(this.dataDir, `bedcare-${spec.deviceId}.sqlite`);
      const db = openNodeDatabase(dbPath);
      const keys = this.loadOrCreateNodeKeys(spec.deviceId, inMemory ? null : keyDir);

      const maxClockRow = db.prepare('SELECT COALESCE(MAX(lamport_clock), 0) as c FROM events').get() as { c: number };
      this.nodes.set(spec.deviceId, {
        deviceId: spec.deviceId,
        nodeName: spec.nodeName,
        departmentId: spec.departmentId,
        db,
        dbPath,
        publicKey: keys.publicKey,
        privateKey: keys.privateKey,
        online: true,
        revoked: false,
        isCoordinator: spec.isCoordinator,
        partitionGroup: 'MAIN',
        lamportClock: maxClockRow.c,
        term: 1,
      });
    }

    // Ensure all nodes register each other in `devices` table if not already present
    const now = new Date().toISOString();
    for (const node of this.nodes.values()) {
      for (const peer of this.nodes.values()) {
        node.db
          .prepare(
            `INSERT OR IGNORE INTO devices (device_id, node_name, department_id, public_key, status, is_coordinator, last_seen_at, paired_at)
             VALUES (?, ?, ?, ?, 'TRUSTED', ?, ?, ?)`
          )
          .run(peer.deviceId, peer.nodeName, peer.departmentId, peer.publicKey, peer.isCoordinator ? 1 : 0, now, now);
      }
    }
  }

  private loadOrCreateNodeKeys(deviceId: string, keyDir: string | null) {
    if (!keyDir) return generateDeviceKeyPair();
    const pubFile = path.join(keyDir, `${deviceId}.pub.pem`);
    const privFile = path.join(keyDir, `${deviceId}.priv.pem`);
    if (fs.existsSync(pubFile) && fs.existsSync(privFile)) {
      return {
        publicKey: fs.readFileSync(pubFile, 'utf8'),
        privateKey: fs.readFileSync(privFile, 'utf8'),
      };
    }
    const pair = generateDeviceKeyPair();
    fs.writeFileSync(pubFile, pair.publicKey, 'utf8');
    fs.writeFileSync(privFile, pair.privateKey, 'utf8');
    return pair;
  }

  public getActiveNode(): NodeRuntime {
    const node = this.nodes.get(this.activeNodeId);
    if (!node) throw new Error(`Active node ${this.activeNodeId} not found`);
    return node;
  }

  public getNode(nodeId: string): NodeRuntime {
    const node = this.nodes.get(nodeId);
    if (!node) throw new Error(`Node ${nodeId} not found`);
    return node;
  }

  public getTotalTrustedActiveNodes(): number {
    let count = 0;
    for (const n of this.nodes.values()) {
      if (!n.revoked) count++;
    }
    return count;
  }

  public getRequiredQuorum(): number {
    const total = this.getTotalTrustedActiveNodes();
    return Math.floor(total / 2) + 1;
  }

  public getReachablePeers(fromNodeId: string): NodeRuntime[] {
    const origin = this.getNode(fromNodeId);
    if (!origin.online || origin.revoked) return [];
    const reachable: NodeRuntime[] = [];
    for (const candidate of this.nodes.values()) {
      if (
        candidate.online &&
        !candidate.revoked &&
        candidate.partitionGroup === origin.partitionGroup
      ) {
        reachable.push(candidate);
      }
    }
    return reachable;
  }

  private ensureCoordinatorInPartition(reachable: NodeRuntime[]): NodeRuntime | null {
    if (reachable.length < this.getRequiredQuorum()) return null;
    const existing = reachable.find((n) => n.isCoordinator);
    if (existing) return existing;
    // Automatic Raft-style leader election: pick lowest lexicographical deviceId in majority partition
    const sorted = [...reachable].sort((a, b) => a.deviceId.localeCompare(b.deviceId));
    const elected = sorted[0];
    for (const n of reachable) {
      n.isCoordinator = n.deviceId === elected.deviceId;
      n.term += 1;
      n.db.prepare('UPDATE devices SET is_coordinator = ? WHERE device_id = ?').run(n.isCoordinator ? 1 : 0, n.deviceId);
    }
    return elected;
  }

  private async withResourceLock<T>(resourceKey: string, fn: () => T | Promise<T>): Promise<T> {
    const prev = this.resourceMutexes.get(resourceKey) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((res) => {
      release = res;
    });
    this.resourceMutexes.set(resourceKey, prev.then(() => next));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private createSignedEvent(
    node: NodeRuntime,
    eventType: string,
    aggregateType: string,
    aggregateId: string,
    payloadObj: Record<string, unknown>,
    userId: string,
    consensusStatus: 'CONFIRMED' | 'PENDING_QUORUM' | 'REJECTED' = 'CONFIRMED'
  ): SignedEvent {
    node.lamportClock += 1;
    const eventId = `evt-${crypto.randomUUID()}`;
    const createdAt = new Date().toISOString();
    const payload = JSON.stringify(payloadObj);
    const seqRow = node.db.prepare('SELECT COALESCE(MAX(sequence_no), 0) + 1 as seq FROM events').get() as { seq: number };

    const canonical = {
      event_id: eventId,
      lamport_clock: node.lamportClock,
      event_type: eventType,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      payload,
      device_id: node.deviceId,
      user_id: userId,
      created_at: createdAt,
    };
    const signature = signEventData(canonical, node.privateKey);

    return {
      ...canonical,
      sequence_no: seqRow.seq,
      signature,
      verified: 1,
      consensus_status: consensusStatus,
    };
  }

  public receiveEventOnNode(targetNode: NodeRuntime, event: SignedEvent): { accepted: boolean; reason?: string } {
    if (targetNode.revoked) {
      return { accepted: false, reason: 'DEVICE_REVOKED' };
    }
    // Verify sender device trust
    const senderDevice = targetNode.db
      .prepare('SELECT * FROM devices WHERE device_id = ?')
      .get(event.device_id) as { public_key: string; status: string } | undefined;

    if (!senderDevice || senderDevice.status === 'REVOKED') {
      return { accepted: false, reason: 'SENDER_DEVICE_REVOKED_OR_UNKNOWN' };
    }

    // Verify Ed25519 signature
    const sigOk = verifyEventSignature(
      {
        event_id: event.event_id,
        lamport_clock: event.lamport_clock,
        event_type: event.event_type,
        aggregate_type: event.aggregate_type,
        aggregate_id: event.aggregate_id,
        payload: event.payload,
        device_id: event.device_id,
        user_id: event.user_id,
        created_at: event.created_at,
      },
      event.signature,
      senderDevice.public_key
    );

    if (!sigOk) {
      targetNode.db
        .prepare(
          `INSERT INTO conflicts (id, resource_type, resource_id, conflicting_event_id, conflicting_device_id, reason, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?)`
        )
        .run(
          `cfl-${crypto.randomUUID()}`,
          event.aggregate_type,
          event.aggregate_id,
          event.event_id,
          event.device_id,
          'INVALID_SIGNATURE: Chữ ký số Ed25519 không hợp lệ hoặc sự kiện bị giả mạo.',
          new Date().toISOString()
        );
      return { accepted: false, reason: 'INVALID_SIGNATURE' };
    }

    targetNode.lamportClock = Math.max(targetNode.lamportClock, event.lamport_clock) + 1;
    const res = applyEventToLocalDb(targetNode.db, event);
    return { accepted: true, reason: res.duplicate ? 'DUPLICATE_IGNORED' : 'APPLIED' };
  }

  public propagateEvent(originNode: NodeRuntime, event: SignedEvent) {
    const reachable = this.getReachablePeers(originNode.deviceId);
    const reachableIds = new Set(reachable.map((n) => n.deviceId));
    const now = new Date().toISOString();

    for (const peer of this.nodes.values()) {
      if (peer.deviceId === originNode.deviceId || peer.revoked) continue;
      if (reachableIds.has(peer.deviceId) && event.consensus_status === 'CONFIRMED') {
        const res = this.receiveEventOnNode(peer, event);
        if (!res.accepted) {
          originNode.db
            .prepare(
              `INSERT INTO sync_queue (id, event_id, target_device_id, status, retry_count, last_error, created_at)
               VALUES (?, ?, ?, 'FAILED', 1, ?, ?)`
            )
            .run(`sq-${crypto.randomUUID()}`, event.event_id, peer.deviceId, res.reason ?? 'FAILED', now);
        }
      } else {
        // Queue for offline / partitioned peer
        originNode.db
          .prepare(
            `INSERT INTO sync_queue (id, event_id, target_device_id, status, retry_count, last_error, created_at)
             VALUES (?, ?, ?, 'PENDING', 0, ?, ?)`
          )
          .run(
            `sq-${crypto.randomUUID()}`,
            event.event_id,
            peer.deviceId,
            event.consensus_status === 'PENDING_QUORUM' ? 'WAITING_QUORUM' : 'PEER_UNREACHABLE',
            now
          );
      }
    }
    this.onClusterUpdate?.();
  }

  /**
   * Standard replicated mutation (non-exclusive-bed-allocation operations like config, dept, cleaning, extension, etc.)
   */
  public commitStandardEvent(
    nodeId: string,
    userId: string,
    eventType: string,
    aggregateType: string,
    aggregateId: string,
    payloadObj: Record<string, unknown>
  ): SignedEvent {
    const node = this.getNode(nodeId);
    if (node.revoked) throw new SecurityRejectionError('Thiết bị này đã bị thu hồi quyền truy cập.', 'DEVICE_REVOKED');

    const userRow = node.db.prepare('SELECT status FROM users WHERE id = ?').get(userId) as { status: string } | undefined;
    if (userRow && userRow.status !== 'ACTIVE') {
      throw new SecurityRejectionError('Tài khoản đã bị khóa hoặc thu hồi.', 'USER_LOCKED');
    }

    const event = this.createSignedEvent(node, eventType, aggregateType, aggregateId, payloadObj, userId, 'CONFIRMED');
    applyEventToLocalDb(node.db, event);
    this.propagateEvent(node, event);
    return event;
  }

  /**
   * Critical Consensus Operation:
   * Enforces distributed Raft-quorum check + anti-double-booking across reachable peers.
   * Never uses Last-Write-Wins!
   */
  public async proposeCriticalAllocation(params: {
    nodeId: string;
    userId: string;
    requestType: 'ASSIGN_BED' | 'RESERVE_BED' | 'EXCLUSIVE_ROOM';
    eventType: 'ADMISSION_CONFIRM' | 'RESERVATION_CREATE' | 'BED_TRANSFER';
    aggregateType: string;
    aggregateId: string;
    bedId?: string | null;
    roomId: string;
    reservationId?: string | null;
    isWholeRoom?: boolean;
    payloadObj: Record<string, unknown>;
  }): Promise<{
    committed: boolean;
    pendingConfirmation: boolean;
    event: SignedEvent;
    quorumAchieved: number;
    quorumRequired: number;
  }> {
    const node = this.getNode(params.nodeId);
    if (node.revoked) {
      throw new SecurityRejectionError('Thiết bị đã bị thu hồi quyền truy cập.', 'DEVICE_REVOKED');
    }

    const resourceKey = params.isWholeRoom ? `room:${params.roomId}` : `bed:${params.bedId ?? params.roomId}`;

    return this.withResourceLock(resourceKey, () => {
      const reachable = this.getReachablePeers(params.nodeId);
      const quorumRequired = this.getRequiredQuorum();
      const coordinator = this.ensureCoordinatorInPartition(reachable);
      const now = new Date().toISOString();

      // Case 1: Network partition or insufficient quorum or coordinator unavailable without quorum
      if (!node.online || reachable.length < quorumRequired || !coordinator) {
        const pendingPayload = {
          ...params.payloadObj,
          status: 'PENDING_CONFIRMATION',
        };
        const pendingEvent = this.createSignedEvent(
          node,
          params.eventType,
          params.aggregateType,
          params.aggregateId,
          pendingPayload,
          params.userId,
          'PENDING_QUORUM'
        );
        applyEventToLocalDb(node.db, pendingEvent);

        node.db
          .prepare(
            `INSERT INTO pending_requests (id, request_type, target_id, payload, device_id, user_id, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 'WAITING_QUORUM', ?)`
          )
          .run(
            `req-${crypto.randomUUID()}`,
            params.requestType,
            params.bedId ?? params.roomId,
            JSON.stringify({ ...params, eventId: pendingEvent.event_id }),
            node.deviceId,
            params.userId,
            now
          );

        node.db
          .prepare(
            `INSERT INTO consensus_log (id, event_id, term, coordinator_id, resource_key, approving_devices, quorum_required, quorum_achieved, decision, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'DEFERRED_NO_QUORUM', ?)`
          )
          .run(
            `con-${crypto.randomUUID()}`,
            pendingEvent.event_id,
            node.term,
            'NONE',
            resourceKey,
            JSON.stringify(reachable.map((n) => n.deviceId)),
            quorumRequired,
            reachable.length,
            now
          );

        this.propagateEvent(node, pendingEvent);
        return {
          committed: false,
          pendingConfirmation: true,
          event: pendingEvent,
          quorumAchieved: reachable.length,
          quorumRequired,
        };
      }

      // Case 2: Quorum reached -> check latest state across ALL reachable peers for conflict!
      for (const peer of reachable) {
        const roomRow = peer.db.prepare('SELECT exclusive_locked, exclusive_lock_id, status FROM rooms WHERE id = ?').get(params.roomId) as
          | { exclusive_locked: number; exclusive_lock_id: string | null; status: string }
          | undefined;

        if (!roomRow || roomRow.status !== 'ACTIVE') {
          throw new ConsensusConflictError('Phòng bệnh không tồn tại hoặc đang ngừng hoạt động.', 'ROOM_INACTIVE');
        }

        if (roomRow.exclusive_locked && roomRow.exclusive_lock_id !== params.reservationId) {
          this.recordConflict(node, reachable, resourceKey, params.aggregateId, 'ROOM_EXCLUSIVE_LOCKED', peer.deviceId);
          throw new ConsensusConflictError(
            `Phòng đã được bao trọn bởi giao dịch khác trên nút ${peer.nodeName}.`,
            'CONFLICT_WHOLE_ROOM_LOCKED',
            { peerId: peer.deviceId }
          );
        }

        if (params.requestType === 'RESERVE_BED' || (params.eventType === 'RESERVATION_CREATE' && !params.isWholeRoom)) {
          const occupiedInRoom = peer.db
            .prepare("SELECT id, code FROM beds WHERE room_id = ? AND status = 'OCCUPIED' LIMIT 1")
            .get(params.roomId) as { id: string; code: string } | undefined;
          if (occupiedInRoom) {
            this.recordConflict(node, reachable, resourceKey, params.roomId, 'ROOM_IN_USE_RESERVATION_BLOCKED', peer.deviceId);
            throw new ConsensusConflictError(
              `Phòng đã chuyển sang trạng thái Đang sử dụng vì giường ${occupiedInRoom.code} đã chiếm dụng. Hệ thống chặn thao tác giữ chỗ giường khác trong cùng phòng (nút ${peer.nodeName}).`,
              'CONFLICT_ROOM_IN_USE',
              { bedCode: occupiedInRoom.code, peerId: peer.deviceId }
            );
          }
        }

        if (params.isWholeRoom) {
          const busyBeds = peer.db
            .prepare("SELECT id, code, status, current_reservation_id FROM beds WHERE room_id = ? AND status NOT IN ('VACANT', 'INACTIVE')")
            .all(params.roomId) as Array<{ id: string; code: string; status: string; current_reservation_id: string | null }>;
          const conflicting = busyBeds.filter((b) => b.current_reservation_id !== params.reservationId);
          if (conflicting.length > 0) {
            this.recordConflict(node, reachable, resourceKey, params.roomId, 'WHOLE_ROOM_BED_BUSY', peer.deviceId);
            throw new ConsensusConflictError(
              `Không thể bao trọn phòng vì giường ${conflicting[0].code} đang ở trạng thái ${conflicting[0].status}.`,
              'CONFLICT_WHOLE_ROOM_BUSY',
              { bedCode: conflicting[0].code }
            );
          }
        } else if (params.bedId) {
          const bedRow = peer.db
            .prepare('SELECT id, code, status, current_admission_id, current_reservation_id FROM beds WHERE id = ?')
            .get(params.bedId) as
            | { id: string; code: string; status: string; current_admission_id: string | null; current_reservation_id: string | null }
            | undefined;

          if (!bedRow) {
            throw new ConsensusConflictError('Không tìm thấy giường bệnh.', 'BED_NOT_FOUND');
          }

          const allowedSameReservation =
            bedRow.status === 'RESERVED' &&
            params.reservationId &&
            bedRow.current_reservation_id === params.reservationId;

          if (bedRow.status !== 'VACANT' && !allowedSameReservation) {
            this.recordConflict(node, reachable, resourceKey, params.bedId, `BED_ALREADY_${bedRow.status}`, peer.deviceId);
            throw new ConsensusConflictError(
              `Xung đột đồng thuận: Giường ${bedRow.code} không ở trạng thái trống trên nút ${peer.nodeName} (hiện tại: ${bedRow.status}).`,
              'CONFLICT_DOUBLE_BOOKING',
              { bedId: params.bedId, currentStatus: bedRow.status, peerId: peer.deviceId }
            );
          }
        }
      }

      // All quorum nodes agree -> commit signed event!
      const committedEvent = this.createSignedEvent(
        node,
        params.eventType,
        params.aggregateType,
        params.aggregateId,
        params.payloadObj,
        params.userId,
        'CONFIRMED'
      );
      applyEventToLocalDb(node.db, committedEvent);

      const approvingIds = reachable.map((n) => n.deviceId);
      for (const peer of reachable) {
        peer.db
          .prepare(
            `INSERT INTO consensus_log (id, event_id, term, coordinator_id, resource_key, approving_devices, quorum_required, quorum_achieved, decision, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'COMMITTED', ?)`
          )
          .run(
            `con-${crypto.randomUUID()}`,
            committedEvent.event_id,
            coordinator.term,
            coordinator.deviceId,
            resourceKey,
            JSON.stringify(approvingIds),
            quorumRequired,
            reachable.length,
            now
          );
      }

      this.propagateEvent(node, committedEvent);
      return {
        committed: true,
        pendingConfirmation: false,
        event: committedEvent,
        quorumAchieved: reachable.length,
        quorumRequired,
      };
    });
  }

  private recordConflict(
    originNode: NodeRuntime,
    reachable: NodeRuntime[],
    resourceKey: string,
    resourceId: string,
    reason: string,
    winningDeviceId: string
  ) {
    const now = new Date().toISOString();
    const conflictId = `cfl-${crypto.randomUUID()}`;
    const eventId = `aborted-${crypto.randomUUID()}`;
    for (const peer of reachable) {
      peer.db
        .prepare(
          `INSERT INTO conflicts (id, resource_type, resource_id, conflicting_event_id, winning_device_id, conflicting_device_id, reason, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)`
        )
        .run(
          conflictId,
          resourceKey.split(':')[0],
          resourceId,
          eventId,
          winningDeviceId,
          originNode.deviceId,
          reason,
          now
        );
      peer.db
        .prepare(
          `INSERT INTO consensus_log (id, event_id, term, coordinator_id, resource_key, approving_devices, quorum_required, quorum_achieved, decision, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ABORTED_CONFLICT', ?)`
        )
        .run(
          `con-${crypto.randomUUID()}`,
          eventId,
          originNode.term,
          winningDeviceId,
          resourceKey,
          JSON.stringify(reachable.map((n) => n.deviceId)),
          this.getRequiredQuorum(),
          reachable.length,
          now
        );
    }
    this.onClusterUpdate?.();
  }

  /**
   * Reconciles all reachable peers:
   * 1. Flushes sync_queue & missing confirmed events between reachable nodes (with signature + revocation checks)
   * 2. Resolves any WAITING_QUORUM pending_requests if quorum is now available
   */
  public async reconcileCluster(): Promise<{
    syncedEvents: number;
    resolvedPending: number;
    rejectedConflicts: number;
  }> {
    let syncedEvents = 0;
    let resolvedPending = 0;
    let rejectedConflicts = 0;
    const now = new Date().toISOString();

    // 1. Sync confirmed events between reachable pairs
    for (const source of this.nodes.values()) {
      if (!source.online || source.revoked) continue;
      const reachable = this.getReachablePeers(source.deviceId);
      const events = source.db
        .prepare("SELECT * FROM events WHERE consensus_status = 'CONFIRMED' ORDER BY lamport_clock ASC, sequence_no ASC")
        .all() as unknown as SignedEvent[];

      for (const target of reachable) {
        if (target.deviceId === source.deviceId) continue;
        for (const ev of events) {
          const exists = target.db.prepare('SELECT event_id FROM events WHERE event_id = ?').get(ev.event_id);
          if (!exists) {
            const res = this.receiveEventOnNode(target, ev);
            if (res.accepted) syncedEvents++;
          }
          source.db
            .prepare("UPDATE sync_queue SET status = 'DELIVERED', delivered_at = ? WHERE event_id = ? AND target_device_id = ? AND status != 'DELIVERED'")
            .run(now, ev.event_id, target.deviceId);
        }
      }
    }

    // 2. Process pending_requests on nodes that now have quorum
    for (const node of this.nodes.values()) {
      if (!node.online || node.revoked) continue;
      const reachable = this.getReachablePeers(node.deviceId);
      if (reachable.length < this.getRequiredQuorum()) continue;

      const pendingRows = node.db
        .prepare("SELECT * FROM pending_requests WHERE status = 'WAITING_QUORUM' ORDER BY created_at ASC")
        .all() as Array<{ id: string; request_type: string; target_id: string; payload: string; user_id: string }>;

      for (const req of pendingRows) {
        const parsed = JSON.parse(req.payload);
        try {
          // Clear temporary local PENDING_CONFIRMATION hold before re-proposing officially
          if (parsed.bedId) {
            node.db
              .prepare("UPDATE beds SET status = 'VACANT', current_admission_id = NULL, current_reservation_id = NULL WHERE id = ? AND status = 'PENDING_CONFIRMATION'")
              .run(parsed.bedId);
          }
          if (parsed.isWholeRoom && parsed.roomId) {
            node.db
              .prepare('UPDATE rooms SET exclusive_locked = 0, exclusive_lock_id = NULL WHERE id = ?')
              .run(parsed.roomId);
            node.db
              .prepare("UPDATE beds SET status = 'VACANT', current_admission_id = NULL, current_reservation_id = NULL WHERE room_id = ? AND status = 'PENDING_CONFIRMATION'")
              .run(parsed.roomId);
          }
          const entityId = parsed.payloadObj?.id || parsed.aggregateId;
          if (parsed.eventType === 'ADMISSION_CONFIRM') {
            node.db.prepare("DELETE FROM admissions WHERE id = ? AND status = 'PENDING_CONFIRMATION'").run(entityId);
          } else if (parsed.eventType === 'RESERVATION_CREATE') {
            node.db.prepare("DELETE FROM reservations WHERE id = ? AND status = 'PENDING_CONFIRMATION'").run(entityId);
          }

          await this.proposeCriticalAllocation({
            nodeId: node.deviceId,
            userId: req.user_id,
            requestType: parsed.requestType,
            eventType: parsed.eventType,
            aggregateType: parsed.aggregateType,
            aggregateId: parsed.aggregateId,
            bedId: parsed.bedId,
            roomId: parsed.roomId,
            reservationId: parsed.reservationId,
            isWholeRoom: parsed.isWholeRoom,
            payloadObj: { ...parsed.payloadObj, status: parsed.eventType === 'ADMISSION_CONFIRM' ? 'ACTIVE' : 'ACTIVE' },
          });
          node.db.prepare("UPDATE pending_requests SET status = 'COMMITTED', resolved_at = ? WHERE id = ?").run(now, req.id);
          resolvedPending++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Xung đột khi đối chiếu';
          node.db
            .prepare("UPDATE pending_requests SET status = 'REJECTED_CONFLICT', conflict_reason = ?, resolved_at = ? WHERE id = ?")
            .run(msg, now, req.id);
          rejectedConflicts++;
        }
      }
    }

    this.onClusterUpdate?.();
    return { syncedEvents, resolvedPending, rejectedConflicts };
  }

  public setNodeState(
    deviceId: string,
    updates: Partial<{ online: boolean; revoked: boolean; isCoordinator: boolean; partitionGroup: string }>
  ) {
    const node = this.getNode(deviceId);
    if (typeof updates.online === 'boolean') node.online = updates.online;
    if (typeof updates.revoked === 'boolean') node.revoked = updates.revoked;
    if (typeof updates.isCoordinator === 'boolean') node.isCoordinator = updates.isCoordinator;
    if (typeof updates.partitionGroup === 'string') node.partitionGroup = updates.partitionGroup;

    const status = node.revoked ? 'REVOKED' : node.online ? 'TRUSTED' : 'OFFLINE';
    for (const peer of this.nodes.values()) {
      peer.db
        .prepare('UPDATE devices SET status = ?, is_coordinator = ?, last_seen_at = ? WHERE device_id = ?')
        .run(status, node.isCoordinator ? 1 : 0, new Date().toISOString(), deviceId);
    }
    this.onClusterUpdate?.();
  }

  public pairNewDevice(nodeName: string, departmentId: string | null, actorUserId: string): NodeRuntime {
    const deviceId = `NODE-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const keys = generateDeviceKeyPair();
    const isMem = this.getActiveNode().dbPath === ':memory:';
    const dbPath = isMem ? ':memory:' : path.join(this.dataDir, `bedcare-${deviceId}.sqlite`);
    const db = openNodeDatabase(dbPath);
    const now = new Date().toISOString();

    const newNode: NodeRuntime = {
      deviceId,
      nodeName,
      departmentId,
      db,
      dbPath,
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      online: true,
      revoked: false,
      isCoordinator: false,
      partitionGroup: 'MAIN',
      lamportClock: 0,
      term: this.getActiveNode().term,
    };

    // Copy existing devices into new node & announce new device via signed event
    const active = this.getActiveNode();
    const existingDevices = active.db.prepare('SELECT * FROM devices').all() as Array<Record<string, unknown>>;
    for (const d of existingDevices) {
      db.prepare(
        'INSERT OR IGNORE INTO devices (device_id, node_name, department_id, public_key, status, is_coordinator, last_seen_at, paired_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(d.device_id as string, d.node_name as string, d.department_id as string | null, d.public_key as string, d.status as string, d.is_coordinator as number, d.last_seen_at as string, d.paired_at as string);
    }
    db.prepare(
      "INSERT OR IGNORE INTO devices (device_id, node_name, department_id, public_key, status, is_coordinator, last_seen_at, paired_at) VALUES (?, ?, ?, ?, 'TRUSTED', 0, ?, ?)"
    ).run(deviceId, nodeName, departmentId, keys.publicKey, now, now);

    this.nodes.set(deviceId, newNode);
    // Pull existing confirmed events so newly paired device starts caught up with cluster state
    const existingEvents = active.db
      .prepare("SELECT * FROM events WHERE consensus_status = 'CONFIRMED' ORDER BY lamport_clock ASC, sequence_no ASC")
      .all() as unknown as SignedEvent[];
    for (const ev of existingEvents) {
      applyEventToLocalDb(db, ev);
    }

    this.commitStandardEvent(active.deviceId, actorUserId, 'DEVICE_UPSERT', 'DEVICE', deviceId, {
      device_id: deviceId,
      node_name: nodeName,
      department_id: departmentId,
      public_key: keys.publicKey,
      status: 'TRUSTED',
      is_coordinator: 0,
      paired_at: now,
      audit_action: 'PAIR_DEVICE',
      audit_details: `Ghép nối thiết bị mới ${nodeName} (${deviceId})`,
    });
    return newNode;
  }

  public revokeDevice(targetDeviceId: string, actorUserId: string) {
    const active = this.getActiveNode();
    if (targetDeviceId === active.deviceId) {
      throw new Error('Không thể thu hồi chính thiết bị đang thao tác.');
    }
    this.setNodeState(targetDeviceId, { revoked: true, isCoordinator: false });
    this.commitStandardEvent(active.deviceId, actorUserId, 'DEVICE_REVOKE', 'DEVICE', targetDeviceId, {
      target_device_id: targetDeviceId,
      audit_action: 'REVOKE_DEVICE',
      audit_details: `Thu hồi quyền truy cập thiết bị ${targetDeviceId}`,
    });
  }

  private static readonly BACKUP_TABLES = [
    'departments',
    'room_standards',
    'bed_types',
    'rooms',
    'beds',
    'patients',
    'diagnosis_configs',
    'registrations',
    'reservations',
    'admissions',
    'bed_extensions',
    'bed_transfers',
    'transfer_requests',
    'cleaning_logs',
    'his_import_logs',
    'his_bed_mappings',
    'his_bed_assignments',
    'his_audit_resolutions',
    'pending_requests',
    'conflicts',
    'users',
    'devices',
    'events',
    'consensus_log',
    'system_configs',
  ] as const;

  public createEncryptedBackup(
    nodeId: string,
    actorUsername: string,
    options?: { prefix?: string }
  ) {
    const node = this.getNode(nodeId);
    const snapshot: Record<string, unknown[]> = {};
    let recordCount = 0;
    for (const t of BedcareCluster.BACKUP_TABLES) {
      const rows = node.db.prepare(`SELECT * FROM ${t}`).all() as Record<string, unknown>[];
      snapshot[t] = rows;
      recordCount += rows.length;
    }

    const payloadJson = JSON.stringify({
      meta: {
        device_id: node.deviceId,
        app_version: '1.0.0',
        schema_version: '1.0.0',
        created_at: new Date().toISOString(),
        created_by: actorUsername,
      },
      tables: snapshot,
    });

    const envelope = encryptBackupPayload(payloadJson);
    const backupId = `bkp-${crypto.randomUUID().slice(0, 8)}`;
    const prefix = sanitizeBackupPrefix(options?.prefix);
    const backupName = `${prefix}-${node.deviceId}-${new Date().toISOString().replace(/[:.]/g, '-')}.bcare`;
    const backupDir = path.join(this.dataDir, 'backups');
    if (node.dbPath !== ':memory:' && !fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    const filePath = node.dbPath === ':memory:' ? `:mem:${backupName}` : path.join(backupDir, backupName);
    if (node.dbPath !== ':memory:') {
      fs.writeFileSync(filePath, JSON.stringify(envelope, null, 2), 'utf8');
    } else {
      this.memoryBackups.set(backupId, envelope);
    }

    const now = new Date().toISOString();
    node.db
      .prepare(
        `INSERT INTO backups (id, backup_name, device_id, app_version, schema_version, checksum_sha256, encrypted, record_count, status, file_path, created_by, created_at)
         VALUES (?, ?, ?, '1.0.0', '1.0.0', ?, 1, ?, 'SUCCESS', ?, ?, ?)`
      )
      .run(backupId, backupName, node.deviceId, envelope.checksum_sha256, recordCount, filePath, actorUsername, now);

    return {
      id: backupId,
      backup_name: backupName,
      checksum_sha256: envelope.checksum_sha256,
      record_count: recordCount,
      file_path: filePath,
      created_at: now,
    };
  }

  private memoryBackups = new Map<string, EncryptedBackupEnvelope>();

  public getEncryptedBackupEnvelope(nodeId: string, backupId: string): {
    backupName: string;
    envelope: EncryptedBackupEnvelope;
  } {
    const node = this.getNode(nodeId);
    const bkpRow = node.db.prepare('SELECT * FROM backups WHERE id = ?').get(backupId) as
      | { id: string; backup_name: string; file_path: string; checksum_sha256: string }
      | undefined;
    if (!bkpRow) throw new Error('Không tìm thấy bản sao lưu.');

    let envelope: EncryptedBackupEnvelope;
    if (bkpRow.file_path.startsWith(':mem:')) {
      const found = this.memoryBackups.get(backupId);
      if (!found) throw new Error('Không tìm thấy dữ liệu sao lưu trong bộ nhớ.');
      envelope = found;
    } else {
      if (!fs.existsSync(bkpRow.file_path)) {
        throw new Error('File bản sao lưu không còn tồn tại trên ổ đĩa máy trạm.');
      }
      envelope = JSON.parse(fs.readFileSync(bkpRow.file_path, 'utf8')) as EncryptedBackupEnvelope;
    }
    return { backupName: bkpRow.backup_name, envelope };
  }

  public verifyEncryptedBackup(nodeId: string, backupId: string) {
    const node = this.getNode(nodeId);
    const bkpRow = node.db.prepare('SELECT * FROM backups WHERE id = ?').get(backupId) as
      | { id: string; backup_name: string; checksum_sha256: string; record_count: number; created_at: string }
      | undefined;
    if (!bkpRow) throw new Error('Không tìm thấy bản sao lưu.');

    const { envelope } = this.getEncryptedBackupEnvelope(nodeId, backupId);
    const decryptedJson = decryptBackupPayload(envelope);
    const actualChecksum = sha256Hex(decryptedJson);
    const parsed = JSON.parse(decryptedJson) as {
      meta: { schema_version: string };
      tables: Record<string, unknown[]>;
    };
    const totalRows = Object.values(parsed.tables || {}).reduce(
      (sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0),
      0
    );
    const valid = actualChecksum === bkpRow.checksum_sha256 && parsed.meta?.schema_version === '1.0.0';
    return {
      valid,
      backup_name: bkpRow.backup_name,
      checksum_sha256: actualChecksum,
      record_count: totalRows,
      created_at: bkpRow.created_at,
    };
  }

  public async restoreFromUploadedEnvelope(
    nodeId: string,
    fileName: string,
    envelope: EncryptedBackupEnvelope,
    actorUsername: string,
    options?: { authoritativeAllNodes?: boolean; createPreRestoreBackup?: boolean }
  ) {
    if (
      !envelope ||
      envelope.algorithm !== 'aes-256-gcm' ||
      !envelope.iv ||
      !envelope.authTag ||
      !envelope.ciphertext ||
      !envelope.checksum_sha256
    ) {
      throw new Error('Định dạng file sao lưu .bcare không hợp lệ hoặc thiếu chữ ký AES-256-GCM.');
    }

    const decryptedJson = decryptBackupPayload(envelope);
    const parsed = JSON.parse(decryptedJson) as {
      meta: { schema_version: string; device_id?: string };
      tables: Record<string, Record<string, unknown>[]>;
    };
    if (parsed.meta?.schema_version !== '1.0.0') {
      throw new Error(`Phiên bản cấu trúc dữ liệu không tương thích: ${parsed.meta?.schema_version || 'unknown'}`);
    }

    let preRestoreBackup: ReturnType<BedcareCluster['createEncryptedBackup']> | undefined;
    if (options?.createPreRestoreBackup) {
      preRestoreBackup = this.createEncryptedBackup(nodeId, actorUsername, { prefix: 'auto-pre-restore' });
    }

    const node = this.getNode(nodeId);
    const totalRows = Object.values(parsed.tables || {}).reduce(
      (sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0),
      0
    );
    const backupId = `bkp-up-${crypto.randomUUID().slice(0, 8)}`;
    const safeName = (fileName || `uploaded-${backupId}.bcare`).replace(/[^a-zA-Z0-9._-]/g, '_');
    const backupDir = path.join(this.dataDir, 'backups');
    if (node.dbPath !== ':memory:' && !fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    const filePath = node.dbPath === ':memory:' ? `:mem:${safeName}` : path.join(backupDir, `${backupId}-${safeName}`);
    if (node.dbPath !== ':memory:') {
      fs.writeFileSync(filePath, JSON.stringify(envelope, null, 2), 'utf8');
    } else {
      this.memoryBackups.set(backupId, envelope);
    }

    node.db
      .prepare(
        `INSERT INTO backups (id, backup_name, device_id, app_version, schema_version, checksum_sha256, encrypted, record_count, status, file_path, created_by, created_at)
         VALUES (?, ?, ?, '1.0.0', '1.0.0', ?, 1, ?, 'SUCCESS', ?, ?, ?)`
      )
      .run(
        backupId,
        safeName,
        parsed.meta.device_id || node.deviceId,
        envelope.checksum_sha256,
        totalRows,
        filePath,
        actorUsername,
        new Date().toISOString()
      );

    const restored = await this.restoreEncryptedBackup(nodeId, backupId, actorUsername, {
      authoritativeAllNodes: options?.authoritativeAllNodes,
      createPreRestoreBackup: false,
    });
    return {
      ...restored,
      preRestoreBackup: preRestoreBackup ?? restored.preRestoreBackup,
    };
  }

  private applySnapshotTablesToDb(
    targetDb: DatabaseSync,
    tables: Record<string, Record<string, unknown>[]>
  ) {
    const restoreOrder = [...BedcareCluster.BACKUP_TABLES];
    targetDb.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;');
    try {
      for (const table of [...restoreOrder].reverse()) {
        targetDb.exec(`DELETE FROM ${table}`);
      }
      for (const table of restoreOrder) {
        const rows = tables[table] ?? [];
        if (rows.length === 0) continue;
        const validCols = new Set(
          (targetDb.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)
        );
        const cols = Object.keys(rows[0]).filter((col) => validCols.has(col));
        if (cols.length === 0) continue;
        const placeholders = cols.map(() => '?').join(',');
        const stmt = targetDb.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`);
        for (const r of rows) {
          stmt.run(...cols.map((c) => r[c] as string | number | null));
        }
      }
      targetDb.exec('COMMIT; PRAGMA foreign_keys = ON;');
    } catch (e) {
      targetDb.exec('ROLLBACK; PRAGMA foreign_keys = ON;');
      throw e;
    }
  }

  public async restoreEncryptedBackup(
    nodeId: string,
    backupId: string,
    actorUsername: string,
    options?: { authoritativeAllNodes?: boolean; createPreRestoreBackup?: boolean }
  ) {
    const node = this.getNode(nodeId);
    const bkpRow = node.db.prepare('SELECT * FROM backups WHERE id = ?').get(backupId) as
      | { id: string; backup_name: string; file_path: string; checksum_sha256: string }
      | undefined;
    if (!bkpRow) throw new Error('Không tìm thấy bản sao lưu.');

    const { envelope } = this.getEncryptedBackupEnvelope(nodeId, backupId);

    const decryptedJson = decryptBackupPayload(envelope);
    const parsed = JSON.parse(decryptedJson) as {
      meta: { schema_version: string; device_id: string };
      tables: Record<string, Record<string, unknown>[]>;
    };

    if (parsed.meta.schema_version !== '1.0.0') {
      throw new Error(`Phiên bản cấu trúc dữ liệu không tương thích: ${parsed.meta.schema_version}`);
    }

    let preRestoreBackup: ReturnType<BedcareCluster['createEncryptedBackup']> | undefined;
    if (options?.createPreRestoreBackup) {
      preRestoreBackup = this.createEncryptedBackup(nodeId, actorUsername, { prefix: 'auto-pre-restore' });
    }

    if (options?.authoritativeAllNodes) {
      for (const peer of this.nodes.values()) {
        this.applySnapshotTablesToDb(peer.db, parsed.tables);
      }
      node.db.prepare("UPDATE backups SET status = 'RESTORED' WHERE id = ?").run(backupId);
      const now = new Date().toISOString();
      for (const peer of this.nodes.values()) {
        peer.db
          .prepare(
            `INSERT INTO audit_logs (id, user_id, username, device_id, action, entity_type, entity_id, details, created_at)
             VALUES (?, ?, ?, ?, 'RESTORE_SAFETY_SNAPSHOT', 'BACKUP', ?, ?, ?)`
          )
          .run(
            `aud-${crypto.randomUUID()}`,
            actorUsername,
            actorUsername,
            peer.deviceId,
            backupId,
            `Khôi phục khẩn cấp toàn cụm về bản sao lưu ${bkpRow.backup_name} (${backupId}).`,
            now
          );
      }
      this.onClusterUpdate?.();
      return {
        restored: true,
        reconciledEvents: 0,
        checksumVerified: sha256Hex(decryptedJson) === bkpRow.checksum_sha256,
        preRestoreBackup,
      };
    }

    // Default P2P recovery: restore local node tables then reconcile newer quorum events
    this.applySnapshotTablesToDb(node.db, parsed.tables);
    node.db.prepare("UPDATE backups SET status = 'RESTORED' WHERE id = ?").run(backupId);

    const syncResult = await this.reconcileCluster();
    node.db
      .prepare(
        `INSERT INTO audit_logs (id, user_id, username, device_id, action, entity_type, entity_id, details, created_at)
         VALUES (?, ?, ?, ?, 'RESTORE_BACKUP', 'BACKUP', ?, ?, ?)`
      )
      .run(
        `aud-${crypto.randomUUID()}`,
        actorUsername,
        actorUsername,
        node.deviceId,
        backupId,
        `Khôi phục bản sao lưu ${backupId} và đối chiếu đồng thuận (+${syncResult.syncedEvents} sự kiện mới từ mạng).`,
        new Date().toISOString()
      );

    return {
      restored: true,
      reconciledEvents: syncResult.syncedEvents,
      checksumVerified: sha256Hex(decryptedJson) === bkpRow.checksum_sha256,
      preRestoreBackup,
    };
  }
}
