// End-to-end smoke gate for the two interactive browser surfaces. It uses
// Chrome's DevTools protocol directly so the docs site keeps a dependency-free
// build and still catches module-loading, WASM, and UI/API integration breaks.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const profile = mkdtempSync(join(tmpdir(), 'marionette-browser-check-'));
const children = [];

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (existsSync(mac)) return mac;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try {
      return execFileSync('which', [name], { encoding: 'utf8' }).trim();
    } catch {
      // Try the next common executable name.
    }
  }
  throw new Error(
    'Chrome not found; set CHROME_PATH or install Google Chrome/Chromium ' +
    '(this optional gate requires Node >= 22)',
  );
}

function waitForOutput(child, stream, pattern, timeoutMs) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${pattern}; output:\n${output}`));
    }, timeoutMs);
    const onData = (chunk) => {
      output += chunk;
      const match = output.match(pattern);
      if (match) {
        cleanup();
        resolve(match);
      }
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(
        `process exited before ${pattern} (code ${String(code)}, signal ${String(signal)}):\n${output}`,
      ));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      stream.off('data', onData);
      child.off('exit', onExit);
    };
    stream.on('data', onData);
    child.on('exit', onExit);
  });
}

async function pageTarget(debugBase) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${debugBase}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) =>
        target.type === 'page' && target.url.startsWith('http://127.0.0.1:'));
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // Chrome can announce DevTools just before the HTTP endpoint is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('timed out waiting for the Chrome page target');
}

async function connect(url) {
  if (typeof WebSocket === 'undefined') {
    throw new Error('check:browser requires Node >= 22 (global WebSocket is unavailable)');
  }
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const exceptions = [];
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails;
      exceptions.push(details.exception?.description ?? details.text);
    }
  });

  const call = (method, params = {}) => {
    const id = nextId++;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result.value;
  };
  const waitFor = async (expression, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const value = await evaluate(expression);
        if (value) return value;
      } catch {
        // Navigation briefly destroys the execution context; retry on the new one.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`timed out waiting for browser condition: ${expression}`);
  };

  await call('Runtime.enable');
  await call('Page.enable');
  return { socket, call, evaluate, waitFor, exceptions };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
}

try {
  const preview = spawn(process.execPath, ['build/serve.mjs'], {
    cwd: root,
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(preview);
  preview.stderr.pipe(process.stderr);
  const previewMatch = await waitForOutput(
    preview,
    preview.stdout,
    /preview: (http:\/\/127\.0\.0\.1:\d+)/,
    10_000,
  );
  const site = previewMatch[1];

  const chrome = spawn(chromePath(), [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--remote-allow-origins=*',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    `${site}/`,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  children.push(chrome);
  const devtoolsMatch = await waitForOutput(
    chrome,
    chrome.stderr,
    /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+)\//,
    15_000,
  );
  const debugBase = devtoolsMatch[1].replace(/^ws:/, 'http:');
  const cdp = await connect(await pageTarget(debugBase));

  await cdp.waitFor(
    `document.querySelector("[data-node]")?.textContent?.includes("say_hello")`,
  );
  const homeChoice = await cdp.evaluate(
    `document.querySelector("[data-choices] button")?.textContent`,
  );
  assert(homeChoice?.includes('Continue automatically'), 'home playground did not render its choice');
  await cdp.evaluate(`document.querySelector("[data-choices] button").click(); true`);
  await cdp.waitFor(`document.querySelector("[data-node]")?.textContent?.includes("END")`);

  await cdp.call('Page.navigate', { url: `${site}/examples` });
  await cdp.waitFor(`document.querySelectorAll("[data-mini]").length >= 3`);
  await cdp.waitFor(
    `[...document.querySelectorAll("[data-mini-status]")].every(` +
    `element => element.textContent.trim().length > 0)`,
    60_000,
  );
  const statuses = await cdp.evaluate(
    `[...document.querySelectorAll("[data-mini-status]")].map(element => element.textContent)`,
  );
  assert(statuses[0].includes('say_hello'), 'hello-world example did not initialize');
  assert(statuses[1].includes('observation required'), 'observation example did not initialize');
  assert(statuses[2].includes('build_checkout'), 'human-gated example did not initialize');

  await cdp.evaluate(
    `document.querySelector("[data-mini] [data-choices] button").click(); true`,
  );
  await cdp.waitFor(
    `document.querySelector("[data-mini] [data-node]")?.textContent?.includes("END")`,
  );
  assert(
    cdp.exceptions.length === 0,
    `browser exception(s):\n${cdp.exceptions.join('\n\n')}`,
  );
  cdp.socket.close();
  console.log('browser: home playground + 3 examples initialize; both UIs walk to END');
} finally {
  for (const child of children.reverse()) {
    await stopChild(child);
  }
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
