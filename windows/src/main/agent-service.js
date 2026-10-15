'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const { METHODS, METHOD_NAMES, WRITE_METHODS } = require('../../agent/api');
const METHOD_SCHEMAS = new Map(METHODS.map((method) => [method.name, method.inputSchema]));

const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

function serviceError(code, message) {
  return Object.assign(new Error(message), { code });
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function safeWrite(socket, value) {
  if (socket.destroyed || !socket.writable) return false;
  try {
    socket.write(`${JSON.stringify(value)}\n`, (error) => {
      if (error && !socket.destroyed) socket.destroy();
    });
    return true;
  } catch {
    if (!socket.destroyed) socket.destroy();
    return false;
  }
}

function validateSchema(value, schema, fieldName = 'params') {
  const expected = schema.type;
  const valid = expected === 'object'
    ? value !== null && typeof value === 'object' && !Array.isArray(value)
    : expected === 'array'
      ? Array.isArray(value)
      : expected === 'integer'
        ? Number.isSafeInteger(value)
        : expected === 'number'
          ? Number.isFinite(value)
          : expected === 'boolean'
            ? typeof value === 'boolean'
            : expected === 'string'
              ? typeof value === 'string'
              : true;
  if (!valid) throw serviceError('INVALID_PARAMS', `${fieldName} must be ${expected}`);
  if (schema.enum && !schema.enum.includes(value)) throw serviceError('INVALID_PARAMS', `${fieldName} has an unsupported value`);
  if (expected === 'object') {
    for (const required of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, required)) throw serviceError('INVALID_PARAMS', `${fieldName}.${required} is required`);
    }
    const properties = schema.properties || {};
    for (const key of Object.keys(value)) {
      if (schema.additionalProperties === false && !Object.prototype.hasOwnProperty.call(properties, key)) {
        throw serviceError('INVALID_PARAMS', `${fieldName}.${key} is not supported`);
      }
      if (properties[key]) validateSchema(value[key], properties[key], `${fieldName}.${key}`);
    }
  }
  if (expected === 'array' && schema.items) {
    value.forEach((item, index) => validateSchema(item, schema.items, `${fieldName}[${index}]`));
  }
}

function createAgentService({
  endpointFile,
  projectsRoot,
  listProjects,
  openEditor,
  getEditorWindow,
  isEditorSender,
  readyTimeoutMs = 15000,
  requestTimeoutMs = 120000,
}) {
  let server = null;
  let endpoint = null;
  const sockets = new Set();
  const readyDirectories = new Set();
  const readyWaiters = new Map();
  const pending = new Map();
  const dedupe = new Map();
  const writeQueues = new Map();

  function normalizedProjectDirectory(directory) {
    if (typeof directory !== 'string' || !directory.trim()) throw serviceError('INVALID_PARAMS', 'directory must be a non-empty path');
    let resolved;
    try { resolved = fs.realpathSync(directory); } catch { throw serviceError('PROJECT_NOT_FOUND', 'Project directory does not exist'); }
    if (!fs.statSync(resolved).isDirectory() || !fs.existsSync(path.join(resolved, 'project.json'))) {
      throw serviceError('PROJECT_NOT_FOUND', 'Directory is not a valid Recly project');
    }
    return resolved;
  }

  function resolveProjectDirectory(directory, { allowOpenOutsideLibrary = true } = {}) {
    const resolved = normalizedProjectDirectory(directory);
    let root;
    try { root = fs.realpathSync(projectsRoot()); } catch { root = null; }
    if (root && (resolved === root || isInside(root, resolved))) return resolved;
    const win = allowOpenOutsideLibrary ? getEditorWindow(resolved) : null;
    if (win && !win.isDestroyed()) return resolved;
    throw serviceError('PROJECT_NOT_FOUND', 'Project must be in the Recly library or already open in the editor');
  }

  function validateRequest(method, params) {
    if (!METHOD_NAMES.has(method)) throw serviceError('METHOD_NOT_FOUND', `Unsupported method: ${String(method)}`);
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw serviceError('INVALID_PARAMS', 'params must be a JSON object');
    validateSchema(params, METHOD_SCHEMAS.get(method));
    if (method !== 'project.list') {
      params.directory = resolveProjectDirectory(params.directory);
    }
    if (WRITE_METHODS.has(method)) {
      if (typeof params.requestId !== 'string' || !params.requestId.trim() || params.requestId.length > 200) {
        throw serviceError('INVALID_PARAMS', 'Write methods require a requestId of at most 200 characters');
      }
      if (!Number.isSafeInteger(params.expectedRevision) || params.expectedRevision < 0) {
        throw serviceError('INVALID_PARAMS', 'Write methods require a non-negative expectedRevision');
      }
    }
    if (method === 'transcript.generate' && (!['microphone', 'systemAudio'].includes(params.track) || !['source', 'retained'].includes(params.scope))) {
      throw serviceError('INVALID_PARAMS', 'track and scope are invalid');
    }
    if (method === 'edit.apply' && (typeof params.planId !== 'string' || !params.planId.trim()) && !Array.isArray(params.operations)) {
      throw serviceError('INVALID_PARAMS', 'edit.apply requires planId or operations');
    }
    if (method === 'media.audio_excerpt') {
      if (!['source', 'output'].includes(params.timeDomain) || !Number.isFinite(params.start) || params.start < 0 ||
          !Number.isFinite(params.duration) || params.duration <= 0 || params.duration > 30 ||
          (params.track !== undefined && !['microphone', 'systemAudio'].includes(params.track)) ||
          !params.track ||
          (params.speed !== undefined && (!Number.isFinite(params.speed) || params.speed < 0.25 || params.speed > 8)) ||
          (params.timeDomain === 'source' && params.speed !== undefined && params.speed !== 1)) {
        throw serviceError('INVALID_PARAMS', 'Audio excerpt requires a valid time range, timeDomain, and source track');
      }
    }
    if (method === 'media.frame' && (!['source', 'output'].includes(params.timeDomain) || !Number.isFinite(params.time) || params.time < 0)) {
      throw serviceError('INVALID_PARAMS', 'Frame requires timeDomain and a non-negative time');
    }
    if (method === 'subtitles.patch' && (!params.patch || typeof params.patch !== 'object' || Array.isArray(params.patch))) {
      throw serviceError('INVALID_PARAMS', 'subtitles.patch requires a patch object');
    }
    return params;
  }

  function waitForReady(directory, win) {
    if (readyDirectories.has(directory)) return Promise.resolve();
    if (!win || win.isDestroyed()) return Promise.reject(serviceError('EDITOR_CLOSED', 'Editor window is closed'));
    return new Promise((resolve, reject) => {
      const waiters = readyWaiters.get(directory) || new Set();
      const waiter = { win, resolve, reject };
      waiters.add(waiter);
      readyWaiters.set(directory, waiters);
      waiter.timer = setTimeout(() => {
        waiters.delete(waiter);
        if (!waiters.size) readyWaiters.delete(directory);
        reject(serviceError('EDITOR_NOT_READY', 'Editor did not finish initialization before the timeout'));
      }, readyTimeoutMs);
    });
  }

  function dispatchToEditor(directory, method, params) {
    const win = getEditorWindow(directory);
    if (!win || win.isDestroyed()) throw serviceError('PROJECT_NOT_OPEN', 'Open this project in the editor first');
    return waitForReady(directory, win).then(() => new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(serviceError('REQUEST_TIMEOUT', 'Editor request timed out'));
      }, requestTimeoutMs);
      pending.set(id, { id, directory, sender: win.webContents, resolve, reject, timeout });
      try {
        win.webContents.send('agent:request', { id, method, params });
      } catch (error) {
        clearTimeout(timeout);
        pending.delete(id);
        reject(serviceError('EDITOR_CLOSED', error.message || 'Could not send request to the editor'));
      }
    }));
  }

  function dispatchOnce(method, params) {
    if (!WRITE_METHODS.has(method)) return dispatch(method, params);
    const key = `${params.directory}\0${params.requestId}`;
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(canonicalize({ method, params }))).digest('hex');
    const existing = dedupe.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw serviceError('REQUEST_ID_CONFLICT', 'A requestId cannot be reused with different content');
      return existing.promise.then((outcome) => {
        if (outcome.error) throw serviceError(outcome.error.code, outcome.error.message);
        return outcome.result;
      });
    }
    const previous = writeQueues.get(params.directory) || Promise.resolve();
    const operation = previous.catch(() => {}).then(() => dispatch(method, params));
    const tail = operation.then(() => {}, () => {}).finally(() => {
      if (writeQueues.get(params.directory) === tail) writeQueues.delete(params.directory);
    });
    writeQueues.set(params.directory, tail);
    const promise = operation.then(
      (result) => ({ result }),
      (error) => ({ error: { code: error.code || 'INTERNAL_ERROR', message: error.message || String(error) } }),
    );
    dedupe.set(key, { fingerprint, promise });
    while (dedupe.size > 256) dedupe.delete(dedupe.keys().next().value);
    return promise.then((outcome) => {
      if (outcome.error) throw serviceError(outcome.error.code, outcome.error.message);
      return outcome.result;
    });
  }

  async function dispatch(method, params) {
    if (method === 'project.list') return listProjects();
    if (method === 'project.open') {
      const directory = resolveProjectDirectory(params.directory);
      const win = openEditor(directory);
      await waitForReady(directory, win);
      return { directory, opened: true };
    }
    if (method === 'export.start') validateExportDestination(params);
    return dispatchToEditor(params.directory, method, params);
  }

  function validateExportDestination(params) {
    const outputFile = path.resolve(params.outputFile || '');
    const extension = path.extname(outputFile).toLowerCase();
    const expected = params.kind === 'audio' ? '.m4a' : '.mp4';
    if (!['video', 'audio'].includes(params.kind) || extension !== expected) throw serviceError('INVALID_PARAMS', 'Output extension must match the export kind');
    if (fs.existsSync(outputFile)) throw serviceError('OUTPUT_EXISTS', 'Output already exists and cannot be overwritten');
    let parent;
    try { parent = fs.realpathSync(path.dirname(outputFile)); } catch { throw serviceError('INVALID_PARAMS', 'Output directory does not exist'); }
    if (!fs.statSync(parent).isDirectory()) throw serviceError('INVALID_PARAMS', 'Output parent is not a directory');
    const projectFile = path.join(params.directory, 'project.json');
    const referenced = new Set([path.resolve(projectFile).toLowerCase()]);
    try {
      const project = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
      const collect = (value) => {
        if (Array.isArray(value)) return value.forEach(collect);
        if (!value || typeof value !== 'object') return;
        for (const [key, child] of Object.entries(value)) {
          if (key === 'file' && typeof child === 'string') {
            referenced.add(path.resolve(path.isAbsolute(child) ? child : path.join(params.directory, child)).toLowerCase());
          } else collect(child);
        }
      };
      collect(project);
    } catch { throw serviceError('PROJECT_NOT_FOUND', 'Could not read the project media manifest'); }
    if (referenced.has(outputFile.toLowerCase())) throw serviceError('INVALID_PARAMS', 'Output cannot replace a project file or source asset');
    return outputFile;
  }

  function handleLine(socket, state, line) {
    let message;
    try { message = JSON.parse(line); } catch { socket.destroy(); return; }
    if (!state.authenticated) {
      const supplied = Buffer.from(typeof message.token === 'string' ? message.token : '');
      const expected = Buffer.from(endpoint.token);
      const authorized = message.type === 'auth' && supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
      safeWrite(socket, { type: 'auth', ok: authorized });
      if (!authorized) socket.destroy();
      else state.authenticated = true;
      return;
    }
    if (message.type !== 'request' || (typeof message.id !== 'string' && typeof message.id !== 'number')) {
      safeWrite(socket, { id: message.id ?? null, ok: false, error: { code: 'INVALID_REQUEST', message: 'Invalid request envelope' } });
      return;
    }
    let params;
    try { params = validateRequest(message.method, { ...(message.params || {}) }); } catch (error) {
      safeWrite(socket, { id: message.id, ok: false, error: { code: error.code || 'INVALID_PARAMS', message: error.message } });
      return;
    }
    Promise.resolve().then(() => dispatchOnce(message.method, params)).then(
      (result) => safeWrite(socket, { id: message.id, ok: true, result }),
      (error) => safeWrite(socket, { id: message.id, ok: false, error: { code: error.code || 'INTERNAL_ERROR', message: error.message || String(error) } }),
    );
  }

  function attachSocket(socket) {
    sockets.add(socket);
    const decoder = new StringDecoder('utf8');
    const state = { authenticated: false, buffer: '' };
    const authTimer = setTimeout(() => { if (!state.authenticated) socket.destroy(); }, 10000);
    socket.setNoDelay(true);
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      state.buffer += decoder.write(chunk);
      if (Buffer.byteLength(state.buffer) > MAX_MESSAGE_BYTES) { socket.destroy(); return; }
      let newline;
      while ((newline = state.buffer.indexOf('\n')) >= 0) {
        const line = state.buffer.slice(0, newline);
        state.buffer = state.buffer.slice(newline + 1);
        handleLine(socket, state, line);
      }
    });
    socket.on('close', () => { clearTimeout(authTimer); sockets.delete(socket); });
  }

  function rendererReady(sender, payload) {
    const directory = typeof payload?.directory === 'string' ? path.resolve(payload.directory) : '';
    if (!directory || !isEditorSender(sender, directory)) return false;
    readyDirectories.add(directory);
    const waiters = readyWaiters.get(directory);
    if (waiters) {
      readyWaiters.delete(directory);
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
    }
    return true;
  }

  function rendererResponse(sender, payload) {
    if (!payload || typeof payload.id !== 'string') return false;
    const request = pending.get(payload.id);
    if (!request || request.sender !== sender || !isEditorSender(sender, request.directory)) return false;
    clearTimeout(request.timeout);
    pending.delete(payload.id);
    if (payload.error && typeof payload.error === 'object') {
      request.reject(serviceError(String(payload.error.code || 'EDITOR_ERROR'), String(payload.error.message || 'Editor request failed')));
    } else request.resolve(payload.result);
    return true;
  }

  function rendererClosed(directory) {
    const normalized = path.resolve(directory);
    readyDirectories.delete(normalized);
    for (const [id, request] of pending) {
      if (request.directory !== normalized) continue;
      clearTimeout(request.timeout);
      pending.delete(id);
      request.reject(serviceError('EDITOR_CLOSED', 'Editor window is closed'));
    }
    const waiters = readyWaiters.get(normalized);
    if (waiters) {
      readyWaiters.delete(normalized);
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(serviceError('EDITOR_CLOSED', 'Editor window is closed'));
      }
    }
  }

  async function start() {
    if (server) return { endpointFile, pipeName: endpoint.pipeName };
    const pipeName = process.platform === 'win32'
      ? `\\\\.\\pipe\\recly-agent-${crypto.randomUUID()}`
      : path.join(os.tmpdir(), `recly-agent-${process.pid}-${crypto.randomUUID()}.sock`);
    endpoint = { version: 1, pipeName, token: crypto.randomBytes(32).toString('hex'), pid: process.pid };
    fs.mkdirSync(path.dirname(endpointFile), { recursive: true });
    fs.writeFileSync(endpointFile, JSON.stringify(endpoint), { encoding: 'utf8', mode: 0o600 });
    server = net.createServer(attachSocket);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(pipeName, () => { server.removeListener('error', reject); resolve(); });
    });
    return { endpointFile, pipeName };
  }

  async function close() {
    for (const socket of sockets) socket.destroy();
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(serviceError('SERVICE_STOPPED', 'Recly Agent service stopped'));
    }
    pending.clear();
    for (const waiters of readyWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(serviceError('SERVICE_STOPPED', 'Recly Agent service stopped'));
      }
    }
    readyWaiters.clear();
    if (server) await new Promise((resolve) => server.close(resolve));
    server = null;
    if (endpoint && fs.existsSync(endpointFile)) {
      try {
        const current = JSON.parse(fs.readFileSync(endpointFile, 'utf8'));
        if (current.token === endpoint.token) fs.unlinkSync(endpointFile);
      } catch { /* Keep a locator another process replaced. */ }
    }
    endpoint = null;
  }

  return { start, close, rendererReady, rendererResponse, rendererClosed, resolveProjectDirectory };
}

module.exports = { createAgentService, serviceError };
