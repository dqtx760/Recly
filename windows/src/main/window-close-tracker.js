'use strict';

function createWindowCloseTracker() {
  const closingByWindow = new WeakMap();
  const pending = new Set();

  function close(window) {
    if (!window || window.isDestroyed()) return Promise.resolve();
    const existing = closingByWindow.get(window);
    if (existing) return existing;

    let resolveClosed;
    const promise = new Promise((resolve) => { resolveClosed = resolve; });
    closingByWindow.set(window, promise);
    pending.add(promise);
    const finish = () => {
      if (closingByWindow.get(window) === promise) closingByWindow.delete(window);
      pending.delete(promise);
      resolveClosed();
    };
    window.once('closed', finish);
    if (window.isDestroyed()) finish();
    else {
      try {
        window.close();
      } catch (error) {
        window.removeListener('closed', finish);
        if (closingByWindow.get(window) === promise) closingByWindow.delete(window);
        pending.delete(promise);
        throw error;
      }
    }
    return promise;
  }

  async function waitForPending() {
    while (pending.size) await Promise.all([...pending]);
  }

  return { close, waitForPending };
}

module.exports = { createWindowCloseTracker };
