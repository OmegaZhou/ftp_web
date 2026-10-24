// Real HTTP/tus benchmark. Credentials stay in files; reports never contain tokens.
// Example: node scripts/benchmark.mjs --base https://playerzhou.com --credentials <json>
//   --remote-credentials /root/<json> --ssh HostDare-VPS --chunks 4,8,16,32 --size 128 --rounds 1 --output <directory>
// Method: initial 128 MiB sweep, top two 3 x 256 MiB, winner 1 GiB;
// compare median upload throughput; <=10% difference prefers the smaller chunk.
import { readFile, mkdir, writeFile, open, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import assert from 'node:assert/strict';
const execute = promisify(execFile), MiB = 1048576;
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => index % 2 ? pairs : [...pairs, [value.replace(/^--/, ''), all[index + 1]]], []));
const base = new URL(args.base ?? 'http://127.0.0.1:1945');
if (base.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(base.hostname)) throw Error('Remote benchmark requires HTTPS');
const chunks = (args.chunks ?? '4,8,16,32').split(',').map(Number), size = Number(args.size ?? 128) * MiB, rounds = Number(args.rounds ?? 1);
assert(chunks.every(x => Number.isInteger(x) && x >= 1 && x <= 64)); assert(Number.isSafeInteger(size) && size > 0); assert(Number.isInteger(rounds) && rounds > 0);
const baselineCount = Number(args['baseline-count'] ?? 20), baselineInterval = Number(args['baseline-interval'] ?? 0);
assert(Number.isInteger(baselineCount) && baselineCount >= 20 && baselineCount <= 1000);
assert(Number.isInteger(baselineInterval) && baselineInterval >= 0 && baselineInterval <= 10000);
const credentials = JSON.parse(await readFile(args.credentials, 'utf8'));
const output = path.resolve(args.output ?? '.codex/tasks/task_001/benchmark'); await mkdir(output, { recursive: true });
const source = path.resolve(args.source ?? '.codex/tasks/task_001/runtime-qa/benchmark-random-1GiB.bin');
await mkdir(path.dirname(source), { recursive: true });
try { const handle = await open(source, 'wx'); try { for (let index = 0; index < 1024; index++) await handle.writeFile(randomBytes(MiB)); await handle.sync(); } finally { await handle.close(); } }
catch (error) { if (error.code !== 'EEXIST') throw error; }
assert.equal((await stat(source)).size, 1024 * MiB, 'Expected a complete fixed 1 GiB benchmark source');
assert(size <= 1024 * MiB, 'Requested upload exceeds benchmark source');
const sourceHash = createHash('sha256'); for await (const data of createReadStream(source, { end: size - 1, highWaterMark: 256 * 1024 })) sourceHash.update(data);
const expectedHash = sourceHash.digest('hex');
const report = { startedAt: new Date().toISOString(), origin: base.origin, locality: ['127.0.0.1', 'localhost'].includes(base.hostname) ? 'loopback-not-selection-evidence' : 'public-network', method: 'sequential PATCH, no automatic retries, bounded 256 KiB file stream, fixed random source prefix, independent FTP RETR', sourcePrefixSha256: expectedHash, chunksMiB: chunks, size, rounds, runs: [], requests: [] };
const progressTimer = setInterval(() => { const run = report.runs.at(-1); if (run?.status === 'running') console.log(JSON.stringify({ progress: true, chunkMiB: run.chunkMiB, round: run.round, acknowledgedBytes: run.patches.reduce((sum, patch) => sum + patch.length, 0), size: run.size, phase: run.transitions.at(-1)?.state ?? 'upload' })); }, 45000);
progressTimer.unref();
let cookie = '', csrf = '';
async function request(endpoint, { method = 'GET', json, headers = {}, body, signal } = {}) {
  const start = performance.now();
  const response = await fetch(new URL('/ftp/api/v2' + endpoint, base), { method: json ? 'POST' : method, headers: { cookie, 'x-csrf-token': csrf, origin: base.origin, ...(json ? { 'content-type': 'application/json' } : {}), ...headers }, body: json ? JSON.stringify(json) : body, ...(body ? { duplex: 'half' } : {}), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000), redirect: 'error' });
  const text = await response.text();
  const ms = performance.now() - start;
  report.requests.push({ endpoint, method: json ? 'POST' : method, status: response.status, ms, offset: response.headers.get('upload-offset') });
  if (!response.ok) throw Error(`${method} ${endpoint}: HTTP ${response.status} ${text.slice(0, 160)}`);
  return { response, ms, data: text ? JSON.parse(text) : null };
}
async function interruptPatch(upload, offset, length) {
  const abort = new AbortController(), partialLength = Math.min(256 * 1024, length - 1);
  assert(partialLength > 0); let emittedBytes = 0;
  async function* partial() {
    for await (const data of createReadStream(source, { start: offset, end: offset + partialLength - 1 })) { emittedBytes += data.length; yield data; }
    // Keep the declared body incomplete until cancelling; this exercises a real socket request.
    await new Promise(resolve => setTimeout(resolve, 750)); abort.abort();
  }
  let aborted = false;
  try { await request(upload, { method: 'PATCH', signal: abort.signal, body: Readable.from(partial()), headers: { 'tus-resumable': '1.0.0', 'upload-offset': String(offset), 'content-length': String(length), 'content-type': 'application/offset+octet-stream' } }); }
  catch (error) { if (!abort.signal.aborted) throw error; aborted = true; }
  assert(aborted, 'Expected interrupted PATCH to reject'); assert(emittedBytes < length);
  const { response } = await request(upload, { method: 'HEAD', headers: { 'tus-resumable': '1.0.0' } });
  const durableOffset = Number(response.headers.get('upload-offset'));
  assert(durableOffset >= offset && durableOffset <= offset + emittedBytes);
  return { originalOffset: offset, declaredBytes: length, emittedBytes, durableOffset, reemittedBytes: emittedBytes - (durableOffset - offset), interpretation: 'Client stream bytes emitted, not TCP delivery measurement; proxy buffering may preserve only preceding acknowledged chunk' };
}
function observeDirectory(samples) {
  let stopped = false, failure;
  const pending = (async () => {
    while (!stopped) {
      const start = performance.now(); const { ms } = await request('/list?path=%2F&limit=1'); samples.push(ms);
      await new Promise(resolve => setTimeout(resolve, Math.max(0, 1000 - (performance.now() - start))));
    }
  })().catch(error => { failure = error; });
  return async () => { stopped = true; await pending; if (failure) throw failure; };
}
async function save() {
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  const rows = ['chunkMiB,round,size,uploadMs,MiBPerSecond,postUploadMs,retrMs,status', ...report.runs.map(r => [r.chunkMiB,r.round,r.size,r.uploadMs,r.MiBPerSecond,r.postUploadMs,r.retr?.ms,r.status].join(','))];
  await writeFile(path.join(output, 'summary.csv'), rows.join('\n'));
}
async function verifyRemote(target) {
  // Send only paths over SSH; the password is read on the server and never printed.
  const program = `import ftplib,hashlib,json,time\nc=json.load(open(${JSON.stringify(args['remote-credentials'])}))\nf=ftplib.FTP();f.connect(c.get('ftpHost','127.0.0.1'),c.get('ftpPort',21),timeout=120);f.login(c['username'],c['password'])\nh=hashlib.sha256();n=[0];t=time.monotonic()\ndef consume(b):\n h.update(b);n[0]+=len(b)\nf.retrbinary('RETR '+${JSON.stringify(target)},consume,262144);f.quit()\nprint(json.dumps({'sha256':h.hexdigest(),'size':n[0],'ms':(time.monotonic()-t)*1000}))`;
  const encoded = Buffer.from(program).toString('base64');
  const command = `python3 -c "import base64;exec(base64.b64decode('${encoded}'))"`;
  const result = await execute('ssh', ['-o', 'BatchMode=yes', args.ssh, command], { timeout: 180000, maxBuffer: 65536 });
  return JSON.parse(result.stdout);
}
async function verifyLocal(target) {
  const { Client } = await import('basic-ftp'); const { Writable } = await import('node:stream');
  const client = new Client(120000), hash = createHash('sha256'); let bytes = 0; const start = performance.now();
  try { await client.access({ host: credentials.ftpHost ?? '127.0.0.1', port: credentials.ftpPort, user: credentials.username, password: credentials.password });
    await client.downloadTo(new Writable({ write(data, _encoding, done) { bytes += data.length; hash.update(data); done(); } }), target);
    return { sha256: hash.digest('hex'), size: bytes, ms: performance.now() - start };
  } finally { client.close(); }
}
async function run(chunkMiB, round) {
  const run = { chunkMiB, round, size, startedAt: new Date().toISOString(), status: 'running', patches: [], directoryLatencyMs: [], transitions: [], retryBytes: 0 }; report.runs.push(run);
  const name = `benchmark-${randomUUID()}.bin`;
  const { data: batch } = await request('/batches', { json: { destination: '/', idempotencyKey: name, entries: [{ relativePath: name, type: 'file', size, lastModified: 1 }] } });
  const { data: committed } = await request(`/batches/${batch.id}/commit`, { json: { conflictPolicy: 'skip' } }); const task = committed.tasks[0]; run.taskId = task.id; run.destinationPath = task.destinationPath;
  await request('/uploads', { method: 'POST', headers: { 'tus-resumable': '1.0.0', 'upload-length': String(size), 'upload-metadata': 'taskId ' + Buffer.from(task.id).toString('base64'), 'content-length': '0' } });
  const upload = `/uploads/${task.uploadId}`, start = performance.now();
  const stopListing = observeDirectory(run.directoryLatencyMs);
  try { for (let offset = 0; offset < size;) {
    if (args.interrupt === 'true' && run.patches.length === 1 && !run.interruption) {
      run.interruption = await interruptPatch(upload, offset, Math.min(chunkMiB * MiB, size - offset));
      offset = run.interruption.durableOffset; run.retryBytes = run.interruption.reemittedBytes;
    }
    const length = Math.min(chunkMiB * MiB, size - offset);
    const body = createReadStream(source, { start: offset, end: offset + length - 1, highWaterMark: 256 * 1024 });
    const { response, ms } = await request(upload, { method: 'PATCH', body, headers: { 'tus-resumable': '1.0.0', 'upload-offset': String(offset), 'content-length': String(length), 'content-type': 'application/offset+octet-stream' } });
    assert.equal(Number(response.headers.get('upload-offset')), offset + length);
    run.patches.push({ offset, length, ms, status: response.status }); offset += length;
    if (args.recovery === 'true' && offset === length) {
      await request(`/tasks/${task.id}/pause`, { json: {} }); const { response: head } = await request(upload, { method: 'HEAD', headers: { 'tus-resumable': '1.0.0' } }); assert.equal(Number(head.headers.get('upload-offset')), offset);
      await request(`/tasks/${task.id}/resume`, { json: {} }); run.pauseHeadResume = true;
    }
  }
  run.uploadMs = performance.now() - start;
  } finally { await stopListing(); }
  if (args.interrupt === 'true') assert(run.interruption, 'Interrupt case must execute an incomplete second PATCH');
  run.MiBPerSecond = size / MiB / (run.uploadMs / 1000); run.sha256 = expectedHash;
  const completedStart = performance.now(); await request(upload + '/complete', { json: { sha256: run.sha256 } });
  if (args.recovery === 'true') { await request(upload + '/complete', { json: { sha256: run.sha256 } }); run.repeatedComplete = true; await new Promise(resolve => setTimeout(resolve, 5000)); run.noHttpRequestMs = 5000; }
  const deadline = Date.now() + 180000;
  for (;;) {
    const { data: current } = await request(`/tasks/${task.id}`);
    if (run.transitions.at(-1)?.state !== current.state) run.transitions.push({ state: current.state, observedMs: performance.now() - completedStart });
    if (current.state === 'COMPLETED') { run.endToEndMs = performance.now() - start; break; }
    if (['FAILED','CANCELLED','AUTH_REQUIRED','EXPIRED'].includes(current.state)) throw Error(`Task stopped: ${current.state} ${current.error?.code}`);
    if (Date.now() > deadline) throw Error('Task completion timed out'); await new Promise(resolve => setTimeout(resolve, 250));
  }
  run.postUploadMs = performance.now() - completedStart;
  run.retr = args.ssh ? await verifyRemote(task.destinationPath) : await verifyLocal(task.destinationPath);
  assert.equal(run.retr.size, size); assert.equal(run.retr.sha256, run.sha256);
  await request('/delete', { json: { path: task.destinationPath, type: 'file', confirm: true } }); run.remoteFileDeleted = true; run.status = 'passed'; run.finishedAt = new Date().toISOString();
  await save(); console.log(JSON.stringify({ chunkMiB, round, MiBPerSecond: run.MiBPerSecond, postUploadMs: run.postUploadMs, retrMs: run.retr.ms, status: run.status }));
}
try {
  const { response, data } = await request('/login', { json: { username: credentials.username, password: credentials.password } }); cookie = response.headers.get('set-cookie').split(';')[0]; csrf = data.csrfToken;
  report.baselineDirectoryLatencyMs = []; report.directoryScope = 'Isolated test account root with benchmark files only; large existing user directories not covered';
  report.baselineCount = baselineCount; report.baselineIntervalMs = baselineInterval;
  for (let index = 0; index < baselineCount; index++) { const start = performance.now(); const { ms } = await request('/list?path=%2F&limit=1'); report.baselineDirectoryLatencyMs.push(ms); if (index + 1 < baselineCount) await new Promise(resolve => setTimeout(resolve, Math.max(0, baselineInterval - (performance.now() - start)))); }
  for (let round = 1; round <= rounds; round++) for (const chunk of (round % 2 ? chunks : [...chunks].reverse())) await run(chunk, round);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.message; const current = report.runs.at(-1); if (current?.status === 'running') { current.status = 'failed'; current.error = error.message; current.acknowledgedBytes = current.patches.reduce((sum, patch) => sum + patch.length, 0); } process.exitCode = 1; console.error(error.message); }
finally { clearInterval(progressTimer); report.finishedAt = new Date().toISOString(); await save(); }
