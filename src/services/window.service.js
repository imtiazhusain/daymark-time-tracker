'use strict';

// active-win 9 is ESM-only. This is still a CommonJS project: dynamic import
// works in Node 18.18+ and avoids the incompatible require('active-win').
let loader;
let warned = false;
async function getActiveWindow() {
  try {
    loader ||= import('active-win');
    const { activeWindow } = await loader;
    const current = await activeWindow();
    warned = false;
    return {
      title: current?.title || '',
      appName: current?.owner?.name || '',
      processPath: current?.owner?.path || ''
    };
  } catch (error) {
    if (!warned) console.warn(`[window] Active window unavailable: ${error.message || error}`);
    warned = true;
    loader = null;
    return { title: '', appName: '', processPath: '' };
  }
}
module.exports = { getActiveWindow };
