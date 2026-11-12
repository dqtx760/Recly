'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');

function normalizeModel(value) {
  if (typeof value !== 'string') return null;
  const model = value.trim();
  if (!model || model.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9.+:/-]*$/.test(model)
    || /^(?:sk|rk|pk|key|token)[-_]|^(?:ghp|gho|ghu|ghs|ghr)_|^github_pat_|^AIza[A-Za-z0-9_-]{20,}|^eyJ[A-Za-z0-9_-]{16,}/i.test(model)
    || (model.length >= 48 && /^[A-Za-z0-9+/=_-]+$/.test(model))) return null;
  return model;
}

function readJsonModel(filePath) {
  try {
    const settings = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return normalizeModel(settings?.model);
  } catch { return null; }
}

function readClaudeConfiguredModel({ env = process.env, home = os.homedir(), workDirectory } = {}) {
  const configured = [normalizeModel(env.ANTHROPIC_MODEL)];
  if (home) configured.push(readJsonModel(path.join(home, '.claude', 'settings.json')));
  if (workDirectory) {
    configured.push(readJsonModel(path.join(workDirectory, '.claude', 'settings.json')));
    configured.push(readJsonModel(path.join(workDirectory, '.claude', 'settings.local.json')));
  }
  const distinct = [...new Set(configured.filter(Boolean))];
  return distinct.length === 1 ? distinct[0] : null;
}

function runtimeModelFromCodexEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  if (!['session_meta', 'session.metadata', 'thread.started', 'turn.started', 'turn.completed'].includes(event.type)) return null;
  const candidates = [
    event.model, event.model_id, event.model_slug,
    event.session?.model, event.session?.model_id,
    event.thread?.model, event.thread?.model_id,
    event.turn?.model, event.turn?.model_id,
    event.payload?.model, event.payload?.model_id, event.payload?.model_slug,
  ];
  return candidates.map(normalizeModel).find(Boolean) || null;
}

function runtimeModelFromCodexEvents(output) {
  let model = null;
  for (const line of String(output || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { model = runtimeModelFromCodexEvent(JSON.parse(line)) || model; } catch {}
  }
  return model;
}

function runtimeModelFromClaudeEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return null;
  const direct = normalizeModel(envelope.model);
  if (direct) return direct;
  const usageModels = envelope.modelUsage && typeof envelope.modelUsage === 'object' && !Array.isArray(envelope.modelUsage)
    ? Object.keys(envelope.modelUsage).map(normalizeModel).filter(Boolean)
    : [];
  const distinct = [...new Set(usageModels)];
  return distinct.length === 1 ? distinct[0] : null;
}

function readCodexConfiguredModel({ executable, cwd, env = process.env, spawnProcess = spawn, timeoutMs = 1500 } = {}) {
  if (!executable) return Promise.resolve(null);
  return new Promise((resolve) => {
    let child, timer, buffer = '', finished = false;
    const decoder = new StringDecoder('utf8');
    const finish = (model = null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { child?.kill(); } catch {}
      resolve(normalizeModel(model));
    };
    const send = (message) => {
      try { child.stdin.write(`${JSON.stringify(message)}\n`); }
      catch { finish(); }
    };
    const onLine = (line) => {
      if (!line.trim()) return;
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id === 1) {
        if (message.error) { finish(); return; }
        send({ method: 'initialized' });
        send({ id: 2, method: 'config/read', params: { cwd: cwd || null, includeLayers: false } });
      } else if (message.id === 2) {
        finish(message.result?.config?.model);
      } else if (message.method && Object.hasOwn(message, 'id')) {
        send({ id: message.id, error: { code: -32601, message: 'Method not supported by Recly model reader' } });
      }
    };

    try {
      child = spawnProcess(executable, ['app-server', '--listen', 'stdio://'], {
        cwd, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch { finish(); return; }
    if (!child?.stdin || !child?.stdout) { finish(); return; }
    timer = setTimeout(() => finish(), timeoutMs);
    child.stdout.on('data', (chunk) => {
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer, 'utf8') > 1024 * 1024) { finish(); return; }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        onLine(line);
        if (finished) return;
      }
    });
    child.stderr?.on('data', () => {});
    child.on('error', () => finish());
    child.on('close', () => finish());
    child.stdin.on('error', () => finish());
    send({ id: 1, method: 'initialize', params: {
      clientInfo: { name: 'recly-model-reader', version: '1.0.0' },
      capabilities: { experimentalApi: false },
    } });
  });
}

module.exports = {
  normalizeModel,
  readClaudeConfiguredModel,
  runtimeModelFromCodexEvent,
  runtimeModelFromCodexEvents,
  runtimeModelFromClaudeEnvelope,
  readCodexConfiguredModel,
};
