import QRCode from "qrcode";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const output = process.argv[2];
if (!output) throw new Error("Anna väljund-PDF-i asukoht");
const [inPng, outPng] = await Promise.all([
  QRCode.toBuffer("objektiaeg://scan?t=sample-in-token", {
    width: 900,
    margin: 2,
    errorCorrectionLevel: "H",
  }),
  QRCode.toBuffer("objektiaeg://scan?t=sample-out-token", {
    width: 900,
    margin: 2,
    errorCorrectionLevel: "H",
  }),
]);
const child = spawn(process.env.PYTHON_BIN ?? "python3", [
  join(moduleDirectory, "generate_qr_sheet.py"),
]);
child.stdout.pipe(createWriteStream(output));
child.stdin.end(
  JSON.stringify({
    siteName: "Kesklinna ehitus",
    gateName: "Peavärav",
    inQrBase64: inPng.toString("base64"),
    outQrBase64: outPng.toString("base64"),
    generatedAt: "18.07.2026",
  }),
);
await new Promise((resolve, reject) =>
  child.on("close", (code) =>
    code === 0
      ? resolve()
      : reject(new Error(`PDF-i loomine lõppes koodiga ${code}`)),
  ),
);
