'use strict';

// Test-only loader for the real Electron main process. It isolates userData,
// the configuration file, and project library before application modules load.
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

for (const name of ['RECLY_AGENT_TEST_USER_DATA', 'RECLY_AGENT_TEST_CONFIG', 'RECLY_AGENT_TEST_ROOT']) {
  if (!process.env[name]) throw new Error(`${name} is required for the isolated Agent Electron test`);
}

const mainPath = path.resolve(__dirname, '..', 'src', 'main', 'main.js');
let source = fs.readFileSync(mainPath, 'utf8').replace(/\r\n/g, '\n');
const electronImport = /^const \{ app, .* \} = require\('electron'\);$/m;
if (!electronImport.test(source)) throw new Error('Cannot locate Electron import in main.js');
source = source.replace(electronImport, (line) => `${line}
if (process.env.RECLY_AGENT_TEST_USER_DATA) {
  const testPath = require('node:path');
  app.setPath('userData', testPath.resolve(process.env.RECLY_AGENT_TEST_USER_DATA));
  require('./config').setConfigPath(testPath.resolve(process.env.RECLY_AGENT_TEST_CONFIG));
}`);

const projectsRootDeclaration = "const projectsRoot = () => (SELF_TEST ? path.join(app.getPath('temp'), 'dogsc-selftest') : getProjectsRoot());";
if (!source.includes(projectsRootDeclaration)) throw new Error('Cannot locate projectsRoot in main.js');
source = source.replace(
  projectsRootDeclaration,
  "const projectsRoot = () => process.env.RECLY_AGENT_TEST_ROOT ? path.resolve(process.env.RECLY_AGENT_TEST_ROOT) : (SELF_TEST ? path.join(app.getPath('temp'), 'dogsc-selftest') : getProjectsRoot());",
);

const bootMarker = "    showRecorder();\n    void listWindows().catch((error) => console.warn('[picker] Failed to preload window list:', error.message));";
if (!source.includes(bootMarker)) throw new Error('Cannot locate the normal application boot point in main.js');
source = source.replace(bootMarker, `    showRecorder();
    if (process.argv.includes('--agent-electron-selftest')) {
      process.on('message', (message) => {
        if (message?.type === 'close-editor') {
          const win = getEditorWindow(message.directory);
          if (!win) {
            if (typeof process.send === 'function') process.send({ type: 'editor-closed', directory: message.directory });
            return;
          }
          win.once('closed', () => {
            if (typeof process.send === 'function') process.send({ type: 'editor-closed', directory: message.directory });
          });
          win.close();
        } else if (message?.type === 'quit') {
          app.quit();
        }
      });
    }
    void listWindows().catch((error) => console.warn('[picker] Failed to preload window list:', error.message));`);

const compiledMain = new Module(mainPath, module);
compiledMain.filename = mainPath;
compiledMain.paths = Module._nodeModulePaths(path.dirname(mainPath));
compiledMain._compile(source, mainPath);
