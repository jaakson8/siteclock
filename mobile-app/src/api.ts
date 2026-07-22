import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";

const API_URL: string =
  (Constants.expoConfig?.extra?.apiUrl as string) ??
  "https://siteclock-api.onrender.com";

const SESSION_KEY = "siteclock_session_v1";

export type Worker = {
  id: string;
  name: string;
  phone: string;
  role: string;
  clientId: string;
  accessToken: string;
  expiresInSeconds: number;
};

export type ScanResult = {
  eventId: string;
  siteId: string;
  siteName: string;
  gateName: string;
  action: "IN" | "OUT";
  registeredAt: string;
};

export type ApiErrorBody = {
  code?: string;
  message?: string;
  requestId?: string;
  retryAfterSeconds?: number;
};

export class ApiError extends Error {
  code?: string;
  status: number;
  requestId?: string;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message ?? "Tundmatu viga");
    this.status = status;
    this.code = body.code;
    this.requestId = body.requestId;
  }
}

async function request<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    token?: string | null;
  } = {},
): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new ApiError(response.status, data as ApiErrorBody);
  }

  return data as T;
}

export async function loadSession(): Promise<Worker | null> {
  try {
    const raw = await SecureStore.getItemAsync(SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Worker;
  } catch {
    return null;
  }
}

export async function saveSession(worker: Worker): Promise<void> {
  await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(worker));
}

export async function clearSession(): Promise<void> {
  await SecureStore.deleteItemAsync(SESSION_KEY);
}

export async function registerWorker(
  phone: string,
  pin: string,
): Promise<Worker> {
  const data = await request<Omit<Worker, "accessToken" | "expiresInSeconds"> & {
    accessToken: string;
    expiresInSeconds: number;
  }>("/v1/auth/register", {
    method: "POST",
    body: { phone, pin },
  });
  const worker: Worker = data as Worker;
  await saveSession(worker);
  return worker;
}

export async function logout(token: string): Promise<void> {
  try {
    await request("/v1/auth/logout", { method: "POST", token });
  } finally {
    await clearSession();
  }
}

export async function submitScan(
  token: string,
  params: {
    qrPayload: string;
    latitude: number;
    longitude: number;
    accuracyMeters: number;
    scannedAt: string;
    clientEventId: string;
    mockedLocation?: boolean;
  },
): Promise<ScanResult> {
  return request<ScanResult>("/v1/attendance/scan", {
    method: "POST",
    token,
    body: params,
  });
}

export type TimesheetDay = {
  date: string;
  siteId: string;
  siteName: string;
  inTime: string | null;
  outTime: string | null;
  totalMinutes: number | null;
  corrected?: boolean;
};

export async function fetchTimesheet(
  token: string,
  from: string,
  to: string,
): Promise<TimesheetDay[]> {
  return request<TimesheetDay[]>(
    `/v1/me/timesheet?from=${from}&to=${to}`,
    { token },
  );
}

export type NotificationItem = {
  id: string;
  type: string;
  title: string;
  message: string;
  readAt: string | null;
  createdAt: string;
};

export async function fetchNotifications(
  token: string,
): Promise<NotificationItem[]> {
  return request<NotificationItem[]>("/v1/me/notifications", { token });
}

export async function markNotificationRead(
  token: string,
  id: string,
): Promise<void> {
  await request(`/v1/me/notifications/${id}/read`, {
    method: "POST",
    token,
  });
}

export async function submitCorrectionRequest(
  token: string,
  params: {
    date: string;
    requestedInTime?: string;
    requestedOutTime?: string;
    reason: string;
  },
): Promise<void> {
  await request("/v1/attendance/correction-requests", {
    method: "POST",
    token,
    body: params,
  });
}

export { API_URL };
