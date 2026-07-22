import { createServer } from "node:http";
import {
  randomBytes,
  randomInt,
  randomUUID,
  createCipheriv,
  createDecipheriv,
  createHash,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStateStore } from "./db.mjs";
import { createEmailProcessor } from "./mailer.mjs";
import { startScheduler } from "./scheduler.mjs";
import QRCode from "qrcode";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const isDevelopmentEnvironment = ["development", "test"].includes(process.env.NODE_ENV);
const developmentPassword = isDevelopmentEnvironment ? "demo1234" : randomBytes(32).toString("base64url");
const transientCodeKey = createHash("sha256")
  .update(process.env.CODE_ENCRYPTION_KEY ?? process.env.SMS_WEBHOOK_TOKEN ?? developmentPassword)
  .digest();

function protectTransientCode(code) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", transientCodeKey, iv);
  const encrypted = Buffer.concat([cipher.update(String(code), "utf8"), cipher.final()]);
  return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}

function revealTransientCode(value) {
  const [iv, tag, encrypted] = String(value).split(".").map((part) => Buffer.from(part, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", transientCodeKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

const admin = {
  id: "admin-1",
  name: "Peakasutaja",
  email: process.env.ADMIN_EMAIL ?? (isDevelopmentEnvironment ? "owner@example.com" : ""),
  role: "admin",
  passwordHash: hashSecret(process.env.ADMIN_PASSWORD ?? developmentPassword),
};
const stateStore = createStateStore(
  process.env.DATABASE_PATH ??
    join(moduleDirectory, "data", "objektiaeg.sqlite"),
);
const persistentState = stateStore.load({
  workers: [
    {
      id: "worker-1",
      name: "Martin Kask",
      phone: "+37255551234",
      role: "worker",
      clientId: "client-1",
    },
  ],
  clients: [
    {
      id: "client-1",
      companyName: "Demo Ehitus OÜ",
      registryCode: "12345678",
      billingEmail: "arved@example.com",
      language: "et",
      monthlyFeeCents: 9900,
      vatRate: 0.24,
      country: "EE",
      invoiceDay: 1,
      dueDays: 14,
      automaticSending: true,
      reminderDays: [1, 7, 14],
      active: true,
      billingStatus: "ACTIVE",
      autoRestrict: true,
      restrictionGraceDays: 3,
      restrictedAt: null,
      restrictionOverrideUntil: null,
    },
  ],
  managers: [
    {
      id: "manager-1",
      name: "Demo Meister",
      email: "meister@example.com",
      title: "Meister",
      role: "manager",
      clientId: "client-1",
      active: true,
      passwordHash: hashSecret(process.env.MANAGER_PASSWORD ?? developmentPassword),
      mustChangePassword: false,
    },
  ],
  events: [],
  correctionRequests: [],
  invoices: [],
  emailOutbox: [],
  auditLogs: [],
  sites: [],
  entrances: [],
  notifications: [],
  invoiceSequence: 0,
});
const {
  workers,
  clients,
  events,
  correctionRequests,
  invoices,
  emailOutbox,
  auditLogs,
  sites,
  entrances,
  managers,
  notifications,
} = persistentState;
export const processPendingEmails = createEmailProcessor({
  outbox: emailOutbox,
  invoices,
  clients,
  moduleDirectory,
  save: () => stateStore.save(persistentState),
  revealCode: revealTransientCode,
});

const qrCodes = new Map([
  [
    "demo-in",
    {
      action: "IN",
      siteId: "site-1",
      siteName: "Kesklinna ehitus",
      gateName: "Peavärav",
      latitude: 59.437,
      longitude: 24.7536,
      radiusMeters: 200,
    },
  ],
  [
    "demo-out",
    {
      action: "OUT",
      siteId: "site-1",
      siteName: "Kesklinna ehitus",
      gateName: "Peavärav",
      latitude: 59.437,
      longitude: 24.7536,
      radiusMeters: 200,
    },
  ],
]);

const sessions = new Map();
const authChallenges = new Map();
const recoveryChallenges = new Map();
const authFailures = new Map();
const authWindowMs = 15 * 60 * 1000;
const authMaxFailures = 5;

function authFailureKey(kind, identifier) {
  return `${kind}:${String(identifier ?? "").trim().toLowerCase()}`;
}

function assertAuthNotLimited(key) {
  const record = authFailures.get(key);
  if (!record) return;
  if (record.resetAt <= Date.now()) {
    authFailures.delete(key);
    return;
  }
  if (record.count >= authMaxFailures)
    throw Object.assign(new Error("Liiga palju ebaõnnestunud katseid. Proovi 15 minuti pärast uuesti."), {
      status: 429,
      code: "AUTH_RATE_LIMITED",
      retryAfterSeconds: Math.ceil((record.resetAt - Date.now()) / 1000),
    });
}

function recordAuthFailure(key, auditId, method) {
  const current = authFailures.get(key);
  const record = current && current.resetAt > Date.now()
    ? { ...current, count: current.count + 1 }
    : { count: 1, resetAt: Date.now() + authWindowMs };
  authFailures.set(key, record);
  audit({ id: auditId }, "AUTHENTICATION_FAILED", "AUTH_METHOD", method, { attempt: record.count });
}

function clearAuthFailures(key) {
  authFailures.delete(key);
}

function maskedIdentifier(value) {
  const text = String(value ?? "");
  if (text.includes("@")) {
    const [name, domain] = text.split("@");
    return `${name.slice(0, 1)}***@${domain}`;
  }
  return `***${normalizePhone(text).slice(-4)}`;
}

function hashSecret(secret) {
  const salt = randomBytes(16);
  const derived = scryptSync(String(secret), salt, 32);
  return `${salt.toString("hex")}:${derived.toString("hex")}`;
}

function verifySecret(secret, storedHash) {
  if (!storedHash) return false;
  const [saltHex, hashHex] = storedHash.split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(
    String(secret),
    Buffer.from(saltHex, "hex"),
    expected.length,
  );
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function createSession(user) {
  const accessToken = randomBytes(32).toString("base64url");
  sessions.set(accessToken, {
    user,
    expiresAt: Date.now() + 8 * 60 * 60 * 1000,
  });
  return accessToken;
}

function normalizePhone(value = "") {
  return String(value).replace(/[\s()-]/g, "");
}

function isValidSingleEmail(value) {
  const email = String(value ?? "").trim();
  return /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(email);
}

function distanceMeters(lat1, lon1, lat2, lon2) {
  const radius = 6371000;
  const toRadians = (value) => (value * Math.PI) / 180;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLon / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function json(response, status, body) {
  stateStore.save(persistentState);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...apiSecurityHeaders(response),
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Request-Id",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Expose-Headers": "X-Request-Id, Content-Disposition",
  });
  response.end(JSON.stringify(body));
}

function apiSecurityHeaders(response) {
  return {
    "Access-Control-Allow-Origin": process.env.CORS_ORIGIN ?? "*",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-site",
    "Cache-Control": "no-store",
    ...(response?.requestId ? { "X-Request-Id": response.requestId } : {}),
    ...(process.env.NODE_ENV === "production"
      ? { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" }
      : {}),
  };
}

export function calculateShiftMinutes(inTime, outTime) {
  const [inHour, inMinute] = inTime.split(":").map(Number);
  const [outHour, outMinute] = outTime.split(":").map(Number);
  const rawMinutes = outHour * 60 + outMinute - inHour * 60 - inMinute;
  return rawMinutes < 0 ? rawMinutes + 24 * 60 : rawMinutes;
}

function buildTimesheet(userId, from, to, siteId = "") {
  const grouped = new Map();
  for (const event of events.filter(
    (item) =>
      item.userId === userId &&
      item.registeredAt.slice(0, 10) >= from &&
      item.registeredAt.slice(0, 10) <= to &&
      (!siteId || item.siteId === siteId),
  )) {
    const date = event.registeredAt.slice(0, 10);
    const day = grouped.get(date) ?? {
      date,
      siteId: event.siteId,
      siteName: event.siteName,
      inTime: null,
      outTime: null,
      totalMinutes: null,
    };
    const time = event.registeredAt.slice(11, 16);
    if (event.action === "IN") day.inTime = time;
    if (event.action === "OUT") day.outTime = time;
    grouped.set(date, day);
  }
  for (const correction of correctionRequests.filter(
    (item) =>
      item.userId === userId &&
      item.status === "APPROVED" &&
      item.date >= from &&
      item.date <= to &&
      (!siteId || item.siteId === siteId),
  )) {
    const day = grouped.get(correction.date) ?? {
      date: correction.date,
      siteId: correction.siteId,
      siteName: correction.siteName || "Parandatud tööpäev",
      inTime: null,
      outTime: null,
      totalMinutes: null,
    };
    if (correction.requestedInTime) day.inTime = correction.requestedInTime;
    if (correction.requestedOutTime) day.outTime = correction.requestedOutTime;
    day.corrected = true;
    day.correctionId = correction.id;
    grouped.set(correction.date, day);
  }
  for (const day of grouped.values()) {
    if (day.inTime && day.outTime) {
      day.totalMinutes = calculateShiftMinutes(day.inTime, day.outTime);
    }
  }
  return [...grouped.values()].sort((a, b) => b.date.localeCompare(a.date));
}

function attendanceReport(from, to, siteId = "", clientId = "") {
  return workers.filter((worker) => !clientId || worker.clientId === clientId).flatMap((worker) =>
    buildTimesheet(worker.id, from, to, siteId).map((day) => ({
      workerId: worker.id,
      workerName: worker.name,
      companyName:
        clients.find((client) => client.id === worker.clientId)?.companyName ?? "",
      ...day,
    })),
  );
}

function currentPresence(at = new Date()) {
  const date = at.toISOString().slice(0, 10);
  const atTime = at.toISOString().slice(11, 16);
  const latestByWorkerAndSite = new Map();
  const setLatest = (record) => {
    const key = `${record.userId}:${record.siteId}`;
    const current = latestByWorkerAndSite.get(key);
    if (!current || record.time >= current.time) latestByWorkerAndSite.set(key, record);
  };
  for (const event of events.filter((item) => item.registeredAt.slice(0, 10) === date && item.registeredAt.slice(11, 16) <= atTime)) {
    setLatest({
      userId: event.userId,
      siteId: event.siteId,
      siteName: event.siteName,
      action: event.action,
      time: event.registeredAt.slice(11, 16),
      registeredAt: event.registeredAt,
    });
  }
  for (const correction of correctionRequests.filter(
    (item) => item.status === "APPROVED" && item.date === date && item.siteId,
  )) {
    if (correction.requestedInTime && correction.requestedInTime <= atTime)
      setLatest({ userId: correction.userId, siteId: correction.siteId, siteName: correction.siteName, action: "IN", time: correction.requestedInTime, corrected: true });
    if (correction.requestedOutTime && correction.requestedOutTime <= atTime)
      setLatest({ userId: correction.userId, siteId: correction.siteId, siteName: correction.siteName, action: "OUT", time: correction.requestedOutTime, corrected: true });
  }
  return [...latestByWorkerAndSite.values()]
    .filter((record) => record.action === "IN" && record.time <= atTime)
    .map((record) => {
      const worker = workers.find((item) => item.id === record.userId);
      const [inHour, inMinute] = record.time.split(":").map(Number);
      const [atHour, atMinute] = atTime.split(":").map(Number);
      const durationMinutes = Math.max(0, atHour * 60 + atMinute - inHour * 60 - inMinute);
      return {
        ...record,
        workerName: worker?.name ?? "Tundmatu töötaja",
        phone: worker?.phone ?? "",
        durationMinutes,
        longShiftWarning: durationMinutes >= 12 * 60,
      };
    })
    .sort((a, b) => a.siteName.localeCompare(b.siteName) || a.workerName.localeCompare(b.workerName));
}

function latestAttendanceAction(userId, siteId, before) {
  const records = events
    .filter((event) => event.userId === userId && event.siteId === siteId && event.registeredAt <= before)
    .map((event) => ({ action: event.action, at: event.registeredAt }));
  for (const correction of correctionRequests.filter(
    (item) => item.userId === userId && item.siteId === siteId && item.status === "APPROVED",
  )) {
    if (correction.requestedInTime) records.push({ action: "IN", at: `${correction.date}T${correction.requestedInTime}:00.000Z` });
    if (correction.requestedOutTime) records.push({ action: "OUT", at: `${correction.date}T${correction.requestedOutTime}:00.000Z` });
  }
  return records.filter((item) => item.at <= before).sort((a, b) => b.at.localeCompare(a.at))[0]?.action ?? null;
}

export function validateScanTimestamp(
  scannedAt,
  receivedAt = new Date(),
  maximumOfflineHours = Number(process.env.MAX_OFFLINE_SCAN_HOURS ?? 24),
) {
  const scannedDate = new Date(scannedAt);
  if (!scannedAt || Number.isNaN(scannedDate.getTime()))
    throw Object.assign(new Error("Skaneerimise aeg puudub või on vigane"), {
      status: 400,
      code: "INVALID_SCAN_TIME",
    });
  const delaySeconds = Math.round((receivedAt.getTime() - scannedDate.getTime()) / 1000);
  if (delaySeconds < -300)
    throw Object.assign(new Error("Telefoni kell on serveri ajast liiga palju ees"), {
      status: 403,
      code: "DEVICE_TIME_AHEAD",
    });
  if (delaySeconds > maximumOfflineHours * 60 * 60)
    throw Object.assign(
      new Error(`Offline-registreering on vanem kui ${maximumOfflineHours} tundi. Esita parandustaotlus.`),
      { status: 409, code: "OFFLINE_SCAN_EXPIRED" },
    );
  return {
    scannedAt: scannedDate.toISOString(),
    receivedAt: receivedAt.toISOString(),
    syncDelaySeconds: Math.max(0, delaySeconds),
    offline: delaySeconds >= 60,
  };
}

function invoicePdf(response, invoice, client) {
  const python = process.env.PYTHON_BIN ?? "python3";
  const child = spawn(python, [join(moduleDirectory, "generate_invoice.py")]);
  const chunks = [];
  const errors = [];
  child.stdout.on("data", (chunk) => chunks.push(chunk));
  child.stderr.on("data", (chunk) => errors.push(chunk));
  child.on("close", (code) => {
    if (code !== 0)
      return json(response, 500, {
        code: "PDF_ERROR",
        message:
          Buffer.concat(errors).toString("utf8") || "PDF-i loomine ebaõnnestus",
      });
    const body = Buffer.concat(chunks);
    response.writeHead(200, {
      ...apiSecurityHeaders(response),
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="arve-${invoice.number}.pdf"`,
      "Content-Length": body.length,
    });
    response.end(body);
  });
  child.stdin.end(
    JSON.stringify({
      ...invoice,
      issuedDate: invoice.issuedDate.split("-").reverse().join("."),
      dueDate: invoice.dueDate.split("-").reverse().join("."),
      seller: {
        name: "Objektiaeg OÜ",
        registryCode: "14990001",
        email: "arved@objektiaeg.ee",
        iban: "EE001010010000000001",
      },
      client: {
        name: client.companyName,
        registryCode: client.registryCode,
        email: client.billingEmail,
      },
    }),
  );
}

async function qrSheetPdf(response, site, entrance, language = "et") {
  const translations = {
    et: {
      entrance: "Sissepääs",
      scanIn: "SKANEERI SISENEMISEL",
      scanOut: "SKANEERI LAHKUMISEL",
      instruction: "Ava SiteClocki äpp ja skaneeri õige kood",
      locationNotice: "Asukohta kontrollitakse ainult registreerimise hetkel.",
      footer: "SiteClock - töömaa kohaloleku registreerimine",
    },
    fi: {
      entrance: "Sisäänkäynti",
      scanIn: "SKANNAA SAAPUESSA",
      scanOut: "SKANNAA LÄHTIESSÄ",
      instruction: "Avaa SiteClock-sovellus ja skannaa oikea koodi",
      locationNotice: "Sijainti tarkistetaan vain kirjautumishetkellä.",
      footer: "SiteClock - työmaan läsnäolon kirjaaminen",
    },
    en: {
      entrance: "Entrance",
      scanIn: "SCAN WHEN ENTERING",
      scanOut: "SCAN WHEN LEAVING",
      instruction: "Open the SiteClock app and scan the correct code",
      locationNotice: "Location is checked only at the time of registration.",
      footer: "SiteClock - construction site attendance registration",
    },
  };
  const selectedLanguage = Object.hasOwn(translations, language) ? language : "et";
  const [inPng, outPng] = await Promise.all([
    QRCode.toBuffer(`objektiaeg://scan?t=${entrance.inToken}`, {
      width: 900,
      margin: 2,
      errorCorrectionLevel: "H",
    }),
    QRCode.toBuffer(`objektiaeg://scan?t=${entrance.outToken}`, {
      width: 900,
      margin: 2,
      errorCorrectionLevel: "H",
    }),
  ]);
  const child = spawn(process.env.PYTHON_BIN ?? "python3", [
    join(moduleDirectory, "generate_qr_sheet.py"),
  ]);
  const chunks = [];
  const errors = [];
  child.stdout.on("data", (chunk) => chunks.push(chunk));
  child.stderr.on("data", (chunk) => errors.push(chunk));
  child.on("close", (code) => {
    if (code !== 0)
      return json(response, 500, {
        code: "PDF_ERROR",
        message:
          Buffer.concat(errors).toString("utf8") ||
          "QR-lehe loomine ebaõnnestus",
      });
    const body = Buffer.concat(chunks);
    response.writeHead(200, {
      ...apiSecurityHeaders(response),
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="qr-${site.id}-${entrance.id}.pdf"`,
      "Content-Length": body.length,
    });
    response.end(body);
  });
  child.stdin.end(
    JSON.stringify({
      siteName: site.name,
      gateName: entrance.name,
      inQrBase64: inPng.toString("base64"),
      outQrBase64: outPng.toString("base64"),
      generatedAt: new Date().toLocaleDateString(
        { et: "et-EE", fi: "fi-FI", en: "en-GB" }[selectedLanguage],
      ),
      labels: translations[selectedLanguage],
    }),
  );
}

function presenceListPdf(response, site, people) {
  const child = spawn(process.env.PYTHON_BIN ?? "python3", [
    join(moduleDirectory, "generate_presence_list.py"),
  ]);
  const chunks = [];
  const errors = [];
  child.stdout.on("data", (chunk) => chunks.push(chunk));
  child.stderr.on("data", (chunk) => errors.push(chunk));
  child.on("close", (code) => {
    if (code !== 0)
      return json(response, 500, {
        code: "PDF_ERROR",
        message: Buffer.concat(errors).toString("utf8") || "Nimekirja PDF-i loomine ebaõnnestus",
      });
    const body = Buffer.concat(chunks);
    response.writeHead(200, {
      ...apiSecurityHeaders(response),
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="kohalolijad-${site.id}.pdf"`,
      "Content-Length": body.length,
    });
    response.end(body);
  });
  child.stdin.end(JSON.stringify({
    siteName: site.name,
    address: site.address,
    generatedAt: new Date().toLocaleString("et-EE"),
    people,
  }));
}

async function readBody(request) {
  const chunks = [];
  const maximumBytes = Number(process.env.MAX_REQUEST_BYTES ?? 1_048_576);
  const declaredBytes = Number(request.headers["content-length"] ?? 0);
  if (declaredBytes > maximumBytes)
    throw Object.assign(new Error("Päring on liiga suur"), { status: 413, code: "REQUEST_TOO_LARGE" });
  let receivedBytes = 0;
  for await (const chunk of request) {
    receivedBytes += chunk.length;
    if (receivedBytes > maximumBytes)
      throw Object.assign(new Error("Päring on liiga suur"), { status: 413, code: "REQUEST_TOO_LARGE" });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Vigane JSON"), {
      status: 400,
      code: "INVALID_JSON",
    });
  }
}

function requireUser(request) {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
  const session = token ? sessions.get(token) : null;
  if (!session || session.expiresAt <= Date.now()) {
    if (token) sessions.delete(token);
    throw Object.assign(new Error("Sisselogimine on aegunud"), {
      status: 401,
      code: "UNAUTHORIZED",
    });
  }
  return session.user;
}

function requireAdmin(request) {
  const user = requireUser(request);
  if (user.role !== "admin")
    throw Object.assign(new Error("Peakasutaja õigus puudub"), {
      status: 403,
      code: "FORBIDDEN",
    });
  return user;
}

function requireManager(request) {
  const user = requireUser(request);
  if (user.role !== "manager")
    throw Object.assign(new Error("Meistri õigus puudub"), {
      status: 403,
      code: "FORBIDDEN",
    });
  if (user.mustChangePassword)
    throw Object.assign(new Error("Enne jätkamist tuleb ajutine parool muuta"), {
      status: 403,
      code: "PASSWORD_CHANGE_REQUIRED",
    });
  return user;
}

function requireOperationsUser(request) {
  const user = requireUser(request);
  if (!["admin", "manager"].includes(user.role))
    throw Object.assign(new Error("Tööandmete haldamise õigus puudub"), { status: 403, code: "FORBIDDEN" });
  return user;
}

function requireClientScope(user, clientId) {
  if (user.role === "manager" && user.clientId !== clientId)
    throw Object.assign(new Error("Teise kliendi andmeid ei saa muuta"), { status: 403, code: "CLIENT_SCOPE_VIOLATION" });
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function localIsoDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function addDays(date, days) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function invoiceNumber(date, sequence) {
  return `${date.getUTCFullYear()}-${String(sequence).padStart(5, "0")}`;
}

function nextInvoiceSequence() {
  const greatestExisting = invoices.reduce((greatest, invoice) => {
    if (invoice.documentType === "CREDIT_NOTE" || String(invoice.number).startsWith("K-")) return greatest;
    const match = String(invoice.number ?? "").match(/-(\d+)$/);
    return match ? Math.max(greatest, Number(match[1])) : greatest;
  }, 0);
  persistentState.invoiceSequence = Math.max(
    Number(persistentState.invoiceSequence) || 0,
    greatestExisting,
  ) + 1;
  return persistentState.invoiceSequence;
}

function audit(user, action, entityType, entityId, details = {}) {
  auditLogs.push({
    id: randomUUID(),
    userId: user.id,
    action,
    entityType,
    entityId,
    details,
    createdAt: new Date().toISOString(),
  });
}

function notifyWorker(userId, type, title, message, details = {}) {
  const existing = notifications.find(
    (item) => item.userId === userId && item.type === type && details.referenceId && item.details?.referenceId === details.referenceId,
  );
  if (existing) return existing;
  const notification = {
    id: randomUUID(),
    userId,
    type,
    title,
    message,
    details,
    readAt: null,
    createdAt: new Date().toISOString(),
  };
  notifications.push(notification);
  return notification;
}

function clientCapabilities(client) {
  const restricted =
    client?.billingStatus === "RESTRICTED" ||
    client?.billingStatus === "MANUALLY_SUSPENDED";
  return {
    attendanceScan: true,
    timesheetRead: true,
    historicalDataRead: true,
    createSites: !restricted,
    addWorkers: !restricted,
    changeSettings: !restricted,
  };
}

function updateClientRestriction(client, status, actor, reason) {
  if (client.billingStatus === status) return false;
  client.billingStatus = status;
  client.restrictedAt =
    status === "RESTRICTED" || status === "MANUALLY_SUSPENDED"
      ? new Date().toISOString()
      : null;
  audit(
    actor,
    status === "ACTIVE" ? "CLIENT_ACCESS_RESTORED" : "CLIENT_ACCESS_RESTRICTED",
    "CLIENT",
    client.id,
    { reason },
  );
  return true;
}

function qrToken(payload = "") {
  if (qrCodes.has(payload)) return payload;
  try {
    const url = new URL(payload);
    return url.searchParams.get("t");
  } catch {
    return null;
  }
}

function resolveQrCode(payload) {
  const token = qrToken(payload);
  if (qrCodes.has(token)) return qrCodes.get(token);
  const entrance = entrances.find(
    (item) => item.inToken === token || item.outToken === token,
  );
  if (!entrance || !entrance.active) return null;
  const site = sites.find((item) => item.id === entrance.siteId && item.active);
  if (!site) return null;
  return {
    action: entrance.inToken === token ? "IN" : "OUT",
    siteId: site.id,
    siteName: site.name,
    gateName: entrance.name,
    latitude: site.latitude,
    longitude: site.longitude,
    radiusMeters: site.radiusMeters,
  };
}

function queueEmail(message) {
  const protectedMessage = message.code === undefined
    ? message
    : { ...message, protectedCode: protectTransientCode(message.code), code: undefined };
  const queued = {
    id: randomUUID(),
    status: "PENDING",
    attempts: 0,
    nextAttemptAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    ...protectedMessage,
  };
  delete queued.code;
  emailOutbox.push(queued);
  return queued;
}

function generateInvoices(runDate, user = admin) {
  const generated = [];
  for (const client of clients.filter(
    (item) => item.active && item.invoiceDay === runDate.getUTCDate(),
  )) {
    const period = runDate.toISOString().slice(0, 7);
    if (
      invoices.some(
        (invoice) =>
          invoice.clientId === client.id && invoice.period === period,
      )
    )
      continue;
    const subtotalCents = client.monthlyFeeCents;
    const vatCents = Math.round(subtotalCents * client.vatRate);
    const invoice = {
      id: randomUUID(),
      number: invoiceNumber(runDate, nextInvoiceSequence()),
      clientId: client.id,
      clientName: client.companyName,
      billingEmail: client.billingEmail,
      period,
      issuedDate: isoDate(runDate),
      dueDate: isoDate(addDays(runDate, client.dueDays)),
      subtotalCents,
      vatCents,
      vatRate: client.vatRate,
      totalCents: subtotalCents + vatCents,
      status: client.automaticSending ? "SENT" : "DRAFT",
      sentAt: client.automaticSending ? new Date().toISOString() : null,
      paidAt: null,
      reminderDays: client.reminderDays,
      remindersSent: [],
    };
    invoices.push(invoice);
    if (client.automaticSending)
      queueEmail({
        type: "INVOICE",
        to: client.billingEmail,
        invoiceId: invoice.id,
      });
    audit(user, "INVOICE_GENERATED", "INVOICE", invoice.id, {
      automaticSending: client.automaticSending,
    });
    generated.push(invoice);
  }
  return generated;
}

function runReminderAutomation(runDate, user = admin) {
  const queued = [];
  for (const invoice of invoices.filter(
    (item) => item.status === "SENT" || item.status === "OVERDUE",
  )) {
    const dueDate = new Date(`${invoice.dueDate}T00:00:00.000Z`);
    const overdueDays = Math.floor(
      (runDate.getTime() - dueDate.getTime()) / 86400000,
    );
    if (overdueDays <= 0) continue;
    invoice.status = "OVERDUE";
    if (
      !invoice.reminderDays.includes(overdueDays) ||
      invoice.remindersSent.includes(overdueDays)
    )
      continue;
    invoice.remindersSent.push(overdueDays);
    queued.push(
      queueEmail({
        type: "PAYMENT_REMINDER",
        to: invoice.billingEmail,
        invoiceId: invoice.id,
        overdueDays,
      }),
    );
  }
  for (const client of clients.filter(
    (item) => item.autoRestrict && item.billingStatus !== "MANUALLY_SUSPENDED",
  )) {
    const overdue = invoices.filter(
      (item) => item.clientId === client.id && item.status === "OVERDUE",
    );
    const shouldRestrict = overdue.some((invoice) => {
      const lastReminderDay = Math.max(...invoice.reminderDays);
      const dueDate = new Date(`${invoice.dueDate}T00:00:00.000Z`);
      const overdueDays = Math.floor(
        (runDate.getTime() - dueDate.getTime()) / 86400000,
      );
      const overrideActive =
        client.restrictionOverrideUntil &&
        client.restrictionOverrideUntil >= isoDate(runDate);
      return (
        invoice.remindersSent.includes(lastReminderDay) &&
        overdueDays >= lastReminderDay + client.restrictionGraceDays &&
        !overrideActive
      );
    });
    if (
      shouldRestrict &&
      updateClientRestriction(
        client,
        "RESTRICTED",
        user,
        "Kolmas maksemeeldetuletus ja lisatähtaeg möödusid",
      )
    )
      queueEmail({
        type: "ACCOUNT_RESTRICTED",
        to: client.billingEmail,
        clientId: client.id,
      });
  }
  return queued;
}

export function runDailyAutomation(date = new Date()) {
  const runDate = new Date(`${localIsoDate(date)}T00:00:00.000Z`);
  const generated = generateInvoices(runDate, admin);
  const reminders = runReminderAutomation(runDate, admin);
  const attendanceReminders = createMissingOutReminders(isoDate(addDays(runDate, -1)));
  stateStore.save(persistentState);
  return { generated, reminders, attendanceReminders };
}

function createMissingOutReminders(date, clientId = "") {
  const created = [];
  for (const worker of workers.filter((item) => item.active !== false && (!clientId || item.clientId === clientId))) {
    const day = buildTimesheet(worker.id, date, date)[0];
    if (!day?.inTime || day.outTime) continue;
    created.push(
      notifyWorker(
        worker.id,
        "MISSING_OUT",
        "OUT-registreering puudub",
        `${date} tööpäeval puudub väljumise registreering. Palun esita parandustaotlus.`,
        { referenceId: `${worker.id}:${date}`, date },
      ),
    );
  }
  return created;
}

export function createApiServer() {
  return createServer(async (request, response) => {
    const startedAt = Date.now();
    const suppliedRequestId = request.headers["x-request-id"];
    response.requestId =
      typeof suppliedRequestId === "string" && /^[A-Za-z0-9._-]{8,100}$/.test(suppliedRequestId)
        ? suppliedRequestId
        : randomUUID();
    response.on("finish", () => {
      if (process.env.NODE_ENV === "production" || process.env.LOG_REQUESTS === "true")
        console.log(JSON.stringify({
          type: "http_request",
          requestId: response.requestId,
          method: request.method,
          path: new URL(request.url ?? "/", "http://localhost").pathname,
          status: response.statusCode,
          durationMs: Date.now() - startedAt,
          timestamp: new Date().toISOString(),
        }));
    });
    if (request.method === "OPTIONS") return json(response, 204, {});
    const url = new URL(request.url ?? "/", "http://localhost");
    try {
      if (request.method === "GET" && url.pathname === "/health")
        return json(response, 200, { status: "ok", database: stateStore.health() ? "ok" : "error", timestamp: new Date().toISOString() });
      if (request.method === "GET" && url.pathname === "/ready")
        return json(response, stateStore.health() ? 200 : 503, { ready: stateStore.health() });

      if (request.method === "GET" && url.pathname === "/v1/me/notifications") {
        const user = requireUser(request);
        return json(
          response,
          200,
          notifications
            .filter((item) => item.userId === user.id)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        );
      }

      if (request.method === "GET" && url.pathname === "/v1/me/profile") {
        const user = requireUser(request);
        const { passwordHash, pinHash, ...profile } = user;
        return json(response, 200, profile);
      }

      if (request.method === "POST" && url.pathname === "/v1/auth/logout") {
        requireUser(request);
        const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
        if (token) sessions.delete(token);
        return json(response, 200, { loggedOut: true });
      }

      const notificationReadMatch = url.pathname.match(/^\/v1\/me\/notifications\/([^/]+)\/read$/);
      if (request.method === "POST" && notificationReadMatch) {
        const user = requireUser(request);
        const notification = notifications.find(
          (item) => item.id === notificationReadMatch[1] && item.userId === user.id,
        );
        if (!notification)
          throw Object.assign(new Error("Teavitust ei leitud"), { status: 404, code: "NOTIFICATION_NOT_FOUND" });
        notification.readAt = notification.readAt ?? new Date().toISOString();
        return json(response, 200, notification);
      }

      if (
        request.method === "GET" &&
        url.pathname === "/v1/attendance/correction-requests"
      ) {
        const user = requireUser(request);
        return json(
          response,
          200,
          correctionRequests
            .filter((item) => item.userId === user.id)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        );
      }

      if (
        request.method === "POST" &&
        url.pathname === "/v1/admin/auth/login"
      ) {
        const body = await readBody(request);
        const rateLimitKey = authFailureKey("staff", body.email);
        assertAuthNotLimited(rateLimitKey);
        const loginUser = [admin, ...managers].find((item) => item.email === body.email);
        if (
          !loginUser || loginUser.active === false ||
          !verifySecret(body.password, loginUser.passwordHash)
        ) {
          recordAuthFailure(rateLimitKey, maskedIdentifier(body.email), "STAFF_PASSWORD");
          throw Object.assign(new Error("Vale e-post või parool"), {
            status: 401,
            code: "INVALID_CREDENTIALS",
          });
        }
        clearAuthFailures(rateLimitKey);
        const challengeId = randomUUID();
        const code = String(randomInt(100000, 1000000));
        authChallenges.set(challengeId, {
          user: loginUser,
          codeHash: hashSecret(code),
          expiresAt: Date.now() + 10 * 60 * 1000,
          attemptsLeft: 5,
          rateLimitKey: authFailureKey("staff-code", loginUser.email),
        });
        queueEmail({
          type: "ADMIN_LOGIN_CODE",
          to: loginUser.email,
          challengeId,
          code,
        });
        return json(response, 200, {
          challengeId,
          requiresTwoFactor: true,
          ...(isDevelopmentEnvironment ? { developmentCode: code } : {}),
        });
      }

      if (
        request.method === "POST" &&
        url.pathname === "/v1/admin/auth/verify"
      ) {
        const body = await readBody(request);
        const challenge = authChallenges.get(body.challengeId);
        if (!challenge || challenge.expiresAt <= Date.now())
          throw Object.assign(new Error("Kinnituskood on aegunud"), {
            status: 401,
            code: "CHALLENGE_EXPIRED",
          });
        assertAuthNotLimited(challenge.rateLimitKey);
        if (!verifySecret(body.code, challenge.codeHash)) {
          recordAuthFailure(challenge.rateLimitKey, maskedIdentifier(challenge.user.email), "STAFF_CODE");
          challenge.attemptsLeft -= 1;
          if (challenge.attemptsLeft <= 0)
            authChallenges.delete(body.challengeId);
          throw Object.assign(new Error("Vale kinnituskood"), {
            status: 401,
            code: "INVALID_CODE",
          });
        }
        clearAuthFailures(challenge.rateLimitKey);
        authChallenges.delete(body.challengeId);
        const accessToken = createSession(challenge.user);
        audit(challenge.user, challenge.user.role === "admin" ? "ADMIN_LOGIN_SUCCEEDED" : "MANAGER_LOGIN_SUCCEEDED", "SESSION", accessToken.slice(0, 12));
        return json(response, 200, {
          id: challenge.user.id,
          name: challenge.user.name,
          email: challenge.user.email,
          role: challenge.user.role,
          clientId: challenge.user.clientId ?? null,
          mustChangePassword: Boolean(challenge.user.mustChangePassword),
          accessToken,
          expiresInSeconds: 28800,
        });
      }

      if (
        request.method === "POST" &&
        url.pathname === "/v1/admin/auth/change-password"
      ) {
        const user = requireUser(request);
        if (user.role !== "manager")
          throw Object.assign(new Error("Paroolivahetus on mõeldud meistrikontole"), { status: 403, code: "FORBIDDEN" });
        const body = await readBody(request);
        if (!verifySecret(body.currentPassword, user.passwordHash))
          throw Object.assign(new Error("Praegune parool on vale"), { status: 401, code: "INVALID_PASSWORD" });
        if (String(body.newPassword ?? "").length < 10 || body.newPassword === body.currentPassword)
          throw Object.assign(new Error("Uus parool peab olema vähemalt 10 märki ja erinema vanast"), { status: 400, code: "WEAK_PASSWORD" });
        user.passwordHash = hashSecret(body.newPassword);
        user.mustChangePassword = false;
        const currentToken = request.headers.authorization?.replace(/^Bearer\s+/i, "");
        for (const [token, session] of sessions)
          if (session.user.id === user.id && token !== currentToken) sessions.delete(token);
        audit(user, "MANAGER_PASSWORD_CHANGED", "MANAGER", user.id);
        return json(response, 200, { changed: true });
      }

      if (request.method === "GET" && url.pathname === "/v1/admin/clients") {
        const user = requireAdmin(request);
        return json(response, 200, clients);
      }

      if (request.method === "GET" && url.pathname === "/v1/admin/managers") {
        requireAdmin(request);
        return json(
          response,
          200,
          managers.map(({ passwordHash, ...manager }) => ({
            ...manager,
            clientName: clients.find((client) => client.id === manager.clientId)?.companyName ?? "",
          })),
        );
      }

      if (request.method === "POST" && url.pathname === "/v1/admin/managers") {
        const user = requireAdmin(request);
        const body = await readBody(request);
        if (!body.name || !body.email || !body.clientId || String(body.password ?? "").length < 8)
          throw Object.assign(new Error("Nimi, e-post, klient ja vähemalt 8-kohaline parool on kohustuslikud"), { status: 400, code: "INVALID_MANAGER" });
        if (managers.some((manager) => manager.email.toLowerCase() === body.email.toLowerCase()))
          throw Object.assign(new Error("Selle e-postiga kasutaja on juba olemas"), { status: 409, code: "EMAIL_EXISTS" });
        if (!clients.some((client) => client.id === body.clientId))
          throw Object.assign(new Error("Klienti ei leitud"), { status: 404, code: "CLIENT_NOT_FOUND" });
        const manager = {
          id: randomUUID(),
          name: body.name,
          email: body.email.toLowerCase(),
          title: body.title ?? "Meister",
          role: "manager",
          clientId: body.clientId,
          active: true,
          passwordHash: hashSecret(body.password),
          mustChangePassword: true,
          createdAt: new Date().toISOString(),
        };
        managers.push(manager);
        audit(user, "MANAGER_CREATED", "MANAGER", manager.id, { clientId: manager.clientId });
        const { passwordHash, ...publicManager } = manager;
        return json(response, 201, publicManager);
      }

      const managerStatusMatch = url.pathname.match(/^\/v1\/admin\/managers\/([^/]+)\/status$/);
      if (request.method === "POST" && managerStatusMatch) {
        const user = requireAdmin(request);
        const manager = managers.find((item) => item.id === managerStatusMatch[1]);
        if (!manager) throw Object.assign(new Error("Kasutajat ei leitud"), { status: 404, code: "MANAGER_NOT_FOUND" });
        const body = await readBody(request);
        manager.active = Boolean(body.active);
        if (!manager.active) for (const [token, session] of sessions) if (session.user.id === manager.id) sessions.delete(token);
        audit(user, manager.active ? "MANAGER_ACTIVATED" : "MANAGER_SUSPENDED", "MANAGER", manager.id);
        const { passwordHash, ...publicManager } = manager;
        return json(response, 200, publicManager);
      }

      const managerPasswordMatch = url.pathname.match(/^\/v1\/admin\/managers\/([^/]+)\/reset-password$/);
      if (request.method === "POST" && managerPasswordMatch) {
        const user = requireAdmin(request);
        const manager = managers.find((item) => item.id === managerPasswordMatch[1]);
        if (!manager) throw Object.assign(new Error("Kasutajat ei leitud"), { status: 404, code: "MANAGER_NOT_FOUND" });
        const temporaryPassword = randomBytes(9).toString("base64url");
        manager.passwordHash = hashSecret(temporaryPassword);
        manager.mustChangePassword = true;
        for (const [token, session] of sessions) if (session.user.id === manager.id) sessions.delete(token);
        audit(user, "MANAGER_PASSWORD_RESET", "MANAGER", manager.id);
        return json(response, 200, { temporaryPassword });
      }

      if (request.method === "POST" && url.pathname === "/v1/admin/clients") {
        const user = requireAdmin(request);
        const body = await readBody(request);
        if (!body.companyName || !body.registryCode || !isValidSingleEmail(body.billingEmail))
          throw Object.assign(
            new Error(
              "Ettevõtte nimi, registrikood ja arve e-post on kohustuslikud",
            ),
            { status: 400, code: "INVALID_CLIENT" },
          );
        const vatRate = Number(body.vatRate ?? (body.country === "FI" ? 0.255 : 0.24));
        if (!Number.isFinite(vatRate) || vatRate < 0 || vatRate > 1)
          throw Object.assign(new Error("Käibemaksumäär peab olema vahemikus 0–100%"), { status: 400, code: "INVALID_CLIENT" });
        const client = {
          id: randomUUID(),
          companyName: body.companyName,
          registryCode: body.registryCode,
          billingEmail: body.billingEmail,
          language: ["et", "fi", "en"].includes(body.language) ? body.language : "et",
          monthlyFeeCents: Number(body.monthlyFeeCents ?? 0),
          country: ["EE", "FI", "OTHER"].includes(body.country) ? body.country : "EE",
          vatRate,
          invoiceDay: Number(body.invoiceDay ?? 1),
          dueDays: Number(body.dueDays ?? 14),
          automaticSending: Boolean(body.automaticSending),
          reminderDays: body.reminderDays ?? [1, 7, 14],
          active: true,
          billingStatus: "ACTIVE",
          autoRestrict: body.autoRestrict ?? true,
          restrictionGraceDays: Number(body.restrictionGraceDays ?? 3),
          restrictedAt: null,
          restrictionOverrideUntil: null,
        };
        clients.push(client);
        audit(user, "CLIENT_CREATED", "CLIENT", client.id, {
          companyName: client.companyName,
        });
        return json(response, 201, client);
      }

      const clientMatch = url.pathname.match(/^\/v1\/admin\/clients\/([^/]+)$/);
      if (request.method === "PUT" && clientMatch) {
        const user = requireAdmin(request);
        const client = clients.find((item) => item.id === clientMatch[1]);
        if (!client)
          throw Object.assign(new Error("Klienti ei leitud"), {
            status: 404,
            code: "CLIENT_NOT_FOUND",
          });
        const body = await readBody(request);
        if (body.vatRate !== undefined && (!Number.isFinite(Number(body.vatRate)) || Number(body.vatRate) < 0 || Number(body.vatRate) > 1))
          throw Object.assign(new Error("Käibemaksumäär peab olema vahemikus 0–100%"), { status: 400, code: "INVALID_CLIENT" });
        if (body.billingEmail !== undefined && !isValidSingleEmail(body.billingEmail))
          throw Object.assign(new Error("Sisesta üks korrektne arve e-posti aadress"), { status: 400, code: "INVALID_CLIENT" });
        if (body.language !== undefined && !["et", "fi", "en"].includes(body.language))
          throw Object.assign(new Error("Toetatud keeled on et, fi ja en"), { status: 400, code: "INVALID_CLIENT" });
        const allowed = [
          "companyName",
          "registryCode",
          "billingEmail",
          "language",
          "monthlyFeeCents",
          "vatRate",
          "country",
          "invoiceDay",
          "dueDays",
          "automaticSending",
          "reminderDays",
          "active",
          "autoRestrict",
          "restrictionGraceDays",
          "restrictionOverrideUntil",
        ];
        for (const key of allowed)
          if (body[key] !== undefined) client[key] = body[key];
        audit(user, "CLIENT_UPDATED", "CLIENT", client.id, {
          fields: Object.keys(body).filter((key) => allowed.includes(key)),
        });
        return json(response, 200, client);
      }

      if (request.method === "GET" && url.pathname === "/v1/admin/sites") {
        requireAdmin(request);
        return json(
          response,
          200,
          sites.filter((site) => !site.archivedAt).map((site) => ({
            ...site,
            entrances: entrances
              .filter((item) => item.siteId === site.id)
              .map(({ inToken, outToken, ...item }) => item),
          })),
        );
      }

      if (request.method === "POST" && url.pathname === "/v1/admin/sites") {
        const user = requireOperationsUser(request);
        const body = await readBody(request);
        const radiusMeters = Number(body.radiusMeters ?? 200);
        if (
          !body.name ||
          !Number.isFinite(body.latitude) ||
          body.latitude < -90 ||
          body.latitude > 90 ||
          !Number.isFinite(body.longitude) ||
          body.longitude < -180 ||
          body.longitude > 180 ||
          !Number.isFinite(radiusMeters) ||
          radiusMeters < 20 ||
          radiusMeters > 2000
        )
          throw Object.assign(
            new Error("Töömaa nimi ja koordinaadid on kohustuslikud"),
            { status: 400, code: "INVALID_SITE" },
          );
        const site = {
          id: randomUUID(),
          clientId: user.role === "manager" ? user.clientId : body.clientId ?? clients[0]?.id,
          name: body.name,
          address: body.address ?? "",
          latitude: body.latitude,
          longitude: body.longitude,
          radiusMeters,
          active: true,
          createdAt: new Date().toISOString(),
        };
        sites.push(site);
        audit(user, "SITE_CREATED", "SITE", site.id, { name: site.name });
        return json(response, 201, site);
      }

      const siteUpdateMatch = url.pathname.match(
        /^\/v1\/admin\/sites\/([^/]+)$/,
      );
      if (request.method === "PUT" && siteUpdateMatch) {
        const user = requireOperationsUser(request);
        const site = sites.find((item) => item.id === siteUpdateMatch[1]);
        if (!site)
          throw Object.assign(new Error("Töömaad ei leitud"), {
            status: 404,
            code: "SITE_NOT_FOUND",
          });
        requireClientScope(user, site.clientId);
        const body = await readBody(request);
        const latitude = Number(body.latitude);
        const longitude = Number(body.longitude);
        const radiusMeters = Number(body.radiusMeters);
        if (
          !String(body.name ?? "").trim() ||
          !Number.isFinite(latitude) ||
          latitude < -90 ||
          latitude > 90 ||
          !Number.isFinite(longitude) ||
          longitude < -180 ||
          longitude > 180 ||
          !Number.isFinite(radiusMeters) ||
          radiusMeters < 20 ||
          radiusMeters > 2000
        )
          throw Object.assign(new Error("Kontrolli töömaa nime, koordinaate ja raadiust"), {
            status: 400,
            code: "INVALID_SITE",
          });
        Object.assign(site, {
          name: String(body.name).trim(),
          address: String(body.address ?? "").trim(),
          latitude,
          longitude,
          radiusMeters,
        });
        audit(user, "SITE_UPDATED", "SITE", site.id, {
          latitude,
          longitude,
          radiusMeters,
        });
        return json(response, 200, site);
      }

      if (request.method === "DELETE" && siteUpdateMatch) {
        const user = requireOperationsUser(request);
        const site = sites.find((item) => item.id === siteUpdateMatch[1]);
        if (!site || site.archivedAt)
          throw Object.assign(new Error("Töömaad ei leitud"), {
            status: 404,
            code: "SITE_NOT_FOUND",
          });
        requireClientScope(user, site.clientId);
        if (currentPresence(new Date()).some((item) => item.siteId === site.id))
          throw Object.assign(new Error("Töömaad ei saa eemaldada, kuni seal on registreeritud töötajaid"), {
            status: 409,
            code: "SITE_HAS_PRESENT_WORKERS",
          });
        site.active = false;
        site.archivedAt = new Date().toISOString();
        for (const entrance of entrances)
          if (entrance.siteId === site.id) entrance.active = false;
        for (const worker of workers)
          if (Array.isArray(worker.assignedSiteIds))
            worker.assignedSiteIds = worker.assignedSiteIds.filter((id) => id !== site.id);
        audit(user, "SITE_ARCHIVED", "SITE", site.id, {
          attendanceRetained: events.filter((event) => event.siteId === site.id).length,
        });
        return json(response, 200, { removed: true, id: site.id });
      }

      if (request.method === "GET" && url.pathname === "/v1/admin/geocode") {
        requireOperationsUser(request);
        const address = String(url.searchParams.get("address") ?? "").trim();
        if (address.length < 4)
          throw Object.assign(new Error("Sisesta täpsem aadress"), {
            status: 400,
            code: "INVALID_ADDRESS",
          });
        const geocodeUrl = new URL("https://nominatim.openstreetmap.org/search");
        geocodeUrl.searchParams.set("q", address);
        geocodeUrl.searchParams.set("format", "jsonv2");
        geocodeUrl.searchParams.set("limit", "1");
        const geocodeResponse = await fetch(geocodeUrl, {
          headers: {
            Accept: "application/json",
            "User-Agent": "SiteClock/1.0 (site location setup)",
          },
        });
        if (!geocodeResponse.ok)
          throw Object.assign(new Error("Aadressi otsing pole hetkel saadaval"), {
            status: 502,
            code: "GEOCODING_UNAVAILABLE",
          });
        const [match] = await geocodeResponse.json();
        const latitude = Number(match?.lat);
        const longitude = Number(match?.lon);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude))
          throw Object.assign(new Error("Aadressi ei leitud. Täpsusta aadressi ja linna."), {
            status: 404,
            code: "ADDRESS_NOT_FOUND",
          });
        return json(response, 200, {
          latitude,
          longitude,
          displayName: match.display_name ?? address,
        });
      }

      const entranceCreateMatch = url.pathname.match(
        /^\/v1\/admin\/sites\/([^/]+)\/entrances$/,
      );
      if (request.method === "POST" && entranceCreateMatch) {
        const user = requireOperationsUser(request);
        const site = sites.find((item) => item.id === entranceCreateMatch[1]);
        if (!site)
          throw Object.assign(new Error("Töömaad ei leitud"), {
            status: 404,
            code: "SITE_NOT_FOUND",
          });
        requireClientScope(user, site.clientId);
        const body = await readBody(request);
        if (!body.name)
          throw Object.assign(new Error("Sissepääsu nimi on kohustuslik"), {
            status: 400,
            code: "INVALID_ENTRANCE",
          });
        const entrance = {
          id: randomUUID(),
          siteId: site.id,
          name: body.name,
          inToken: randomBytes(32).toString("base64url"),
          outToken: randomBytes(32).toString("base64url"),
          active: true,
          createdAt: new Date().toISOString(),
        };
        entrances.push(entrance);
        audit(user, "ENTRANCE_CREATED", "ENTRANCE", entrance.id, {
          siteId: site.id,
          name: entrance.name,
        });
        const { inToken, outToken, ...publicEntrance } = entrance;
        return json(response, 201, publicEntrance);
      }

      const presencePdfMatch = url.pathname.match(
        /^\/v1\/admin\/sites\/([^/]+)\/presence-list.pdf$/,
      );
      if (request.method === "GET" && presencePdfMatch) {
        const user = requireOperationsUser(request);
        const site = sites.find((item) => item.id === presencePdfMatch[1]);
        if (!site)
          throw Object.assign(new Error("Töömaad ei leitud"), { status: 404, code: "SITE_NOT_FOUND" });
        requireClientScope(user, site.clientId);
        const people = currentPresence(new Date()).filter((item) => item.siteId === site.id);
        audit(user, "PRESENCE_LIST_EXPORTED", "SITE", site.id, { peopleCount: people.length });
        stateStore.save(persistentState);
        return presenceListPdf(response, site, people);
      }

      const qrPdfMatch = url.pathname.match(
        /^\/v1\/admin\/entrances\/([^/]+)\/qr-sheet.pdf$/,
      );
      if (request.method === "GET" && qrPdfMatch) {
        const user = requireOperationsUser(request);
        const entrance = entrances.find((item) => item.id === qrPdfMatch[1]);
        const site =
          entrance && sites.find((item) => item.id === entrance.siteId);
        if (!entrance || !site)
          throw Object.assign(new Error("Sissepääsu ei leitud"), {
            status: 404,
            code: "ENTRANCE_NOT_FOUND",
          });
        requireClientScope(user, site.clientId);
        const language = ["et", "fi", "en"].includes(url.searchParams.get("lang"))
          ? url.searchParams.get("lang")
          : "et";
        return await qrSheetPdf(response, site, entrance, language);
      }

      const qrRotateMatch = url.pathname.match(
        /^\/v1\/admin\/entrances\/([^/]+)\/rotate-qr$/,
      );
      if (request.method === "POST" && qrRotateMatch) {
        const user = requireOperationsUser(request);
        const entrance = entrances.find((item) => item.id === qrRotateMatch[1]);
        if (!entrance)
          throw Object.assign(new Error("Sissepääsu ei leitud"), {
            status: 404,
            code: "ENTRANCE_NOT_FOUND",
          });
        const entranceSite = sites.find((site) => site.id === entrance.siteId);
        requireClientScope(user, entranceSite?.clientId);
        entrance.inToken = randomBytes(32).toString("base64url");
        entrance.outToken = randomBytes(32).toString("base64url");
        audit(user, "QR_TOKENS_ROTATED", "ENTRANCE", entrance.id);
        return json(response, 200, { rotated: true });
      }

      if (request.method === "GET" && url.pathname === "/v1/admin/workers") {
        requireAdmin(request);
        return json(
          response,
          200,
          workers.filter((worker) => !worker.removedAt).map(({ pinHash, ...worker }) => worker),
        );
      }

      if (request.method === "POST" && url.pathname === "/v1/admin/workers") {
        const user = requireOperationsUser(request);
        const body = await readBody(request);
        const requestedClientId = user.role === "manager" ? user.clientId : body.clientId;
        const client = clients.find((item) => item.id === requestedClientId);
        if (!client)
          throw Object.assign(new Error("Klienti ei leitud"), {
            status: 404,
            code: "CLIENT_NOT_FOUND",
          });
        if (!clientCapabilities(client).addWorkers)
          throw Object.assign(
            new Error(
              "Konto on piiratud kasutusega ja uusi töötajaid ei saa lisada",
            ),
            { status: 403, code: "ACCOUNT_RESTRICTED" },
          );
        if (!body.name || !body.phone)
          throw Object.assign(
            new Error("Töötaja nimi ja telefoninumber on kohustuslikud"),
            { status: 400, code: "INVALID_WORKER" },
          );
        if (
          workers.some(
            (item) => normalizePhone(item.phone) === normalizePhone(body.phone),
          )
        )
          throw Object.assign(
            new Error("Selle telefoninumbriga töötaja on juba olemas"),
            { status: 409, code: "PHONE_EXISTS" },
          );
        const assignedSiteIds = Array.isArray(body.assignedSiteIds)
          ? body.assignedSiteIds.filter((id) =>
              sites.some(
                (site) => site.id === id && site.clientId === client.id && site.active !== false && !site.archivedAt,
              ),
            )
          : [];
        const worker = {
          id: randomUUID(),
          clientId: client.id,
          name: body.name,
          phone: normalizePhone(body.phone),
          role: body.role ?? "worker",
          jobTitle: body.jobTitle ?? "",
          companyName: body.companyName ?? client.companyName,
          assignedSiteIds,
          active: true,
          pinHash: null,
          createdAt: new Date().toISOString(),
        };
        workers.push(worker);
        audit(user, "WORKER_CREATED", "WORKER", worker.id, {
          clientId: client.id,
          assignedSiteIds,
        });
        const { pinHash, ...publicWorker } = worker;
        return json(response, 201, publicWorker);
      }

      const workerMatch = url.pathname.match(/^\/v1\/admin\/workers\/([^/]+)$/);
      if (request.method === "PUT" && workerMatch) {
        const user = requireOperationsUser(request);
        const worker = workers.find((item) => item.id === workerMatch[1]);
        if (!worker)
          throw Object.assign(new Error("Töötajat ei leitud"), {
            status: 404,
            code: "WORKER_NOT_FOUND",
          });
        requireClientScope(user, worker.clientId);
        const body = await readBody(request);
        const allowed = [
          "name",
          "phone",
          "jobTitle",
          "companyName",
          "role",
          "assignedSiteIds",
          "active",
        ];
        for (const key of allowed)
          if (body[key] !== undefined)
            worker[key] =
              key === "phone" ? normalizePhone(body[key]) : body[key];
        audit(user, "WORKER_UPDATED", "WORKER", worker.id, {
          fields: Object.keys(body).filter((key) => allowed.includes(key)),
        });
        const { pinHash, ...publicWorker } = worker;
        return json(response, 200, publicWorker);
      }

      if (request.method === "DELETE" && workerMatch) {
        const user = requireOperationsUser(request);
        const worker = workers.find((item) => item.id === workerMatch[1]);
        if (!worker || worker.removedAt)
          throw Object.assign(new Error("Töötajat ei leitud"), {
            status: 404,
            code: "WORKER_NOT_FOUND",
          });
        requireClientScope(user, worker.clientId);
        if (currentPresence(new Date()).some((item) => item.userId === worker.id))
          throw Object.assign(new Error("Töötajat ei saa eemaldada enne OUT-registreeringut"), {
            status: 409,
            code: "WORKER_IS_ON_SITE",
          });
        worker.active = false;
        worker.assignedSiteIds = [];
        worker.pinHash = null;
        worker.removedAt = new Date().toISOString();
        for (const [token, session] of sessions)
          if (session.user.id === worker.id) sessions.delete(token);
        audit(user, "WORKER_ARCHIVED", "WORKER", worker.id, {
          attendanceRetained: events.filter((event) => event.userId === worker.id).length,
        });
        return json(response, 200, { removed: true, id: worker.id });
      }

      const resetPinMatch = url.pathname.match(
        /^\/v1\/admin\/workers\/([^/]+)\/reset-pin$/,
      );
      if (request.method === "POST" && resetPinMatch) {
        const user = requireOperationsUser(request);
        const worker = workers.find((item) => item.id === resetPinMatch[1]);
        if (!worker)
          throw Object.assign(new Error("Töötajat ei leitud"), {
            status: 404,
            code: "WORKER_NOT_FOUND",
          });
        requireClientScope(user, worker.clientId);
        worker.pinHash = null;
        for (const [token, session] of sessions)
          if (session.user.id === worker.id) sessions.delete(token);
        audit(user, "WORKER_PIN_RESET", "WORKER", worker.id);
        return json(response, 200, { reset: true });
      }

      const workerExportMatch = url.pathname.match(
        /^\/v1\/admin\/workers\/([^/]+)\/personal-data-export$/,
      );
      if (request.method === "GET" && workerExportMatch) {
        const user = requireAdmin(request);
        const worker = workers.find((item) => item.id === workerExportMatch[1]);
        if (!worker)
          throw Object.assign(new Error("Töötajat ei leitud"), {
            status: 404,
            code: "WORKER_NOT_FOUND",
          });
        const { pinHash, ...profile } = worker;
        audit(user, "WORKER_DATA_EXPORTED", "WORKER", worker.id);
        return json(response, 200, {
          exportedAt: new Date().toISOString(),
          profile,
          attendanceEvents: events.filter((event) => event.userId === worker.id),
          correctionRequests: correctionRequests.filter((item) => item.userId === worker.id),
        });
      }

      const workerAnonymizeMatch = url.pathname.match(
        /^\/v1\/admin\/workers\/([^/]+)\/anonymize$/,
      );
      if (request.method === "POST" && workerAnonymizeMatch) {
        const user = requireAdmin(request);
        const worker = workers.find((item) => item.id === workerAnonymizeMatch[1]);
        if (!worker)
          throw Object.assign(new Error("Töötajat ei leitud"), {
            status: 404,
            code: "WORKER_NOT_FOUND",
          });
        if (worker.anonymizedAt)
          throw Object.assign(new Error("Töötaja on juba anonüümseks muudetud"), {
            status: 409,
            code: "ALREADY_ANONYMIZED",
          });
        for (const [token, session] of sessions)
          if (session.user.id === worker.id) sessions.delete(token);
        const previousPhone = worker.phone;
        worker.name = `Anonüümne töötaja ${worker.id.slice(0, 6)}`;
        worker.phone = "";
        worker.jobTitle = "";
        worker.companyName = "";
        worker.assignedSiteIds = [];
        worker.pinHash = null;
        worker.active = false;
        worker.anonymizedAt = new Date().toISOString();
        for (const correction of correctionRequests)
          if (correction.userId === worker.id) correction.workerName = worker.name;
        for (let index = emailOutbox.length - 1; index >= 0; index -= 1)
          if (emailOutbox[index].type === "ACCOUNT_RECOVERY_CODE" && emailOutbox[index].to === previousPhone)
            emailOutbox.splice(index, 1);
        audit(user, "WORKER_ANONYMIZED", "WORKER", worker.id, {
          attendanceRetained: events.filter((event) => event.userId === worker.id).length,
        });
        const { pinHash, ...publicWorker } = worker;
        return json(response, 200, publicWorker);
      }

      if (
        request.method === "POST" &&
        url.pathname === "/v1/admin/billing/generate"
      ) {
        const user = requireAdmin(request);
        const body = await readBody(request);
        const runDate = new Date(
          `${body.date ?? isoDate(new Date())}T00:00:00.000Z`,
        );
        const generated = generateInvoices(runDate, user);
        return json(response, 201, generated);
      }

      if (request.method === "GET" && url.pathname === "/v1/admin/invoices") {
        requireAdmin(request);
        return json(response, 200, invoices);
      }

      const paidMatch = url.pathname.match(
        /^\/v1\/admin\/invoices\/([^/]+)\/mark-paid$/,
      );
      if (request.method === "POST" && paidMatch) {
        const user = requireAdmin(request);
        const invoice = invoices.find((item) => item.id === paidMatch[1]);
        if (!invoice)
          throw Object.assign(new Error("Arvet ei leitud"), {
            status: 404,
            code: "INVOICE_NOT_FOUND",
          });
        if (invoice.status === "CREDITED")
          throw Object.assign(
            new Error("Krediteeritud arvet ei saa tasutuks märkida"),
            { status: 409, code: "INVOICE_CREDITED" },
          );
        invoice.status = "PAID";
        invoice.paidAt = new Date().toISOString();
        audit(user, "INVOICE_MARKED_PAID", "INVOICE", invoice.id);
        const client = clients.find((item) => item.id === invoice.clientId);
        const stillOverdue = invoices.some(
          (item) =>
            item.clientId === invoice.clientId &&
            item.id !== invoice.id &&
            item.status === "OVERDUE",
        );
        if (client && !stillOverdue && client.billingStatus === "RESTRICTED")
          updateClientRestriction(
            client,
            "ACTIVE",
            user,
            "Kõik tähtaja ületanud arved on tasutud",
          );
        return json(response, 200, invoice);
      }

      const creditMatch = url.pathname.match(
        /^\/v1\/admin\/invoices\/([^/]+)\/credit$/,
      );
      if (request.method === "POST" && creditMatch) {
        const user = requireAdmin(request);
        const original = invoices.find((item) => item.id === creditMatch[1]);
        if (!original)
          throw Object.assign(new Error("Arvet ei leitud"), {
            status: 404,
            code: "INVOICE_NOT_FOUND",
          });
        if (
          original.status === "CREDITED" ||
          original.documentType === "CREDIT_NOTE"
        )
          throw Object.assign(new Error("Arve on juba krediteeritud"), {
            status: 409,
            code: "ALREADY_CREDITED",
          });
        const body = await readBody(request);
        const credit = {
          ...original,
          id: randomUUID(),
          number: `K-${original.number}`,
          documentType: "CREDIT_NOTE",
          originalInvoiceId: original.id,
          subtotalCents: -original.subtotalCents,
          vatCents: -original.vatCents,
          totalCents: -original.totalCents,
          issuedDate: isoDate(new Date()),
          dueDate: isoDate(new Date()),
          status: "SENT",
          sentAt: new Date().toISOString(),
          paidAt: null,
          creditReason: body.reason ?? "Arve tühistamine",
          remindersSent: [],
        };
        original.status = "CREDITED";
        invoices.push(credit);
        queueEmail({
          type: "CREDIT_NOTE",
          to: credit.billingEmail,
          invoiceId: credit.id,
        });
        audit(user, "CREDIT_NOTE_CREATED", "INVOICE", credit.id, {
          originalInvoiceId: original.id,
          reason: credit.creditReason,
        });
        return json(response, 201, credit);
      }

      const pdfMatch = url.pathname.match(
        /^\/v1\/admin\/invoices\/([^/]+)\/pdf$/,
      );
      if (request.method === "GET" && pdfMatch) {
        requireAdmin(request);
        const invoice = invoices.find((item) => item.id === pdfMatch[1]);
        if (!invoice)
          throw Object.assign(new Error("Arvet ei leitud"), {
            status: 404,
            code: "INVOICE_NOT_FOUND",
          });
        const client = clients.find((item) => item.id === invoice.clientId);
        return invoicePdf(response, invoice, client);
      }

      if (
        request.method === "POST" &&
        url.pathname === "/v1/admin/billing/reminders/run"
      ) {
        const user = requireAdmin(request);
        const body = await readBody(request);
        const runDate = new Date(
          `${body.date ?? isoDate(new Date())}T00:00:00.000Z`,
        );
        const queued = runReminderAutomation(runDate, user);
        return json(response, 200, queued);
      }

      const accessMatch = url.pathname.match(
        /^\/v1\/admin\/clients\/([^/]+)\/access$/,
      );
      if (request.method === "POST" && accessMatch) {
        const user = requireAdmin(request);
        const client = clients.find((item) => item.id === accessMatch[1]);
        if (!client)
          throw Object.assign(new Error("Klienti ei leitud"), {
            status: 404,
            code: "CLIENT_NOT_FOUND",
          });
        const body = await readBody(request);
        if (
          !["ACTIVE", "RESTRICTED", "MANUALLY_SUSPENDED"].includes(body.status)
        )
          throw Object.assign(new Error("Vigane konto olek"), {
            status: 400,
            code: "INVALID_STATUS",
          });
        client.restrictionOverrideUntil = body.overrideUntil ?? null;
        updateClientRestriction(
          client,
          body.status,
          user,
          body.reason ?? "Peakasutaja käsitsi muudatus",
        );
        return json(response, 200, {
          client,
          capabilities: clientCapabilities(client),
        });
      }

      if (
        request.method === "GET" &&
        url.pathname === "/v1/account/capabilities"
      ) {
        const user = requireUser(request);
        const client = clients.find((item) => item.id === user.clientId);
        return json(response, 200, {
          billingStatus: client?.billingStatus ?? "ACTIVE",
          capabilities: clientCapabilities(client),
        });
      }

      if (
        request.method === "GET" &&
        url.pathname === "/v1/admin/email-outbox"
      ) {
        requireAdmin(request);
        return json(response, 200, emailOutbox.map(({ code, protectedCode, ...message }) => message));
      }

      if (
        request.method === "POST" &&
        url.pathname === "/v1/admin/email-outbox/process"
      ) {
        requireAdmin(request);
        return json(response, 200, await processPendingEmails());
      }

      if (request.method === "GET" && url.pathname === "/v1/admin/audit-logs") {
        requireAdmin(request);
        return json(response, 200, [...auditLogs].reverse());
      }

      if (request.method === "POST" && url.pathname === "/v1/admin/attendance/reminders/run") {
        const user = requireOperationsUser(request);
        const body = await readBody(request);
        const date = body.date ?? isoDate(addDays(new Date(), -1));
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
          throw Object.assign(new Error("Vigane kuupäev"), { status: 400, code: "INVALID_DATE" });
        const created = createMissingOutReminders(date, user.role === "manager" ? user.clientId : "");
        audit(user, "MISSING_OUT_REMINDERS_RUN", "ATTENDANCE", date, { count: created.length });
        return json(response, 200, created);
      }

      if (request.method === "GET" && url.pathname === "/v1/manager/dashboard") {
        const user = requireManager(request);
        const clientWorkers = workers.filter((worker) => worker.clientId === user.clientId && !worker.removedAt);
        const workerIds = new Set(clientWorkers.map((worker) => worker.id));
        const clientSites = sites.filter((site) => site.clientId === user.clientId && !site.archivedAt);
        const siteIds = new Set(clientSites.map((site) => site.id));
        return json(response, 200, {
          clients: clients.filter((client) => client.id === user.clientId),
          sites: clientSites.map((site) => ({
            ...site,
            entrances: entrances
              .filter((entrance) => entrance.siteId === site.id)
              .map(({ inToken, outToken, ...entrance }) => entrance),
          })),
          workers: clientWorkers.map(({ pinHash, ...worker }) => worker),
          corrections: correctionRequests
            .filter((item) => workerIds.has(item.userId))
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
          presence: currentPresence(new Date()).filter(
            (item) => workerIds.has(item.userId) && siteIds.has(item.siteId),
          ),
        });
      }

      if (request.method === "GET" && url.pathname === "/v1/admin/attendance-report") {
        const user = requireOperationsUser(request);
        const from = url.searchParams.get("from") ?? "0000-01-01";
        const to = url.searchParams.get("to") ?? "9999-12-31";
        const siteId = url.searchParams.get("siteId") ?? "";
        if (siteId) requireClientScope(user, sites.find((site) => site.id === siteId)?.clientId);
        if (from > to) throw Object.assign(new Error("Alguskuupäev peab olema enne lõppkuupäeva"), { status: 400, code: "INVALID_PERIOD" });
        return json(response, 200, attendanceReport(from, to, siteId, user.role === "manager" ? user.clientId : ""));
      }

      if (request.method === "GET" && url.pathname === "/v1/admin/current-presence") {
        requireAdmin(request);
        const requestedAt = url.searchParams.get("at");
        const at = requestedAt ? new Date(requestedAt) : new Date();
        if (Number.isNaN(at.getTime())) throw Object.assign(new Error("Vigane aja väärtus"), { status: 400, code: "INVALID_DATE" });
        return json(response, 200, currentPresence(at));
      }

      if (request.method === "GET" && url.pathname === "/v1/admin/attendance-report.csv") {
        const user = requireOperationsUser(request);
        const from = url.searchParams.get("from") ?? "0000-01-01";
        const to = url.searchParams.get("to") ?? "9999-12-31";
        const siteId = url.searchParams.get("siteId") ?? "";
        if (siteId) requireClientScope(user, sites.find((site) => site.id === siteId)?.clientId);
        const escape = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
        const rows = attendanceReport(from, to, siteId, user.role === "manager" ? user.clientId : "");
        audit(user, "ATTENDANCE_REPORT_EXPORTED", "ATTENDANCE_REPORT", `${from}:${to}`, { siteId: siteId || null, rowCount: rows.length });
        stateStore.save(persistentState);
        const csv = [
          ["Töötaja", "Ettevõte", "Töömaa", "Kuupäev", "IN", "OUT", "Tunnid", "Parandatud"],
          ...rows.map((row) => [row.workerName, row.companyName, row.siteName, row.date, row.inTime, row.outTime, row.totalMinutes == null ? "" : (row.totalMinutes / 60).toFixed(2).replace(".", ","), row.corrected ? "Jah" : "Ei"]),
        ].map((row) => row.map(escape).join(";")).join("\r\n");
        const body = Buffer.from(`\uFEFF${csv}`, "utf8");
        response.writeHead(200, {
          ...apiSecurityHeaders(response),
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="tooaja-aruanne-${from}-${to}.csv"`,
          "Content-Length": body.length,
        });
        return response.end(body);
      }

      if (request.method === "GET" && url.pathname === "/v1/admin/correction-requests") {
        requireAdmin(request);
        return json(response, 200, [...correctionRequests].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      }

      const correctionDecisionMatch = url.pathname.match(/^\/v1\/admin\/correction-requests\/([^/]+)\/decision$/);
      if (request.method === "POST" && correctionDecisionMatch) {
        const user = requireUser(request);
        if (!["admin", "manager"].includes(user.role))
          throw Object.assign(new Error("Otsustamise õigus puudub"), { status: 403, code: "FORBIDDEN" });
        const correction = correctionRequests.find((item) => item.id === correctionDecisionMatch[1]);
        if (!correction) throw Object.assign(new Error("Parandustaotlust ei leitud"), { status: 404, code: "CORRECTION_NOT_FOUND" });
        if (user.role === "manager") {
          const correctionWorker = workers.find((worker) => worker.id === correction.userId);
          if (correctionWorker?.clientId !== user.clientId)
            throw Object.assign(new Error("Teise kliendi taotlust ei saa menetleda"), { status: 403, code: "CLIENT_SCOPE_VIOLATION" });
        }
        if (correction.status !== "PENDING") throw Object.assign(new Error("Taotlus on juba menetletud"), { status: 409, code: "ALREADY_DECIDED" });
        const body = await readBody(request);
        if (!["APPROVED", "REJECTED"].includes(body.decision)) throw Object.assign(new Error("Vigane otsus"), { status: 400, code: "INVALID_DECISION" });
        correction.status = body.decision;
        correction.decisionNote = body.note ?? "";
        correction.decidedAt = new Date().toISOString();
        correction.decidedBy = user.id;
        notifyWorker(
          correction.userId,
          body.decision === "APPROVED" ? "CORRECTION_APPROVED" : "CORRECTION_REJECTED",
          body.decision === "APPROVED" ? "Parandustaotlus kinnitatud" : "Parandustaotlus tagasi lükatud",
          `${correction.date} tööaja parandus on ${body.decision === "APPROVED" ? "kinnitatud" : "tagasi lükatud"}.${correction.decisionNote ? ` Märkus: ${correction.decisionNote}` : ""}`,
          { referenceId: correction.id, date: correction.date },
        );
        audit(user, body.decision === "APPROVED" ? "CORRECTION_APPROVED" : "CORRECTION_REJECTED", "CORRECTION_REQUEST", correction.id, { workerId: correction.userId, date: correction.date, note: correction.decisionNote });
        return json(response, 200, correction);
      }

      if (request.method === "POST" && url.pathname === "/v1/auth/register") {
        const body = await readBody(request);
        const rateLimitKey = authFailureKey("worker", normalizePhone(body.phone));
        assertAuthNotLimited(rateLimitKey);
        const worker = workers.find(
          (item) => normalizePhone(item.phone) === normalizePhone(body.phone),
        );
        if (!worker) {
          recordAuthFailure(rateLimitKey, maskedIdentifier(body.phone), "WORKER_PIN");
          throw Object.assign(
            new Error("Sellise telefoninumbriga töötajat ei leitud"),
            { status: 404, code: "WORKER_NOT_FOUND" },
          );
        }
        if (worker.active === false)
          throw Object.assign(new Error("Töötaja konto on peatatud"), {
            status: 403,
            code: "WORKER_SUSPENDED",
          });
        if (!/^\d{4,}$/.test(String(body.pin ?? "")))
          throw Object.assign(new Error("PIN peab olema vähemalt 4 numbrit"), {
            status: 400,
            code: "INVALID_PIN",
          });
        if (!worker.pinHash)
          throw Object.assign(new Error("PIN-i esmakordseks määramiseks kinnita telefoninumber SMS-koodiga"), {
            status: 403,
            code: "PIN_SETUP_REQUIRED",
          });
        if (!verifySecret(body.pin, worker.pinHash)) {
          recordAuthFailure(rateLimitKey, maskedIdentifier(body.phone), "WORKER_PIN");
          throw Object.assign(new Error("Vale PIN-kood"), {
            status: 401,
            code: "INVALID_PIN",
          });
        }
        clearAuthFailures(rateLimitKey);
        const accessToken = createSession(worker);
        audit(worker, "WORKER_LOGIN_SUCCEEDED", "SESSION", accessToken.slice(0, 12));
        const { pinHash, ...publicWorker } = worker;
        return json(response, 200, {
          ...publicWorker,
          accessToken,
          expiresInSeconds: 28800,
        });
      }

      if (
        request.method === "POST" &&
        url.pathname === "/v1/auth/recovery/request"
      ) {
        const body = await readBody(request);
        const requestLimitKey = authFailureKey("recovery-request", normalizePhone(body.phone));
        assertAuthNotLimited(requestLimitKey);
        const worker = workers.find(
          (item) => normalizePhone(item.phone) === normalizePhone(body.phone),
        );
        if (worker) {
          const challengeId = randomUUID();
          const code = String(randomInt(100000, 1000000));
          recoveryChallenges.set(challengeId, {
            user: worker,
            codeHash: hashSecret(code),
            expiresAt: Date.now() + 10 * 60 * 1000,
            attemptsLeft: 5,
            rateLimitKey: authFailureKey("recovery-code", normalizePhone(worker.phone)),
          });
          recordAuthFailure(requestLimitKey, maskedIdentifier(worker.phone), "RECOVERY_REQUEST");
          queueEmail({
            type: "ACCOUNT_RECOVERY_CODE",
            to: worker.phone,
            challengeId,
            code,
          });
          return json(response, 200, {
            accepted: true,
            challengeId,
            ...(isDevelopmentEnvironment ? { developmentCode: code } : {}),
          });
        }
        return json(response, 200, { accepted: true });
      }

      if (
        request.method === "POST" &&
        url.pathname === "/v1/auth/recovery/confirm"
      ) {
        const body = await readBody(request);
        const challenge = recoveryChallenges.get(body.challengeId);
        if (!challenge || challenge.expiresAt <= Date.now())
          throw Object.assign(new Error("Taastamiskood on aegunud"), {
            status: 401,
            code: "CHALLENGE_EXPIRED",
          });
        assertAuthNotLimited(challenge.rateLimitKey);
        if (!verifySecret(body.code, challenge.codeHash)) {
          recordAuthFailure(challenge.rateLimitKey, maskedIdentifier(challenge.user.phone), "RECOVERY_CODE");
          challenge.attemptsLeft -= 1;
          if (challenge.attemptsLeft <= 0)
            recoveryChallenges.delete(body.challengeId);
          throw Object.assign(new Error("Vale taastamiskood"), {
            status: 401,
            code: "INVALID_CODE",
          });
        }
        if (!/^\d{4,}$/.test(String(body.newPin ?? "")))
          throw Object.assign(new Error("PIN peab olema vähemalt 4 numbrit"), {
            status: 400,
            code: "INVALID_PIN",
          });
        challenge.user.pinHash = hashSecret(body.newPin);
        clearAuthFailures(challenge.rateLimitKey);
        clearAuthFailures(authFailureKey("recovery-request", normalizePhone(challenge.user.phone)));
        clearAuthFailures(authFailureKey("worker", normalizePhone(challenge.user.phone)));
        recoveryChallenges.delete(body.challengeId);
        for (const [token, session] of sessions)
          if (session.user.id === challenge.user.id) sessions.delete(token);
        return json(response, 200, { reset: true });
      }

      if (request.method === "POST" && url.pathname === "/v1/attendance/scan") {
        const user = requireUser(request);
        const body = await readBody(request);
        if (body.mockedLocation)
          throw Object.assign(new Error("Võltsasukoht tuvastatud"), {
            status: 403,
            code: "MOCK_LOCATION",
          });
        if (
          ![body.latitude, body.longitude, body.accuracyMeters].every(
            Number.isFinite,
          ) || body.latitude < -90 || body.latitude > 90 ||
          body.longitude < -180 || body.longitude > 180 ||
          body.accuracyMeters <= 0
        )
          throw Object.assign(new Error("Asukohaandmed puuduvad"), {
            status: 400,
            code: "LOCATION_REQUIRED",
          });
        if (body.accuracyMeters > 100)
          throw Object.assign(new Error("Asukoht ei ole piisavalt täpne"), {
            status: 403,
            code: "LOCATION_INACCURATE",
          });
        const code = resolveQrCode(body.qrPayload);
        if (!code)
          throw Object.assign(new Error("QR-kood ei kehti"), {
            status: 404,
            code: "INVALID_QR",
          });
        const alreadySaved = body.clientEventId
          ? events.find((event) => event.clientEventId === body.clientEventId && event.userId === user.id)
          : null;
        if (alreadySaved) return json(response, 200, alreadySaved);
        const serverReceivedAt = new Date();
        const scanTiming = process.env.SCAN_TIME_VALIDATION === "false"
          ? {
              scannedAt: body.scannedAt ?? serverReceivedAt.toISOString(),
              receivedAt: serverReceivedAt.toISOString(),
              syncDelaySeconds: 0,
              offline: false,
            }
          : validateScanTimestamp(body.scannedAt, serverReceivedAt);
        if (
          Array.isArray(user.assignedSiteIds) &&
          user.assignedSiteIds.length > 0 &&
          !user.assignedSiteIds.includes(code.siteId)
        )
          throw Object.assign(
            new Error("Töötaja ei ole sellele töömaale määratud"),
            { status: 403, code: "SITE_NOT_ASSIGNED" },
          );
        const distance = distanceMeters(
          body.latitude,
          body.longitude,
          code.latitude,
          code.longitude,
        );
        if (distance > code.radiusMeters)
          throw Object.assign(
            new Error(`Asud töömaast ${Math.round(distance)} meetri kaugusel`),
            { status: 403, code: "OUTSIDE_GEOFENCE" },
          );
        const registeredAt = scanTiming.scannedAt;
        const previousAction = latestAttendanceAction(user.id, code.siteId, registeredAt);
        if (code.action === "IN" && previousAction === "IN") {
          audit(user, "ATTENDANCE_SCAN_BLOCKED", "SITE", code.siteId, { reason: "ALREADY_CHECKED_IN", action: code.action, registeredAt });
          throw Object.assign(
            new Error("Oled sellele töömaale juba sisse registreeritud"),
            { status: 409, code: "ALREADY_CHECKED_IN" },
          );
        }
        if (code.action === "OUT" && previousAction !== "IN") {
          audit(user, "ATTENDANCE_SCAN_BLOCKED", "SITE", code.siteId, { reason: "NOT_CHECKED_IN", action: code.action, registeredAt });
          throw Object.assign(
            new Error("Enne väljumist pead olema töömaale sisse registreeritud"),
            { status: 409, code: "NOT_CHECKED_IN" },
          );
        }
        const event = {
          eventId: randomUUID(),
          clientEventId: body.clientEventId ?? null,
          userId: user.id,
          siteId: code.siteId,
          action: code.action,
          siteName: code.siteName,
          gateName: code.gateName,
          registeredAt,
          receivedAt: scanTiming.receivedAt,
          syncDelaySeconds: scanTiming.syncDelaySeconds,
          offline: scanTiming.offline,
          latitude: body.latitude,
          longitude: body.longitude,
          accuracyMeters: body.accuracyMeters,
          distanceMeters: Math.round(distance),
        };
        events.push(event);
        if (event.offline)
          audit(user, "OFFLINE_ATTENDANCE_SYNCED", "ATTENDANCE_EVENT", event.eventId, {
            siteId: event.siteId,
            syncDelaySeconds: event.syncDelaySeconds,
          });
        return json(response, 201, event);
      }

      if (request.method === "GET" && url.pathname === "/v1/me/timesheet") {
        const user = requireUser(request);
        const from = url.searchParams.get("from") ?? "0000-01-01";
        const to = url.searchParams.get("to") ?? "9999-12-31";
        return json(response, 200, buildTimesheet(user.id, from, to));
      }

      if (
        request.method === "POST" &&
        url.pathname === "/v1/attendance/correction-requests"
      ) {
        const user = requireUser(request);
        const body = await readBody(request);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date ?? "") || !body.reason)
          throw Object.assign(
            new Error("Kuupäev ja põhjendus on kohustuslikud"),
            { status: 400, code: "INVALID_REQUEST" },
          );
        if (body.requestedInTime && !/^\d{2}:\d{2}$/.test(body.requestedInTime)) throw Object.assign(new Error("Vigane IN-aeg"), { status: 400, code: "INVALID_TIME" });
        if (body.requestedOutTime && !/^\d{2}:\d{2}$/.test(body.requestedOutTime)) throw Object.assign(new Error("Vigane OUT-aeg"), { status: 400, code: "INVALID_TIME" });
        if (!body.requestedInTime && !body.requestedOutTime) throw Object.assign(new Error("Vähemalt üks parandatav aeg on kohustuslik"), { status: 400, code: "INVALID_REQUEST" });
        if (correctionRequests.some((item) => item.userId === user.id && item.date === body.date && item.status === "PENDING")) throw Object.assign(new Error("Selle kuupäeva parandustaotlus juba ootab"), { status: 409, code: "DUPLICATE_REQUEST" });
        const matchingEvent = events.find((event) => event.userId === user.id && event.registeredAt.startsWith(body.date));
        const correction = {
          id: randomUUID(),
          userId: user.id,
          workerName: user.name,
          date: body.date,
          requestedInTime: body.requestedInTime ?? null,
          requestedOutTime: body.requestedOutTime ?? null,
          reason: body.reason,
          siteId: body.siteId ?? matchingEvent?.siteId ?? null,
          siteName: body.siteName ?? matchingEvent?.siteName ?? "",
          status: "PENDING",
          createdAt: new Date().toISOString(),
        };
        correctionRequests.push(correction);
        return json(response, 201, correction);
      }

      return json(response, 404, {
        code: "NOT_FOUND",
        message: "Päringut ei leitud",
      });
    } catch (error) {
      return json(response, error.status ?? 500, {
        code: error.code ?? "INTERNAL_ERROR",
        message: error.message ?? "Serveri viga",
        requestId: response.requestId,
        ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
      });
    }
  });
}

export function validateProductionConfig(environment = process.env) {
  if (["development", "test"].includes(environment.NODE_ENV)) return true;
  const errors = [];
  const isPlaceholder = (value) =>
    !value || /^(MUUDA|CHANGE|CHANGEME)|example\.com|PILOOT-DOMEEN/i.test(String(value));
  const adminPassword = String(environment.ADMIN_PASSWORD ?? "");
  const managerPassword = String(environment.MANAGER_PASSWORD ?? "");
  if (adminPassword.length < 12 || isPlaceholder(adminPassword) || adminPassword === "demo1234")
    errors.push("ADMIN_PASSWORD peab olema vähemalt 12 märki");
  if (managerPassword.length < 12 || isPlaceholder(managerPassword) || managerPassword === "demo1234")
    errors.push("MANAGER_PASSWORD peab olema vähemalt 12 märki");
  if (adminPassword && adminPassword === managerPassword)
    errors.push("ADMIN_PASSWORD ja MANAGER_PASSWORD peavad olema erinevad");
  if (isPlaceholder(environment.ADMIN_EMAIL))
    errors.push("ADMIN_EMAIL peab olema peakasutaja päris e-posti aadress");
  if (!environment.DATABASE_PATH || environment.DATABASE_PATH === ":memory:")
    errors.push("DATABASE_PATH peab viitama püsivale andmebaasifailile");
  if (!String(environment.CORS_ORIGIN ?? "").startsWith("https://") || isPlaceholder(environment.CORS_ORIGIN))
    errors.push("CORS_ORIGIN peab olema piloodi HTTPS-päritolu");
  const offlineHours = Number(environment.MAX_OFFLINE_SCAN_HOURS ?? 24);
  if (!Number.isFinite(offlineHours) || offlineHours < 1 || offlineHours > 72)
    errors.push("MAX_OFFLINE_SCAN_HOURS peab olema vahemikus 1 kuni 72");
  if ([environment.SELLER_NAME, environment.SELLER_REGISTRY_CODE, environment.SELLER_IBAN].some(isPlaceholder))
    errors.push("Müüja arveldusandmed on puudulikud");
  if (!environment.SMTP_HOST || !environment.SMTP_USER || !environment.SMTP_PASS)
    errors.push("SMTP seadistus on tootmises kaheastmelise sisselogimise jaoks kohustuslik");
  if (!String(environment.SMS_WEBHOOK_URL ?? "").startsWith("https://") || isPlaceholder(environment.SMS_WEBHOOK_URL))
    errors.push("SMS_WEBHOOK_URL peab olema PIN-i taastamise HTTPS-aadress");
  if (String(environment.SMS_WEBHOOK_TOKEN ?? "").length < 16 || isPlaceholder(environment.SMS_WEBHOOK_TOKEN))
    errors.push("SMS_WEBHOOK_TOKEN peab olema vähemalt 16 märki");
  if (errors.length) throw new Error(`Tootmiskeskkonna seadistus vigane:\n- ${errors.join("\n- ")}`);
  return true;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  validateProductionConfig();
  const port = Number(process.env.PORT ?? 3000);
  const server = createApiServer();
  server.listen(port, "0.0.0.0", () => {
    console.log(`SiteClock API: http://0.0.0.0:${port}`);
    startScheduler({
      runDaily: runDailyAutomation,
      processEmails: processPendingEmails,
    });
    processPendingEmails().catch((error) =>
      console.error("E-posti töötluse viga:", error),
    );
  });
}
