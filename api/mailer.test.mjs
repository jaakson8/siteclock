import test from "node:test";
import assert from "node:assert/strict";
import { createEmailProcessor, localizedMailContent } from "./mailer.mjs";

test("arve ja meeldetuletus kasutavad kliendi suhtluskeelt", () => {
  const invoice = { number: "2026-001", totalCents: 12400, dueDate: "2026-08-01" };
  const finnish = localizedMailContent({ type: "INVOICE" }, invoice, { language: "fi" });
  assert.match(finnish.subject, /Lasku/);
  assert.match(finnish.text, /Eräpäivä/);
  const english = localizedMailContent({ type: "PAYMENT_REMINDER", overdueDays: 7 }, invoice, { language: "en" });
  assert.match(english.subject, /Payment reminder/);
  assert.match(english.text, /7 days overdue/);
});

test("PIN-i taastamiskood saadetakse SMS-webhooki kaudu ja eemaldatakse järjekorrast", async () => {
  const previousUrl = process.env.SMS_WEBHOOK_URL;
  const previousToken = process.env.SMS_WEBHOOK_TOKEN;
  const previousFetch = globalThis.fetch;
  process.env.SMS_WEBHOOK_URL = "https://sms.example.test/send";
  process.env.SMS_WEBHOOK_TOKEN = "test-token-123456789";
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200 };
  };
  try {
    const outbox = [{
      id: "sms-1",
      type: "ACCOUNT_RECOVERY_CODE",
      to: "+37255551234",
      code: "176949",
      status: "PENDING",
    }];
    const processMessages = createEmailProcessor({
      outbox,
      invoices: [],
      clients: [],
      save: () => {},
      moduleDirectory: ".",
    });
    const [result] = await processMessages();
    assert.equal(result.status, "SENT");
    assert.equal(request.url, "https://sms.example.test/send");
    assert.equal(request.options.headers.Authorization, "Bearer test-token-123456789");
    assert.deepEqual(JSON.parse(request.options.body), {
      to: "+37255551234",
      message: "SiteClocki PIN-i taastamiskood on 176949. Kood kehtib 10 minutit.",
    });
    assert.equal(outbox[0].code, undefined);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.SMS_WEBHOOK_URL;
    else process.env.SMS_WEBHOOK_URL = previousUrl;
    if (previousToken === undefined) delete process.env.SMS_WEBHOOK_TOKEN;
    else process.env.SMS_WEBHOOK_TOKEN = previousToken;
  }
});
