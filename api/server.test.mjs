import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApiServer, validateProductionConfig, validateScanTimestamp } from './server.mjs';

let server;
let baseUrl;
let token;
let adminToken;
let managerToken;
let entranceId;
let siteId;
let createdWorkerId;
let correctionId;

before(async () => {
  server = createApiServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

test('tervise- ja valmisolekukontroll kinnitavad andmebaasi ühendust', async () => {
  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(health.headers.get('x-frame-options'), 'DENY');
  assert.match(health.headers.get('x-request-id'), /^[a-f0-9-]{36}$/);
  assert.equal((await health.json()).database, 'ok');
  const ready = await fetch(`${baseUrl}/ready`);
  assert.equal(ready.status, 200);
  assert.equal((await ready.json()).ready, true);
});

test('tootmiskeskkond ei käivitu vaikimisi paroolide või püsimäluta', () => {
  assert.throws(() => validateProductionConfig({ NODE_ENV: 'production', ADMIN_PASSWORD: 'lühike', DATABASE_PATH: ':memory:' }), /seadistus vigane/);
  assert.throws(() => validateProductionConfig({ NODE_ENV: 'production', ADMIN_PASSWORD: 'MUUDA-VÄHEMALT-12-MÄRGILISEKS', MANAGER_PASSWORD: 'teine-turvaline-parool', ADMIN_EMAIL: 'admin@objektiaeg.ee', DATABASE_PATH: '/data/app.sqlite', CORS_ORIGIN: 'https://pilot.objektiaeg.ee', SELLER_NAME: 'Objektiaeg OÜ', SELLER_REGISTRY_CODE: '12345678', SELLER_IBAN: 'EE001' }), /ADMIN_PASSWORD/);
  assert.equal(validateProductionConfig({ NODE_ENV: 'production', ADMIN_PASSWORD: 'turvaline-parool-123', MANAGER_PASSWORD: 'teine-turvaline-parool-456', ADMIN_EMAIL: 'admin@objektiaeg.ee', DATABASE_PATH: '/data/app.sqlite', CORS_ORIGIN: 'https://pilot.objektiaeg.ee', SELLER_NAME: 'Objektiaeg OÜ', SELLER_REGISTRY_CODE: '12345678', SELLER_IBAN: 'EE001', SMTP_HOST: 'smtp.objektiaeg.ee', SMTP_USER: 'mailer', SMTP_PASS: 'smtp-secret', SMS_WEBHOOK_URL: 'https://sms.objektiaeg.ee/send', SMS_WEBHOOK_TOKEN: 'sms-token-123456789' }), true);
});

test('offline-skaneeringu aeg välistab tuleviku ja üle 24 tunni vanuse kande', () => {
  const now = new Date('2026-07-18T12:00:00.000Z');
  const offline = validateScanTimestamp('2026-07-18T10:30:00.000Z', now, 24);
  assert.equal(offline.offline, true);
  assert.equal(offline.syncDelaySeconds, 5400);
  assert.throws(() => validateScanTimestamp('2026-07-18T12:06:00.000Z', now, 24), (error) => error.code === 'DEVICE_TIME_AHEAD');
  assert.throws(() => validateScanTimestamp('2026-07-17T11:59:59.000Z', now, 24), (error) => error.code === 'OFFLINE_SCAN_EXPIRED');
});

test('liiga suur päring blokeeritakse enne JSON-i töötlemist', async () => {
  const response = await fetch(`${baseUrl}/v1/admin/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'pilot-test-request-001' }, body: JSON.stringify({ padding: 'x'.repeat(1_048_576) }) });
  assert.equal(response.status, 413);
  assert.equal(response.headers.get('x-request-id'), 'pilot-test-request-001');
  const body = await response.json();
  assert.equal(body.code, 'REQUEST_TOO_LARGE');
  assert.equal(body.requestId, 'pilot-test-request-001');
});

test('konto seotakse olemasoleva töötajaga', async () => {
  const response = await fetch(`${baseUrl}/v1/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Martin Kask', phone: '+372 5555 1234', pin: '1234' }) });
  assert.equal(response.status, 200);
  const body = await response.json();
  token = body.accessToken;
  assert.equal(body.id, 'worker-1');
});

test('töötaja sessiooni saab kontrollida ja serveris lõpetada', async () => {
  const profile = await fetch(`${baseUrl}/v1/me/profile`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(profile.status, 200);
  assert.equal((await profile.json()).name, 'Martin Kask');
  const login = await fetch(`${baseUrl}/v1/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Martin Kask', phone: '+37255551234', pin: '1234' }) });
  const logoutToken = (await login.json()).accessToken;
  const logoutResponse = await fetch(`${baseUrl}/v1/auth/logout`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${logoutToken}` }, body: '{}' });
  assert.equal(logoutResponse.status, 200);
  const expired = await fetch(`${baseUrl}/v1/me/profile`, { headers: { Authorization: `Bearer ${logoutToken}` } });
  assert.equal(expired.status, 401);
});

test('läheduses tehtud IN registreeritakse', async () => {
  const response = await fetch(`${baseUrl}/v1/attendance/scan`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ clientEventId: 'mobile-event-1', qrPayload: 'demo-in', latitude: 59.437, longitude: 24.7536, accuracyMeters: 10, mockedLocation: false, scannedAt: '2026-07-18T07:42:00.000Z' }) });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.action, 'IN');
  assert.equal(body.distanceMeters, 0);
});

test('offline-järjekorra kordussaatmine ei tekita topeltkannet', async () => {
  const replay = await fetch(`${baseUrl}/v1/attendance/scan`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ clientEventId: 'mobile-event-1', qrPayload: 'demo-in', latitude: 59.437, longitude: 24.7536, accuracyMeters: 10, mockedLocation: false, scannedAt: '2026-07-18T07:42:00.000Z' }) });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).clientEventId, 'mobile-event-1');
});

test('topelt-IN blokeeritakse ja katse auditeeritakse', async () => {
  const duplicate = await fetch(`${baseUrl}/v1/attendance/scan`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ qrPayload: 'demo-in', latitude: 59.437, longitude: 24.7536, accuracyMeters: 10, mockedLocation: false, scannedAt: '2026-07-18T07:43:00.000Z' }) });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).code, 'ALREADY_CHECKED_IN');
});

test('kaugelt tehtud OUT lükatakse tagasi', async () => {
  const response = await fetch(`${baseUrl}/v1/attendance/scan`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ qrPayload: 'demo-out', latitude: 59.45, longitude: 24.75, accuracyMeters: 10, mockedLocation: false }) });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'OUTSIDE_GEOFENCE');
});

test('tunnileht sisaldab IN registreeringut', async () => {
  const response = await fetch(`${baseUrl}/v1/me/timesheet?from=2026-07-18&to=2026-07-18`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.length, 1);
  assert.equal(body[0].inTime, '07:42');
});

test('peakasutaja saab sisse logida ja koostada automaatse arve', async () => {
  const login = await fetch(`${baseUrl}/v1/admin/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com', password: 'demo1234' }) });
  assert.equal(login.status, 200);
  const challenge = await login.json();
  assert.equal(challenge.requiresTwoFactor, true);
  const verification = await fetch(`${baseUrl}/v1/admin/auth/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challengeId: challenge.challengeId, code: challenge.developmentCode }) });
  assert.equal(verification.status, 200);
  adminToken = (await verification.json()).accessToken;
  const generated = await fetch(`${baseUrl}/v1/admin/billing/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ date: '2026-07-01' }) });
  assert.equal(generated.status, 201);
  const invoices = await generated.json();
  assert.equal(invoices.length, 1);
  assert.equal(invoices[0].status, 'SENT');
  assert.equal(invoices[0].totalCents, 12276);
});

test('töötaja parandustaotlus kinnitatakse ja kajastub tunnilehel', async () => {
  const request = await fetch(`${baseUrl}/v1/attendance/correction-requests`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ date: '2026-07-18', requestedOutTime: '16:15', reason: 'Unustasin OUT-koodi skaneerida' }) });
  assert.equal(request.status, 201);
  correctionId = (await request.json()).id;
  const decision = await fetch(`${baseUrl}/v1/admin/correction-requests/${correctionId}/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ decision: 'APPROVED', note: 'Meistri kinnitus olemas' }) });
  assert.equal((await decision.json()).status, 'APPROVED');
  const timesheet = await fetch(`${baseUrl}/v1/me/timesheet?from=2026-07-18&to=2026-07-18`, { headers: { Authorization: `Bearer ${token}` } });
  const [day] = await timesheet.json();
  assert.equal(day.outTime, '16:15');
  assert.equal(day.corrected, true);
  assert.equal(day.totalMinutes, 513);
});

test('töötaja näeb enda parandustaotluse otsust ja märkust', async () => {
  const response = await fetch(`${baseUrl}/v1/attendance/correction-requests`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  const [request] = await response.json();
  assert.equal(request.id, correctionId);
  assert.equal(request.status, 'APPROVED');
  assert.equal(request.decisionNote, 'Meistri kinnitus olemas');
  assert.ok(request.decidedAt);
});

test('töötaja saab paranduse otsuse teavituse ja märgib selle loetuks', async () => {
  const response = await fetch(`${baseUrl}/v1/me/notifications`, { headers: { Authorization: `Bearer ${token}` } });
  const [notification] = await response.json();
  assert.equal(notification.type, 'CORRECTION_APPROVED');
  assert.equal(notification.readAt, null);
  const read = await fetch(`${baseUrl}/v1/me/notifications/${notification.id}/read`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: '{}' });
  assert.ok((await read.json()).readAt);
});

test('OUT ilma aktiivse IN-ita blokeeritakse', async () => {
  const response = await fetch(`${baseUrl}/v1/attendance/scan`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ qrPayload: 'demo-out', latitude: 59.437, longitude: 24.7536, accuracyMeters: 10, mockedLocation: false, scannedAt: '2026-07-18T16:16:00.000Z' }) });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'NOT_CHECKED_IN');
});

test('lõpetamata tööpäev loob töötajale meeldetuletuse', async () => {
  const scan = await fetch(`${baseUrl}/v1/attendance/scan`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ clientEventId: 'missing-out-day', qrPayload: 'demo-in', latitude: 59.437, longitude: 24.7536, accuracyMeters: 10, mockedLocation: false, scannedAt: '2026-07-19T07:30:00.000Z' }) });
  assert.equal(scan.status, 201);
  const run = await fetch(`${baseUrl}/v1/admin/attendance/reminders/run`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ date: '2026-07-19' }) });
  assert.equal(run.status, 200);
  const notificationsResponse = await fetch(`${baseUrl}/v1/me/notifications`, { headers: { Authorization: `Bearer ${token}` } });
  assert.ok((await notificationsResponse.json()).some((item) => item.type === 'MISSING_OUT'));
});

test('peakasutaja saab tööaja aruande ja CSV ekspordi', async () => {
  const report = await fetch(`${baseUrl}/v1/admin/attendance-report?from=2026-07-18&to=2026-07-18`, { headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(report.status, 200);
  const [row] = await report.json();
  assert.equal(row.workerName, 'Martin Kask');
  assert.equal(row.totalMinutes, 513);
  assert.equal(row.corrected, true);
  const csv = await fetch(`${baseUrl}/v1/admin/attendance-report.csv?from=2026-07-18&to=2026-07-18`, { headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(csv.headers.get('content-type'), 'text/csv; charset=utf-8');
  const text = await csv.text();
  assert.match(text, /Martin Kask/);
  assert.match(text, /8,55/);
});

test('peakasutaja näeb hetkel töömaal viibivaid töötajaid', async () => {
  const midday = await fetch(`${baseUrl}/v1/admin/current-presence?at=2026-07-18T12:00:00.000Z`, { headers: { Authorization: `Bearer ${adminToken}` } });
  const present = await midday.json();
  assert.equal(present.length, 1);
  assert.equal(present[0].workerName, 'Martin Kask');
  assert.equal(present[0].durationMinutes, 258);
  const afterOut = await fetch(`${baseUrl}/v1/admin/current-presence?at=2026-07-18T17:00:00.000Z`, { headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal((await afterOut.json()).length, 0);
});

test('peakasutaja saab luua töömaa ja sissepääsu', async () => {
  const siteResponse = await fetch(`${baseUrl}/v1/admin/sites`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ name: 'Testobjekt', address: 'Testi 1, Tallinn', latitude: 59.437, longitude: 24.7536, radiusMeters: 200 }) });
  assert.equal(siteResponse.status, 201);
  const site = await siteResponse.json();
  siteId = site.id;
  const entranceResponse = await fetch(`${baseUrl}/v1/admin/sites/${site.id}/entrances`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ name: 'Peavärav' }) });
  assert.equal(entranceResponse.status, 201);
  entranceId = (await entranceResponse.json()).id;
});

test('peakasutaja saab lisada töötaja ja siduda ta töömaaga', async () => {
  const response = await fetch(`${baseUrl}/v1/admin/workers`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ clientId: 'client-1', name: 'Jaan Lepp', phone: '+37255550001', jobTitle: 'Betoneerija', assignedSiteIds: [siteId] }) });
  assert.equal(response.status, 201);
  const worker = await response.json();
  createdWorkerId = worker.id;
  assert.deepEqual(worker.assignedSiteIds, [siteId]);
  assert.equal(worker.pinHash, undefined);
});

test('peakasutaja saab töötaja peatada ja PIN-i lähtestada', async () => {
  const update = await fetch(`${baseUrl}/v1/admin/workers/${createdWorkerId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ active: false }) });
  assert.equal((await update.json()).active, false);
  const reset = await fetch(`${baseUrl}/v1/admin/workers/${createdWorkerId}/reset-pin`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` }, body: '{}' });
  assert.equal((await reset.json()).reset, true);
});

test('meister logib sisse ja näeb ainult oma kliendi tööandmeid', async () => {
  const login = await fetch(`${baseUrl}/v1/admin/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'meister@example.com', password: 'demo1234' }) });
  const challenge = await login.json();
  const verification = await fetch(`${baseUrl}/v1/admin/auth/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challengeId: challenge.challengeId, code: challenge.developmentCode }) });
  const session = await verification.json();
  assert.equal(session.role, 'manager');
  assert.equal(session.clientId, 'client-1');
  managerToken = session.accessToken;
  const dashboard = await fetch(`${baseUrl}/v1/manager/dashboard`, { headers: { Authorization: `Bearer ${managerToken}` } });
  assert.equal(dashboard.status, 200);
  const data = await dashboard.json();
  assert.ok(data.workers.every((worker) => worker.clientId === 'client-1'));
  assert.ok(data.sites.every((site) => site.clientId === 'client-1'));
  const billing = await fetch(`${baseUrl}/v1/admin/invoices`, { headers: { Authorization: `Bearer ${managerToken}` } });
  assert.equal(billing.status, 403);
  const managerSiteResponse = await fetch(`${baseUrl}/v1/admin/sites`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${managerToken}` }, body: JSON.stringify({ clientId: 'other-client', name: 'Meistri objekt', latitude: 59.44, longitude: 24.75, radiusMeters: 150 }) });
  assert.equal(managerSiteResponse.status, 201);
  const managerSite = await managerSiteResponse.json();
  assert.equal(managerSite.clientId, 'client-1');
  const managerEntrance = await fetch(`${baseUrl}/v1/admin/sites/${managerSite.id}/entrances`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${managerToken}` }, body: JSON.stringify({ name: 'Meistri värav' }) });
  assert.equal(managerEntrance.status, 201);
  const managerWorker = await fetch(`${baseUrl}/v1/admin/workers`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${managerToken}` }, body: JSON.stringify({ clientId: 'other-client', name: 'Meistri Töötaja', phone: '+37255550123', assignedSiteIds: [managerSite.id] }) });
  assert.equal(managerWorker.status, 201);
  assert.equal((await managerWorker.json()).clientId, 'client-1');
  const report = await fetch(`${baseUrl}/v1/admin/attendance-report?from=2026-07-18&to=2026-07-18`, { headers: { Authorization: `Bearer ${managerToken}` } });
  assert.equal(report.status, 200);
  assert.ok((await report.json()).every((row) => row.companyName === 'Demo Ehitus OÜ'));
  const csv = await fetch(`${baseUrl}/v1/admin/attendance-report.csv?from=2026-07-18&to=2026-07-18`, { headers: { Authorization: `Bearer ${managerToken}` } });
  assert.equal(csv.headers.get('content-type'), 'text/csv; charset=utf-8');
});

test('peakasutaja haldab meistrite ja projektijuhtide kontosid', async () => {
  const created = await fetch(`${baseUrl}/v1/admin/managers`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ clientId: 'client-1', name: 'Mari Tamm', email: 'mari@example.com', title: 'Projektijuht', password: 'turvaline123' }) });
  assert.equal(created.status, 201);
  const manager = await created.json();
  assert.equal(manager.passwordHash, undefined);
  const suspended = await fetch(`${baseUrl}/v1/admin/managers/${manager.id}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ active: false }) });
  assert.equal((await suspended.json()).active, false);
  const blockedLogin = await fetch(`${baseUrl}/v1/admin/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'mari@example.com', password: 'turvaline123' }) });
  assert.equal(blockedLogin.status, 401);
  const reset = await fetch(`${baseUrl}/v1/admin/managers/${manager.id}/reset-password`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` }, body: '{}' });
  const temporaryPassword = (await reset.json()).temporaryPassword;
  assert.ok(temporaryPassword.length >= 12);
  await fetch(`${baseUrl}/v1/admin/managers/${manager.id}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ active: true }) });
  const temporaryLogin = await fetch(`${baseUrl}/v1/admin/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'mari@example.com', password: temporaryPassword }) });
  const temporaryChallenge = await temporaryLogin.json();
  const temporaryVerification = await fetch(`${baseUrl}/v1/admin/auth/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challengeId: temporaryChallenge.challengeId, code: temporaryChallenge.developmentCode }) });
  const temporarySession = await temporaryVerification.json();
  assert.equal(temporarySession.mustChangePassword, true);
  const blockedDashboard = await fetch(`${baseUrl}/v1/manager/dashboard`, { headers: { Authorization: `Bearer ${temporarySession.accessToken}` } });
  assert.equal((await blockedDashboard.json()).code, 'PASSWORD_CHANGE_REQUIRED');
  const changed = await fetch(`${baseUrl}/v1/admin/auth/change-password`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${temporarySession.accessToken}` }, body: JSON.stringify({ currentPassword: temporaryPassword, newPassword: 'MinuUusParool123!' }) });
  assert.equal(changed.status, 200);
  const allowedDashboard = await fetch(`${baseUrl}/v1/manager/dashboard`, { headers: { Authorization: `Bearer ${temporarySession.accessToken}` } });
  assert.equal(allowedDashboard.status, 200);
});

test('sissepääsu prinditav IN/OUT QR-leht genereeritakse', async () => {
  process.env.PYTHON_BIN = '/Users/jaakviik/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3';
  const response = await fetch(`${baseUrl}/v1/admin/entrances/${entranceId}/qr-sheet.pdf`, { headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/pdf');
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), '%PDF');
});

test('töömaa prinditav kohalolijate PDF genereeritakse', async () => {
  process.env.PYTHON_BIN = '/Users/jaakviik/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3';
  const response = await fetch(`${baseUrl}/v1/admin/sites/${siteId}/presence-list.pdf`, { headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/pdf');
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), '%PDF');
});

test('e-kirjade töötlus jääb ilma SMTP seadistuseta testrežiimi', async () => {
  const processed = await fetch(`${baseUrl}/v1/admin/email-outbox/process`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` }, body: '{}' });
  assert.equal(processed.status, 200);
  const results = await processed.json();
  assert.ok(results.some((item) => item.status === 'TEST_READY'));
});

test('tasumata arvele lisatakse õigel päeval meeldetuletus', async () => {
  const response = await fetch(`${baseUrl}/v1/admin/billing/reminders/run`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ date: '2026-07-16' }) });
  assert.equal(response.status, 200);
  const reminders = await response.json();
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].overdueDays, 1);
});

test('pärast kolmandat meeldetuletust ja lisatähtaega rakendub piiratud kasutus', async () => {
  for (const date of ['2026-07-22', '2026-07-29', '2026-08-01']) {
    const response = await fetch(`${baseUrl}/v1/admin/billing/reminders/run`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ date }) });
    assert.equal(response.status, 200);
  }
  const clientsResponse = await fetch(`${baseUrl}/v1/admin/clients`, { headers: { Authorization: `Bearer ${adminToken}` } });
  const [client] = await clientsResponse.json();
  assert.equal(client.billingStatus, 'RESTRICTED');
  const capabilitiesResponse = await fetch(`${baseUrl}/v1/account/capabilities`, { headers: { Authorization: `Bearer ${token}` } });
  const capabilities = await capabilitiesResponse.json();
  assert.equal(capabilities.capabilities.attendanceScan, true);
  assert.equal(capabilities.capabilities.timesheetRead, true);
  assert.equal(capabilities.capabilities.createSites, false);
  const blockedWorker = await fetch(`${baseUrl}/v1/admin/workers`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ clientId: 'client-1', name: 'Blokeeritud Kasutaja', phone: '+37255550002' }) });
  assert.equal(blockedWorker.status, 403);
});

test('peakasutaja saab lisada Soome kliendi õige käibemaksuga', async () => {
  const response = await fetch(`${baseUrl}/v1/admin/clients`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ companyName: 'Uus Klient OÜ', registryCode: '87654321', billingEmail: 'uus@example.com', monthlyFeeCents: 14900, automaticSending: false, country: 'FI', language: 'fi' }) });
  assert.equal(response.status, 201);
  const client = await response.json();
  assert.equal(client.companyName, 'Uus Klient OÜ');
  assert.equal(client.country, 'FI');
  assert.equal(client.language, 'fi');
  assert.equal(client.vatRate, 0.255);
});

test('arve PDF genereeritakse', async () => {
  process.env.PYTHON_BIN = '/Users/jaakviik/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3';
  const invoicesResponse = await fetch(`${baseUrl}/v1/admin/invoices`, { headers: { Authorization: `Bearer ${adminToken}` } });
  const [invoice] = await invoicesResponse.json();
  const response = await fetch(`${baseUrl}/v1/admin/invoices/${invoice.id}/pdf`, { headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/pdf');
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), '%PDF');
});

test('peakasutaja saab kliendi andmeid muuta', async () => {
  const clientsResponse = await fetch(`${baseUrl}/v1/admin/clients`, { headers: { Authorization: `Bearer ${adminToken}` } });
  const client = (await clientsResponse.json()).find((item) => item.companyName === 'Uus Klient OÜ');
  const response = await fetch(`${baseUrl}/v1/admin/clients/${client.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ monthlyFeeCents: 15900 }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).monthlyFeeCents, 15900);
});

test('arve saab märkida tasutuks ja krediteerida', async () => {
  const invoicesResponse = await fetch(`${baseUrl}/v1/admin/invoices`, { headers: { Authorization: `Bearer ${adminToken}` } });
  const [invoice] = await invoicesResponse.json();
  const paid = await fetch(`${baseUrl}/v1/admin/invoices/${invoice.id}/mark-paid`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` }, body: '{}' });
  assert.equal((await paid.json()).status, 'PAID');
  const clientsAfterPayment = await fetch(`${baseUrl}/v1/admin/clients`, { headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal((await clientsAfterPayment.json())[0].billingStatus, 'ACTIVE');
  const credited = await fetch(`${baseUrl}/v1/admin/invoices/${invoice.id}/credit`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ reason: 'Testkrediteerimine' }) });
  assert.equal(credited.status, 201);
  const credit = await credited.json();
  assert.equal(credit.totalCents, -12276);
  assert.equal(credit.documentType, 'CREDIT_NOTE');
});

test('peakasutaja toimingud jäävad auditilogisse', async () => {
  const response = await fetch(`${baseUrl}/v1/admin/audit-logs`, { headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(response.status, 200);
  const logs = await response.json();
  assert.ok(logs.some((item) => item.action === 'CLIENT_UPDATED'));
  assert.ok(logs.some((item) => item.action === 'CREDIT_NOTE_CREATED'));
  assert.ok(logs.some((item) => item.action === 'ADMIN_LOGIN_SUCCEEDED'));
  assert.ok(logs.some((item) => item.action === 'WORKER_LOGIN_SUCCEEDED'));
  assert.ok(logs.some((item) => item.action === 'ATTENDANCE_SCAN_BLOCKED' && item.details.reason === 'ALREADY_CHECKED_IN'));
});

test('peakasutaja saab isikuandmed eksportida ja töötaja anonüümseks muuta', async () => {
  const exported = await fetch(`${baseUrl}/v1/admin/workers/worker-1/personal-data-export`, { headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(exported.status, 200);
  const data = await exported.json();
  assert.equal(data.profile.name, 'Martin Kask');
  assert.equal(data.profile.pinHash, undefined);
  assert.equal(data.attendanceEvents.length, 2);
  const anonymized = await fetch(`${baseUrl}/v1/admin/workers/${createdWorkerId}/anonymize`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` }, body: '{}' });
  assert.equal(anonymized.status, 200);
  const worker = await anonymized.json();
  assert.match(worker.name, /^Anonüümne töötaja/);
  assert.equal(worker.phone, '');
  assert.equal(worker.active, false);
  assert.ok(worker.anonymizedAt);
});

test('vale PIN ei loo töötaja sessiooni', async () => {
  const response = await fetch(`${baseUrl}/v1/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Martin Kask', phone: '+37255551234', pin: '9999' }) });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, 'INVALID_PIN');
});

test('PIN peab sisaldama ainult numbreid', async () => {
  const response = await fetch(`${baseUrl}/v1/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Martin Kask', phone: '+37255551234', pin: 'abcd' }) });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'INVALID_PIN');
});

test('korduvad valed PIN-id käivitavad ajutise lukustuse', async () => {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(`${baseUrl}/v1/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Martin Kask', phone: '+37255551234', pin: '9999' }) });
    assert.equal(response.status, 401);
  }
  const limited = await fetch(`${baseUrl}/v1/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Martin Kask', phone: '+37255551234', pin: '1234' }) });
  assert.equal(limited.status, 429);
  const body = await limited.json();
  assert.equal(body.code, 'AUTH_RATE_LIMITED');
  assert.ok(body.retryAfterSeconds > 0);
});

test('töötaja saab PIN-koodi taastada ühekordse koodiga', async () => {
  const request = await fetch(`${baseUrl}/v1/auth/recovery/request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '+37255551234' }) });
  const challenge = await request.json();
  const confirmation = await fetch(`${baseUrl}/v1/auth/recovery/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challengeId: challenge.challengeId, code: challenge.developmentCode, newPin: '5678' }) });
  assert.equal(confirmation.status, 200);
  const login = await fetch(`${baseUrl}/v1/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Martin Kask', phone: '+37255551234', pin: '5678' }) });
  assert.equal(login.status, 200);
});
