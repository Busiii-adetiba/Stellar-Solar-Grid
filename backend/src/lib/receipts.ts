import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ReceiptRecord {
  paymentId: string;
  amount: number;
  meterId: string;
  date: string;
  transactionHash: string;
  invoiceNumber: string;
  filePath: string;
}

const storageRoot = process.env.RECEIPTS_STORAGE_PATH ?? join(process.cwd(), "data", "receipts");
const indexPath = join(storageRoot, "index.json");
const records = new Map<string, ReceiptRecord>();
let loaded = false;

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  if (!existsSync(indexPath)) return;
  try {
    const parsed = JSON.parse(readFileSync(indexPath, "utf8")) as ReceiptRecord[];
    for (const record of parsed) records.set(record.paymentId, record);
  } catch {
    // A corrupt index should not prevent payments from being processed.
  }
}

function persist() {
  mkdirSync(storageRoot, { recursive: true });
  writeFileSync(indexPath, JSON.stringify([...records.values()], null, 2));
}

function escapePdfText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** Create a small, dependency-free PDF receipt with a standards-compliant xref table. */
export function createReceiptPdf(record: Omit<ReceiptRecord, "filePath">): Buffer {
  const lines = [
    "SolarGrid Payment Receipt",
    `Invoice number: ${record.invoiceNumber}`,
    `Payment amount: ${record.amount} stroops`,
    `Meter ID: ${record.meterId}`,
    `Date: ${record.date}`,
    `Transaction hash: ${record.transactionHash}`,
  ];
  const stream = ["BT", "/F1 14 Tf", "72 740 Td", ...lines.flatMap((line, i) => [
    i === 0 ? `(${escapePdfText(line)}) Tj` : `0 -24 Td (${escapePdfText(line)}) Tj`,
  ]), "ET"].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "utf8");
}

export function saveReceipt(input: Omit<ReceiptRecord, "invoiceNumber" | "filePath">): ReceiptRecord {
  ensureLoaded();
  const existing = records.get(input.paymentId);
  if (existing) return existing;
  const invoiceNumber = `INV-${Date.parse(input.date) || Date.now()}-${input.transactionHash.slice(0, 8).toUpperCase()}`;
  const record = { ...input, invoiceNumber, filePath: join(storageRoot, `${input.paymentId}.pdf`) };
  mkdirSync(dirname(record.filePath), { recursive: true });
  writeFileSync(record.filePath, createReceiptPdf(record));
  records.set(input.paymentId, record);
  persist();
  return record;
}

export function getReceipt(paymentId: string): ReceiptRecord | undefined {
  ensureLoaded();
  return records.get(paymentId);
}

export function readReceiptPdf(paymentId: string): Buffer | undefined {
  const receipt = getReceipt(paymentId);
  if (!receipt || !existsSync(receipt.filePath)) return undefined;
  return readFileSync(receipt.filePath);
}

export function resetReceiptsForTests() {
  records.clear();
  loaded = true;
}
