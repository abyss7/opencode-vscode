'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createInterface } = require('node:readline');
const { createObserver, readRegularFile } = require('../plugins/permission-profiles/progress.cjs');

async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-progress-sources-'));
  let child, liveRoot;
  try {
    const log = path.join(temp, 'build.log');
    const writer = await fs.open(log, 'w+');
    await writer.write('first');
    let chunk = await readRegularFile(log, {}, 3);
    assert.equal(Buffer.from(chunk.data, 'base64').toString(), 'fir');
    chunk = await readRegularFile(log, chunk);
    assert.equal(Buffer.from(chunk.data, 'base64').toString(), 'st');
    await writer.write(' next');
    await writer.close();
    assert.equal(await fs.readFile(log, 'utf8'), 'first next', 'reader must not seek the writer');
    chunk = await readRegularFile(log, chunk);
    assert.equal(Buffer.from(chunk.data, 'base64').toString(), ' next');
    await fs.writeFile(log, 'new');
    chunk = await readRegularFile(log, chunk);
    assert.equal(chunk.reset, true);
    assert.equal(Buffer.from(chunk.data, 'base64').toString(), 'new');
    const oldIdentity = chunk.identity;
    await fs.rename(log, `${log}.old`);
    await fs.writeFile(log, 'replacement');
    chunk = await readRegularFile(log, chunk);
    assert.notEqual(chunk.identity, oldIdentity);
    assert.equal(chunk.reset, true);
    assert.equal(Buffer.from(chunk.data, 'base64').toString(), 'replacement');
    assert.equal(await readRegularFile(temp), null, 'directories are not logs');
    for (const platform of ['win32', 'darwin']) {
      const observer = createObserver({ platform, procRoot: path.join(temp, 'absent') });
      assert.deepEqual(await observer.observe({}), { supported: false, sources: [] });
    }

    if (process.platform !== 'linux') return;
    const procRoot = path.join(temp, 'proc');
    const stat = async (pid, parent, birth = '12345') => {
      const fields = Array(20).fill('0');
      fields[0] = 'S'; fields[1] = String(parent); fields[19] = birth;
      await fs.writeFile(path.join(procRoot, String(pid), 'stat'), `${pid} (name (with parentheses)) ${fields.join(' ')}\n`);
    };
    const fakeProcess = async (pid, parent, executable, children = '') => {
      const base = path.join(procRoot, String(pid));
      await fs.mkdir(path.join(base, 'task', String(pid)), { recursive: true });
      await fs.mkdir(path.join(base, 'fd'));
      await stat(pid, parent);
      await fs.symlink(`/usr/bin/${executable}`, path.join(base, 'exe'));
      await fs.writeFile(path.join(base, 'task', String(pid), 'children'), children);
    };
    await fakeProcess(500, 400, 'zsh', '501');
    await fakeProcess(501, 500, 'ninja');
    await fs.writeFile(log, '[1/192] CXX first\n');
    await fs.symlink(log, path.join(procRoot, '501/fd/1'));
    await fs.symlink(log, path.join(procRoot, '501/fd/2'));
    const observer = createObserver({ platform: 'linux', procRoot, ownerPID: 400 });
    const input = { sessionID: 'ses_test', shellID: 'sh_build', pid: 500, executables: ['ninja'], states: [] };
    let result = await observer.observe(input);
    assert.equal(result.supported, true);
    assert.equal(result.sources.length, 1, 'merged stderr must not read the file twice');
    assert.equal(result.sources[0].kind, 'file');
    assert.equal(Buffer.from(result.sources[0].data, 'base64').toString(), '[1/192] CXX first\n');
    input.states = result.sources;
    await fs.appendFile(log, '[2/192] CXX second\n');
    result = await observer.observe(input);
    assert.equal(Buffer.from(result.sources[0].data, 'base64').toString(), '[2/192] CXX second\n');
    input.states = result.sources;
    result = await observer.observe(input);
    assert.equal(result.sources[0].data, '', 'unchanged file must not be replayed');

    await fs.rename(log, `${log}.unavailable`);
    result = await observer.observe(input);
    assert.equal(result.complete, false, 'unreadable descriptors of a live producer are not an exit');
    await fs.rename(`${log}.unavailable`, log);
    result = await observer.observe(input);
    assert.equal(result.complete, true);
    assert.equal(result.sources[0].cursor, input.states[0].cursor);
    assert.equal(result.sources[0].data, '', 'recovery keeps the original cursor');

    await fs.writeFile(path.join(procRoot, '500/task/500/children'), '');
    result = await observer.observe(input);
    assert.equal(result.complete, false, 'discovery gaps cannot invalidate a directly verified live producer');
    await fs.writeFile(path.join(procRoot, '500/task/500/children'), '501');

    // Process completion, not outer-shell completion, removes the source.
    await fs.rename(path.join(procRoot, '501/stat'), path.join(procRoot, '501/stat.saved'));
    assert.deepEqual((await observer.observe(input)).sources, []);
    await fs.rename(path.join(procRoot, '501/stat.saved'), path.join(procRoot, '501/stat'));
    await stat(500, 400, '99999');
    assert.deepEqual((await observer.observe(input)).sources, [], 'PID reuse cannot resume an old execution');
    await stat(500, 400);
    await stat(500, 399);
    assert.deepEqual((await observer.observe(input)).sources, [], 'foreign process roots are rejected');
    await stat(500, 400);
    await assert.rejects(observer.observe({ ...input, sessionID: '../../etc' }), /Invalid/);
    await assert.rejects(observer.observe({ ...input, executables: ['../../ninja'] }), /Invalid/);

    await fakeProcess(502, 500, 'ninja');
    await fs.writeFile(path.join(procRoot, '500/task/500/children'), '501 502');
    result = await observer.observe(input);
    assert.deepEqual(result.sources, [], 'concurrent matching processes are ambiguous');
    assert.equal(result.complete, false, 'ambiguity is not confirmed completion of the previous producer');
    await fs.writeFile(path.join(procRoot, '500/task/500/children'), '501');

    // A pipe is classified, never opened/read by the observer.
    child = spawn(global.process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'ignore'] });
    await once(child, 'spawn');
    await fs.unlink(path.join(procRoot, '501/fd/1'));
    await fs.unlink(path.join(procRoot, '501/fd/2'));
    await fs.symlink(`/proc/${child.pid}/fd/1`, path.join(procRoot, '501/fd/1'));
    result = await observer.observe(input);
    assert.deepEqual(result.sources, [{ id: '501:12345/capture', kind: 'capture' }]);
    assert.equal(await readRegularFile(`/proc/${child.pid}/fd/1`), null);
    observer.dispose();

    // Real procfs, an owned shell-like parent, and a live redirected executable.
    // Copy a tiny system binary, not a real build; no model or external session.
    const executable = path.join(temp, 'ninja');
    await fs.copyFile('/bin/sleep', executable);
    await fs.chmod(executable, 0o700);
    const liveLog = path.join(temp, 'live.log');
    const code = `
      const fs = require('node:fs');
      const { spawn } = require('node:child_process');
      const fd = fs.openSync(${JSON.stringify(liveLog)}, 'w');
      fs.writeSync(fd, '[1/192] CXX first\\n');
      const job = spawn(${JSON.stringify(executable)}, ['60'], { stdio: ['ignore', fd, fd] });
      job.on('spawn', () => console.log('ready'));
      job.on('exit', () => console.log('stopped'));
      process.stdin.on('data', data => {
        if (data.toString().trim() === 'append') { fs.writeSync(fd, '[2/192] CXX second\\n'); console.log('appended'); }
        else job.kill();
      });
      process.on('SIGTERM', () => { job.kill(); process.exit(0); });
    `;
    liveRoot = spawn(global.process.execPath, ['-e', code], { stdio: ['pipe', 'pipe', 'inherit'] });
    const lines = createInterface({ input: liveRoot.stdout })[Symbol.asyncIterator]();
    assert.equal((await lines.next()).value, 'ready');
    const live = createObserver();
    const liveInput = { sessionID: 'ses_live', shellID: 'sh_live', pid: liveRoot.pid, executables: ['ninja'], states: [] };
    result = await live.observe(liveInput);
    assert.equal(result.sources.length, 1);
    assert.equal(Buffer.from(result.sources[0].data, 'base64').toString(), '[1/192] CXX first\n');
    liveInput.states = result.sources;
    liveRoot.stdin.write('append\n');
    assert.equal((await lines.next()).value, 'appended');
    result = await live.observe(liveInput);
    assert.equal(Buffer.from(result.sources[0].data, 'base64').toString(), '[2/192] CXX second\n');
    liveRoot.stdin.write('stop\n');
    assert.equal((await lines.next()).value, 'stopped');
    assert.deepEqual((await live.observe(liveInput)).sources, [], 'real child exit removes source, parent still alive');
    assert.equal(liveRoot.exitCode, null);
    live.dispose();
  } finally {
    if (child) { const closed = once(child, 'close'); child.kill(); await closed; }
    if (liveRoot) { const closed = once(liveRoot, 'close'); liveRoot.kill(); await closed; }
    await fs.rm(temp, { recursive: true, force: true });
  }
  console.log('Progress sources: portable positional file reader, Linux ownership/lifecycle, PID reuse and no pipe reads passed');
}

main().catch((error) => { console.error(error); global.process.exitCode = 1; });
