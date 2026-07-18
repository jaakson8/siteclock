import nodemailer from "nodemailer";
import { spawn } from "node:child_process";

function pdfBuffer(pythonBin, scriptPath, invoice, client) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin, [scriptPath]);
    const output = [];
    const errors = [];
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(output))
        : reject(
            new Error(
              Buffer.concat(errors).toString("utf8") ||
                "PDF-i loomine ebaõnnestus",
            ),
          ),
    );
    child.stdin.end(
      JSON.stringify({
        ...invoice,
        issuedDate: invoice.issuedDate.split("-").reverse().join("."),
        dueDate: invoice.dueDate.split("-").reverse().join("."),
        seller: {
          name: process.env.SELLER_NAME ?? "Objektiaeg OÜ",
          registryCode: process.env.SELLER_REGISTRY_CODE ?? "14990001",
          email: process.env.MAIL_FROM ?? "arved@objektiaeg.ee",
          iban: process.env.SELLER_IBAN ?? "EE001010010000000001",
        },
        client: {
          name: client.companyName,
          registryCode: client.registryCode,
          email: client.billingEmail,
        },
        language: client.language ?? "et",
      }),
    );
  });
}

export function localizedMailContent(message, invoice, client) {
  const language = client?.language ?? "et";
  if (message.type === "INVOICE")
    return language === "fi" ? {
      subject: `Lasku ${invoice.number}`,
      text: `Hei!\n\nLiitteenä on lasku ${invoice.number}, yhteensä ${(invoice.totalCents / 100).toFixed(2)} EUR. Eräpäivä: ${invoice.dueDate}.\n\nSiteClock`,
    } : language === "en" ? {
      subject: `Invoice ${invoice.number}`,
      text: `Hello,\n\nPlease find attached invoice ${invoice.number} for ${(invoice.totalCents / 100).toFixed(2)} EUR. Due date: ${invoice.dueDate}.\n\nSiteClock`,
    } : {
      subject: `Arve ${invoice.number}`,
      text: `Tere!\n\nManuses on arve ${invoice.number} summas ${(invoice.totalCents / 100).toFixed(2)} EUR. Maksetähtaeg: ${invoice.dueDate}.\n\nSiteClock`,
    };
  if (message.type === "CREDIT_NOTE")
    return language === "fi" ? { subject: `Hyvityslasku ${invoice.number}`, text: `Hei!\n\nLiitteenä on hyvityslasku ${invoice.number}.\n\nSiteClock` } : language === "en" ? { subject: `Credit note ${invoice.number}`, text: `Hello,\n\nPlease find attached credit note ${invoice.number}.\n\nSiteClock` } : {
      subject: `Kreeditarve ${invoice.number}`,
      text: `Tere!\n\nManuses on kreeditarve ${invoice.number}.\n\nSiteClock`,
    };
  if (message.type === "PAYMENT_REMINDER")
    return language === "fi" ? { subject: `Maksumuistutus: lasku ${invoice.number}`, text: `Hei!\n\nLasku ${invoice.number} on ollut erääntyneenä ${message.overdueDays} päivää. Pyydämme maksamaan laskun.\n\nSiteClock` } : language === "en" ? { subject: `Payment reminder: invoice ${invoice.number}`, text: `Hello,\n\nInvoice ${invoice.number} is ${message.overdueDays} days overdue. Please arrange payment.\n\nSiteClock` } : {
      subject: `Meeldetuletus: arve ${invoice.number} on tasumata`,
      text: `Tere!\n\nArve ${invoice.number} maksetähtaeg on möödunud ${message.overdueDays} päeva. Palume arve tasuda.\n\nSiteClock`,
    };
  if (message.type === "ACCOUNT_RESTRICTED")
    return language === "fi" ? { subject: "SiteClock-tili on rajoitetussa käytössä", text: "Hei!\n\nMaksamattoman laskun vuoksi tili on siirretty rajoitetun käytön tilaan. IN/OUT ja työajat toimivat edelleen. Kaikki ominaisuudet palautetaan maksun vahvistamisen jälkeen.\n\nSiteClock" } : language === "en" ? { subject: "SiteClock account has restricted access", text: "Hello,\n\nThe account has been placed in restricted mode due to an unpaid invoice. IN/OUT and timesheets remain available. Full access will be restored after payment is confirmed.\n\nSiteClock" } : {
      subject: "SiteClocki konto on piiratud kasutusega",
      text: "Tere!\n\nTasumata arve tõttu on konto viidud piiratud kasutuse režiimi. IN/OUT ja tunnilehed jätkavad tööd. Täisfunktsionaalsus taastub pärast makse kinnitamist.\n\nSiteClock",
    };
  if (message.type === "ADMIN_LOGIN_CODE")
    return {
      subject: "SiteClocki kinnituskood",
      text: `Sinu peakasutaja sisselogimise kinnituskood on ${message.code}. Kood kehtib 10 minutit.`,
    };
  return null;
}

export function createEmailProcessor({
  outbox,
  invoices,
  clients,
  save,
  moduleDirectory,
}) {
  const smtpConfigured = Boolean(
    process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS,
  );
  const smsConfigured = Boolean(
    process.env.SMS_WEBHOOK_URL && process.env.SMS_WEBHOOK_TOKEN,
  );
  const transport = smtpConfigured
    ? nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT ?? 587),
        secure: process.env.SMTP_SECURE === "true",
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      })
    : null;

  return async function processPendingEmails(now = new Date()) {
    const results = [];
    for (const message of outbox.filter(
      (item) =>
        !["SENT", "PROCESSING"].includes(item.status) &&
        (!item.nextAttemptAt || item.nextAttemptAt <= now.toISOString()),
    )) {
      if (message.type === "ACCOUNT_RECOVERY_CODE") {
        if (!smsConfigured) {
          message.status = "TEST_READY";
          results.push({ id: message.id, status: message.status });
          continue;
        }
        message.status = "PROCESSING";
        try {
          const smsResponse = await fetch(process.env.SMS_WEBHOOK_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${process.env.SMS_WEBHOOK_TOKEN}`,
            },
            body: JSON.stringify({
              to: message.to,
              message: `SiteClocki PIN-i taastamiskood on ${message.code}. Kood kehtib 10 minutit.`,
            }),
          });
          if (!smsResponse.ok)
            throw new Error(`SMS-teenus vastas staatusega ${smsResponse.status}`);
          message.status = "SENT";
          message.sentAt = new Date().toISOString();
          delete message.code;
        } catch (error) {
          message.attempts = (message.attempts ?? 0) + 1;
          message.status = message.attempts >= 5 ? "FAILED" : "RETRY";
          message.lastError = error.message;
          message.nextAttemptAt = new Date(
            Date.now() + Math.min(60, 2 ** message.attempts) * 60_000,
          ).toISOString();
        }
        results.push({ id: message.id, status: message.status });
        continue;
      }
      if (!transport) {
        message.status = "TEST_READY";
        results.push({ id: message.id, status: message.status });
        continue;
      }
      message.status = "PROCESSING";
      try {
        const invoice = invoices.find((item) => item.id === message.invoiceId);
        const client = invoice
          ? clients.find((item) => item.id === invoice.clientId)
          : clients.find((item) => item.id === message.clientId);
        const mailContent = localizedMailContent(message, invoice, client);
        if (!mailContent)
          throw new Error("Selle sõnumitüübi saatja pole seadistatud");
        const attachments =
          invoice && ["INVOICE", "CREDIT_NOTE"].includes(message.type)
            ? [
                {
                  filename: `arve-${invoice.number}.pdf`,
                  content: await pdfBuffer(
                    process.env.PYTHON_BIN ?? "python3",
                    `${moduleDirectory}/generate_invoice.py`,
                    invoice,
                    client,
                  ),
                },
              ]
            : [];
        const info = await transport.sendMail({
          from: process.env.MAIL_FROM ?? process.env.SMTP_USER,
          to: message.to,
          ...mailContent,
          attachments,
        });
        message.status = "SENT";
        message.sentAt = new Date().toISOString();
        message.providerMessageId = info.messageId;
        delete message.code;
      } catch (error) {
        message.attempts = (message.attempts ?? 0) + 1;
        message.status = message.attempts >= 5 ? "FAILED" : "RETRY";
        message.lastError = error.message;
        message.nextAttemptAt = new Date(
          Date.now() + Math.min(60, 2 ** message.attempts) * 60_000,
        ).toISOString();
      }
      results.push({ id: message.id, status: message.status });
    }
    save();
    return results;
  };
}
