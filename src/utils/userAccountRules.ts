import type { UserRole } from '../types/bedcare';

export const DEFAULT_ADMIN_ID = 'usr-admin';
export const DEFAULT_ADMIN_USERNAME = 'admin';
export const DEFAULT_ADMIN_PASSWORD = 'admin';
export const DEFAULT_STAFF_RESET_PASSWORD = '123456';
export const MIN_USER_PASSWORD_LENGTH = 4;

export function isDefaultAdminAccount(user: { id?: string | null; username?: string | null }): boolean {
  const uname = (user.username ?? '').trim().toLowerCase();
  return user.id === DEFAULT_ADMIN_ID || uname === DEFAULT_ADMIN_USERNAME;
}

export interface AccountMutationCheckResult {
  allowed: boolean;
  statusCode: number;
  error?: string;
}

export function validateUserUpdateRule(params: {
  actorRole: UserRole;
  targetUser: { id: string; username: string; role: UserRole };
  nextUsername?: string;
  nextRole: UserRole;
  nextStatus?: 'ACTIVE' | 'LOCKED' | 'REVOKED';
}): AccountMutationCheckResult {
  const { actorRole, targetUser, nextUsername, nextRole, nextStatus } = params;

  if (isDefaultAdminAccount(targetUser)) {
    if (nextUsername && nextUsername.trim().toLowerCase() !== DEFAULT_ADMIN_USERNAME) {
      return {
        allowed: false,
        statusCode: 403,
        error: 'Không được phép đổi tên đăng nhập của tài khoản admin mặc định.',
      };
    }
    if (nextRole !== 'SUPER_ADMIN') {
      return {
        allowed: false,
        statusCode: 403,
        error: 'Tài khoản admin mặc định luôn phải giữ quyền cao nhất (Super Admin).',
      };
    }
    if (nextStatus && nextStatus !== 'ACTIVE') {
      return {
        allowed: false,
        statusCode: 403,
        error: 'Không được phép khóa hoặc thu hồi tài khoản admin mặc định.',
      };
    }
  }

  if (actorRole === 'ADMIN' && (targetUser.role === 'SUPER_ADMIN' || nextRole === 'SUPER_ADMIN')) {
    return {
      allowed: false,
      statusCode: 403,
      error: 'Admin hệ thống không được phép tạo hoặc chỉnh sửa tài khoản Super Admin.',
    };
  }

  return { allowed: true, statusCode: 200 };
}

export function validateUserStatusRule(params: {
  actorId: string;
  actorRole: UserRole;
  targetUser: { id: string; username: string; role: UserRole };
  nextStatus: 'ACTIVE' | 'LOCKED' | 'REVOKED';
}): AccountMutationCheckResult {
  const { actorId, actorRole, targetUser, nextStatus } = params;

  if (isDefaultAdminAccount(targetUser) && nextStatus !== 'ACTIVE') {
    return {
      allowed: false,
      statusCode: 403,
      error: 'Không được phép khóa hoặc thu hồi tài khoản admin mặc định.',
    };
  }
  if (targetUser.id === actorId && nextStatus !== 'ACTIVE') {
    return {
      allowed: false,
      statusCode: 400,
      error: 'Không thể tự khóa tài khoản đang đăng nhập.',
    };
  }
  if (actorRole === 'ADMIN' && targetUser.role === 'SUPER_ADMIN') {
    return {
      allowed: false,
      statusCode: 403,
      error: 'Admin hệ thống không được phép thay đổi trạng thái tài khoản Super Admin.',
    };
  }
  return { allowed: true, statusCode: 200 };
}

export function validateUserDeleteRule(params: {
  actorId: string;
  actorRole: UserRole;
  targetUser: { id: string; username: string; role: UserRole };
}): AccountMutationCheckResult {
  const { actorId, actorRole, targetUser } = params;

  if (isDefaultAdminAccount(targetUser)) {
    return {
      allowed: false,
      statusCode: 403,
      error: 'Không được phép xóa tài khoản admin mặc định của hệ thống.',
    };
  }
  if (targetUser.id === actorId) {
    return {
      allowed: false,
      statusCode: 400,
      error: 'Không thể tự xóa tài khoản đang đăng nhập.',
    };
  }
  if (actorRole === 'ADMIN' && targetUser.role === 'SUPER_ADMIN') {
    return {
      allowed: false,
      statusCode: 403,
      error: 'Admin hệ thống không được phép xóa tài khoản Super Admin.',
    };
  }
  return { allowed: true, statusCode: 200 };
}
