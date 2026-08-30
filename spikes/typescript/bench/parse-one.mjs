// Parses a single file in an isolated process so hangs/crashes on hostile
// input are observable rather than fatal to the whole benchmark run.
import { readFile } from 'node:fs/promises';
import { STD_FONTS } from './lib.mjs';

const [, , kind, file] = process.argv;

async function parsePdf(p) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(await readFile(p));
  // isEvalSupported:false disables the PDF JS engine (GHSA-hq66-cqwq-w95j class).
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: false,
    standardFontDataUrl: STD_FONTS }).promise;
  let n = 0;
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    n += tc.items.length;
  }
  return n;
}

async function parseDocx(p) {
  const mammoth = (await import('mammoth')).default;
  const r = await mammoth.extractRawText({ buffer: await readFile(p) });
  return r.value.length;
}

async function parseXlsx(p) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(p);
  let n = 0;
  wb.eachSheet((ws) => ws.eachRow(() => n++));
  return n;
}

async function parseCsv(p) {
  const { parse } = await import('csv-parse');
  const { createReadStream } = await import('node:fs');
  let n = 0;
  await new Promise((res, rej) => {
    createReadStream(p).pipe(parse({ relax_column_count: true }))
      .on('data', () => n++).on('end', res).on('error', rej);
  });
  return n;
}

const table = { pdf: parsePdf, docx: parseDocx, xlsx: parseXlsx, csv: parseCsv };

try {
  const units = await table[kind](file);
  process.stdout.write(JSON.stringify({ outcome: 'ok', units }));
} catch (e) {
  process.stdout.write(JSON.stringify({
    outcome: 'clean_error',
    error: e && e.constructor ? e.constructor.name : 'Error',
    message: String(e && e.message || e).slice(0, 200),
  }));
}
