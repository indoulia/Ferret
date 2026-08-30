import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CODE, DOCS, MALFORMED, LARGE, SPIKES, STD_FONTS, emit, stats, timed, walk, sha256 } from './lib.mjs';

const execFileP = promisify(execFile);
const REPO = path.resolve(SPIKES, '..');
const HERE = path.dirname(fileURLToPath(import.meta.url));

const B = {};

// ---- memory: resident set after the core dependency surface is loaded ----
B.memory = async () => {
  const before = process.memoryUsage().rss;
  await Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'), import('mammoth'), import('exceljs'),
    import('csv-parse'), import('pg'), import('web-tree-sitter'),
    import('@modelcontextprotocol/sdk/server/mcp.js'),
  ]);
  const after = process.memoryUsage().rss;
  emit('memory', 'bytes', [after], {
    rss_before_imports: before,
    heap_used: process.memoryUsage().heapUsed,
  });
};

// ---- filesystem scan: walk + read + content hash (the indexing hot path) ----
// Both strategies are measured because a naive sequential `await` badly
// understates the runtime; each runtime is credited with its best result.
B.fsscan = async () => {
  const CH = 64;
  const strategies = {
    sequential: async () => {
      const files = await walk(CODE);
      let bytes = 0;
      for (const f of files) { const b = await readFile(f); bytes += b.length; sha256(b); }
      return { files: files.length, bytes };
    },
    parallel64: async () => {
      const files = await walk(CODE);
      let bytes = 0;
      for (let k = 0; k < files.length; k += CH) {
        const bufs = await Promise.all(files.slice(k, k + CH).map((f) => readFile(f)));
        for (const b of bufs) { bytes += b.length; sha256(b); }
      }
      return { files: files.length, bytes };
    },
  };
  const detail = {};
  let meta;
  for (const [name, fn] of Object.entries(strategies)) {
    const s = [];
    for (let i = 0; i < 5; i++) { const r = await timed(fn); s.push(r.ms); meta = r.meta; }
    detail[name] = { samples: s, ...stats(s) };
  }
  const best = Object.entries(detail).sort((a, b) => a[1].median - b[1].median)[0];
  emit('fsscan', 'ms', detail[best[0]].samples,
    { ...meta, best_strategy: best[0], concurrency: CH, strategies: detail });
};

// ---- concurrent indexing: worker pool hashing the same tree ----
B.concurrency = async () => {
  const files = await walk(CODE);
  const N = 4;
  const chunks = Array.from({ length: N }, (_, i) => files.filter((_, j) => j % N === i));
  const samples = [];
  for (let i = 0; i < 3; i++) {
    const r = await timed(async () => {
      const counts = await Promise.all(chunks.map((c) => new Promise((res, rej) => {
        const w = new Worker(path.join(HERE, 'worker.mjs'), { workerData: { files: c } });
        w.on('message', res);
        w.on('error', rej);
      })));
      return { hashed: counts.reduce((a, b) => a + b, 0) };
    });
    samples.push(r.ms);
  }
  emit('concurrency', 'ms', samples, { files: files.length, workers: N, model: 'worker_threads' });
};

// ---- git: the operations Ferret performs during discovery and ingestion ----
B.git = async () => {
  const samples = [];
  let meta;
  for (let i = 0; i < 10; i++) {
    const r = await timed(async () => {
      const [log, files, status] = await Promise.all([
        execFileP('git', ['-C', REPO, 'log', '--format=%H%x00%an%x00%aI%x00%s', '-n', '200']),
        execFileP('git', ['-C', REPO, 'ls-files']),
        execFileP('git', ['-C', REPO, 'status', '--porcelain']),
      ]);
      return {
        commits: log.stdout.trim().split('\n').filter(Boolean).length,
        tracked: files.stdout.trim().split('\n').filter(Boolean).length,
      };
    });
    samples.push(r.ms);
    meta = r.meta;
  }
  emit('git', 'ms', samples, { ...meta, strategy: 'git executable via child_process' });
};

// ---- document parsing ----
async function parseAll(kind, ext, fn, runs = 3) {
  const files = (await walk(DOCS)).filter((f) => f.endsWith(ext));
  const samples = [];
  let units = 0;
  for (let i = 0; i < runs; i++) {
    const r = await timed(async () => {
      let u = 0;
      for (const f of files) u += await fn(f);
      return u;
    });
    samples.push(r.ms);
    units = r.meta;
  }
  emit(`parse_${kind}`, 'ms', samples, { files: files.length, units });
}

B.pdf = async () => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  await parseAll('pdf', '.pdf', async (p) => {
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(await readFile(p)),
      isEvalSupported: false,
      useSystemFonts: false,
      standardFontDataUrl: STD_FONTS,
    }).promise;
    let n = 0;
    for (let i = 1; i <= doc.numPages; i++) {
      n += (await (await doc.getPage(i)).getTextContent()).items.length;
    }
    return n;
  });
};

B.docx = async () => {
  const mammoth = (await import('mammoth')).default;
  await parseAll('docx', '.docx', async (p) => (
    await mammoth.extractRawText({ buffer: await readFile(p) })).value.length);
};

B.xlsx = async () => {
  const ExcelJS = (await import('exceljs')).default;
  await parseAll('xlsx', '.xlsx', async (p) => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(p);
    let n = 0;
    wb.eachSheet((ws) => ws.eachRow(() => n++));
    return n;
  });
};

B.csv = async () => {
  const { parse } = await import('csv-parse');
  await parseAll('csv', '.csv', (p) => new Promise((res, rej) => {
    let n = 0;
    createReadStream(p).pipe(parse({}))
      .on('data', () => n++)
      .on('end', () => res(n))
      .on('error', rej);
  }));
};

// ---- tree-sitter: symbol extraction over the code tree ----
B.treesitter = async () => {
  const { Parser, Language } = await import('web-tree-sitter');
  await Parser.init();
  const wasmDir = path.join(SPIKES, 'typescript', 'node_modules', 'tree-sitter-wasms', 'out');
  const langs = {
    '.ts': await Language.load(path.join(wasmDir, 'tree-sitter-typescript.wasm')),
    '.js': await Language.load(path.join(wasmDir, 'tree-sitter-javascript.wasm')),
    '.py': await Language.load(path.join(wasmDir, 'tree-sitter-python.wasm')),
  };
  const files = (await walk(CODE)).filter((f) => langs[path.extname(f)]);
  const samples = [];
  let meta;
  for (let i = 0; i < 3; i++) {
    const r = await timed(async () => {
      const parser = new Parser();
      let nodes = 0;
      let parsed = 0;
      for (const f of files) {
        parser.setLanguage(langs[path.extname(f)]);
        const tree = parser.parse(await readFile(f, 'utf8'));
        if (!tree) continue;
        const stack = [tree.rootNode];
        while (stack.length) {
          const n = stack.pop();
          if (n.isNamed) nodes++;
          for (let c = 0; c < n.namedChildCount; c++) stack.push(n.namedChild(c));
        }
        tree.delete();
        parsed++;
      }
      parser.delete();
      return { parsed, named_nodes: nodes };
    });
    samples.push(r.ms);
    meta = r.meta;
  }
  emit('treesitter', 'ms', samples, { ...meta, binding: 'web-tree-sitter (WASM)' });
};

// ---- large single file: streaming behaviour and peak resident memory ----
B.largefile = async () => {
  const { parse } = await import('csv-parse');
  const p = path.join(LARGE, 'large.csv');
  const size = (await stat(p)).size;
  const samples = [];
  let peak = 0;
  let rows = 0;
  for (let i = 0; i < 3; i++) {
    const r = await timed(() => new Promise((res, rej) => {
      let n = 0;
      const t = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 50);
      createReadStream(p).pipe(parse({}))
        .on('data', () => n++)
        .on('end', () => { clearInterval(t); res(n); })
        .on('error', (e) => { clearInterval(t); rej(e); });
    }));
    samples.push(r.ms);
    rows = r.meta;
  }
  emit('largefile_csv', 'ms', samples, {
    bytes: size, rows, peak_rss_bytes: peak, mode: 'streaming',
  });
};

// ---- robustness: hostile/corrupt input, one isolated process per case ----
B.robustness = async () => {
  const manifest = JSON.parse(await readFile(path.join(MALFORMED, 'MALFORMED.json'), 'utf8'));
  const TIMEOUT = 30000;
  const results = [];
  for (const c of manifest.malformed) {
    const file = path.join(MALFORMED, c.file);
    const t = Date.now();
    const res = await new Promise((resolve) => {
      const ch = spawn(process.execPath, [path.join(HERE, 'parse-one.mjs'), c.kind, file],
        { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      const timer = setTimeout(() => { ch.kill('SIGKILL'); resolve({ outcome: 'timeout' }); }, TIMEOUT);
      ch.stdout.on('data', (d) => { out += d; });
      ch.stderr.on('data', (d) => { err += d; });
      ch.on('close', (code) => {
        clearTimeout(timer);
        if (out.trim()) {
          try { return resolve(JSON.parse(out)); } catch { /* fall through to crash */ }
        }
        return resolve({ outcome: 'crash', exit_code: code, stderr: err.slice(-200) });
      });
    });
    results.push({ ...c, ...res, ms: Date.now() - t });
  }
  const tally = results.reduce((a, r) => ({ ...a, [r.outcome]: (a[r.outcome] || 0) + 1 }), {});
  emit('robustness', 'cases', [results.length], { tally, results });
};

// ---- postgres: bulk ingest, FTS index build, FTS query ----
B.postgres = async () => {
  const pg = (await import('pg')).default;
  const client = new pg.Client({ connectionString: process.env.FERRET_PG_URL });
  await client.connect();
  await client.query('DROP TABLE IF EXISTS bench_node');
  await client.query('CREATE TABLE bench_node (id int primary key, name text, body text, tsv tsvector)');
  const ROWS = 50000;
  const rows = Array.from({ length: ROWS }, (_, i) => [i, `name${i}`,
    `ferret evidence provenance row ${i} indexed repository content`]);

  const ins = await timed(async () => {
    const CH = 1000;
    for (let i = 0; i < rows.length; i += CH) {
      const chunk = rows.slice(i, i + CH);
      const vals = chunk.map((_, j) => `($${j * 3 + 1},$${j * 3 + 2},$${j * 3 + 3})`).join(',');
      await client.query(`INSERT INTO bench_node (id,name,body) VALUES ${vals}`, chunk.flat());
    }
    return { rows: ROWS };
  });

  const idx = await timed(async () => {
    await client.query("UPDATE bench_node SET tsv = to_tsvector('english', body)");
    await client.query('CREATE INDEX bench_node_tsv ON bench_node USING gin(tsv)');
    return {};
  });

  const qs = [];
  let hits = 0;
  for (let i = 0; i < 20; i++) {
    const q = await timed(async () => {
      const r = await client.query(
        "SELECT id FROM bench_node WHERE tsv @@ plainto_tsquery('english','provenance evidence') LIMIT 100");
      return r.rowCount;
    });
    qs.push(q.ms);
    hits = q.meta;
  }
  await client.end();
  emit('postgres_insert', 'ms', [ins.ms], { rows: ROWS, driver: 'pg' });
  emit('postgres_index', 'ms', [idx.ms], { rows: ROWS, driver: 'pg' });
  emit('postgres_fts_query', 'ms', qs, { hits, driver: 'pg' });
};

const which = process.argv[2];
if (!B[which]) {
  console.error(`unknown benchmark: ${which}; have: ${Object.keys(B).join(',')}`);
  process.exit(2);
}
await B[which]();
