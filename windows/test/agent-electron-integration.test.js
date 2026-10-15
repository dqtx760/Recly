'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AgentClient } = require('../agent/client');

const windowsRoot = path.resolve(__dirname, '..');
const fixtureDirectory = process.env.RECLY_AGENT_TEST_FIXTURE ? path.resolve(process.env.RECLY_AGENT_TEST_FIXTURE) : null;

function wait(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

function copyFixture(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const input = path.join(source, entry.name);
    const output = path.join(destination, entry.name);
    if (entry.isDirectory()) copyFixture(input, output);
    else fs.copyFileSync(input, output, fs.constants.COPYFILE_EXCL);
  }
}

async function waitForFile(file, child, output, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    if (child.exitCode !== null) throw new Error(`Electron exited before creating its Agent endpoint (${child.exitCode}).\n${output()}`);
    await wait(100);
  }
  throw new Error(`Timed out waiting for the isolated Agent endpoint.\n${output()}`);
}

function waitForMessage(child, type, directory, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('message', onMessage);
      reject(new Error(`Timed out waiting for Electron message: ${type}`));
    }, timeoutMs);
    const onMessage = (message) => {
      if (message?.type !== type || (directory && path.resolve(message.directory) !== path.resolve(directory))) return;
      clearTimeout(timer);
      child.off('message', onMessage);
      resolve(message);
    };
    child.on('message', onMessage);
  });
}

async function pollJob(client, directory, jobId, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let job;
  while (Date.now() < deadline) {
    job = await client.call('jobs.get', { directory, jobId });
    if (['completed', 'failed', 'cancelled'].includes(job?.status)) return job;
    await wait(350);
  }
  throw new Error(`ASR job timed out: ${JSON.stringify(job)}`);
}

async function run() {
  assert.ok(fixtureDirectory, '请设置 RECLY_AGENT_TEST_FIXTURE 为本地验收工程目录；夹具要求见 docs/agent-control.md 的验证章节。');
  assert.ok(fs.existsSync(path.join(fixtureDirectory, 'project.json')), 'the real 20-second Chinese fixture must exist');
  const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recly-agent-electron-'));
  const userData = path.join(isolatedRoot, 'user-data');
  const projectsRoot = path.join(isolatedRoot, 'projects');
  const configFile = path.join(isolatedRoot, 'config.json');
  const projectDirectory = path.join(projectsRoot, path.basename(fixtureDirectory));
  const endpointFile = path.join(userData, 'agent-endpoint.json');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(projectsRoot, { recursive: true });
  copyFixture(fixtureDirectory, projectDirectory);

  const electronBinary = require('electron');
  assert.equal(typeof electronBinary, 'string', 'Electron package must resolve its executable');
  const environment = {
    ...process.env,
    RECLY_AGENT_TEST_USER_DATA: userData,
    RECLY_AGENT_TEST_CONFIG: configFile,
    RECLY_AGENT_TEST_ROOT: projectsRoot,
    RECLY_AGENT_ENDPOINT: endpointFile,
  };
  delete environment.ELECTRON_RUN_AS_NODE;
  process.stdout.write(`Starting isolated Electron integration: ${isolatedRoot}\n`);
  const child = spawn(electronBinary, [path.join(__dirname, 'agent-electron-loader.js'), '--agent-electron-selftest'], {
    cwd: windowsRoot,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  let capturedOutput = '';
  child.stdout.on('data', (chunk) => { capturedOutput = (capturedOutput + String(chunk)).slice(-12000); });
  child.stderr.on('data', (chunk) => { capturedOutput = (capturedOutput + String(chunk)).slice(-12000); });
  const client = new AgentClient({ endpointFile, timeoutMs: 120000 });
  let success = false;

  try {
    await waitForFile(endpointFile, child, () => capturedOutput);
    process.stdout.write('Electron Agent endpoint ready.\n');
    const opened = await client.call('project.open', { directory: projectDirectory });
    assert.equal(opened.opened, true);
    const initial = await client.call('project.get', { directory: projectDirectory });
    assert.equal(initial.project.media.screen.duration, 20);
    assert.ok(initial.project.media.microphone, 'the fixture has a microphone track');
    const segment = initial.project.timeline.segments[0];
    assert.ok(segment.sourceEnd - segment.sourceStart > 1);

    const operations = [{ type: 'trim', segmentId: segment.id, start: segment.sourceStart + 0.2, end: segment.sourceEnd - 0.2 }];
    const preview = await client.call('edit.preview', { directory: projectDirectory, operations });
    const applied = await client.call('edit.apply', {
      directory: projectDirectory, expectedRevision: initial.revision, requestId: 'electron-trim-1', planId: preview.planId, operations,
    });
    assert.equal(applied.revision, initial.revision + 1);
    const trimmed = await client.call('project.get', { directory: projectDirectory });
    assert.equal(trimmed.project.timeline.segments[0].sourceStart, operations[0].start);

    await assert.rejects(client.call('edit.apply', {
      directory: projectDirectory,
      expectedRevision: trimmed.revision,
      requestId: 'electron-atomic-failure',
      operations: [
        { type: 'trim', segmentId: segment.id, start: segment.sourceStart + 0.4, end: segment.sourceEnd - 0.4 },
        { type: 'remove', segmentId: 'missing-segment-id' },
      ],
    }), (error) => error.code === 'not_found');
    const afterFailure = await client.call('project.get', { directory: projectDirectory });
    assert.equal(afterFailure.revision, trimmed.revision, 'failed batch leaves the live project revision unchanged');
    assert.equal(afterFailure.project.timeline.segments[0].sourceStart, operations[0].start, 'failed batch leaves earlier operations unapplied');

    const undo = await client.call('history.undo', { directory: projectDirectory, expectedRevision: trimmed.revision, requestId: 'electron-undo-1' });
    assert.equal(undo.revision, trimmed.revision + 1);
    const redo = await client.call('history.redo', { directory: projectDirectory, expectedRevision: undo.revision, requestId: 'electron-redo-1' });
    assert.equal(redo.revision, undo.revision + 1);

    const sourceFrame = await client.call('media.frame', { directory: projectDirectory, timeDomain: 'source', time: 0.5 });
    const outputFrame = await client.call('media.frame', { directory: projectDirectory, timeDomain: 'output', time: 0.5 });
    for (const frame of [sourceFrame, outputFrame]) {
      assert.equal(frame.mimeType, 'image/png');
      assert.equal(Buffer.from(frame.base64, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    }
    assert.ok(outputFrame.sourceTime > outputFrame.time, 'output capture follows the trimmed live timeline');

    const excerpt = await client.call('media.audio_excerpt', {
      directory: projectDirectory, timeDomain: 'output', track: 'microphone', start: 0.5, duration: 0.25,
    });
    assert.equal(excerpt.timeDomain, 'output');
    assert.equal(excerpt.duration, 0.25);
    assert.ok(Buffer.from(excerpt.base64, 'base64').length > 1000);

    const beforeAsr = await client.call('project.get', { directory: projectDirectory });
    const generation = await client.call('transcript.generate', {
      directory: projectDirectory, track: 'microphone', scope: 'source',
      expectedRevision: beforeAsr.revision, requestId: 'electron-asr-1',
    });
    const job = await pollJob(client, projectDirectory, generation.jobId);
    assert.equal(job.status, 'completed', `real fixture ASR must complete: ${JSON.stringify(job.error)}`);
    assert.ok(Array.isArray(job.result?.cues) && job.result.cues.length > 0, 'real ASR returns source-time cues');

    const replacement = await client.call('subtitles.patch', {
      directory: projectDirectory,
      expectedRevision: beforeAsr.revision,
      requestId: 'electron-subtitles-1',
      patch: { enabled: true, sourceTrack: 'microphone', language: 'zh', replaceCues: job.result.cues },
    });
    const patched = await client.call('project.get', { directory: projectDirectory });
    assert.equal(patched.revision, replacement.revision);
    assert.equal(patched.project.subtitles.cues.length, job.result.cues.length);
    const correctionTarget = patched.project.subtitles.cues.find((cue) => /coldex|work\s*body/i.test(cue.text));
    assert.ok(correctionTarget, 'the spoken fixture contains a recognizable misspelled product name to correct');
    const correctedText = correctionTarget.text.replace(/coldex/ig, 'Codex').replace(/work\s*body/ig, 'WorkBuddy');
    assert.notEqual(correctedText, correctionTarget.text, 'subtitle correction must actually change text');
    const corrected = await client.call('subtitles.patch', {
      directory: projectDirectory,
      expectedRevision: patched.revision,
      requestId: 'electron-subtitles-correction-1',
      patch: { cues: [{ id: correctionTarget.id, text: correctedText }] },
    });
    assert.equal(corrected.revision, patched.revision + 1);
    assert.equal((await client.call('project.save', {
      directory: projectDirectory, expectedRevision: corrected.revision, requestId: 'electron-save-1',
    })).savedRevision, corrected.revision);

    const savedProject = JSON.parse(fs.readFileSync(path.join(projectDirectory, 'project.json'), 'utf8'));
    assert.equal(savedProject.revision, corrected.revision);
    assert.equal(savedProject.subtitles.cues.length, job.result.cues.length);

    const closed = waitForMessage(child, 'editor-closed', projectDirectory);
    child.send({ type: 'close-editor', directory: projectDirectory });
    await closed;
    const reopened = await client.call('project.open', { directory: projectDirectory });
    assert.equal(reopened.opened, true);
    const reloaded = await client.call('project.get', { directory: projectDirectory });
    assert.equal(reloaded.revision, corrected.revision);
    assert.equal(reloaded.project.subtitles.cues.length, job.result.cues.length);
    assert.equal(reloaded.project.subtitles.cues.find((cue) => cue.id === correctionTarget.id).text, correctedText);
    assert.equal(reloaded.project.timeline.segments[0].sourceStart, operations[0].start);

    let speedRevision = reloaded.revision;
    for (const speed of [8, 0.25, 1]) {
      const changed = await client.call('edit.apply', { directory: projectDirectory,
        expectedRevision: speedRevision, requestId: `electron-speed-${speed}`,
        operations: [{ type: 'speed', segmentId: segment.id, value: speed }] });
      speedRevision = changed.revision;
      const spedExcerpt = await client.call('media.audio_excerpt', { directory: projectDirectory,
        timeDomain: 'output', track: 'microphone', start: 0, duration: speed === 8 ? 0.25 : 1 });
      assert.equal(spedExcerpt.speed, speed);
      assert.equal(spedExcerpt.sourceDuration, speed === 8 ? 2 : speed);
    }
    await client.call('project.save', { directory: projectDirectory, expectedRevision: speedRevision, requestId: 'electron-save-speeds' });
    const interruptedExport = await client.call('export.start', { directory: projectDirectory,
      expectedRevision: speedRevision, requestId: 'electron-export-close', kind: 'video',
      outputFile: path.join(isolatedRoot, 'interrupted.mp4'), frameRate: 30 });
    assert.ok(interruptedExport.jobId);
    const exportOwnerClosed = waitForMessage(child, 'editor-closed', projectDirectory);
    child.send({ type: 'close-editor', directory: projectDirectory });
    await exportOwnerClosed;
    await client.call('project.open', { directory: projectDirectory });
    const shortExportProject = await client.call('edit.apply', { directory: projectDirectory,
      expectedRevision: speedRevision, requestId: 'electron-short-export-trim',
      operations: [{ type: 'trim', segmentId: segment.id, start: 15.5, end: 19.5 }] });
    const correctedFrame = await client.call('media.frame', { directory: projectDirectory, timeDomain: 'output', time: 1.5 });
    fs.writeFileSync(path.join(isolatedRoot, 'corrected-caption.png'), Buffer.from(correctedFrame.base64, 'base64'));
    const exportedAfterClose = await client.call('export.start', { directory: projectDirectory,
      expectedRevision: shortExportProject.revision, requestId: 'electron-export-after-close', kind: 'video',
      outputFile: path.join(isolatedRoot, 'after-close.mp4'), frameRate: 30 });
    const exportJob = await pollJob(client, projectDirectory, exportedAfterClose.jobId);
    assert.equal(exportJob.status, 'completed', `export after closing its previous owner must succeed: ${JSON.stringify(exportJob.error)}`);
    const exportedFile = path.join(isolatedRoot, 'after-close.mp4');
    assert.ok(fs.statSync(exportedFile).size > 1000);
    const probed = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', exportedFile], { encoding: 'utf8', windowsHide: true });
    assert.equal(probed.status, 0, probed.stderr);
    const metadata = JSON.parse(probed.stdout);
    assert.ok(metadata.streams.some((stream) => stream.codec_type === 'video'));
    assert.ok(metadata.streams.some((stream) => stream.codec_type === 'audio'));
    assert.ok(Math.abs(Number(metadata.format.duration) - 4) < 0.15, 'trimmed export has four-second duration');
    const decoded = spawnSync('ffmpeg', ['-v', 'error', '-i', exportedFile, '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true });
    assert.equal(decoded.status, 0, decoded.stderr);

    process.stdout.write(`Real Electron Agent integration passed: trim, atomic rejection, undo/redo, source/output capture, ASR (${job.result.cues.length} cues), subtitle patch/save, reopen persistence, 8x/0.25x audio, and export lock recovery after owner close.\nIsolated test data: ${isolatedRoot}\n`);
    success = true;
  } finally {
    client.close();
    if (child.connected) {
      try { child.send({ type: 'quit' }); } catch { /* The test process may already be exiting. */ }
    }
    if (child.exitCode === null) {
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        wait(35000).then(() => { if (child.exitCode === null) child.kill(); }),
      ]);
    }
    if (!success) process.stderr.write(`${capturedOutput}\nIsolated test data preserved at ${isolatedRoot}\n`);
  }
}

run().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
