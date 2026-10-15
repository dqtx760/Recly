'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { AgentClient, readEndpoint } = require('../agent/client');
const { createAgentService } = require('../src/main/agent-service');

function waitFor(predicate, timeoutMs = 500) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('Timed out waiting for the test condition'));
      setTimeout(check, 2);
    };
    check();
  });
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => error.code === code);
}

async function main() {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recly-agent-service-'));
  const libraryRoot = path.join(testRoot, 'library');
  const projectDirectory = path.join(libraryRoot, 'sample.dogscproject');
  const outsideDirectory = path.join(testRoot, 'outside.dogscproject');
  const endpointFile = path.join(testRoot, 'agent-endpoint.json');
  fs.mkdirSync(projectDirectory, { recursive: true });
  fs.mkdirSync(outsideDirectory);
  fs.writeFileSync(path.join(projectDirectory, 'project.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(outsideDirectory, 'project.json'), '{}', 'utf8');

  let currentWindow = null;
  let shouldAutoRespond = true;
  const sent = [];
  let service;
  const createWindow = (directory) => {
    const webContents = {
      send(channel, payload) {
        if (channel !== 'agent:request') return;
        sent.push({ directory, payload });
        if (shouldAutoRespond) queueMicrotask(() => service.rendererResponse(webContents, { id: payload.id, result: { method: payload.method, params: payload.params } }));
      },
    };
    return { directory, webContents, isDestroyed: () => false };
  };
  service = createAgentService({
    endpointFile,
    projectsRoot: () => libraryRoot,
    listProjects: async () => [{ directory: projectDirectory, name: 'sample' }],
    openEditor: (directory) => {
      currentWindow = createWindow(directory);
      queueMicrotask(() => service.rendererReady(currentWindow.webContents, { directory }));
      return currentWindow;
    },
    getEditorWindow: (directory) => currentWindow && path.resolve(directory).toLowerCase() === path.resolve(currentWindow.directory).toLowerCase() ? currentWindow : null,
    isEditorSender: (sender, directory) => Boolean(currentWindow && sender === currentWindow.webContents && path.resolve(directory).toLowerCase() === path.resolve(currentWindow.directory).toLowerCase()),
    readyTimeoutMs: 30,
    requestTimeoutMs: 1000,
  });
  const client = new AgentClient({ endpointFile, timeoutMs: 1200 });

  try {
    await service.start();
    const endpoint = readEndpoint(endpointFile);
    await new Promise((resolve, reject) => {
      const socket = net.createConnection(endpoint.pipeName);
      let buffer = '';
      socket.on('connect', () => socket.write(`${JSON.stringify({ type: 'auth', token: 'incorrect' })}\n`));
      socket.on('data', (chunk) => {
        buffer += String(chunk);
        if (!buffer.includes('\n')) return;
        const response = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
        assert.deepEqual(response, { type: 'auth', ok: false });
        socket.destroy();
        resolve();
      });
      socket.on('error', reject);
    });

    assert.deepEqual(await client.call('project.list'), [{ directory: projectDirectory, name: 'sample' }]);
    await assert.rejects(client.call('system.run', {}), (error) => error.code === 'METHOD_NOT_FOUND');
    assert.throws(() => service.resolveProjectDirectory(outsideDirectory), (error) => error.code === 'PROJECT_NOT_FOUND');
    await expectCode(client.call('project.open', { directory: outsideDirectory }), 'PROJECT_NOT_FOUND');

    const opened = await client.call('project.open', { directory: projectDirectory });
    assert.equal(opened.opened, true);
    assert.equal(opened.directory, fs.realpathSync(projectDirectory));
    assert.equal((await client.call('project.get', { directory: projectDirectory })).method, 'project.get');

    for (const speed of [0.25, 8]) {
      const excerpt = await client.call('media.audio_excerpt', { directory: projectDirectory,
        timeDomain: 'output', track: 'microphone', start: 0, duration: 1, speed });
      assert.equal(excerpt.params.speed, speed);
    }
    await expectCode(client.call('media.audio_excerpt', { directory: projectDirectory,
      timeDomain: 'output', track: 'microphone', start: 0, duration: 1, speed: 8.1 }), 'INVALID_PARAMS');

    const firstWrite = { directory: projectDirectory, expectedRevision: 0, requestId: 'same-write' };
    const before = sent.length;
    const writeResult = await client.call('history.undo', firstWrite);
    assert.equal(writeResult.method, 'history.undo');
    assert.equal(sent.length, before + 1);
    assert.equal((await client.call('history.undo', firstWrite)).method, 'history.undo');
    assert.equal(sent.length, before + 1, 'same request id and content is idempotent');
    await expectCode(client.call('history.undo', { ...firstWrite, expectedRevision: 1 }), 'REQUEST_ID_CONFLICT');

    const queuedWindow = currentWindow;
    shouldAutoRespond = false;
    const firstQueued = client.call('history.undo', { directory: projectDirectory, expectedRevision: 0, requestId: 'queue-1' });
    await waitFor(() => sent.length === before + 2);
    const secondQueued = client.call('history.redo', { directory: projectDirectory, expectedRevision: 0, requestId: 'queue-2' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sent.length, before + 2, 'write calls are serialized per project');
    service.rendererResponse(queuedWindow.webContents, { id: sent[sent.length - 1].payload.id, result: { accepted: 1 } });
    assert.equal((await firstQueued).accepted, 1);
    await waitFor(() => sent.length === before + 3);
    service.rendererResponse(queuedWindow.webContents, { id: sent[sent.length - 1].payload.id, result: { accepted: 2 } });
    assert.equal((await secondQueued).accepted, 2);

    shouldAutoRespond = true;
    service.rendererClosed(projectDirectory);
    const pending = client.call('timeline.get', { directory: projectDirectory });
    await expectCode(pending, 'EDITOR_NOT_READY');
    const closedPending = client.call('project.get', { directory: projectDirectory });
    const dispatchCount = sent.length;
    shouldAutoRespond = false;
    service.rendererReady(queuedWindow.webContents, { directory: projectDirectory });
    await waitFor(() => sent.length > dispatchCount);
    service.rendererClosed(projectDirectory);
    await expectCode(closedPending, 'EDITOR_CLOSED');

    const outsideWindow = createWindow(outsideDirectory);
    currentWindow = outsideWindow;
    assert.equal(service.resolveProjectDirectory(outsideDirectory), fs.realpathSync(outsideDirectory));
    service.rendererReady(outsideWindow.webContents, { directory: outsideDirectory });
    shouldAutoRespond = true;
    assert.equal((await client.call('project.get', { directory: outsideDirectory })).method, 'project.get');
    const focusedOutside = await client.call('project.open', { directory: outsideDirectory });
    assert.equal(focusedOutside.opened, true, 'already-open outside-library projects can be focused for Agent handoff');
    assert.equal(focusedOutside.directory, fs.realpathSync(outsideDirectory));
    currentWindow = null;
    service.rendererClosed(outsideDirectory);
    await expectCode(client.call('project.open', { directory: outsideDirectory }), 'PROJECT_NOT_FOUND');
  } finally {
    client.close();
    await service.close();
    for (const file of [path.join(projectDirectory, 'project.json'), path.join(outsideDirectory, 'project.json'), endpointFile]) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    for (const directory of [projectDirectory, outsideDirectory, libraryRoot, testRoot]) {
      if (fs.existsSync(directory)) fs.rmdirSync(directory);
    }
  }

  process.stdout.write('Agent service protocol, authentication, request validation, dedupe, queueing, ready/closed, and project boundaries passed.\n');
}

main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
