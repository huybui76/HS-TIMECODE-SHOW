'use strict';

// Run the actual browser scripts, not extracted functions. All effects stay in memory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const indexPath = path.join(root, 'renderer/index.html');
const html = fs.readFileSync(indexPath, 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)].map((match) => {
  const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(match[1]);
  assert.ok(src, 'Every renderer script must have a local src');
  assert.ok(!/^(?:[a-z]+:|\/\/|\/)/i.test(src[1]), 'No external script: ' + src[1]);
  const file = path.resolve(path.dirname(indexPath), src[1]);
  assert.ok(file.startsWith(root + path.sep), 'Script escapes module root: ' + src[1]);
  assert.ok(fs.statSync(file).isFile(), 'Missing local script: ' + src[1]);
  return { src: src[1], file, source: fs.readFileSync(file, 'utf8') };
});

class FakeEventTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, fn, options) {
    assert.equal(typeof fn, 'function', 'Listener for ' + type);
    const list = this.listeners.get(type) || [];
    if (!list.some((entry) => entry.fn === fn)) list.push({ fn, once: !!options?.once });
    this.listeners.set(type, list);
  }
  removeEventListener(type, fn) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter((entry) => entry.fn !== fn));
  }
  dispatchEvent(event) {
    event.target ||= this;
    event.currentTarget = this;
    for (const entry of [...(this.listeners.get(event.type) || [])]) {
      if (entry.once) this.removeEventListener(event.type, entry.fn);
      entry.fn.call(this, event);
    }
    return !event.defaultPrevented;
  }
}

class FakeEvent {
  constructor(type, options = {}) { this.type = type; Object.assign(this, options); }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() {}
}

const canvasCalls = new Map();
const canvasContext = {};
for (const method of ['save', 'restore', 'beginPath', 'closePath', 'rect', 'clip', 'moveTo',
  'lineTo', 'arc', 'fill', 'stroke', 'fillRect', 'clearRect', 'strokeRect', 'fillText',
  'strokeText', 'setTransform', 'resetTransform', 'setLineDash', 'translate', 'scale',
  'rotate', 'quadraticCurveTo', 'bezierCurveTo', 'roundRect', 'drawImage']) {
  canvasContext[method] = () => canvasCalls.set(method, (canvasCalls.get(method) || 0) + 1);
}
canvasContext.measureText = (text) => ({ width: String(text).length * 7 });
canvasContext.createLinearGradient = () => ({ addColorStop() {} });

class FakeElement extends FakeEventTarget {
  constructor(tag, doc) {
    super();
    this.tagName = tag.toUpperCase(); this.ownerDocument = doc;
    this.children = []; this.parentElement = null; this.attributes = new Map();
    this.style = { setProperty(name, value) { this[name] = String(value); },
      removeProperty(name) { delete this[name]; }, getPropertyValue(name) { return this[name] || ''; } };
    this.dataset = {}; this.className = ''; this.id = ''; this._value = null; this._text = '';
    this.hidden = false; this.disabled = false; this.checked = false; this.selected = false;
    this.clientWidth = 960; this.clientHeight = 540; this.width = 960; this.height = 540;
    this.scrollTop = 0; this.scrollLeft = 0;
    this.paused = true; this.ended = false; this.currentTime = 0; this.duration = 0;
    this.volume = 1; this.playbackRate = 1; this.src = '';
    this.classList = {
      contains: (value) => this.className.split(/\s+/).includes(value),
      add: (...values) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...values])].join(' '); },
      remove: (...values) => { this.className = this.className.split(/\s+/).filter((value) => !values.includes(value)).join(' '); },
      toggle: (value, force) => {
        const on = force === undefined ? !this.classList.contains(value) : !!force;
        this.classList[on ? 'add' : 'remove'](value); return on;
      }
    };
  }
  get value() {
    if (this.tagName === 'SELECT' && this._value === null) {
      return (this.options.find((option) => option.selected) || this.options[0])?.value || '';
    }
    return this._value === null ? (this.tagName === 'OPTION' ? this.textContent.trim() : '') : this._value;
  }
  set value(value) { this._value = String(value); }
  get options() { return this.children.filter((node) => node.tagName === 'OPTION'); }
  get textContent() { return this._text + this.children.map((node) => node.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  get innerHTML() { return this._html || ''; }
  set innerHTML(value) { this.replaceChildren(); this._text = ''; this._html = String(value); parseHTML(this._html, this); }
  get firstChild() { return this.children[0] || null; }
  get lastChild() { return this.children.at(-1) || null; }
  get parentNode() { return this.parentElement; }
  get scrollHeight() { return this.children.length * 24; }
  get offsetWidth() { return this.clientWidth; }
  get offsetHeight() { return this.clientHeight; }
  appendChild(node) {
    if (node.tagName === '#FRAGMENT') { [...node.children].forEach((child) => this.appendChild(child)); return node; }
    node.remove(); node.parentElement = this; this.children.push(node); return node;
  }
  append(...nodes) { nodes.forEach((node) => this.appendChild(node)); }
  removeChild(node) {
    const index = this.children.indexOf(node); assert.ok(index >= 0, 'removeChild requires child');
    this.children.splice(index, 1); node.parentElement = null; return node;
  }
  remove() { if (this.parentElement) this.parentElement.removeChild(this); }
  replaceChildren(...nodes) { [...this.children].forEach((node) => this.removeChild(node)); this.append(...nodes); }
  setAttribute(name, value) {
    value = String(value); this.attributes.set(name, value);
    if (name === 'class') this.className = value;
    else if (name === 'id') this.id = value;
    else if (name === 'value') this.value = value;
    else if (name === 'style') {
      this.style.cssText = value;
      for (const declaration of value.split(';')) {
        const colon = declaration.indexOf(':');
        if (colon >= 0) this.style[declaration.slice(0, colon).trim().replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = declaration.slice(colon + 1).trim();
      }
    }
    else if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    else if (['hidden', 'checked', 'selected', 'disabled'].includes(name)) this[name] = true;
    else this[name] = value;
  }
  getAttribute(name) {
    if (name === 'id') return this.id || null;
    if (name === 'class') return this.className || null;
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name) { this.attributes.delete(name); if (name === 'src') this.src = ''; }
  matches(selector) {
    return selector.split(',').some((part) => {
      part = part.trim();
      const attrs = [...part.matchAll(/\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]/g)];
      part = part.replace(/\[[^\]]*\]/g, '');
      const tag = /^[\w-]+/.exec(part);
      const id = /#([\w-]+)/.exec(part);
      const classes = [...part.matchAll(/\.([\w-]+)/g)];
      return (!tag || this.tagName === tag[0].toUpperCase()) && (!id || this.id === id[1])
        && classes.every((match) => this.classList.contains(match[1]))
        && attrs.every((match) => this.getAttribute(match[1]) !== null
          && (match[2] === undefined || this.getAttribute(match[1]) === match[2]));
    });
  }
  querySelectorAll(selector) {
    const result = [];
    const visit = (parent) => parent.children.forEach((node) => {
      if (selector.split(',').some((part) => {
        const parts = part.trim().split(/\s+(?![^\[]*\])/); let at = node;
        if (!at.matches(parts.pop())) return false;
        while (parts.length) {
          const ancestor = parts.pop(); at = at.parentElement;
          while (at && !at.matches(ancestor)) at = at.parentElement;
          if (!at) return false;
        }
        return true;
      })) result.push(node);
      visit(node);
    });
    visit(this); return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
  getBoundingClientRect() { return { x: 0, y: 0, left: 0, top: 0, width: this.clientWidth, height: this.clientHeight, right: this.clientWidth, bottom: this.clientHeight }; }
  getContext(kind) { assert.equal(kind, '2d'); return canvasContext; }
  focus() { this.ownerDocument.activeElement = this; }
  blur() { this.ownerDocument.activeElement = this.ownerDocument.body; }
  select() {}
  setPointerCapture() {}
  releasePointerCapture() {}
  scrollIntoView() {}
  pause() { this.paused = true; }
  play() { this.paused = false; return Promise.resolve(); }
  load() {}
}

function parseHTML(source, parent) {
  const stack = [parent];
  const tokens = source.match(/<!--[\s\S]*?-->|<\/?[a-z](?:[^>"']|"[^"]*"|'[^']*')*>|[^<]+/gi) || [];
  for (const token of tokens) {
    if (token.startsWith('<!--')) continue;
    const close = /^<\/([\w-]+)/.exec(token);
    if (close) {
      const index = stack.findLastIndex((node) => node.tagName === close[1].toUpperCase());
      if (index > 0) stack.length = index;
      continue;
    }
    const open = /^<([\w-]+)\b([\s\S]*?)\/?\s*>$/.exec(token);
    if (!open) { stack.at(-1)._text += token; continue; }
    const node = new FakeElement(open[1], parent.ownerDocument);
    for (const attr of open[2].matchAll(/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+)))?/g)) {
      node.setAttribute(attr[1], attr[2] ?? attr[3] ?? attr[4] ?? '');
    }
    stack.at(-1).appendChild(node);
    if (!/^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i.test(open[1]) && !token.endsWith('/>')) stack.push(node);
  }
}

function makeBrowser() {
  const document = new FakeElement('#document', null); document.ownerDocument = document;
  document.createElement = (tag) => new FakeElement(tag, document);
  document.createElementNS = (_, tag) => document.createElement(tag);
  document.createDocumentFragment = () => document.createElement('#fragment');
  document.getElementById = (id) => document.querySelector('#' + id);
  parseHTML(html, document);
  document.body = document.querySelector('body'); document.documentElement = document.querySelector('html');
  document.activeElement = document.body;
  const callbacks = new Map(), calls = [], timers = new Map(), raf = new Map();
  let now = 0, nextId = 0;
  const hs = {};
  // These names are explicit preload APIs, never application-function fallbacks.
  for (const name of ['onOscPort', 'onOscProc', 'onOsc', 'onOscBatch', 'onStatus', 'onStats',
    'onOscTargets', 'onLanPeers', 'onLanProject', 'onLanControl', 'onMiniCmd', 'onMiniState',
    'onMiniSettings', 'onUiState', 'onConvItem', 'onConvState', 'onConvDone']) {
    hs[name] = (fn) => { const list = callbacks.get(name) || []; list.push(fn); callbacks.set(name, list); };
  }
  for (const name of ['oscMode', 'oscUi', 'sendUiState', 'lanSendControl', 'lanSendProject', 'openMini']) {
    hs[name] = (...args) => { calls.push({ name, args }); };
  }
  for (const name of ['send', 'setListenPort', 'setOscFloatAddresses', 'oscEnable', 'oscDisable']) {
    hs[name] = async (...args) => { calls.push({ name, args }); return true; };
  }
  hs.oscTargetsGet = async () => { calls.push({ name: 'oscTargetsGet' }); return []; };
  hs.oscTargetsSet = async (targets) => { calls.push({ name: 'oscTargetsSet', args: [targets] }); return structuredClone(targets); };
  hs.lanStatus = async () => { calls.push({ name: 'lanStatus' }); return { running: false, role: 'master', peers: [], group: 'TEST' }; };
  for (const name of ['readFileBuf', 'fileStat', 'openProject', 'saveProject', 'saveProjectTo',
    'openAudio', 'openAudioMulti', 'filePath', 'convStart', 'convScanFolder', 'convOpenFolder']) {
    hs[name] = () => { throw new Error('Unexpected file/device operation in bootstrap: hs.' + name); };
  }
  const storage = new Map(), consoleErrors = [];
  class FakeAudioContext {
    constructor() { this.state = 'running'; this.currentTime = 0; this.sampleRate = 48000; this.destination = {}; }
    resume() { return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
    decodeAudioData() { throw new Error('Unexpected audio decode in no-audio bootstrap'); }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    createMediaElementSource() { return { connect() {}, disconnect() {} }; }
  }
  const browser = Object.assign(new FakeEventTarget(), {
    document, hs, console: { log() {}, warn() {}, error: (...args) => consoleErrors.push(args) },
    navigator: { requestMIDIAccess: async () => { calls.push({ name: 'requestMIDIAccess' }); return { inputs: new Map() }; } },
    performance: { timeOrigin: 1700000000000, now: () => now },
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: (key) => storage.delete(key) },
    Event: FakeEvent, Audio: class extends FakeElement { constructor() { super('audio', document); } },
    AudioContext: FakeAudioContext, structuredClone,
    innerWidth: 1440, innerHeight: 900, devicePixelRatio: 1,
    confirm: () => false, alert() {}, prompt: () => null,
    getComputedStyle: (node) => node.style,
    setTimeout: (fn, delay = 0) => { const id = ++nextId; timers.set(id, { fn, at: now + delay, delay, repeat: false }); return id; },
    clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, delay) => { const id = ++nextId; timers.set(id, { fn, at: now + delay, delay, repeat: true }); return id; },
    clearInterval: (id) => timers.delete(id),
    requestAnimationFrame: (fn) => { const id = ++nextId; raf.set(id, fn); return id; },
    cancelAnimationFrame: (id) => raf.delete(id)
  });
  browser.window = browser; browser.self = browser; document.defaultView = browser;
  const context = vm.createContext(browser);
  const run = (source) => vm.runInContext(source, context, { timeout: 2000 });
  const invoke = (fn, ...args) => {
    browser.__callback = fn; browser.__args = args;
    try { return run('__callback(...__args)'); } finally { delete browser.__callback; delete browser.__args; }
  };
  return { browser, document, callbacks, calls, timers, raf, storage, consoleErrors, context, run, invoke,
    advance(ms) {
      const end = now + ms; let count = 0;
      while (true) {
        const pending = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!pending) break;
        assert.ok(++count <= 2000, 'Finite timer budget exceeded');
        const [id, timer] = pending; now = timer.at;
        if (timer.repeat) timer.at += timer.delay; else timers.delete(id);
        invoke(timer.fn);
      }
      now = end;
    },
    frame() {
      const batch = [...raf]; raf.clear();
      for (const [, fn] of batch) invoke(fn, now);
    }
  };
}

async function main() {
  let passed = 0, failed = 0;
  async function test(name, fn) {
    try { await fn(); passed++; console.log('PASS ' + name); }
    catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
  }
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); await new Promise(setImmediate); };
  const env = makeBrowser();
  try {
    await test('real HTML local scripts are packaged and dependencies precede app', () => {
      const required = ['../realtime-config.js', 'osc-feedback.js', 'rec-engine.js', 'cue-layout.js', 'curve-tools.js', 'cue-playback.js', 'app.js'];
      if (fs.existsSync(path.join(root, 'renderer/curve-editor.js'))) required.splice(-1, 0, 'curve-editor.js');
      for (const src of required) {
        assert.equal(scripts.filter((script) => script.src === src).length, 1, src + ' must load exactly once');
        if (src !== 'app.js') assert.ok(scripts.findIndex((script) => script.src === src) < scripts.findIndex((script) => script.src === 'app.js'), src + ' must precede app.js');
      }
      assert.ok(scripts.findIndex((script) => script.src === 'curve-tools.js') < scripts.findIndex((script) => script.src === 'curve-editor.js') || !required.includes('curve-editor.js'), 'Curve tools must precede editor');
      const packaged = [indexPath, ...scripts.map((script) => script.file)];
      if (fs.existsSync(path.join(root, 'recording-session.js'))) packaged.push(path.join(root, 'recording-session.js'));
      for (const file of packaged) {
        const relative = path.relative(root, file).split(path.sep).join('/');
        assert.ok(pkg.build.files.some((pattern) => pattern === relative || (pattern.endsWith('/**') && relative.startsWith(pattern.slice(0, -2)))), 'Not included in package build.files: ' + relative);
      }
    });
    await test('fake DOM comes from real HTML and VM has no host I/O APIs', () => {
      for (const match of html.matchAll(/\bid="([^"]+)"/g)) assert.ok(env.document.getElementById(match[1]), 'Parsed HTML ID: ' + match[1]);
      assert.equal(env.document.getElementById('fpsSel').value, '30');
      assert.equal(env.document.getElementById('speedSel').value, '1');
      assert.equal(env.document.querySelectorAll('#menubar .menu').length, 5);
      assert.equal(env.document.querySelectorAll('input[name="recMode"]').length, 2);
      for (const name of ['require', 'process', 'fetch', 'WebSocket', 'XMLHttpRequest']) assert.equal(env.run('typeof ' + name), 'undefined', name);
    });
    let loaded = false;
    await test('execute WHOLE renderer/app.js in real HTML script order', async () => {
      for (const script of scripts) vm.runInContext(script.source, env.context, { filename: script.file, timeout: 2000 });
      await drain();
      assert.equal(unhandled.length, 0, 'Unhandled bootstrap rejection');
      assert.equal(env.consoleErrors.length, 0, 'Renderer console.error during bootstrap');
      const model = env.run('state');
      assert.equal(model.folders.length, 1);
      assert.ok(model.lanes.length > 0);
      assert.equal(model.recArmed, false);
      assert.equal(model.audioClips.length, 0);
      assert.equal(env.document.getElementById('missing-dom-id'), null, 'Unknown IDs must not be fabricated');
      for (const name of ['HSCueLayout', 'HSCurveTools', 'HSPlayback']) assert.ok(env.browser[name], name + ' browser global');
      if (fs.existsSync(path.join(root, 'renderer/curve-editor.js'))) assert.equal(typeof env.browser.HSCurveEditor?.mount, 'function', 'Existing curve editor must be loaded from HTML');
      loaded = true;
    });
    // A bootstrap exception invalidates every later runtime assertion; never substitute application stubs.
    if (loaded) {
      await test('collected DOM/window/bridge handlers and bounded scheduled work', async () => {
        for (const name of ['onOscPort', 'onOscProc', 'onStatus', 'onStats', 'onOscTargets', 'onMiniCmd']) assert.ok(env.callbacks.get(name)?.length, name);
        assert.ok(env.document.listeners.get('keydown')?.length);
        assert.ok(env.browser.listeners.get('mouseup')?.length);
        assert.ok(env.document.getElementById('btnPlay').listeners.get('click')?.length);
        assert.ok(env.raf.size > 0, 'rAF must schedule without synchronous recursion');
        env.frame(); env.advance(850); env.frame(); await drain();
        assert.ok(env.calls.some((call) => call.name === 'requestMIDIAccess'), 'Deferred MIDI initialization ran against empty fake access');
        assert.ok(canvasCalls.get('fillRect') > 0, 'Real timeline drawing reached canvas');
      });
      await test('async OSC panel initialization uses only in-memory bridge promises', async () => {
        await env.run('initOscPanelOnce()'); await drain();
        assert.ok(env.calls.some((call) => call.name === 'oscTargetsGet'));
        assert.ok(env.calls.some((call) => call.name === 'oscTargetsSet'));
        assert.ok(env.calls.some((call) => call.name === 'lanStatus'));
        assert.equal(env.run('oscUI.targets.length'), 1);
        assert.ok(env.document.getElementById('oscTargetList').children.length > 0);
      });
      await test('production play/setFrame/engine/pause with REC off and no audio', async () => {
        env.run('state.recArmed = false; setFrame(30); play()');
        assert.equal(env.run('state.playing'), true);
        env.advance(100); env.frame(); await drain();
        assert.ok(env.run('state.frame') > 30);
        env.run('pause(true); setFrame(12)');
        assert.equal(env.run('state.playing'), false);
        assert.equal(env.run('state.frame'), 12);
        assert.equal(env.run('state.recArmed'), false);
        assert.equal(env.document.getElementById('player').paused, true);
        assert.ok(!env.calls.some((call) => call.name === 'send'), 'Empty show must not send OSC');
      });
      await test('no deferred bootstrap rejection or renderer error', async () => {
        await drain();
        assert.deepEqual(unhandled, []);
        assert.deepEqual(env.consoleErrors, []);
      });
    }
  } finally {
    env.timers.clear(); env.raf.clear(); process.removeListener('unhandledRejection', onUnhandled);
  }
  console.log(`Renderer bootstrap: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => { console.error(error.stack); process.exitCode = 1; });
