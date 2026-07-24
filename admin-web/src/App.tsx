import { Component, useMemo, useState } from "react";
import type { ErrorInfo, FormEvent, ReactNode } from "react";
import "./App.css";
import "./Client.css";
import "./Actions.css";
import "./Sites.css";
import "./Workers.css";
import { initialWebLanguage, persistWebLanguage, webAccountText, webTranslate, webUiText } from "./i18n";
import type { WebLanguage, WebTranslationKey } from "./i18n";

const apiUrl = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:3000";

type Client = {
  id: string;
  companyName: string;
  registryCode: string;
  billingEmail: string;
  language: "et" | "fi" | "en";
  country: "EE" | "FI" | "OTHER";
  vatRate: number;
  monthlyFeeCents: number;
  automaticSending: boolean;
  billingStatus: "ACTIVE" | "WARNING" | "RESTRICTED" | "MANUALLY_SUSPENDED";
};
type Entrance = {
  id: string;
  siteId: string;
  name: string;
  active: boolean;
  createdAt: string;
};
type Site = {
  id: string;
  clientId: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  active: boolean;
  entrances: Entrance[];
};
type Worker = {
  id: string;
  clientId: string;
  name: string;
  phone: string;
  role: string;
  jobTitle: string;
  companyName: string;
  assignedSiteIds?: string[];
  active: boolean;
};
type Manager = {
  id: string;
  clientId: string;
  clientName: string;
  name: string;
  email: string;
  title: string;
  active: boolean;
};
type Invoice = {
  id: string;
  number: string;
  clientName: string;
  issuedDate: string;
  dueDate: string;
  totalCents: number;
  status: "DRAFT" | "SENT" | "PAID" | "OVERDUE" | "CREDITED";
  documentType?: "INVOICE" | "CREDIT_NOTE";
};
type OutboxMessage = {
  id: string;
  type:
    | "INVOICE"
    | "PAYMENT_REMINDER"
    | "CREDIT_NOTE"
    | "ACCOUNT_RESTRICTED"
    | "ADMIN_LOGIN_CODE"
    | "ACCOUNT_RECOVERY_CODE";
  to: string;
  createdAt: string;
  overdueDays?: number;
  status?:
    | "PENDING"
    | "TEST_READY"
    | "PROCESSING"
    | "SENT"
    | "RETRY"
    | "FAILED";
};
type CorrectionRequest = {
  id: string;
  workerId: string;
  workerName: string;
  siteName: string;
  date: string;
  requestedInTime?: string;
  requestedOutTime?: string;
  reason: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  createdAt: string;
  decisionNote?: string;
};
type AttendanceRow = {
  workerId: string;
  workerName: string;
  companyName: string;
  siteName: string;
  date: string;
  inTime: string | null;
  outTime: string | null;
  totalMinutes: number | null;
  corrected?: boolean;
};
type PresenceRow = {
  userId: string;
  workerName: string;
  phone: string;
  siteId: string;
  siteName: string;
  time: string;
  durationMinutes: number;
  longShiftWarning: boolean;
};
type AuditLog = {
  id: string;
  userId: string;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
  createdAt: string;
};

async function api<T>(
  path: string,
  token: string,
  options?: RequestInit,
): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options?.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(`${body.message ?? `Serveri viga ${response.status}`}${body.requestId ? ` (viide: ${body.requestId})` : ""}`);
  return body;
}

function ensureArray<T>(value: unknown, label: string): T[] {
  if (!Array.isArray(value)) throw new Error(`${label}: server tagastas vigase andmevormingu`);
  return value as T[];
}

function localDateValue(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function euro(cents: number) {
  return new Intl.NumberFormat("et-EE", {
    style: "currency",
    currency: "EUR",
  }).format(cents / 100);
}
function statusLabel(status: Invoice["status"]) {
  return {
    DRAFT: "Mustand",
    SENT: "Saadetud",
    PAID: "Tasutud",
    OVERDUE: "Tähtaja ületanud",
    CREDITED: "Krediteeritud",
  }[status];
}
function auditActionLabel(action: string) {
  return (
    {
      ADMIN_LOGIN_SUCCEEDED: "Peakasutaja sisselogimine",
      WORKER_LOGIN_SUCCEEDED: "Töötaja sisselogimine",
      ATTENDANCE_SCAN_BLOCKED: "QR-registreering blokeeritud",
      CORRECTION_APPROVED: "Parandus kinnitatud",
      CORRECTION_REJECTED: "Parandus tagasi lükatud",
      CLIENT_CREATED: "Klient loodud",
      CLIENT_UPDATED: "Klient muudetud",
      SITE_CREATED: "Töömaa loodud",
      SITE_UPDATED: "Töömaa muudetud",
      SITE_ARCHIVED: "Töömaa eemaldatud",
      ENTRANCE_CREATED: "Sissepääs loodud",
      QR_TOKENS_ROTATED: "QR-koodid uuendatud",
      WORKER_CREATED: "Töötaja loodud",
      WORKER_UPDATED: "Töötaja muudetud",
      WORKER_ARCHIVED: "Töötaja eemaldatud",
      WORKER_PIN_RESET: "Töötaja PIN lähtestatud",
      WORKER_DATA_EXPORTED: "Töötaja andmed eksporditud",
      WORKER_ANONYMIZED: "Töötaja anonüümseks muudetud",
      MANAGER_CREATED: "Meistri konto loodud",
      MANAGER_ACTIVATED: "Meistri konto aktiveeritud",
      MANAGER_SUSPENDED: "Meistri konto peatatud",
      MANAGER_PASSWORD_RESET: "Meistri parool lähtestatud",
      MANAGER_PASSWORD_CHANGED: "Meistri parool muudetud",
      MANAGER_LOGIN_SUCCEEDED: "Meistri sisselogimine",
      ATTENDANCE_REPORT_EXPORTED: "Tööaja aruanne eksporditud",
      PRESENCE_LIST_EXPORTED: "Kohalolijate nimekiri eksporditud",
      AUTHENTICATION_FAILED: "Ebaõnnestunud sisselogimine",
      OFFLINE_ATTENDANCE_SYNCED: "Offline-registreering sünkroonitud",
      INVOICE_GENERATED: "Arve koostatud",
      INVOICE_MARKED_PAID: "Arve tasutuks märgitud",
      CREDIT_NOTE_CREATED: "Kreeditarve loodud",
    } as Record<string, string>
  )[action] ?? action;
}

class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("SiteClocki haldusliidese viga", error, info.componentStack);
  }

  render() {
    if (this.state.failed)
      return <main className="login-shell"><section className="login-card"><h1>SiteClock</h1><p>Vaate laadimisel tekkis viga.</p><button onClick={() => window.location.reload()}>Laadi uuesti</button></section></main>;
    return this.props.children;
  }
}

function SiteClockApp() {
  const [language, setLanguage] = useState<WebLanguage>(initialWebLanguage);
  const t = (key: WebTranslationKey) => webTranslate(language, key);
  const u = (text: string) => webUiText(language, text);
  const a = (text: string) => webAccountText(language, text);
  const changeLanguage = (next: WebLanguage) => { setLanguage(next); persistWebLanguage(next); };
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [developmentCode, setDevelopmentCode] = useState("");
  const [sessionRole, setSessionRole] = useState<"admin" | "manager">("admin");
  const [mustChangePassword, setMustChangePassword] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [newPasswordAgain, setNewPasswordAgain] = useState("");
  const [clients, setClients] = useState<Client[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [outbox, setOutbox] = useState<OutboxMessage[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [managers, setManagers] = useState<Manager[]>([]);
  const [corrections, setCorrections] = useState<CorrectionRequest[]>([]);
  const [attendanceRows, setAttendanceRows] = useState<AttendanceRow[]>([]);
  const [presence, setPresence] = useState<PresenceRow[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [auditFilter, setAuditFilter] = useState("");
  const [reportFilters, setReportFilters] = useState({
    from: `${localDateValue().slice(0, 8)}01`,
    to: localDateValue(),
    siteId: "",
  });
  const [tab, setTab] = useState<
    | "overview"
    | "presence"
    | "clients"
    | "workers"
    | "managers"
    | "sites"
    | "corrections"
    | "reports"
    | "invoices"
    | "outbox"
    | "audit"
  >("overview");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [clientForm, setClientForm] = useState({
    companyName: "",
    registryCode: "",
    billingEmail: "",
    monthlyFee: "99",
    automaticSending: true,
    language: "et" as "et" | "fi" | "en",
    country: "EE" as "EE" | "FI" | "OTHER",
    vatPercent: "24",
  });
  const [editingClientId, setEditingClientId] = useState<string | null>(null);
  const [siteForm, setSiteForm] = useState({
    name: "",
    address: "",
    latitude: "",
    longitude: "",
    radiusMeters: "200",
  });
  const [editingSiteId, setEditingSiteId] = useState<string | null>(null);
  const [locatingSite, setLocatingSite] = useState(false);
  const [entranceNames, setEntranceNames] = useState<Record<string, string>>(
    {},
  );
  const [workerForm, setWorkerForm] = useState({
    clientId: "",
    name: "",
    phone: "",
    jobTitle: "",
    siteId: "",
  });
  const [managerForm, setManagerForm] = useState({ clientId: "", name: "", email: "", title: "Meister", password: "" });

  async function loadAll(accessToken: string, role = sessionRole) {
    if (role === "manager") {
      const dashboard = await api<{
        clients: Client[];
        sites: Site[];
        workers: Worker[];
        corrections: CorrectionRequest[];
        presence: PresenceRow[];
      }>("/v1/manager/dashboard", accessToken);
      const dashboardClients = ensureArray<Client>(dashboard.clients, "Kliendid");
      setClients(dashboardClients);
      if (dashboardClients[0])
        setWorkerForm((current) => ({ ...current, clientId: dashboardClients[0].id }));
      setSites(ensureArray<Site>(dashboard.sites, "Töömaad"));
      setWorkers(ensureArray<Worker>(dashboard.workers, "Töötajad"));
      setCorrections(ensureArray<CorrectionRequest>(dashboard.corrections, "Parandustaotlused"));
      setPresence(ensureArray<PresenceRow>(dashboard.presence, "Kohalolijad"));
      return;
    }
    const [
      clientRows,
      invoiceRows,
      messageRows,
      siteRows,
      workerRows,
      correctionRows,
      presenceRows,
      auditRows,
      managerRows,
    ] =
      await Promise.all([
        api<Client[]>("/v1/admin/clients", accessToken),
        api<Invoice[]>("/v1/admin/invoices", accessToken),
        api<OutboxMessage[]>("/v1/admin/email-outbox", accessToken),
        api<Site[]>("/v1/admin/sites", accessToken),
        api<Worker[]>("/v1/admin/workers", accessToken),
        api<CorrectionRequest[]>(
          "/v1/admin/correction-requests",
          accessToken,
        ),
        api<PresenceRow[]>("/v1/admin/current-presence", accessToken),
        api<AuditLog[]>("/v1/admin/audit-logs", accessToken),
        api<Manager[]>("/v1/admin/managers", accessToken),
      ]);
    setClients(ensureArray<Client>(clientRows, "Kliendid"));
    setInvoices(ensureArray<Invoice>(invoiceRows, "Arved"));
    setOutbox(ensureArray<OutboxMessage>(messageRows, "Saatmisjärjekord"));
    setSites(ensureArray<Site>(siteRows, "Töömaad"));
    setWorkers(ensureArray<Worker>(workerRows, "Töötajad"));
    setCorrections(ensureArray<CorrectionRequest>(correctionRows, "Parandustaotlused"));
    setPresence(ensureArray<PresenceRow>(presenceRows, "Kohalolijad"));
    setAuditLogs(ensureArray<AuditLog>(auditRows, "Auditilogi"));
    setManagers(ensureArray<Manager>(managerRows, "Meistrid"));
    if (!workerForm.clientId && clientRows[0])
      setWorkerForm((current) => ({ ...current, clientId: clientRows[0].id }));
  }

  async function logoutAdmin() {
    try {
      await api("/v1/auth/logout", token, { method: "POST", body: "{}" });
    } catch {
      // Local logout must still complete if the server is unavailable.
    } finally {
      setToken("");
      setChallengeId("");
      setVerificationCode("");
    }
  }

  async function login(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const loginResult = await api<{
        challengeId?: string;
        developmentCode?: string;
        accessToken?: string;
        role?: "admin" | "manager";
        mustChangePassword?: boolean;
      }>("/v1/admin/auth/login", "", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      if (loginResult.accessToken && loginResult.role) {
        setSessionRole(loginResult.role);
        setMustChangePassword(Boolean(loginResult.mustChangePassword));
        setToken(loginResult.accessToken);
        if (!loginResult.mustChangePassword)
          await loadAll(loginResult.accessToken, loginResult.role);
        return;
      }
      if (!loginResult.challengeId)
        throw new Error("Sisselogimise vastus oli vigane");
      setChallengeId(loginResult.challengeId);
      setDevelopmentCode(loginResult.developmentCode ?? "");
      if (loginResult.developmentCode)
        setVerificationCode(loginResult.developmentCode);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Sisselogimine ebaõnnestus",
      );
    } finally {
      setBusy(false);
    }
  }

  async function verifyLogin(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const session = await api<{
        accessToken: string;
        role: "admin" | "manager";
        mustChangePassword: boolean;
      }>(
        "/v1/admin/auth/verify",
        "",
        {
          method: "POST",
          body: JSON.stringify({ challengeId, code: verificationCode }),
        },
      );
      setSessionRole(session.role);
      setMustChangePassword(session.mustChangePassword);
      setToken(session.accessToken);
      if (!session.mustChangePassword)
        await loadAll(session.accessToken, session.role);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Koodi kontroll ebaõnnestus",
      );
    } finally {
      setBusy(false);
    }
  }

  async function changeOwnPassword(event: FormEvent) {
    event.preventDefault();
    if (newPassword !== newPasswordAgain) return setError("Uued paroolid ei ühti");
    setBusy(true);
    setError("");
    try {
      await api("/v1/admin/auth/change-password", token, {
        method: "POST",
        body: JSON.stringify({ currentPassword: password, newPassword }),
      });
      setPassword(newPassword);
      setNewPassword("");
      setNewPasswordAgain("");
      setMustChangePassword(false);
      await loadAll(token, sessionRole);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Parooli ei saanud muuta");
    } finally { setBusy(false); }
  }

  async function runBilling(path: string, date: string) {
    setBusy(true);
    setError("");
    try {
      await api(path, token, {
        method: "POST",
        body: JSON.stringify({ date }),
      });
      await loadAll(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Toiming ebaõnnestus");
    } finally {
      setBusy(false);
    }
  }

  async function addClient(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(
        editingClientId
          ? `/v1/admin/clients/${editingClientId}`
          : "/v1/admin/clients",
        token,
        {
          method: editingClientId ? "PUT" : "POST",
          body: JSON.stringify({
            ...clientForm,
            monthlyFeeCents: Math.round(Number(clientForm.monthlyFee) * 100),
            vatRate: Number(clientForm.vatPercent) / 100,
            invoiceDay: 1,
            dueDays: 14,
            reminderDays: [1, 7, 14],
          }),
        },
      );
      setClientForm({
        companyName: "",
        registryCode: "",
        billingEmail: "",
        monthlyFee: "99",
        automaticSending: true,
        language: "et" as "et" | "fi" | "en",
        country: "EE" as "EE" | "FI" | "OTHER",
        vatPercent: "24",
      });
      setEditingClientId(null);
      await loadAll(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Klienti ei lisatud");
    } finally {
      setBusy(false);
    }
  }

  async function openPdf(
    invoice: Invoice,
    action: "pdf" | "paid" | "credit" = "pdf",
  ) {
    if (action !== "pdf") return invoiceAction(invoice, action);
    setError("");
    try {
      const response = await fetch(
        `${apiUrl}/v1/admin/invoices/${invoice.id}/pdf`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!response.ok)
        throw new Error(
          (await response.json()).message ?? "PDF-i ei saadud luua",
        );
      const objectUrl = URL.createObjectURL(await response.blob());
      window.open(objectUrl, "_blank", "noopener,noreferrer");
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "PDF-i avamine ebaõnnestus",
      );
    }
  }

  function editClient(client: Client) {
    setEditingClientId(client.id);
    setClientForm({
      companyName: client.companyName,
      registryCode: client.registryCode,
      billingEmail: client.billingEmail,
      monthlyFee: String(client.monthlyFeeCents / 100),
      automaticSending: client.automaticSending,
      language: client.language ?? "et",
      country: client.country ?? "EE",
      vatPercent: String((client.vatRate ?? 0.24) * 100),
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function invoiceAction(invoice: Invoice, action: "paid" | "credit") {
    const reason =
      action === "credit"
        ? window.prompt("Kreeditarve põhjus:", "Arve tühistamine")
        : null;
    if (action === "credit" && !reason) return;
    setBusy(true);
    setError("");
    try {
      await api(
        `/v1/admin/invoices/${invoice.id}/${action === "paid" ? "mark-paid" : "credit"}`,
        token,
        {
          method: "POST",
          body: JSON.stringify(action === "credit" ? { reason } : {}),
        },
      );
      await loadAll(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Toiming ebaõnnestus");
    } finally {
      setBusy(false);
    }
  }

  async function changeClientAccess(client: Client) {
    const restricted = ["RESTRICTED", "MANUALLY_SUSPENDED"].includes(
      client.billingStatus,
    );
    setBusy(true);
    setError("");
    try {
      await api(`/v1/admin/clients/${client.id}/access`, token, {
        method: "POST",
        body: JSON.stringify({
          status: restricted ? "ACTIVE" : "RESTRICTED",
          reason: restricted
            ? "Peakasutaja taastas ligipääsu"
            : "Peakasutaja rakendas piirangu",
        }),
      });
      await loadAll(token);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Ligipääsu ei saanud muuta",
      );
    } finally {
      setBusy(false);
    }
  }

  async function addSite(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      let latitude = siteForm.latitude.trim() ? Number(siteForm.latitude) : Number.NaN;
      let longitude = siteForm.longitude.trim() ? Number(siteForm.longitude) : Number.NaN;
      if ((!Number.isFinite(latitude) || !Number.isFinite(longitude)) && siteForm.address.trim()) {
        const coordinates = await api<{ latitude: number; longitude: number }>(
          `/v1/admin/geocode?address=${encodeURIComponent(siteForm.address.trim())}`,
          token,
        );
        latitude = coordinates.latitude;
        longitude = coordinates.longitude;
      }
      await api(editingSiteId ? `/v1/admin/sites/${editingSiteId}` : "/v1/admin/sites", token, {
        method: editingSiteId ? "PUT" : "POST",
        body: JSON.stringify({
          name: siteForm.name,
          address: siteForm.address,
          latitude,
          longitude,
          radiusMeters: Number(siteForm.radiusMeters),
          clientId: clients[0]?.id,
        }),
      });
      setSiteForm({
        name: "",
        address: "",
        latitude: "",
        longitude: "",
        radiusMeters: "200",
      });
      setEditingSiteId(null);
      await loadAll(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Töömaad ei lisatud");
    } finally {
      setBusy(false);
    }
  }

  async function findSiteAddress() {
    if (!siteForm.address.trim()) return setError("Sisesta esmalt töömaa aadress.");
    setLocatingSite(true);
    setError("");
    try {
      const result = await api<{ latitude: number; longitude: number }>(
        `/v1/admin/geocode?address=${encodeURIComponent(siteForm.address.trim())}`,
        token,
      );
      setSiteForm((current) => ({
        ...current,
        latitude: result.latitude.toFixed(6),
        longitude: result.longitude.toFixed(6),
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Aadressi ei leitud");
    } finally {
      setLocatingSite(false);
    }
  }

  function useCurrentSiteLocation() {
    if (!navigator.geolocation) return setError("Brauser ei toeta asukoha määramist.");
    setLocatingSite(true);
    setError("");
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        setSiteForm((current) => ({
          ...current,
          latitude: coords.latitude.toFixed(6),
          longitude: coords.longitude.toFixed(6),
        }));
        setLocatingSite(false);
      },
      () => {
        setError("Asukohta ei saadud. Luba brauseris asukoha kasutamine ja proovi uuesti.");
        setLocatingSite(false);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  }

  function editSite(site: Site) {
    setEditingSiteId(site.id);
    setSiteForm({
      name: site.name,
      address: site.address,
      latitude: site.latitude.toFixed(6),
      longitude: site.longitude.toFixed(6),
      radiusMeters: String(site.radiusMeters),
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function cancelSiteEdit() {
    setEditingSiteId(null);
    setSiteForm({ name: "", address: "", latitude: "", longitude: "", radiusMeters: "200" });
    setError("");
  }

  async function removeSite(site: Site) {
    const messages = {
      et: `Kas eemaldada töömaa „${site.name}”? Varasemad tööajaandmed säilivad.`,
      fi: `Poistetaanko työmaa ”${site.name}”? Aiemmat työaikatiedot säilyvät.`,
      en: `Remove the site “${site.name}”? Previous timesheet data will be retained.`,
    };
    if (!window.confirm(messages[language])) return;
    setBusy(true);
    setError("");
    try {
      await api(`/v1/admin/sites/${site.id}`, token, { method: "DELETE" });
      if (editingSiteId === site.id) cancelSiteEdit();
      await loadAll(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Töömaad ei saanud eemaldada");
    } finally {
      setBusy(false);
    }
  }

  async function addEntrance(siteId: string) {
    const name = entranceNames[siteId]?.trim();
    if (!name) return;
    setBusy(true);
    setError("");
    try {
      await api(`/v1/admin/sites/${siteId}/entrances`, token, {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      setEntranceNames({ ...entranceNames, [siteId]: "" });
      await loadAll(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sissepääsu ei lisatud");
    } finally {
      setBusy(false);
    }
  }

  async function openQrSheet(entrance: Entrance) {
    setError("");
    try {
      const response = await fetch(
        `${apiUrl}/v1/admin/entrances/${entrance.id}/qr-sheet.pdf?lang=${language}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!response.ok)
        throw new Error(
          (await response.json()).message ?? "QR-lehte ei saadud luua",
        );
      const objectUrl = URL.createObjectURL(await response.blob());
      window.open(objectUrl, "_blank", "noopener,noreferrer");
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "QR-lehe avamine ebaõnnestus",
      );
    }
  }

  async function openPresenceList(site: Site) {
    setError("");
    try {
      const response = await fetch(`${apiUrl}/v1/admin/sites/${site.id}/presence-list.pdf`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error((await response.json()).message ?? "Nimekirja ei saadud luua");
      const objectUrl = URL.createObjectURL(await response.blob());
      window.open(objectUrl, "_blank", "noopener,noreferrer");
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Nimekirja avamine ebaõnnestus");
    }
  }

  async function rotateQr(entrance: Entrance) {
    if (
      !window.confirm(
        `Uuendada sissepääsu „${entrance.name}” QR-koodid? Vanad koodid lõpetavad kohe töötamise.`,
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      await api(`/v1/admin/entrances/${entrance.id}/rotate-qr`, token, {
        method: "POST",
        body: "{}",
      });
      await loadAll(token);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "QR-koode ei saanud uuendada",
      );
    } finally {
      setBusy(false);
    }
  }

  async function addWorker(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/v1/admin/workers", token, {
        method: "POST",
        body: JSON.stringify({
          clientId: workerForm.clientId,
          name: workerForm.name,
          phone: workerForm.phone,
          jobTitle: workerForm.jobTitle,
          assignedSiteIds: workerForm.siteId ? [workerForm.siteId] : [],
        }),
      });
      setWorkerForm({
        ...workerForm,
        name: "",
        phone: "",
        jobTitle: "",
        siteId: "",
      });
      await loadAll(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Töötajat ei lisatud");
    } finally {
      setBusy(false);
    }
  }

  async function updateWorker(worker: Worker, changes: Partial<Worker>) {
    setBusy(true);
    setError("");
    try {
      await api(`/v1/admin/workers/${worker.id}`, token, {
        method: "PUT",
        body: JSON.stringify(changes),
      });
      await loadAll(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Töötajat ei saanud muuta");
    } finally {
      setBusy(false);
    }
  }

  async function removeWorker(worker: Worker) {
    const messages = {
      et: `Kas eemaldada töötaja „${worker.name}”? Tema varasem tunnileht säilib.`,
      fi: `Poistetaanko työntekijä ”${worker.name}”? Hänen aiempi työaikakirjanpitonsa säilyy.`,
      en: `Remove the worker “${worker.name}”? Their previous timesheet data will be retained.`,
    };
    if (!window.confirm(messages[language])) return;
    setBusy(true);
    setError("");
    try {
      await api(`/v1/admin/workers/${worker.id}`, token, { method: "DELETE" });
      await loadAll(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Töötajat ei saanud eemaldada");
    } finally {
      setBusy(false);
    }
  }

  async function resetWorkerPin(worker: Worker) {
    if (
      !window.confirm(
        `Lähtestada töötaja „${worker.name}” PIN? Kõik tema sessioonid suletakse.`,
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      await api(`/v1/admin/workers/${worker.id}/reset-pin`, token, {
        method: "POST",
        body: "{}",
      });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "PIN-i ei saanud lähtestada",
      );
    } finally {
      setBusy(false);
    }
  }

  async function exportWorkerData(worker: Worker) {
    setError("");
    try {
      const data = await api<Record<string, unknown>>(
        `/v1/admin/workers/${worker.id}/personal-data-export`,
        token,
      );
      const objectUrl = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
      );
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = `tootaja-andmed-${worker.id}.json`;
      link.click();
      URL.revokeObjectURL(objectUrl);
      await loadAll(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Andmeid ei saanud eksportida");
    }
  }

  async function anonymizeWorker(worker: Worker) {
    const confirmation = window.prompt(
      `See eemaldab pöördumatult töötaja „${worker.name}” isikuandmed ja sulgeb konto. Kinnitamiseks kirjuta ANONÜÜMI.`,
      "",
    );
    if (confirmation !== "ANONÜÜMI") return;
    setBusy(true);
    setError("");
    try {
      await api(`/v1/admin/workers/${worker.id}/anonymize`, token, {
        method: "POST",
        body: "{}",
      });
      await loadAll(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Töötajat ei saanud anonüümseks muuta");
    } finally {
      setBusy(false);
    }
  }

  async function addManager(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/v1/admin/managers", token, { method: "POST", body: JSON.stringify(managerForm) });
      setManagerForm({ clientId: managerForm.clientId, name: "", email: "", title: "Meister", password: "" });
      await loadAll(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kasutajat ei saanud lisada");
    } finally { setBusy(false); }
  }

  async function changeManagerStatus(manager: Manager) {
    setBusy(true);
    try {
      await api(`/v1/admin/managers/${manager.id}/status`, token, { method: "POST", body: JSON.stringify({ active: !manager.active }) });
      await loadAll(token);
    } catch (err) { setError(err instanceof Error ? err.message : "Konto olekut ei saanud muuta"); }
    finally { setBusy(false); }
  }

  async function resetManagerPassword(manager: Manager) {
    if (!window.confirm(`Lähtestada kasutaja „${manager.name}” parool ja sulgeda tema sessioonid?`)) return;
    try {
      const result = await api<{ temporaryPassword: string }>(`/v1/admin/managers/${manager.id}/reset-password`, token, { method: "POST", body: "{}" });
      window.alert(`Ajutine parool: ${result.temporaryPassword}\nSalvesta see turvaliselt — parooli hiljem enam ei näidata.`);
      await loadAll(token);
    } catch (err) { setError(err instanceof Error ? err.message : "Parooli ei saanud lähtestada"); }
  }

  async function decideCorrection(
    correction: CorrectionRequest,
    status: "APPROVED" | "REJECTED",
  ) {
    const decisionNote = window.prompt(
      status === "APPROVED" ? "Kinnituse märkus (valikuline):" : "Tagasilükkamise põhjus:",
      "",
    );
    if (decisionNote === null) return;
    setBusy(true);
    setError("");
    try {
      await api(`/v1/admin/correction-requests/${correction.id}/decision`, token, {
        method: "POST",
        body: JSON.stringify({ decision: status, note: decisionNote }),
      });
      await loadAll(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Otsust ei saanud salvestada");
    } finally {
      setBusy(false);
    }
  }

  function reportQuery() {
    return new URLSearchParams(reportFilters).toString();
  }

  async function loadAttendanceReport() {
    setBusy(true);
    setError("");
    try {
      setAttendanceRows(
        await api<AttendanceRow[]>(
          `/v1/admin/attendance-report?${reportQuery()}`,
          token,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Aruannet ei saanud laadida");
    } finally {
      setBusy(false);
    }
  }

  async function downloadAttendanceCsv() {
    setError("");
    try {
      const response = await fetch(
        `${apiUrl}/v1/admin/attendance-report.csv?${reportQuery()}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!response.ok) throw new Error("CSV eksport ebaõnnestus");
      const objectUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = `tooaja-aruanne-${reportFilters.from}-${reportFilters.to}.csv`;
      link.click();
      URL.revokeObjectURL(objectUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "CSV eksport ebaõnnestus");
    }
  }

  const totals = useMemo(
    () => ({
      billed: invoices.reduce((sum, invoice) => sum + invoice.totalCents, 0),
      overdue: invoices
        .filter((invoice) => invoice.status === "OVERDUE")
        .reduce((sum, invoice) => sum + invoice.totalCents, 0),
    }),
    [invoices],
  );
  const filteredAuditLogs = useMemo(() => {
    const query = auditFilter.trim().toLocaleLowerCase("et");
    if (!query) return auditLogs;
    return auditLogs.filter((row) =>
      `${auditActionLabel(row.action)} ${row.action} ${row.userId} ${row.entityType} ${row.entityId} ${JSON.stringify(row.details)}`
        .toLocaleLowerCase("et")
        .includes(query),
    );
  }, [auditFilter, auditLogs]);

  if (!token)
    return (
      <main className="login-shell">
        <form
          className="login-card"
          onSubmit={challengeId ? verifyLogin : login}
        >
          <img className="logo" src="/siteclock-icon.png" alt="SiteClock" />
          <h1>SiteClock</h1>
          <p>{t("adminCenter")}</p>
          <LanguagePicker language={language} onChange={changeLanguage} label={t("language")} />
          {!challengeId ? (
            <>
              <label>
                {t("email")}
                <input
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  type="email"
                  required
                />
              </label>
              <label>
                {t("password")}
                <input
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  type="password"
                  required
                />
              </label>
            </>
          ) : (
            <>
              <p>{t("codeHelp")}</p>
              <label>
                {t("verificationCode")}
                <input
                  value={verificationCode}
                  onChange={(e) => setVerificationCode(e.target.value)}
                  inputMode="numeric"
                  maxLength={6}
                  required
                />
              </label>
              {developmentCode && (
                <div className="dev-code">
                  {t("testCode")}: <strong>{developmentCode}</strong>
                </div>
              )}
              <button
                type="button"
                className="back-button"
                onClick={() => {
                  setChallengeId("");
                  setVerificationCode("");
                }}
              >
                {t("back")}
              </button>
            </>
          )}
          {error && <div className="error">{error}</div>}
          <button disabled={busy}>
            {busy ? t("checking") : challengeId ? t("verifyEnter") : t("continue")}
          </button>
        </form>
      </main>
    );

  if (mustChangePassword)
    return (
      <main className="login-shell">
        <form className="login-card" onSubmit={changeOwnPassword}>
          <img className="logo" src="/siteclock-icon.png" alt="SiteClock" />
          <h1>{t("setPassword")}</h1>
          <p>{t("temporaryPassword")}</p>
          <LanguagePicker language={language} onChange={changeLanguage} label={t("language")} />
          <label>{t("newPassword")}<input type="password" minLength={10} required value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></label>
          <label>{t("repeatPassword")}<input type="password" minLength={10} required value={newPasswordAgain} onChange={(event) => setNewPasswordAgain(event.target.value)} /></label>
          {error && <div className="error">{error}</div>}
          <button disabled={busy}>{busy ? t("saving") : t("changeContinue")}</button>
        </form>
      </main>
    );

  return (
    <div className="app-shell">
      <aside>
        <div className="aside-brand">
          <img className="logo" src="/siteclock-icon.png" alt="SiteClock" />
          <div>
            <strong>SiteClock</strong>
            <span>{sessionRole === "admin" ? t("admin") : t("manager")}</span>
          </div>
        </div>
        <nav>
          {[
            ["overview", t("overview")],
            ["presence", t("presence")],
            ["clients", t("clients")],
            ["workers", t("workers")],
            ["managers", t("managers")],
            ["sites", t("sites")],
            ["corrections", t("corrections")],
            ["reports", t("reports")],
            ["invoices", t("invoices")],
            ["outbox", t("outbox")],
            ["audit", t("audit")],
          ]
            .filter(([id]) =>
              sessionRole === "admin"
                ? true
                : ["overview", "presence", "workers", "sites", "corrections", "reports"].includes(id),
            )
            .map(([id, label]) => (
            <button
              key={id}
              className={tab === id ? "active" : ""}
              onClick={() => setTab(id as typeof tab)}
            >
              {label}
            </button>
          ))}
        </nav>
        <button className="logout" onClick={logoutAdmin}>
          {t("logout")}
        </button>
        <LanguagePicker language={language} onChange={changeLanguage} label={t("language")} compact />
      </aside>
      <main className="content">
        <header>
          <div>
            <h1>
              {tab === "overview"
                ? sessionRole === "admin" ? t("helloAdmin") : t("helloManager")
                : {
                    clients: t("clients"),
                    presence: t("presence"),
                    workers: t("workers"),
                    managers: t("managers"),
                    sites: t("sitesEntrances"),
                    corrections: t("corrections"),
                    reports: t("reports"),
                    invoices: t("invoices"),
                    outbox: t("outbox"),
                    audit: t("audit"),
                  }[tab]}
            </h1>
            <p>{new Intl.DateTimeFormat(language === "fi" ? "fi-FI" : language === "en" ? "en-GB" : "et-EE", { dateStyle: "long" }).format(new Date())}</p>
          </div>
          <button className="refresh" onClick={() => loadAll(token)}>
            {t("refreshData")}
          </button>
        </header>
        {error && <div className="error">{error}</div>}
        {tab === "overview" && sessionRole === "admin" && (
          <>
            <section className="stats">
              <Stat label={t("activeClients")} value={String(clients.length)} />
              <Stat label={t("currentlyOnSite")} value={String(presence.length)} />
              <Stat label={t("totalInvoices")} value={euro(totals.billed)} />
              <Stat
                label={t("overdue")}
                value={euro(totals.overdue)}
                warning={totals.overdue > 0}
              />
              <Stat label={t("queued")} value={String(outbox.length)} />
              <Stat
                label={t("pendingCorrections")}
                value={String(corrections.filter((row) => row.status === "PENDING").length)}
                warning={corrections.some((row) => row.status === "PENDING")}
              />
            </section>
            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>Arvelduse automaatika</h2>
                  <p>Testtoimingud ei saada päris e-kirju.</p>
                </div>
              </div>
              <div className="automation">
                <button
                  disabled={busy}
                  onClick={() =>
                    runBilling("/v1/admin/billing/generate", `${localDateValue().slice(0, 8)}01`)
                  }
                >
                  Koosta jooksva kuu arved
                </button>
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    runBilling("/v1/admin/billing/reminders/run", localDateValue())
                  }
                >
                  Kontrolli meeldetuletusi
                </button>
              </div>
            </section>
            <InvoiceTable rows={invoices.slice(0, 5)} onPdf={openPdf} />
          </>
        )}
        {tab === "overview" && sessionRole === "manager" && (
          <>
            <section className="stats">
              <Stat label={t("mySites")} value={String(sites.length)} />
              <Stat label={t("workers")} value={String(workers.length)} />
              <Stat label={t("currentlyOnSite")} value={String(presence.length)} />
              <Stat label={t("pendingCorrections")} value={String(corrections.filter((row) => row.status === "PENDING").length)} warning={corrections.some((row) => row.status === "PENDING")} />
            </section>
            <section className="panel">
              <div className="panel-head"><div><h2>Minu ettevõtte töömaad</h2><p>Nähtavad on ainult sinu kliendiettevõtte andmed.</p></div></div>
              {sites.length === 0 ? <Empty text="Töömaid ei ole" /> : <div className="table-wrap"><table><thead><tr><th>Töömaa</th><th>Aadress</th><th>Sissepääse</th><th>Olek</th></tr></thead><tbody>{sites.map((site) => <tr key={site.id}><td><strong>{site.name}</strong></td><td>{site.address}</td><td>{site.entrances.length}</td><td><span className={`pill ${site.active ? "paid" : "overdue"}`}>{site.active ? "Aktiivne" : "Suletud"}</span></td></tr>)}</tbody></table></div>}
            </section>
          </>
        )}
        {tab === "presence" && (
          <>
            <section className="stats">
              <Stat label={t("workersInside")} value={String(presence.length)} />
              <Stat label={t("activeSites")} value={String(new Set(presence.map((row) => row.siteId)).size)} />
              <Stat label={t("longShiftWarnings")} value={String(presence.filter((row) => row.longShiftWarning).length)} warning={presence.some((row) => row.longShiftWarning)} />
            </section>
            <section className="panel">
              <div className="panel-head">
                <div><h2>{t("currentlyRegistered")}</h2><p>{t("presenceHelp")}</p></div>
                <button disabled={busy} onClick={() => loadAll(token)}>{t("refresh")}</button>
              </div>
              {presence.length === 0 ? <Empty text={t("nobodyOnSite")} detail={language === "fi" ? "Tiedot näkyvät täällä kirjauksen jälkeen." : language === "en" ? "Data will appear here after registration." : undefined} /> : (
                <div className="table-wrap"><table><thead><tr><th>{t("worker")}</th><th>{t("phone")}</th><th>{t("site")}</th><th>{t("arrived")}</th><th>{t("duration")}</th><th>{t("status")}</th></tr></thead><tbody>
                  {presence.map((row) => <tr key={`${row.userId}-${row.siteId}`}><td><strong>{row.workerName}</strong></td><td>{row.phone}</td><td>{row.siteName}</td><td>{row.time}</td><td>{Math.floor(row.durationMinutes / 60)} h {row.durationMinutes % 60} min</td><td><span className={`pill ${row.longShiftWarning ? "overdue" : "paid"}`}>{row.longShiftWarning ? t("checkShift") : t("onSite")}</span></td></tr>)}
                </tbody></table></div>
              )}
            </section>
          </>
        )}
        {tab === "clients" && (
          <>
            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>{editingClientId ? a("Muuda klienti") : a("Lisa klient")}</h2>
                  <p>{a("Arvelduse põhiseaded")}</p>
                </div>
                {editingClientId && (
                  <button
                    onClick={() => {
                      setEditingClientId(null);
                      setClientForm({
                        companyName: "",
                        registryCode: "",
                        billingEmail: "",
                        monthlyFee: "99",
                        automaticSending: true,
                        language: "et" as "et" | "fi" | "en",
                        country: "EE" as "EE" | "FI" | "OTHER",
                        vatPercent: "24",
                      });
                    }}
                  >
                    {a("Tühista muutmine")}
                  </button>
                )}
              </div>
              <form className="client-form" onSubmit={addClient}>
                <label>
                  {a("Ettevõtte nimi")}
                  <input
                    required
                    value={clientForm.companyName}
                    onChange={(e) =>
                      setClientForm({
                        ...clientForm,
                        companyName: e.target.value,
                      })
                    }
                  />
                </label>
                <label>
                  {a("Registrikood")}
                  <input
                    required
                    value={clientForm.registryCode}
                    onChange={(e) =>
                      setClientForm({
                        ...clientForm,
                        registryCode: e.target.value,
                      })
                    }
                  />
                </label>
                <label>
                  {a("Arve e-post")}
                  <input
                    required
                    type="email"
                    value={clientForm.billingEmail}
                    onChange={(e) =>
                      setClientForm({
                        ...clientForm,
                        billingEmail: e.target.value,
                      })
                    }
                  />
                </label>
                <label>
                  {language === "fi" ? "Maa" : language === "en" ? "Country" : "Riik"}
                  <select value={clientForm.country} onChange={(event) => { const country = event.target.value as "EE" | "FI" | "OTHER"; setClientForm({ ...clientForm, country, vatPercent: country === "FI" ? "25.5" : country === "EE" ? "24" : clientForm.vatPercent }); }}>
                    <option value="EE">Eesti</option>
                    <option value="FI">Suomi</option>
                    <option value="OTHER">{language === "fi" ? "Muu" : language === "en" ? "Other" : "Muu"}</option>
                  </select>
                </label>
                <label>
                  {language === "fi" ? "ALV %" : language === "en" ? "VAT %" : "Käibemaks %"}
                  <input required type="number" min="0" max="100" step="0.1" value={clientForm.vatPercent} onChange={(event) => setClientForm({ ...clientForm, vatPercent: event.target.value })} />
                </label>
                <label>
                  {language === "fi" ? "Viestintäkieli" : language === "en" ? "Communication language" : "Suhtluskeel"}
                  <select value={clientForm.language} onChange={(event) => setClientForm({ ...clientForm, language: event.target.value as "et" | "fi" | "en" })}>
                    <option value="et">Eesti</option>
                    <option value="fi">Suomi</option>
                    <option value="en">English</option>
                  </select>
                </label>
                <label>
                  {a("Kuutasu ilma KM-ta")}
                  <input
                    required
                    type="number"
                    min="0"
                    step="0.01"
                    value={clientForm.monthlyFee}
                    onChange={(e) =>
                      setClientForm({
                        ...clientForm,
                        monthlyFee: e.target.value,
                      })
                    }
                  />
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={clientForm.automaticSending}
                    onChange={(e) =>
                      setClientForm({
                        ...clientForm,
                        automaticSending: e.target.checked,
                      })
                    }
                  />{" "}
                  {a("Saada arved automaatselt")}
                </label>
                <button disabled={busy}>
                  {busy
                    ? u("Salvestan…")
                    : editingClientId
                      ? a("Salvesta muudatused")
                      : a("Salvesta klient")}
                </button>
              </form>
            </section>
            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>{t("clients")}</h2>
                  <p>{a("Arvelduse ja automaatse saatmise seaded")}</p>
                </div>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{u("Ettevõte")}</th>
                      <th>{a("Registrikood")}</th>
                      <th>{a("Arve e-post")}</th>
                      <th>{language === "fi" ? "Kieli" : language === "en" ? "Language" : "Keel"}</th>
                      <th>{a("Kuutasu")}</th>
                      <th>{language === "fi" ? "ALV" : language === "en" ? "VAT" : "KM"}</th>
                      <th>{a("Saatmine")}</th>
                      <th>{a("Konto olek")}</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {clients.map((client) => (
                      <tr key={client.id}>
                        <td>
                          <strong>{client.companyName}</strong>
                        </td>
                        <td>{client.registryCode}</td>
                        <td>{client.billingEmail}</td>
                        <td>{client.language?.toUpperCase() ?? "ET"}</td>
                        <td>{euro(client.monthlyFeeCents)}</td>
                        <td>{((client.vatRate ?? 0.24) * 100).toLocaleString(language === "fi" ? "fi-FI" : language === "en" ? "en-GB" : "et-EE")}%</td>
                        <td>
                          <span className="pill sent">
                            {client.automaticSending
                              ? a("Automaatne")
                              : a("Kinnitusega")}
                          </span>
                        </td>
                        <td>
                          <span
                            className={`pill ${client.billingStatus === "ACTIVE" ? "paid" : "overdue"}`}
                          >
                            {client.billingStatus === "ACTIVE"
                              ? u("Aktiivne")
                              : client.billingStatus === "RESTRICTED"
                                ? a("Piiratud kasutus")
                                : client.billingStatus === "WARNING"
                                  ? a("Maksehoiatus")
                                  : a("Käsitsi peatatud")}
                          </span>
                        </td>
                        <td>
                          <div className="row-actions">
                            <button
                              className="table-action"
                              onClick={() => editClient(client)}
                            >
                              {a("Muuda")}
                            </button>
                            <button
                              className="table-action"
                              disabled={busy}
                              onClick={() => changeClientAccess(client)}
                            >
                              {client.billingStatus === "ACTIVE"
                                ? a("Piira")
                                : a("Taasta")}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
        {tab === "managers" && (
          <>
            <section className="panel"><div className="panel-head"><div><h2>{a("Lisa meister või projektijuht")}</h2><p>{a("Konto näeb ainult valitud kliendi tööandmeid.")}</p></div></div>
              <form className="worker-form" onSubmit={addManager}>
                <label>{u("Klient")}<select required value={managerForm.clientId} onChange={(event) => setManagerForm({ ...managerForm, clientId: event.target.value })}><option value="">{u("Vali klient")}</option>{clients.map((client) => <option key={client.id} value={client.id}>{client.companyName}</option>)}</select></label>
                <label>{u("Nimi")}<input required value={managerForm.name} onChange={(event) => setManagerForm({ ...managerForm, name: event.target.value })} /></label>
                <label>{t("email")}<input required type="email" value={managerForm.email} onChange={(event) => setManagerForm({ ...managerForm, email: event.target.value })} /></label>
                <label>{a("Rollinimetus")}<select value={managerForm.title} onChange={(event) => setManagerForm({ ...managerForm, title: event.target.value })}><option value="Meister">{a("Meister")}</option><option value="Projektijuht">{a("Projektijuht")}</option></select></label>
                <label>{a("Esialgne parool")}<input required minLength={8} type="password" value={managerForm.password} onChange={(event) => setManagerForm({ ...managerForm, password: event.target.value })} /></label>
                <button disabled={busy}>{a("Loo kasutajakonto")}</button>
              </form>
            </section>
            <section className="panel"><div className="panel-head"><div><h2>{a("Kasutajakontod")}</h2><p>{managers.length} {a("meistrit või projektijuhti")}</p></div></div>
              <div className="table-wrap"><table><thead><tr><th>{u("Nimi")}</th><th>{a("Roll")}</th><th>{t("email")}</th><th>{u("Klient")}</th><th>{u("Olek")}</th><th>{u("Toimingud")}</th></tr></thead><tbody>{managers.map((manager) => <tr key={manager.id}><td><strong>{manager.name}</strong></td><td>{manager.title === "Meister" ? a("Meister") : manager.title === "Projektijuht" ? a("Projektijuht") : manager.title}</td><td>{manager.email}</td><td>{manager.clientName}</td><td><span className={`pill ${manager.active ? "paid" : "overdue"}`}>{manager.active ? u("Aktiivne") : u("Peatatud")}</span></td><td><div className="row-actions"><button className="table-action" disabled={busy} onClick={() => changeManagerStatus(manager)}>{manager.active ? a("Peata konto") : u("Aktiveeri")}</button><button className="table-action" disabled={busy} onClick={() => resetManagerPassword(manager)}>{a("Lähtesta parool")}</button></div></td></tr>)}</tbody></table></div>
            </section>
          </>
        )}
        {tab === "workers" && (
          <>
            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>{u("Lisa töötaja")}</h2>
                  <p>
                    {u("Töötaja seotakse veebirakenduses oleva ettevõtte ja töömaaga")}
                  </p>
                </div>
              </div>
              <form className="worker-form" onSubmit={addWorker}>
                <label>
                  {u("Klient")}
                  <select
                    required
                    value={workerForm.clientId}
                    onChange={(e) =>
                      setWorkerForm({
                        ...workerForm,
                        clientId: e.target.value,
                        siteId: "",
                      })
                    }
                  >
                    <option value="">{u("Vali klient")}</option>
                    {clients.map((client) => (
                      <option key={client.id} value={client.id}>
                        {client.companyName}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {u("Nimi")}
                  <input
                    required
                    value={workerForm.name}
                    onChange={(e) =>
                      setWorkerForm({ ...workerForm, name: e.target.value })
                    }
                  />
                </label>
                <label>
                  {t("phone")}
                  <input
                    required
                    value={workerForm.phone}
                    onChange={(e) =>
                      setWorkerForm({ ...workerForm, phone: e.target.value })
                    }
                  />
                </label>
                <label>
                  {u("Amet")}
                  <input
                    value={workerForm.jobTitle}
                    onChange={(e) =>
                      setWorkerForm({ ...workerForm, jobTitle: e.target.value })
                    }
                  />
                </label>
                <label>
                  {t("site")}
                  <select
                    value={workerForm.siteId}
                    onChange={(e) =>
                      setWorkerForm({ ...workerForm, siteId: e.target.value })
                    }
                  >
                    <option value="">{u("Kõik töömaad")}</option>
                    {sites
                      .filter((site) => site.clientId === workerForm.clientId)
                      .map((site) => (
                        <option key={site.id} value={site.id}>
                          {site.name}
                        </option>
                      ))}
                  </select>
                </label>
                <button disabled={busy}>
                  {busy ? u("Salvestan…") : u("Lisa töötaja")}
                </button>
              </form>
            </section>
            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>{t("workers")}</h2>
                  <p>{workers.length} {u("kasutajat")}</p>
                </div>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{u("Nimi")}</th>
                      <th>{t("phone")}</th>
                      <th>{u("Amet")}</th>
                      <th>{u("Ettevõte")}</th>
                      <th>{t("site")}</th>
                      <th>{u("Olek")}</th>
                      <th>{u("Toimingud")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {workers.map((worker) => (
                      <tr key={worker.id}>
                        <td>
                          <strong>{worker.name}</strong>
                        </td>
                        <td>{worker.phone}</td>
                        <td>{worker.jobTitle || "-"}</td>
                        <td>{worker.companyName}</td>
                        <td>
                          {worker.assignedSiteIds?.length
                            ? worker.assignedSiteIds
                                .map(
                                  (id) =>
                                    sites.find((site) => site.id === id)?.name,
                                )
                                .filter(Boolean)
                                .join(", ")
                            : u("Kõik")}
                        </td>
                        <td>
                          <span
                            className={`pill ${worker.active ? "paid" : "overdue"}`}
                          >
                            {worker.active ? u("Aktiivne") : u("Peatatud")}
                          </span>
                        </td>
                        <td>
                          <div className="row-actions">
                            <button
                              className="table-action"
                              disabled={busy}
                              onClick={() =>
                                updateWorker(worker, { active: !worker.active })
                              }
                            >
                              {worker.active ? u("Peata") : u("Aktiveeri")}
                            </button>
                            <button
                              className="table-action"
                              disabled={busy}
                              onClick={() => resetWorkerPin(worker)}
                            >
                              {u("Lähtesta PIN")}
                            </button>
                            <button className="table-action" disabled={busy} onClick={() => exportWorkerData(worker)}>{u("Ekspordi andmed")}</button>
                            <button className="table-action danger" disabled={busy} onClick={() => removeWorker(worker)}>{u("Eemalda töötaja")}</button>
                            {sessionRole === "admin" && !worker.name.startsWith("Anonüümne töötaja") && <button className="table-action danger" disabled={busy} onClick={() => anonymizeWorker(worker)}>{u("Anonümiseeri")}</button>}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
        {tab === "sites" && (
          <>
            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>{editingSiteId ? u("Muuda töömaad") : u("Lisa töömaa")}</h2>
                  <p>{u("Asukohta kasutatakse QR-registreeringu kontrollimiseks")}</p>
                </div>
              </div>
              <form className="site-form" onSubmit={addSite}>
                <label>
                  {u("Töömaa nimi")}
                  <input
                    required
                    value={siteForm.name}
                    onChange={(e) =>
                      setSiteForm({ ...siteForm, name: e.target.value })
                    }
                  />
                </label>
                <label>
                  {u("Aadress")}
                  <input
                    value={siteForm.address}
                    onChange={(e) =>
                      setSiteForm({ ...siteForm, address: e.target.value })
                    }
                  />
                  <button type="button" className="secondary-action" disabled={locatingSite || !siteForm.address.trim()} onClick={findSiteAddress}>
                    {locatingSite ? u("Otsin asukohta…") : u("Leia aadressi asukoht")}
                  </button>
                </label>
                <label>
                  {u("Laiuskraad")}
                  <input
                    type="number"
                    step="0.000001"
                    value={siteForm.latitude}
                    onChange={(e) =>
                      setSiteForm({ ...siteForm, latitude: e.target.value })
                    }
                  />
                </label>
                <label>
                  {u("Pikkuskraad")}
                  <input
                    type="number"
                    step="0.000001"
                    value={siteForm.longitude}
                    onChange={(e) =>
                      setSiteForm({ ...siteForm, longitude: e.target.value })
                    }
                  />
                  <button type="button" className="secondary-action" disabled={locatingSite} onClick={useCurrentSiteLocation}>
                    {u("Kasuta minu praegust asukohta")}
                  </button>
                </label>
                <label>
                  {u("Lubatud raadius (m)")}
                  <input
                    required
                    type="number"
                    min="20"
                    max="2000"
                    value={siteForm.radiusMeters}
                    onChange={(e) =>
                      setSiteForm({ ...siteForm, radiusMeters: e.target.value })
                    }
                  />
                </label>
                <div className="site-form-actions">
                  <button disabled={busy || locatingSite}>
                    {busy ? u("Salvestan…") : editingSiteId ? u("Salvesta töömaa") : u("Loo töömaa")}
                  </button>
                  {editingSiteId && <button type="button" className="secondary-action" disabled={busy} onClick={cancelSiteEdit}>{u("Tühista muutmine")}</button>}
                </div>
              </form>
            </section>
            <div className="site-grid">
              {sites.length === 0 ? (
                <section className="panel">
                  <Empty text={u("Töömaid pole veel loodud")} detail={language === "fi" ? "Luo ensimmäinen työmaa yllä olevalla lomakkeella." : language === "en" ? "Create the first site using the form above." : undefined} />
                </section>
              ) : (
                sites.map((site) => (
                  <section className="panel site-card" key={site.id}>
                    <div className="panel-head">
                      <div>
                        <h2>{site.name}</h2>
                        <p>
                          {site.address || u("Aadress puudub")} · {u("raadius")}{" "}
                          {site.radiusMeters} m
                        </p>
                      </div>
                      <div className="row-actions"><button className="table-action" disabled={busy} onClick={() => editSite(site)}>{u("Muuda asukohta")}</button><button className="table-action" onClick={() => openPresenceList(site)}>{u("Kohalolijate PDF")}</button><button className="table-action danger" disabled={busy} onClick={() => removeSite(site)}>{u("Eemalda töömaa")}</button><span className="pill paid">{u("Aktiivne")}</span></div>
                    </div>
                    <div className="site-meta">
                      <span>GPS</span>
                      <strong>
                        {site.latitude.toFixed(6)}, {site.longitude.toFixed(6)}
                      </strong>
                    </div>
                    <div className="entrances">
                      <h3>{u("Sissepääsud")}</h3>
                      {site.entrances.length === 0 ? (
                        <p className="muted-copy">{u("Sissepääse pole lisatud.")}</p>
                      ) : (
                        site.entrances.map((entrance) => (
                          <div className="entrance-row" key={entrance.id}>
                            <strong>{entrance.name}</strong>
                            <div className="row-actions">
                              <button
                                className="table-action"
                                onClick={() => openQrSheet(entrance)}
                              >
                                {u("Ava QR-leht")}
                              </button>
                              <button
                                className="table-action danger"
                                disabled={busy}
                                onClick={() => rotateQr(entrance)}
                              >
                                {u("Uuenda koodid")}
                              </button>
                            </div>
                          </div>
                        ))
                      )}
                      <div className="entrance-add">
                        <input
                          placeholder={u("Sissepääsu nimi")}
                          value={entranceNames[site.id] ?? ""}
                          onChange={(e) =>
                            setEntranceNames({
                              ...entranceNames,
                              [site.id]: e.target.value,
                            })
                          }
                        />
                        <button
                          disabled={busy || !entranceNames[site.id]?.trim()}
                          onClick={() => addEntrance(site.id)}
                        >
                          {u("Lisa sissepääs")}
                        </button>
                      </div>
                    </div>
                  </section>
                ))
              )}
            </div>
          </>
        )}
        {tab === "corrections" && (
          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>{t("correctionTitle")}</h2>
                <p>{t("correctionAuditHelp")}</p>
              </div>
            </div>
            {corrections.length === 0 ? (
              <Empty text={t("noCorrections")} detail={language === "fi" ? "Tiedot näkyvät täällä pyynnön lähettämisen jälkeen." : language === "en" ? "Data will appear here after a request is submitted." : undefined} />
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{t("worker")}</th>
                      <th>{t("site")}</th>
                      <th>{t("date")}</th>
                      <th>{t("requestedTime")}</th>
                      <th>{t("reason")}</th>
                      <th>{t("status")}</th>
                      <th>{t("actions")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {corrections.map((correction) => (
                      <tr key={correction.id}>
                        <td><strong>{correction.workerName}</strong></td>
                        <td>{correction.siteName}</td>
                        <td>{correction.date}</td>
                        <td>
                          IN {correction.requestedInTime || "—"}<br />
                          OUT {correction.requestedOutTime || "—"}
                        </td>
                        <td>{correction.reason}</td>
                        <td>
                          <span className={`pill ${correction.status === "APPROVED" ? "paid" : correction.status === "REJECTED" ? "overdue" : "sent"}`}>
                            {correction.status === "PENDING" ? t("pending") : correction.status === "APPROVED" ? t("approved") : t("rejected")}
                          </span>
                          {correction.decisionNote && <small className="decision-note">{correction.decisionNote}</small>}
                        </td>
                        <td>
                          {correction.status === "PENDING" && (
                            <div className="row-actions">
                              <button className="table-action" disabled={busy} onClick={() => decideCorrection(correction, "APPROVED")}>{t("approve")}</button>
                              <button className="table-action danger" disabled={busy} onClick={() => decideCorrection(correction, "REJECTED")}>{t("reject")}</button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}
        {tab === "reports" && (
          <>
            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>{t("createReport")}</h2>
                  <p>{t("reportHelp")}</p>
                </div>
              </div>
              <div className="report-filters">
                <label>
                  {t("start")}
                  <input type="date" value={reportFilters.from} onChange={(event) => setReportFilters({ ...reportFilters, from: event.target.value })} />
                </label>
                <label>
                  {t("end")}
                  <input type="date" value={reportFilters.to} onChange={(event) => setReportFilters({ ...reportFilters, to: event.target.value })} />
                </label>
                <label>
                  {t("site")}
                  <select value={reportFilters.siteId} onChange={(event) => setReportFilters({ ...reportFilters, siteId: event.target.value })}>
                    <option value="">{t("allSites")}</option>
                    {sites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
                  </select>
                </label>
                <button disabled={busy} onClick={loadAttendanceReport}>{t("showReport")}</button>
                <button className="secondary" disabled={busy} onClick={downloadAttendanceCsv}>{t("downloadCsv")}</button>
              </div>
            </section>
            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>{t("workdays")}</h2>
                  <p>{attendanceRows.length} {t("rows")} · {t("total")} {(attendanceRows.reduce((sum, row) => sum + (row.totalMinutes ?? 0), 0) / 60).toFixed(2)} {t("hours")}</p>
                </div>
              </div>
              {attendanceRows.length === 0 ? <Empty text={t("choosePeriod")} detail={language === "fi" ? "Tiedot näkyvät täällä raportin luomisen jälkeen." : language === "en" ? "Data will appear here after the report is created." : undefined} /> : (
                <div className="table-wrap"><table><thead><tr><th>{t("worker")}</th><th>{t("company")}</th><th>{t("site")}</th><th>{t("date")}</th><th>IN</th><th>OUT</th><th>{t("hours")}</th><th>{t("mark")}</th></tr></thead><tbody>
                  {attendanceRows.map((row) => <tr key={`${row.workerId}-${row.date}-${row.siteName}`}><td><strong>{row.workerName}</strong></td><td>{row.companyName}</td><td>{row.siteName}</td><td>{row.date}</td><td>{row.inTime ?? "—"}</td><td>{row.outTime ?? "—"}</td><td>{row.totalMinutes == null ? t("incomplete") : (row.totalMinutes / 60).toFixed(2)}</td><td>{row.corrected && <span className="pill sent">{t("corrected")}</span>}</td></tr>)}
                </tbody></table></div>
              )}
            </section>
          </>
        )}
        {tab === "invoices" && <InvoiceTable rows={invoices} onPdf={openPdf} />}
        {tab === "outbox" && (
          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>Test-väljundkast</h2>
                <p>Päris e-kirju praegu ei saadeta</p>
              </div>
              <button
                disabled={busy}
                onClick={() =>
                  runBilling("/v1/admin/email-outbox/process", "2026-07-18")
                }
              >
                Töötle järjekord
              </button>
            </div>
            {outbox.length === 0 ? (
              <Empty text="Saatmisjärjekord on tühi" />
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Tüüp</th>
                      <th>Saaja</th>
                      <th>Loodud</th>
                      <th>Olek</th>
                    </tr>
                  </thead>
                  <tbody>
                    {outbox.map((item) => (
                      <tr key={item.id}>
                        <td>
                          {item.type === "INVOICE"
                            ? "Arve"
                            : item.type === "CREDIT_NOTE"
                              ? "Kreeditarve"
                              : item.type === "ACCOUNT_RESTRICTED"
                                ? "Konto piirangu teade"
                                : item.type === "ADMIN_LOGIN_CODE"
                                  ? "Peakasutaja kinnituskood"
                                  : item.type === "ACCOUNT_RECOVERY_CODE"
                                    ? "Konto taastamiskood"
                                    : `Meeldetuletus (${item.overdueDays}. päev)`}
                        </td>
                        <td>{item.to}</td>
                        <td>
                          {new Date(item.createdAt).toLocaleString("et-EE")}
                        </td>
                        <td>
                          <span
                            className={`pill ${item.status === "SENT" ? "paid" : item.status === "FAILED" ? "overdue" : "draft"}`}
                          >
                            {item.status === "SENT"
                              ? "Saadetud"
                              : item.status === "FAILED"
                                ? "Ebaõnnestus"
                                : item.status === "RETRY"
                                  ? "Uus katse"
                                  : item.status === "TEST_READY"
                                    ? "Testrežiimis valmis"
                                    : "Järjekorras"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}
        {tab === "audit" && (
          <section className="panel">
            <div className="panel-head">
              <div><h2>Süsteemi auditilogi</h2><p>Muutmatu ajalugu turva- ja haldustoimingutest.</p></div>
              <input className="audit-search" placeholder="Otsi toimingu, kasutaja või põhjuse järgi" value={auditFilter} onChange={(event) => setAuditFilter(event.target.value)} />
            </div>
            {filteredAuditLogs.length === 0 ? <Empty text="Sobivaid auditikirjeid ei leitud" /> : (
              <div className="table-wrap"><table><thead><tr><th>Aeg</th><th>Toiming</th><th>Kasutaja</th><th>Objekt</th><th>Üksikasjad</th></tr></thead><tbody>
                {filteredAuditLogs.map((row) => <tr key={row.id}><td>{new Date(row.createdAt).toLocaleString("et-EE")}</td><td><strong>{auditActionLabel(row.action)}</strong>{row.action === "ATTENDANCE_SCAN_BLOCKED" && <span className="pill overdue audit-alert">Turvahoiatus</span>}</td><td>{row.userId === "admin-1" ? "Peakasutaja" : workers.find((worker) => worker.id === row.userId)?.name ?? row.userId}</td><td>{row.entityType} · {row.entityId}</td><td><code className="audit-details">{Object.keys(row.details).length ? JSON.stringify(row.details) : "—"}</code></td></tr>)}
              </tbody></table></div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}

export default function App() {
  return <AppErrorBoundary><SiteClockApp /></AppErrorBoundary>;
}

function LanguagePicker({ language, onChange, label, compact = false }: { language: WebLanguage; onChange: (language: WebLanguage) => void; label: string; compact?: boolean }) {
  return <div className={`web-language ${compact ? "compact" : ""}`}><span>{label}</span>{(["et", "fi", "en"] as WebLanguage[]).map((code) => <button type="button" key={code} className={language === code ? "selected" : ""} onClick={() => onChange(code)}>{code.toUpperCase()}</button>)}</div>;
}

function Stat({
  label,
  value,
  warning,
}: {
  label: string;
  value: string;
  warning?: boolean;
}) {
  return (
    <div className={`stat ${warning ? "warning" : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
function Empty({ text, detail = "Andmed ilmuvad siia pärast toimingu tegemist." }: { text: string; detail?: string }) {
  return (
    <div className="empty">
      <strong>{text}</strong>
      <span>{detail}</span>
    </div>
  );
}
function InvoiceTable({
  rows,
  onPdf,
}: {
  rows: Invoice[];
  onPdf: (invoice: Invoice, action?: "pdf" | "paid" | "credit") => void;
}) {
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>Arved</h2>
          <p>Viimased koostatud ja saadetud arved</p>
        </div>
      </div>
      {rows.length === 0 ? (
        <Empty text="Arveid pole veel koostatud" />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Arve nr</th>
                <th>Klient</th>
                <th>Kuupäev</th>
                <th>Maksetähtaeg</th>
                <th>Summa</th>
                <th>Olek</th>
                <th>Toimingud</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((invoice) => (
                <tr key={invoice.id}>
                  <td>
                    <strong>{invoice.number}</strong>
                  </td>
                  <td>{invoice.clientName}</td>
                  <td>{invoice.issuedDate}</td>
                  <td>{invoice.dueDate}</td>
                  <td>{euro(invoice.totalCents)}</td>
                  <td>
                    <span className={`pill ${invoice.status.toLowerCase()}`}>
                      {statusLabel(invoice.status)}
                    </span>
                  </td>
                  <td>
                    <div className="row-actions">
                      <button
                        className="table-action"
                        onClick={() => onPdf(invoice)}
                      >
                        PDF
                      </button>
                      {!["PAID", "CREDITED"].includes(invoice.status) &&
                        invoice.documentType !== "CREDIT_NOTE" && (
                          <button
                            className="table-action"
                            onClick={() => onPdf(invoice, "paid")}
                          >
                            Märgi tasutuks
                          </button>
                        )}
                      {invoice.documentType !== "CREDIT_NOTE" &&
                        invoice.status !== "CREDITED" && (
                          <button
                            className="table-action danger"
                            onClick={() => onPdf(invoice, "credit")}
                          >
                            Kreeditarve
                          </button>
                        )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
