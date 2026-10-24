import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir, statfs, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomBytes, generateKeyPairSync } from 'node:crypto';
import NodeRSA from 'node-rsa';
import { request as httpRequest, type Server } from 'node:http';
import { createApp } from '../server/app.ts';
import { absolutePath, relativePath } from '../server/paths.ts';
import type { Task } from '../server/types.ts';

let directory: string, fixture: ChildProcess, ftpPort: number;
let service: Awaited<ReturnType<typeof createApp>>, server: Server, base: string;
type User = { cookie: string; csrf: string; id: string };
let alice: User, bob: User;
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
async function start() {
  service = await createApp({ directory: path.join(directory, 'state'), legacyKeyDirectory: directory, secret: 'integration-only-session-secret', ftp: { port: ftpPort, timeout: 3000 }, transfer: { reserveBytes: 0, reserveRatio: 0 } });
  server = service.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function stop() { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await service.close(); }
async function request(endpoint: string, options: { user?: User; method?: string; body?: unknown; headers?: Record<string, string>; raw?: Uint8Array } = {}) {
  const response = await fetch(base + '/ftp/api/v2' + endpoint, { method: options.method ?? (options.body ? 'POST' : 'GET'), headers: { ...(options.user ? { cookie: options.user.cookie, 'x-csrf-token': options.user.csrf } : {}), ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers }, body: options.raw as BodyInit ?? (options.body ? JSON.stringify(options.body) : undefined) });
  return response;
}
async function login(username: string) {
  const response = await request('/login', { body: { username, password: 'integration-only' } });
  assert.equal(response.status, 200); const data = await response.json();
  return { cookie: response.headers.get('set-cookie')!.split(';')[0], csrf: data.csrfToken, id: data.user.id };
}
async function batch(entries: unknown[], policy = 'skip', user = alice) {
  const response = await request('/batches', { user, body: { destination: '/', entries, idempotencyKey: randomBytes(8).toString('hex') } });
  assert.equal(response.status, 201, await response.clone().text()); const draft = await response.json();
  const committed = await request(`/batches/${draft.id}/commit`, { user, body: { conflictPolicy: policy, confirmReplace: policy === 'replace' } });
  assert.equal(committed.status, 200, await committed.clone().text());
  return (await committed.json()).tasks as Task[];
}
async function newTask(name: string, size: number) { return (await batch([{ relativePath: name, size, type: 'file', lastModified: 1 }]))[0]; }
async function createUpload(task: Task) {
  const response = await request('/uploads', { user: alice, method: 'POST', headers: { 'tus-resumable': '1.0.0', 'upload-length': String(task.size), 'upload-metadata': 'taskId ' + Buffer.from(task.id).toString('base64'), 'content-length': '0' } });
  assert.equal(response.status, 201, await response.text());
  assert.equal(response.headers.get('location'), `/ftp/api/v2/uploads/${task.uploadId}`);
}
async function patch(task: Task, data: Uint8Array, offset: number, user = alice) {
  return request(`/uploads/${task.uploadId}`, { user, method: 'PATCH', raw: data, headers: { 'tus-resumable': '1.0.0', 'upload-offset': String(offset), 'content-type': 'application/offset+octet-stream' } });
}
async function complete(task: Task, digest: string) { return request(`/uploads/${task.uploadId}/complete`, { user: alice, body: { sha256: digest } }); }
async function waitState(id: string, states: string[]) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const task = service.store.getTask(id);
    if (states.includes(task.state)) return task;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Task ${id} stuck at ${service.store.getTask(id).state}`);
}
before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'ftp-web-test-'));
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await writeFile(path.join(directory, 'pri_key.rsa'), keys.privateKey.export({ type: 'pkcs1', format: 'pem' }));
  await writeFile(path.join(directory, 'pub_key.rsa'), keys.publicKey.export({ type: 'spki', format: 'pem' }));
  fixture = spawn('python', ['-u', 'test/ftp_fixture.py', path.join(directory, 'remote')], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  ftpPort = await new Promise<number>((resolve, reject) => {
    let diagnostic = ''; let ready = false;
    const timeout = setTimeout(() => reject(new Error('FTP fixture did not start; install pyftpdlib for Python')), 10000);
    fixture.stderr!.on('data', data => { diagnostic = (diagnostic + String(data)).slice(-2048); });
    fixture.once('error', error => { clearTimeout(timeout); reject(error); });
    fixture.once('exit', () => { clearTimeout(timeout); if (!ready) reject(new Error('FTP fixture failed: ' + diagnostic)); });
    fixture.stdout!.once('data', data => { clearTimeout(timeout); ready = true; resolve(Number(String(data).trim())); });
  });
  await start(); alice = await login('alice'); bob = await login('bob');
});
after(async () => {
  if (server) await stop(); fixture?.kill(); if (fixture && fixture.exitCode === null) await once(fixture, 'exit');
  if (directory) { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('ftp-web-test-')); await rm(directory, { recursive: true, force: true }); }
});

test('paths reject traversal/control/absolute manifest while preserving literal percent and Unicode', () => {
  for (const value of ['../secret', '/absolute', 'a/../b', 'a/./b', 'C:/x', 'a\\b', 'a\0b']) assert.throws(() => relativePath(value));
  assert.equal(relativePath('资料/100%2e.txt'), '资料/100%2e.txt'); assert.equal(absolutePath('/资料//a'), '/资料/a');
});
test('all auth failures terminate and mutations require CSRF and trusted Origin', async () => {
  assert.equal((await request('/tasks')).status, 401);
  assert.equal((await request('/mkdir', { user: alice, body: { path: '/denied' }, headers: { 'x-csrf-token': '' } })).status, 403);
  assert.equal((await request('/mkdir', { user: alice, body: { path: '/denied' }, headers: { origin: 'https://evil.invalid' } })).status, 403);
  const legacy = await fetch(base + '/ftp/api/get_dir'); assert.equal(legacy.status, 200); assert.equal((await legacy.json()).message, 'Need login');
});
test('legacy RSA login preserves Android connect.sid cookie and old directory/pwd envelopes', async () => {
  const keyResponse = await fetch(base + '/ftp/api/pub_rsa', { redirect: 'manual' });
  assert.equal(keyResponse.status, 200); assert.equal(keyResponse.headers.get('location'), null);
  const publicKey = await keyResponse.text();
  const rsa = new NodeRSA(publicKey); rsa.setOptions({ encryptionScheme: 'pkcs1', environment: 'browser' });
  for (const format of ['application/json', 'application/x-www-form-urlencoded']) {
    const encrypted = { user: rsa.encrypt('alice', 'base64'), password: rsa.encrypt('integration-only', 'base64') };
    const response = await fetch(base + '/ftp/api/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': format }, body: format === 'application/json' ? JSON.stringify(encrypted) : new URLSearchParams(encrypted).toString() });
    assert.equal(response.status, 200); assert.equal(response.headers.get('location'), null);
    assert.match(response.headers.get('content-type')!, /application\/json/u);
    assert.equal((await response.json()).message, 'success');
    const cookie = response.headers.get('set-cookie')!.split(';')[0]; assert.ok(cookie.startsWith('connect.sid='));
    for (const endpoint of ['get_dir', 'pwd']) {
      const result = await fetch(base + '/ftp/api/' + endpoint, { redirect: 'manual', headers: { cookie } });
      assert.equal(result.status, 200); assert.equal(result.headers.get('location'), null);
      assert.match(result.headers.get('content-type')!, /application\/json/u);
      const value = await result.json(); assert.equal(value.message, 'success');
      if (endpoint === 'pwd') assert.deepEqual(value, { message: 'success', result: '/' });
    }
  }
});

test('old Web entry points redirect GET and HEAD to the fixed new app regardless of query', async () => {
  for (const endpoint of ['/ftp', '/ftp/', '/ftp/login.html', '/ftp/index.html']) {
    for (const suffix of ['', '?next=https%3A%2F%2Fexample.invalid%2F&legacy=1']) {
      for (const method of ['GET', 'HEAD']) {
        const response = await fetch(base + endpoint + suffix, { method, redirect: 'manual' });
        assert.equal(response.status, 302, `${method} ${endpoint}${suffix}`);
        assert.equal(response.headers.get('location'), '/ftp/app/');
        const body = await response.text();
        if (method === 'HEAD') assert.equal(body, '');
        else assert.ok(!body.includes('<form'));
      }
    }
  }
});
test('real tus offset/ownership and asynchronous idempotent complete transfer Unicode folder + empty directory', async () => {
  const data = randomBytes(320000);
  const tasks = await batch([{ relativePath: '资料/空目录', type: 'directory', size: 0 }, { relativePath: '资料/100%2e文件.bin', type: 'file', size: data.length }]);
  const task = tasks.find(item => item.type === 'file')!;
  await createUpload(task);
  assert.equal((await patch(task, data.subarray(0, 100000), 0)).status, 204);
  assert.equal((await patch(task, data.subarray(0, 1), 0)).status, 409);
  assert.equal((await patch(task, data.subarray(0, 1), 100000, bob)).status, 404);
  assert.equal((await request(`/tasks/${task.id}`, { user: bob })).status, 404);
  assert.equal((await complete(task, hash(data))).status, 409);
  const head = await request(`/uploads/${task.uploadId}`, { user: alice, method: 'HEAD', headers: { 'tus-resumable': '1.0.0' } });
  assert.equal(head.headers.get('upload-offset'), '100000');
  assert.equal((await patch(task, data.subarray(100000), 100000)).status, 204);
  assert.equal((await complete(task, hash(data))).status, 202);
  assert.equal((await complete(task, hash(data))).status, 202);
  assert.equal((await complete(task, '0'.repeat(64))).status, 409);
  const done = await waitState(task.id, ['COMPLETED', 'FAILED']); assert.equal(done.state, 'COMPLETED', JSON.stringify(done.error));
  assert.equal(done.attempts, 1); assert.equal(done.transferredBytes, data.length);
  assert.equal(await service.ftp.digest(alice.id, task.destinationPath), hash(data));
  assert.equal((await service.ftp.stat(alice.id, '/资料/空目录'))?.type, 'directory');
  const downloaded = await request('/download?path=' + encodeURIComponent(task.destinationPath), { user: alice });
  assert.equal(downloaded.headers.get('content-length'), String(data.length)); assert.equal(downloaded.headers.get('content-type'), 'application/octet-stream'); assert.match(downloaded.headers.get('content-disposition')!, /filename\*=UTF-8''/u);
  assert.equal(hash(new Uint8Array(await downloaded.arrayBuffer())), hash(data));
});
test('wrong complete hash cannot reach FTP and cannot be silently retried', async () => {
  const data = Buffer.from('wrong digest'); const task = await newTask('wrong.bin', data.length); await createUpload(task);
  assert.equal((await patch(task, data, 0)).status, 204); assert.equal((await complete(task, '0'.repeat(64))).status, 202);
  const failed = await waitState(task.id, ['FAILED']); assert.equal(failed.error?.code, 'HASH_MISMATCH');
  assert.equal(await service.ftp.stat(alice.id, '/wrong.bin'), undefined);
  assert.equal((await request(`/tasks/${task.id}/retry`, { user: alice, body: {} })).status, 409);
  await request(`/tasks/${task.id}/cancel`, { user: alice, body: {} });
});
test('pause blocks PATCH; cancel remains terminal and removes only its staging object', async () => {
  const task = await newTask('cancel.bin', 10); await createUpload(task); await patch(task, Buffer.from('12'), 0);
  assert.equal((await request(`/tasks/${task.id}/pause`, { user: alice, body: {} })).status, 200);
  assert.equal((await patch(task, Buffer.from('34'), 2)).status, 409);
  await request(`/tasks/${task.id}/resume`, { user: alice, body: {} });
  assert.equal((await patch(task, Buffer.from('34'), 2)).status, 204);
  await request(`/tasks/${task.id}/cancel`, { user: alice, body: {} });
  assert.equal(service.store.getTask(task.id).state, 'CANCELLED');
  assert.equal((await complete(task, '0'.repeat(64))).status, 409);
  assert.equal((await request(`/uploads/${task.uploadId}`, { user: alice, method: 'HEAD', headers: { 'tus-resumable': '1.0.0' } })).status, 404);
});
test('restart recovers durable offset, trims uncheckpointed tail and waits for FTP reauthorization', async () => {
  const data = randomBytes(10000); const task = await newTask('restart.bin', data.length); await createUpload(task); await patch(task, data.subarray(0, 4000), 0);
  const staged = service.transfers.filePath(task); await stop();
  await writeFile(staged, Buffer.concat([data.subarray(0, 4000), Buffer.from('uncheckpointed')]));
  await start();
  const session = await (await request('/session', { user: alice })).json(); assert.equal(session.authenticated, true); assert.equal(session.ftpAuthorized, false);
  const head = await request(`/uploads/${task.uploadId}`, { user: alice, method: 'HEAD', headers: { 'tus-resumable': '1.0.0' } }); assert.equal(head.headers.get('upload-offset'), '4000');
  assert.equal((await patch(task, data.subarray(4000), 4000)).status, 204); await complete(task, hash(data));
  assert.equal((await waitState(task.id, ['AUTH_REQUIRED'])).verified, true);
  const oldId = alice.id; alice = await login('alice'); assert.equal(alice.id, oldId); bob = await login('bob');
  assert.equal((await waitState(task.id, ['COMPLETED', 'FAILED'])).state, 'COMPLETED');
  assert.equal(await service.ftp.digest(alice.id, '/restart.bin'), hash(data));
});
test('keep-both remaps a complete directory tree and replacement refuses changed destination', async () => {
  const tasks = await batch([{ relativePath: '资料', type: 'directory', size: 0 }, { relativePath: '资料/child', type: 'directory', size: 0 }, { relativePath: '资料/child/new.txt', type: 'file', size: 0 }], 'keep-both');
  assert.deepEqual(tasks.map(task => task.destinationPath), ['/资料 (1)', '/资料 (1)/child', '/资料 (1)/child/new.txt']);
  for (const task of tasks) if (task.type === 'file') await request(`/tasks/${task.id}/cancel`, { user: alice, body: {} });
  await writeFile(path.join(directory, 'remote/alice/replace.txt'), 'original');
  const task = (await batch([{ relativePath: 'replace.txt', type: 'file', size: 3 }], 'replace'))[0];
  await createUpload(task); await patch(task, Buffer.from('new'), 0);
  await writeFile(path.join(directory, 'remote/alice/replace.txt'), 'changed original');
  await complete(task, hash(Buffer.from('new')));
  const failed = await waitState(task.id, ['FAILED', 'COMPLETED']); assert.equal(failed.error?.code, 'DESTINATION_CHANGED');
  assert.equal(await readFile(path.join(directory, 'remote/alice/replace.txt'), 'utf8'), 'changed original');
  await request(`/tasks/${task.id}/cancel`, { user: alice, body: {} });
});
test('missing downloads end with an error and browsing remains independent of legacy cwd', async () => {
  const missing = await request('/download?path=/missing.bin', { user: alice }); assert.equal(missing.status, 404); await missing.arrayBuffer();
  const changed = await fetch(base + '/ftp/api/change_dir', { method: 'POST', headers: { cookie: alice.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ path: '/资料' }) }); assert.equal((await changed.json()).message, 'success');
  const listing = await (await request('/list?path=/', { user: alice })).json(); assert.equal(listing.path, '/'); assert.ok(listing.items.some((item: any) => item.name === 'restart.bin'));
  const files = await readdir(path.join(directory, 'state')); assert.ok(files.includes('tasks.sqlite'));
});
test('worker re-reads queued tasks after another transfer waits: cancel/pause are never overwritten', async () => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const original = service.ftp.mkdir.bind(service.ftp);
  service.ftp.mkdir = async (owner, target) => { if (target === '/blocked-a') { entered(); await blocked; } return original(owner, target); };
  try {
    const tasks = await batch(['blocked-a', 'cancelled-b', 'paused-c'].map(relativePath => ({ relativePath, type: 'directory', size: 0 })));
    // Locate by name because manifest ordering is deterministic but not user-provided ordering.
    const a = tasks.find(task => task.relativePath === 'blocked-a')!;
    const b = tasks.find(task => task.relativePath === 'cancelled-b')!;
    const c = tasks.find(task => task.relativePath === 'paused-c')!;
    await started;
    await request(`/tasks/${b.id}/cancel`, { user: alice, body: {} });
    await request(`/tasks/${c.id}/pause`, { user: alice, body: {} });
    release(); await waitState(a.id, ['COMPLETED']);
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(service.store.getTask(b.id).state, 'CANCELLED'); assert.equal(service.store.getTask(c.id).state, 'PAUSED');
    assert.equal(await service.ftp.stat(alice.id, '/cancelled-b'), undefined); assert.equal(await service.ftp.stat(alice.id, '/paused-c'), undefined);
    await request(`/tasks/${c.id}/cancel`, { user: alice, body: {} });
  } finally { release(); service.ftp.mkdir = original; }
});
test('manifest validation and quota failures reserve no task and duplicate task metadata cannot bypass ownership', async () => {
  const invalid = await request('/batches', { user: alice, body: { destination: '/', entries: [null] } }); assert.equal(invalid.status, 400);
  const blocked = await request('/batches', { user: alice, body: { destination: '/', entries: [{ relativePath: 'same', type: 'file', size: 0 }, { relativePath: 'same/child', type: 'file', size: 0 }] } }); assert.equal(blocked.status, 409);
  const original = service.transfers.config.globalQuota; service.transfers.config.globalQuota = 0;
  try {
    const draft = await (await request('/batches', { user: alice, body: { destination: '/', entries: [{ relativePath: 'quota.bin', type: 'file', size: 1 }] } })).json();
    const denied = await request(`/batches/${draft.id}/commit`, { user: alice, body: { conflictPolicy: 'skip' } }); assert.equal(denied.status, 507);
    assert.equal(service.store.tasks(alice.id).some(task => task.batchId === draft.id), false);
  } finally { service.transfers.config.globalQuota = original; }
  const aliceTask = await newTask('duplicate-meta.bin', 0);
  const bobTask = (await batch([{ relativePath: 'bob.bin', type: 'file', size: 0 }], 'skip', bob))[0];
  const metadata = [aliceTask.id, bobTask.id].map(id => 'taskId ' + Buffer.from(id).toString('base64')).join(',');
  const denied = await request('/uploads', { user: alice, method: 'POST', headers: { 'tus-resumable': '1.0.0', 'upload-length': '0', 'upload-metadata': metadata, 'content-length': '0' } }); assert.equal(denied.status, 400);
  assert.equal(service.store.getTask(bobTask.id).uploadUrl, null);
  await request(`/tasks/${aliceTask.id}/cancel`, { user: alice, body: {} }); await request(`/tasks/${bobTask.id}/cancel`, { user: bob, body: {} });
});
test('large real request bodies reach FTP via bounded tus chunks and independent RETR hash matches', async context => {
  const MiB = 1048576; const block = randomBytes(8 * MiB); const total = Number(process.env.FTP_TEST_LARGE_MIB ?? 129) * MiB;
  assert.ok(Number.isSafeInteger(total) && total >= 129 * MiB && total <= 2 * 1024 * MiB);
  const startedAt = performance.now(); let peakRss = process.memoryUsage().rss;
  const sample = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 20); sample.unref();
  const digest = createHash('sha256'); const task = await newTask('large-integration.bin', total); await createUpload(task);
  for (let offset = 0; offset < total; offset += block.length) {
    const chunk = block.subarray(0, Math.min(block.length, total - offset)); digest.update(chunk);
    const response = await patch(task, chunk, offset); assert.equal(response.status, 204, await response.text());
    if (offset % (32 * MiB) === 0) assert.equal((await request('/list?path=/', { user: alice })).status, 200);
  }
  const expected = digest.digest('hex'); const accepted = await complete(task, expected); assert.equal(accepted.status, 202);
  const done = await waitState(task.id, ['COMPLETED', 'FAILED']); assert.equal(done.state, 'COMPLETED', JSON.stringify(done.error));
  assert.equal(done.uploadedBytes, total); assert.equal(done.transferredBytes, total);
  const transferMs = performance.now() - startedAt;
  const verifyStarted = performance.now();
  assert.equal(await service.ftp.digest(alice.id, '/large-integration.bin'), expected);
  const verificationMs = performance.now() - verifyStarted;
  clearInterval(sample);
  context.diagnostic(JSON.stringify({ bytes: total, sha256: expected, transferMs, independentFtpRetrMs: verificationMs, peakTestProcessRss: peakRss, note: 'loopback integration only; client and server share one process; not a production chunk benchmark' }));
  const response = await request('/download?path=/large-integration.bin', { user: alice });
  const reader = response.body!.getReader(); await reader.read(); await reader.cancel();
  assert.equal((await request('/list?path=/', { user: alice })).status, 200);
});
test('manifest pages commit more than 500 files without losing paths and task listing is paginated', async () => {
  const entries = Array.from({ length: 500 }, (_, index) => ({ relativePath: `paged/file-${index}.txt`, type: 'file', size: 0 }));
  const initial = await request('/batches', { user: alice, body: { destination: '/', entries, idempotencyKey: 'paged-regression' } }); assert.equal(initial.status, 201);
  const draft = await initial.json();
  const appended = await request(`/batches/${draft.id}/entries`, { user: alice, body: { entries: [{ relativePath: 'paged/last.txt', type: 'file', size: 0 }] } }); assert.equal(appended.status, 200);
  const committed = await request(`/batches/${draft.id}/commit`, { user: alice, body: { conflictPolicy: 'skip' } }); assert.equal(committed.status, 200, await committed.clone().text());
  const tasks: Task[] = (await committed.json()).tasks; assert.equal(tasks.length, 501); assert.ok(tasks.some(task => task.destinationPath === '/paged/last.txt'));
  const page = await (await request('/tasks?limit=200', { user: alice })).json(); assert.equal(page.tasks.length, 200); assert.equal(page.nextCursor, '200');
  for (const task of tasks) await service.transfers.action(task.id, alice.id, 'cancel');
});
test('directory creation refuses file targets and legacy uploads share reservation/operation safety', async () => {
  await writeFile(path.join(directory, 'remote/alice/not-a-directory'), 'existing');
  const denied = await request('/mkdir', { user: alice, body: { path: '/not-a-directory' } }); assert.equal(denied.status, 409);
  const legacyRequest = (endpoint: string, body: unknown) => fetch(base + '/ftp/api/' + endpoint, { method: 'POST', headers: { cookie: alice.cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const folder = await legacyRequest('mkdir', { path: '/legacy-test' }); assert.equal((await folder.json()).message, 'success');
  const form = new FormData(); form.append('file', new Blob(['legacy bytes']), 'old.txt'); form.append('name', 'old.txt'); form.append('path', '/legacy-test/');
  const uploaded = await fetch(base + '/ftp/api/upload', { method: 'POST', headers: { cookie: alice.cookie }, body: form }); assert.equal((await uploaded.json()).message, 'success');
  assert.equal(service.transfers.legacyReservations.size, 0);
  const renamed = await legacyRequest('rename', { old_path: '/legacy-test/old.txt', new_path: '/legacy-test/new.txt' }); assert.equal((await renamed.json()).message, 'success');
  const download = await fetch(base + '/ftp/api/download/' + encodeURIComponent('/legacy-test/new.txt'), { headers: { cookie: alice.cookie } }); assert.equal(download.headers.get('content-length'), '12'); assert.equal(await download.text(), 'legacy bytes');
  assert.equal((await (await legacyRequest('delete_file', { path: '/legacy-test/new.txt' })).json()).message, 'success');
  assert.equal((await (await legacyRequest('rmdir', { path: '/legacy-test' })).json()).message, 'success');
  const first = await service.transfers.reserveLegacy(alice.id, 100); const second = await service.transfers.reserveLegacy(alice.id, 100);
  try { await assert.rejects(service.transfers.reserveLegacy(alice.id, 1), { code: 'LEGACY_BUSY' }); }
  finally { service.transfers.legacyReservations.delete(first); service.transfers.legacyReservations.delete(second); }
});
test('VERIFYING retains a full FTP copy budget before hash completes', async () => {
  const task = await newTask('quota-verifying.bin', 16 * 1048576); const current = service.store.getTask(task.id);
  current.state = 'VERIFYING'; current.uploadedBytes = current.size; current.sha256 = '0'.repeat(64); service.store.saveTask(current);
  const disk = await statfs(path.join(directory, 'state')); const prior = service.transfers.config.reserveBytes;
  service.transfers.config.reserveBytes = disk.bavail * disk.bsize - 8 * 1048576;
  try { await assert.rejects(service.transfers.checkQuota(alice.id, 0), { code: 'DISK_RESERVE' }); }
  finally { service.transfers.config.reserveBytes = prior; await service.transfers.action(task.id, alice.id, 'cancel'); }
});
test('rename-intent crash with identical original content completes once and cleans its remote part', async () => {
  const data = Buffer.from('same content before rename');
  await writeFile(path.join(directory, 'remote/alice/same-content.txt'), data);
  const task = (await batch([{ relativePath: 'same-content.txt', type: 'file', size: data.length }], 'replace'))[0];
  await createUpload(task); await patch(task, data, 0);
  const crash = service.store.getTask(task.id); crash.sha256 = hash(data); crash.verified = true; crash.state = 'COMMITTING'; crash.renameIntent = true; crash.attempts = 1; service.store.saveTask(crash);
  const temporary = path.join(directory, 'remote/alice', `.ftp-web-${task.id}.part`); await writeFile(temporary, data);
  await stop(); await start(); alice = await login('alice'); bob = await login('bob');
  const completed = await waitState(task.id, ['COMPLETED', 'FAILED']); assert.equal(completed.state, 'COMPLETED');
  const deadline = Date.now() + 3000;
  while (service.store.getTask(task.id).cleanupPending && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(service.store.getTask(task.id).cleanupPending, false);
  await assert.rejects(readFile(temporary), { code: 'ENOENT' });
  assert.equal(await service.ftp.digest(alice.id, '/same-content.txt'), hash(data));
});
test('data directory enforces one active owner and malformed/wrong logins return bounded errors', async () => {
  await assert.rejects(createApp({ directory: path.join(directory, 'state'), secret: 'second' }), /already owned/u);
  assert.equal((await request('/login', { body: {} })).status, 400);
  const wrong = await request('/login', { body: { username: 'alice', password: 'incorrect' } }); assert.equal(wrong.status, 401);
  const temporary = await createApp({ directory: path.join(directory, 'development-state'), ftp: { port: ftpPort } });
  await temporary.close(); assert.ok((await readFile(path.join(directory, 'development-state/session-secret'), 'utf8')).length >= 64);
  await assert.rejects(createApp({ directory: path.join(directory, 'production-state'), production: true }), /SESSION_SECRET/u);
  await assert.rejects(createApp({ directory: path.join(directory, 'production-state'), production: true, secret: 'production-secret-test' }), /UPLOAD_CHUNK_SIZE/u);
});

test('chunk selection stays pending until a validated benchmark identifier is configured', async () => {
  assert.equal(service.config.chunkSizeStatus, 'benchmark-pending');
  assert.equal(service.config.chunkBenchmarkId, null);
  const measured = await createApp({ directory: path.join(directory, 'measured-state'), chunkBenchmarkId: 'test-fixture-only', transfer: { chunkSize: 4 * 1048576 } });
  try {
    assert.equal(measured.config.chunkSizeStatus, 'measured');
    assert.equal(measured.config.chunkBenchmarkId, 'test-fixture-only');
    assert.equal(measured.config.chunkSize, 4 * 1048576);
  } finally { await measured.close(); }
  for (const chunkBenchmarkId of ['', '../not-valid', 'line\nbreak', 'a'.repeat(65)]) {
    await assert.rejects(createApp({ directory: path.join(directory, 'invalid-benchmark-state'), chunkBenchmarkId }), /UPLOAD_CHUNK_BENCHMARK_ID/u);
  }
});

test('mid-PATCH socket disconnect releases the task only after the durable writer settles, then HEAD resumes', async () => {
  const MiB = 1048576, data = randomBytes(8 * MiB), initial = 4 * MiB, partial = 256 * 1024;
  const task = await newTask('interrupted-socket.bin', data.length); await createUpload(task);
  assert.equal((await patch(task, data.subarray(0, initial), 0)).status, 204);
  let release!: () => void, settled!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const writerSettled = new Promise<void>(resolve => { settled = resolve; });
  const originalWrite = service.transfers.files.write.bind(service.transfers.files);
  service.transfers.files.write = async (...args) => {
    try { return await originalWrite(...args); }
    finally { if (args[1] === task.uploadId) { settled(); await gate; } }
  };
  const client = httpRequest(base + '/ftp/api/v2/uploads/' + task.uploadId, { method: 'PATCH', headers: {
    cookie: alice.cookie, 'x-csrf-token': alice.csrf, 'tus-resumable': '1.0.0',
    'upload-offset': String(initial), 'content-length': String(data.length - initial), 'content-type': 'application/offset+octet-stream',
  } });
  client.on('error', () => {});
  try {
    client.write(data.subarray(initial, initial + partial));
    const deadline = Date.now() + 5000;
    while ((await stat(service.transfers.filePath(task))).size < initial + partial) {
      assert.ok(Date.now() < deadline, 'partial request body reached the real file store');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    client.destroy();
    await Promise.race([writerSettled, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('writer did not settle after disconnect')), 3000).unref())]);
    assert.equal(service.store.getTask(task.id).uploadedBytes, initial + partial);
    let headFinished = false;
    const head = fetch(base + '/ftp/api/v2/uploads/' + task.uploadId, { method: 'HEAD', headers: { cookie: alice.cookie, 'tus-resumable': '1.0.0' }, signal: AbortSignal.timeout(3000) }).then(response => { headFinished = true; return response; });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(headFinished, false, 'HEAD must wait for the datastore finalizer');
    assert.ok(service.transfers.locks.has(task.id));
    release();
    const response = await head;
    assert.equal(response.status, 200);
    assert.equal(Number(response.headers.get('upload-offset')), initial + partial);
    service.transfers.files.write = originalWrite;
    assert.equal((await patch(task, data.subarray(initial + partial), initial + partial)).status, 204);
    assert.equal((await complete(task, hash(data))).status, 202);
    assert.equal((await waitState(task.id, ['COMPLETED', 'FAILED'])).state, 'COMPLETED');
    assert.equal(await service.ftp.digest(alice.id, task.destinationPath), hash(data));
    assert.equal(service.transfers.locks.has(task.id), false);
    assert.equal(service.transfers.files.pendingWrites.size, 0);
  } finally { client.destroy(); release(); service.transfers.files.write = originalWrite; }
});
