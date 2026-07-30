import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { apiErrorMessage, loadLanguage } from './i18n';

export type RegisterAccountInput = {
  name: string;
  phone: string;
  pin: string;
};

export type Account = {
  id: string;
  name: string;
  phone: string;
  role: 'worker' | 'manager';
  accessToken: string;
  expiresInSeconds?: number;
  sessionExpiresAt?: number;
};

export type ScanInput = {
  clientEventId: string;
  qrPayload: string;
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  mockedLocation: boolean;
  scannedAt: string;
};

export type ScanResponse = {
  eventId: string;
  action: 'IN' | 'OUT';
  siteName: string;
  gateName: string;
  registeredAt: string;
  distanceMeters: number;
};

export type TimesheetDay = {
  date: string;
  siteName: string;
  inTime: string;
  outTime: string | null;
  totalMinutes: number | null;
};
export type CorrectionRequest = {
  id: string;
  date: string;
  siteName: string;
  requestedInTime: string | null;
  requestedOutTime: string | null;
  reason: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  createdAt: string;
  decidedAt?: string;
  decisionNote?: string;
};
export type WorkerNotification = {
  id: string;
  type: 'CORRECTION_APPROVED' | 'CORRECTION_REJECTED' | 'MISSING_OUT';
  title: string;
  message: string;
  readAt: string | null;
  createdAt: string;
};

export type RecoveryChallenge = {
  accepted: boolean;
  challengeId?: string;
  developmentCode?: string;
};

const baseUrl = (process.env.EXPO_PUBLIC_API_URL || 'https://siteclock-web.onrender.com/api').replace(/\/$/, '');
let demoAccount: Account | null = null;
const pendingScanKey = 'objektiaeg.pending-scans.v1';
const sessionKey = 'objektiaeg.worker-session.v1';

export class ApiRequestError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export type PendingScan = { id: string; input: ScanInput; queuedAt: string; lastError?: string };

async function readPendingScans(): Promise<PendingScan[]> {
  const stored = await AsyncStorage.getItem(pendingScanKey);
  if (!stored) return [];
  try { return JSON.parse(stored) as PendingScan[]; } catch { return []; }
}

async function writePendingScans(rows: PendingScan[]) {
  await AsyncStorage.setItem(pendingScanKey, JSON.stringify(rows));
}

export function isNetworkFailure(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return error instanceof TypeError || message.includes('network request failed') || message.includes('failed to fetch');
}

export async function queueScan(input: ScanInput) {
  const rows = await readPendingScans();
  rows.push({ id: `pending-${Date.now()}-${Math.random().toString(16).slice(2)}`, input, queuedAt: new Date().toISOString() });
  await writePendingScans(rows);
  return rows.length;
}

export async function pendingScanCount() {
  return (await readPendingScans()).length;
}

export async function discardFirstPendingScan() {
  const rows = await readPendingScans();
  rows.shift();
  await writePendingScans(rows);
  return rows.length;
}

export async function syncPendingScans() {
  const rows = await readPendingScans();
  const remaining: PendingScan[] = [];
  let synced = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    try {
      await registerScan(row.input);
      synced += 1;
    } catch (error) {
      remaining.push({ ...row, lastError: error instanceof Error ? error.message : 'Saatmine ebaõnnestus' }, ...rows.slice(index + 1));
      break;
    }
  }
  await writePendingScans(remaining);
  return { synced, pending: remaining.length, lastError: remaining[0]?.lastError };
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  if (!baseUrl) throw new Error('DEMO_MODE');
  const language = await loadLanguage();
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Accept-Language': language,
      ...(demoAccount ? { Authorization: `Bearer ${demoAccount.accessToken}` } : {}),
      ...options?.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const fallback = body.message ?? `API error ${response.status}`;
    const localized = apiErrorMessage(language, body.code, fallback);
    throw new ApiRequestError(`${localized}${body.requestId ? ` (${body.requestId})` : ''}`, body.code);
  }
  return body as T;
}

export async function registerAccount(input: RegisterAccountInput): Promise<Account> {
  if (!baseUrl) {
    demoAccount = { id: 'worker-demo-1', name: input.name, phone: input.phone, role: 'worker', accessToken: 'demo-token' };
    await SecureStore.setItemAsync(sessionKey, JSON.stringify(demoAccount));
    return demoAccount;
  }
  const account = await request<Account>('/v1/auth/register', { method: 'POST', body: JSON.stringify(input) });
  demoAccount = {
    ...account,
    sessionExpiresAt: Date.now() + (account.expiresInSeconds ?? 28_800) * 1000,
  };
  await SecureStore.setItemAsync(sessionKey, JSON.stringify(demoAccount));
  return demoAccount;
}

export async function restoreSession(): Promise<Account | null> {
  const stored = await SecureStore.getItemAsync(sessionKey);
  if (!stored) return null;
  try {
    demoAccount = JSON.parse(stored) as Account;
    if (demoAccount.sessionExpiresAt && demoAccount.sessionExpiresAt <= Date.now()) {
      demoAccount = null;
      await SecureStore.deleteItemAsync(sessionKey);
      return null;
    }
    if (!baseUrl) return demoAccount;
    const profile = await request<Omit<Account, 'accessToken'>>('/v1/me/profile');
    demoAccount = { ...demoAccount, ...profile };
    await SecureStore.setItemAsync(sessionKey, JSON.stringify(demoAccount));
    return demoAccount;
  } catch {
    demoAccount = null;
    await SecureStore.deleteItemAsync(sessionKey);
    return null;
  }
}

export async function logout() {
  try {
    if (baseUrl && demoAccount) await request('/v1/auth/logout', { method: 'POST', body: '{}' });
  } finally {
    demoAccount = null;
    await SecureStore.deleteItemAsync(sessionKey);
  }
}

export async function requestPinRecovery(phone: string): Promise<RecoveryChallenge> {
  if (!baseUrl) return { accepted: true, challengeId: 'demo-recovery', developmentCode: '176949' };
  return request<RecoveryChallenge>('/v1/auth/recovery/request', {
    method: 'POST',
    body: JSON.stringify({ phone }),
  });
}

export async function confirmPinRecovery(input: { challengeId: string; code: string; newPin: string }) {
  if (!baseUrl) {
    if (input.code !== '176949') throw new Error('Vale taastamiskood');
    return { reset: true };
  }
  return request<{ reset: boolean }>('/v1/auth/recovery/confirm', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function registerScan(input: ScanInput): Promise<ScanResponse> {
  if (!baseUrl) {
    return {
      eventId: `demo-${Date.now()}`,
      action: input.qrPayload.toUpperCase().includes('OUT') ? 'OUT' : 'IN',
      siteName: 'Kesklinna ehitus',
      gateName: 'Peavärav',
      registeredAt: input.scannedAt,
      distanceMeters: 42,
    };
  }
  return request<ScanResponse>('/v1/attendance/scan', { method: 'POST', body: JSON.stringify(input) });
}

export async function getTimesheet(from: string, to: string): Promise<TimesheetDay[]> {
  if (!baseUrl) return [
    { date: '2026-07-18', siteName: 'Kesklinna ehitus', inTime: '07:42', outTime: null, totalMinutes: null },
    { date: '2026-07-17', siteName: 'Kesklinna ehitus', inTime: '08:03', outTime: '17:01', totalMinutes: 538 },
    { date: '2026-07-16', siteName: 'Sadama objekt', inTime: '07:28', outTime: '17:58', totalMinutes: 630 },
  ];
  return request<TimesheetDay[]>(`/v1/me/timesheet?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
}

export async function submitCorrection(input: { date: string; requestedInTime?: string; requestedOutTime?: string; reason: string }) {
  if (!baseUrl) return { id: `demo-correction-${Date.now()}`, ...input, status: 'PENDING' };
  return request('/v1/attendance/correction-requests', { method: 'POST', body: JSON.stringify(input) });
}

export async function getCorrectionRequests(): Promise<CorrectionRequest[]> {
  if (!baseUrl) return [
    { id: 'demo-correction-1', date: '2026-07-18', siteName: 'Kesklinna ehitus', requestedInTime: '07:42', requestedOutTime: '16:15', reason: 'Unustasin OUT-koodi skaneerida', status: 'PENDING', createdAt: new Date().toISOString() },
  ];
  return request<CorrectionRequest[]>('/v1/attendance/correction-requests');
}

export async function getNotifications(): Promise<WorkerNotification[]> {
  if (!baseUrl) return [];
  return request<WorkerNotification[]>('/v1/me/notifications');
}

export async function markNotificationRead(id: string) {
  if (!baseUrl) return;
  return request(`/v1/me/notifications/${id}/read`, { method: 'POST', body: '{}' });
}
