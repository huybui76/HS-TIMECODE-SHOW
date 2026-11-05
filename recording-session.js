'use strict';

const realtime = require('./realtime-config');
const { rdp, groupKeyFor } = require('./renderer/rec-engine');

const DEFAULTS = realtime;

function copy(value) {
  if (Array.isArray(value)) return value.map(copy);
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (ArrayBuffer.isView(value)) {
    if (value instanceof DataView) return new DataView(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    return new value.constructor(value);
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = copy(value[key]);
    return out;
  }
  return value;
}

function numeric(args) {
  return args.findIndex((value) => typeof value === 'number' && Number.isFinite(value));
}

function order(a, b) { return a.t - b.t || a.order - b.order; }

class RecordingSession {
  constructor({ config, emit, onMapping, onWarning } = {}) {
    if (typeof emit !== 'function') throw new TypeError('RecordingSession requires emit(action)');
    this.config = Object.freeze(Object.assign({}, DEFAULTS, config));
    if (this.config.FLOAT_MAX_POINTS < 2 || this.config.OSC_RING_CAPACITY < 2) {
      throw new RangeError('Recording capacities must retain at least two endpoints');
    }
    this.emit = emit;
    this.onMapping = onMapping || (() => {});
    this.onWarning = onWarning || (() => {});
    this.phase = 'idle';
    this.nextId = 0;
    this._reset();
  }

  _reset() {
    this.notes = [];
    this.floats = [];
    this.activeNotes = new Map();
    this.activeFloats = new Map();
    this.osc = [];
    this.streams = [];
    this.addresses = new Map();
    this.mappings = new Map();
    this.warnings = new Set();
    this.eventOrder = 0;
    this.now = -Infinity;
    this.cutoff = Infinity;
    this.finishDeadline = Infinity;
  }

  start({ session, fps, anchorEpoch, anchorFrame, speed = 1, mappings = [], smpteInput } = {}) {
    if (this.phase !== 'idle' || !this.isDrained()) throw new Error('Previous recording session has not drained');
    if (![fps, anchorEpoch, anchorFrame, speed].every(Number.isFinite) || fps <= 0 || speed <= 0) {
      throw new TypeError('Finite anchors, positive fps and speed are required');
    }
    this._reset();
    this.session = session;
    this.anchor = Object.freeze({ fps, anchorEpoch, anchorFrame, speed,
      latency: this.config.RECORD_LATENCY_COMPENSATION_MS, smpteInput: copy(smpteInput) });
    this.mappings = new Map(mappings.map(([key, value]) => [key, copy(value)]));
    while (this.mappings.size > this.config.REC_MAPPING_MAX) this.mappings.delete(this.mappings.keys().next().value);
    this.phase = 'recording';
    return this;
  }

  _frame(t) {
    const a = this.anchor;
    return Math.max(0, Math.round(a.anchorFrame + (t - a.anchorEpoch - a.latency) * a.fps * a.speed / 1000));
  }

  _key(event) {
    const key = `${event.kind === 'cc' ? 'cc' : 'n'}${event.num}c${event.ch}`;
    return event.device == null ? key : `${event.device}|${key}`;
  }

  _warn(key, text) {
    if (!this.warnings.has(key)) {
      this.warnings.add(key);
      if (this.warnings.size > this.config.OSC_FILTER_CACHE_SIZE) this.warnings.delete(this.warnings.values().next().value);
      this.onWarning(text);
    }
  }

  _info(address) {
    if (this.addresses.has(address)) return this.addresses.get(address);
    const parts = address.split('/').filter(Boolean);
    const last = parts[parts.length - 1];
    const note = parts[0] === 'composition' && (last === 'connect' ||
      (last === 'clear' && (parts.includes('layers') || parts.includes('selectedlayer'))));
    const path = [];
    let selected = false;
    let specificity = 0;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part.startsWith('selected')) {
        selected = true;
        path.push(part.slice(8), '*');
      } else if (['layers', 'clips', 'columns', 'groups'].includes(part) && i + 1 < parts.length) {
        path.push(part.slice(0, -1), parts[++i]);
        specificity += 20;
      } else path.push(part);
    }
    const info = { note, selected, specificity, path, last };
    if (this.addresses.size >= this.config.OSC_FILTER_CACHE_SIZE) this.addresses.delete(this.addresses.keys().next().value);
    this.addresses.set(address, info);
    return info;
  }

  _alias(a, b) {
    if (a === b) return false;
    const x = this._info(a), y = this._info(b);
    if (!x.selected && !y.selected) return false;
    // A selectedclip route may omit its containing layer altogether.
    const short = x.path.length <= y.path.length ? x.path : y.path;
    const long = x.path.length <= y.path.length ? y.path : x.path;
    const offset = long.length - short.length;
    if (offset && short[1] !== 'clip') return false;
    for (let i = offset ? 1 : 0; i < short.length; i++) {
      const j = offset && i ? i + offset : i;
      if (short[i] !== long[j] && short[i] !== '*' && long[j] !== '*') return false;
    }
    return true;
  }

  ingestOsc(event) {
    if (this.phase === 'idle' || !event || typeof event.address !== 'string' ||
        !event.address.startsWith('/') || event.address.length < 2 ||
        !Array.isArray(event.args) || !Number.isFinite(event.t)) return false;
    if (this.phase === 'finishing' && event.t > this.cutoff + this.config.MATCH_WINDOW_MS) return false;
    const args = copy(event.args);
    const info = this._info(event.address);
    const valueIndex = numeric(args);
    const rec = { address: event.address, args, t: event.t, seq: event.seq,
      order: ++this.eventOrder, valueIndex, owner: null };
    if (info.note) {
      for (const note of this.notes) {
        if (!note.primary) continue;
        const aliases = this._takeAliases(note.primary, [rec], note.id);
        if (aliases.length) {
          note.extras.push(...aliases);
          return true;
        }
      }
    }
    // Integer payloads such as custom trigger IDs are not automation curves.
    const floatValue = valueIndex >= 0 && args[valueIndex] >= 0 && args[valueIndex] <= 1;
    if (info.note || !floatValue) {
      this.osc.push(rec);
    } else {
      let stream = this.streams.find((s) => s.address === rec.address &&
        rec.t >= s.start - this.config.FLOAT_IDLE_TIMEOUT_MS && rec.t <= s.last + this.config.FLOAT_IDLE_TIMEOUT_MS);
      if (!stream) {
        stream = { address: rec.address, start: rec.t, last: rec.t, points: [] };
        this.streams.push(stream);
      }
      stream.start = Math.min(stream.start, rec.t);
      stream.last = Math.max(stream.last, rec.t);
      stream.points.push(rec);
      stream.points.sort(order);
      this._capPoints(stream.points, `osc:${stream.address}`);
    }
    this._boundStorage(event.t);
    return true;
  }

  midi(event) {
    if (this.phase === 'idle' || !event || !['noteOn', 'noteOff', 'cc'].includes(event.kind) ||
        !Number.isFinite(event.t) || !Number.isInteger(event.num) || event.num < 0 || event.num > 127 ||
        !Number.isInteger(event.ch) || event.ch < 1 || event.ch > 16 ||
        (event.kind !== 'noteOff' && (!Number.isFinite(event.value) || event.value < 0 || event.value > 127)) ||
        event.t > this.cutoff) return false;
    const key = this._key(event);
    if (event.kind === 'noteOff') {
      const note = this.activeNotes.get(key);
      if (!note || event.t < note.t) return false;
      note.end = event.t;
      this.activeNotes.delete(key);
      return true;
    }
    if (event.kind === 'noteOn') {
      const previous = this.activeNotes.get(key);
      if (previous) previous.end = Math.max(previous.t, event.t);
      const note = { id: ++this.nextId, key, num: event.num, ch: event.ch, vel: event.value,
        device: event.device, t: event.t, order: ++this.eventOrder, end: this.phase === 'finishing' ? this.cutoff : null,
        resolved: false, primary: null, extras: [] };
      this.notes.push(note);
      this.activeNotes.set(key, note);
    } else {
      let f = this.activeFloats.get(key);
      if (f && event.t - f.last >= this.config.FLOAT_IDLE_TIMEOUT_MS) {
        this.activeFloats.delete(key);
        f = null;
      }
      if (!f) {
        f = { id: ++this.nextId, key, num: event.num, ch: event.ch, device: event.device,
          t: event.t, last: event.t, order: ++this.eventOrder, points: [] };
        this.floats.push(f);
        this.activeFloats.set(key, f);
      }
      f.last = Math.max(f.last, event.t);
      f.t = Math.min(f.t, event.t);
      f.points.push({ t: event.t, value: event.value / 127, order: ++this.eventOrder });
      f.points.sort(order);
      this._capPoints(f.points, `midi:${key}`);
    }
    if (this.notes.length + this.floats.length > this.config.OSC_PENDING_MIDI_MAX) {
      this.tick(event.t);
      this._warn('midi-cap', 'Pending MIDI capacity reached; oldest gesture finalized early');
      while (this.notes.length + this.floats.length > this.config.OSC_PENDING_MIDI_MAX) {
        const oldest = [...this.notes, ...this.floats].sort(order)[0];
        if (this.notes.includes(oldest)) {
          oldest.end = oldest.end == null ? event.t : oldest.end;
          this._resolveNote(oldest);
          this._emitNote(oldest);
        } else this._emitFloat(oldest, null);
      }
    }
    return true;
  }

  _capPoints(points, key) {
    const cap = this.config.FLOAT_MAX_POINTS;
    if (points.length <= cap) return;
    this._warn(`points:${key}`, `FLOAT_MAX_POINTS reached for ${key}; interior samples reduced, endpoints retained`);
    const reduced = [points[0]];
    for (let i = 2; i < points.length - 1; i += 2) reduced.push(points[i]);
    reduced.push(points[points.length - 1]);
    points.splice(0, points.length, ...reduced);
  }

  _floatOverlaps(f, start, end) {
    return start <= f.last + this.config.MATCH_WINDOW_MS && end >= f.t - this.config.MATCH_PRE_MS;
  }

  _protected(rec) {
    return this.notes.some((n) => (!n.resolved && rec.t >= n.t - this.config.MATCH_PRE_MS &&
      rec.t <= n.t + this.config.MATCH_WINDOW_MS) || (n.primary && n.end != null &&
      rec.address === n.primary.address && rec.t >= n.end - this.config.MATCH_PRE_MS &&
      rec.t <= n.end + this.config.MATCH_WINDOW_MS));
  }

  _boundStorage(t) {
    const oldest = t - this.config.OSC_BUFFER_SECONDS * 1000;
    const retained = this.osc.filter((r) => r.t >= oldest || this._protected(r));
    if (retained.length !== this.osc.length) this._warn('expired', 'OSC retention expired before tick; old unowned events dropped');
    this.osc = retained;
    this.streams = this.streams.filter((s) => {
      if (s.last >= oldest || this.floats.some((f) => this._floatOverlaps(f, s.start, s.last))) return true;
      this._warn('expired', 'OSC retention expired before tick; old unowned events dropped');
      return false;
    });
    let size = this.osc.length + this.streams.reduce((n, s) => n + s.points.length, 0);
    while (size > this.config.OSC_RING_CAPACITY) {
      this._warn('osc-cap', 'OSC_RING_CAPACITY reached; oldest unowned OSC data dropped');
      this.osc.sort(order);
      const stream = this.streams.reduce((best, s) => !best || s.start < best.start ? s : best, null);
      if (this.osc.length && (!stream || this.osc[0].t <= stream.start)) {
        this.osc.shift();
        size--;
      } else if (stream.points.length > 2) {
        stream.points.splice(1, 1);
        size--;
      } else {
        size -= stream.points.length;
        this.streams.splice(this.streams.indexOf(stream), 1);
      }
    }
  }

  _primary(candidates) {
    candidates.sort(order);
    if (!candidates.length) return null;
    const first = candidates[0];
    const cluster = candidates.filter((r) => r === first ||
      (Math.abs(r.t - first.t) <= this.config.MATCH_ALIAS_MS && this._alias(r.address, first.address)));
    cluster.sort((a, b) => this._info(b.address).specificity - this._info(a.address).specificity || order(a, b));
    return cluster[0];
  }

  _takeAliases(primary, candidates, id) {
    const extras = [];
    for (const rec of candidates) {
      if (rec.owner != null || rec === primary || !this._alias(primary.address, rec.address) ||
          Math.abs(rec.t - primary.t) > this.config.MATCH_ALIAS_MS ||
          rec.args[rec.valueIndex] !== primary.args[primary.valueIndex]) continue;
      rec.owner = id;
      extras.push({ address: rec.address, args: copy(rec.args), t: rec.t,
        dtMs: rec.t - primary.t, seq: rec.seq, alias: true });
    }
    return extras;
  }

  _resolveNote(note) {
    const c = this.config;
    const candidates = this.osc.filter((r) => r.owner == null && this._info(r.address).note &&
      !(this._info(r.address).last === 'connect' && r.args[r.valueIndex] === 0) &&
      r.t >= note.t - c.MATCH_PRE_MS && r.t <= note.t + c.MATCH_WINDOW_MS);
    note.primary = this._primary(candidates);
    note.resolved = true;
    if (note.primary) {
      note.primary.owner = note.id;
      note.extras.push(...this._takeAliases(note.primary, candidates, note.id));
    }
  }

  _base(item, kind, source, end) {
    return { id: item.id, actionId: item.id, session: this.session, kind, source,
      num: item.num, ch: item.ch, vel: item.vel, device: item.device,
      startFrame: this._frame(item.t), durationFrames: kind === 'trigger' ?
        Math.max(1, Math.round(this.config.DEFAULT_TRIGGER_LENGTH_S * this.anchor.fps)) :
        Math.max(0, this._frame(end) - this._frame(item.t)),
      startMs: item.t, endMs: end, holdMs: Math.max(0, end - item.t),
      address: '', args: [], keyframes: [], matched: false, guessed: false, unassigned: source === 'midi',
      score: 0, matchLatencyMs: null, extras: [], keyframesRaw: 0, keyframesSent: 0,
      dataOrigin: source, smpteInput: copy(this.anchor.smpteInput) };
  }

  _fallback(cue, key) {
    const mapping = this.mappings.get(key);
    if (this.config.USE_LEARNED_MAPPING_FALLBACK && mapping && typeof mapping.address === 'string' && mapping.address) {
      cue.address = mapping.address;
      cue.args = Array.isArray(mapping.args) ? copy(mapping.args) : [];
      cue.guessed = true;
      cue.unassigned = false;
    }
  }

  _publish(cue, key) {
    cue.laneGroup = groupKeyFor(cue);
    if (key && cue.matched) {
      const mapping = { address: cue.address, args: copy(cue.args), kind: cue.kind };
      this.mappings.set(key, copy(mapping));
      while (this.mappings.size > this.config.REC_MAPPING_MAX) this.mappings.delete(this.mappings.keys().next().value);
      this.onMapping(key, mapping);
    }
    this.emit(cue);
  }

  _emitNote(note) {
    const end = Math.max(note.t, note.end);
    const kind = end - note.t >= this.config.PIANO_HOLD_THRESHOLD_S * 1000 ? 'piano' : 'trigger';
    const cue = this._base(note, kind, 'midi', end);
    if (note.primary) {
      cue.address = note.primary.address;
      cue.args = copy(note.primary.args);
      cue.matched = true;
      cue.unassigned = false;
      cue.dataOrigin = 'osc';
      cue.score = 1;
      cue.matchLatencyMs = note.primary.t - note.t;
      cue.extras = note.extras;
      for (const rec of this.osc.sort(order)) {
        if (rec.owner != null || this._info(rec.address).last !== 'connect' || rec.args[rec.valueIndex] !== 0 ||
            (rec.address !== cue.address && !this._alias(rec.address, cue.address)) ||
            rec.t < end - this.config.MATCH_PRE_MS || rec.t > end + this.config.MATCH_WINDOW_MS) continue;
        rec.owner = note.id;
        cue.extras.push({ address: rec.address, args: copy(rec.args), t: rec.t, seq: rec.seq, release: true });
        // Each actual release plus its selected aliases belongs to one note only.
        cue.extras.push(...this._takeAliases(rec, this.osc, note.id));
        break;
      }
    } else this._fallback(cue, note.key);
    this.notes.splice(this.notes.indexOf(note), 1);
    if (this.activeNotes.get(note.key) === note) this.activeNotes.delete(note.key);
    this._publish(cue, note.key);
  }

  _floatOptions(f) {
    const byAddress = new Map();
    for (const stream of this.streams) {
      for (const rec of stream.points) {
        if (rec.owner != null || rec.t < f.t - this.config.MATCH_PRE_MS || rec.t > f.last + this.config.MATCH_WINDOW_MS) continue;
        if (!byAddress.has(rec.address)) byAddress.set(rec.address, []);
        byAddress.get(rec.address).push(rec);
      }
    }
    const options = [];
    for (const [address, records] of byAddress) {
      records.sort(order);
      const c = this.config;
      const sampleCount = Math.min(f.points.length, c.FLOAT_MATCH_MAX_SAMPLES);
      const samples = Array.from({ length: sampleCount }, (_, i) =>
        f.points[Math.round(i * (f.points.length - 1) / Math.max(1, sampleCount - 1))]);
      const lags = new Set();
      const addLag = (lag) => {
        if (lag >= -c.MATCH_PRE_MS && lag <= c.MATCH_WINDOW_MS && lags.size < c.FLOAT_MATCH_MAX_LAGS) lags.add(lag);
      };
      addLag(0); addLag(-c.MATCH_PRE_MS); addLag(c.MATCH_WINDOW_MS);
      addLag(records[0].t - f.t); addLag(records[records.length - 1].t - f.last);
      const grid = Math.max(2, Math.floor(c.FLOAT_MATCH_MAX_LAGS / 2));
      for (let i = 0; i < grid; i++) addLag(-c.MATCH_PRE_MS + i * (c.MATCH_PRE_MS + c.MATCH_WINDOW_MS) / (grid - 1));
      for (let i = 0; i < sampleCount && lags.size < c.FLOAT_MATCH_MAX_LAGS; i++) {
        addLag(records[Math.round(i * (records.length - 1) / Math.max(1, sampleCount - 1))].t - samples[i].t);
      }
      let best = null;
      // Monotonic cursors make each bounded lag trial linear, not a pairwise scan.
      for (const lag of lags) {
        const pairs = [];
        let index = 0, used = -1, distance = 0;
        for (const point of samples) {
          const target = point.t + lag;
          while (index + 1 < records.length &&
              Math.abs(records[index + 1].t - target) < Math.abs(records[index].t - target)) index++;
          const nearest = records[index];
          if (index === used || nearest.t < point.t - c.MATCH_PRE_MS || nearest.t > point.t + c.MATCH_WINDOW_MS) continue;
          used = index;
          distance += Math.abs(nearest.t - point.t);
          pairs.push([point.value, nearest.args[nearest.valueIndex]]);
        }
        if (pairs.length < c.FLOAT_MATCH_MIN_PAIRS) continue;
        const meanA = pairs.reduce((n, p) => n + p[0], 0) / pairs.length;
        const meanB = pairs.reduce((n, p) => n + p[1], 0) / pairs.length;
        let cross = 0, aa = 0, bb = 0;
        for (const [a, b] of pairs) {
          cross += (a - meanA) * (b - meanB);
          aa += (a - meanA) ** 2;
          bb += (b - meanB) ** 2;
        }
        const correlation = aa && bb ? Math.abs(cross / Math.sqrt(aa * bb)) : 0;
        const proximity = 1 - Math.min(1, distance / pairs.length / (c.MATCH_PRE_MS + c.MATCH_WINDOW_MS));
        const coverage = pairs.length / samples.length;
        const score = (correlation * 0.8 + proximity * 0.2) * coverage;
        if (correlation >= c.FLOAT_MATCH_MIN_CORRELATION && score >= c.FLOAT_MATCH_MIN_SCORE &&
            (!best || score > best.score)) {
          best = { address, records, score, correlation, lag };
        }
      }
      if (best) options.push(best);
    }
    options.sort((a, b) => b.score - a.score || this._info(b.address).specificity - this._info(a.address).specificity ||
      order(a.records[0], b.records[0]));
    // Concrete and selected aliases represent one candidate, not ambiguity.
    const distinct = [];
    for (const option of options) {
      const alias = distinct.find((other) => this._alias(other.address, option.address) &&
        Math.abs(other.score - option.score) < this.config.FLOAT_MATCH_AMBIGUITY);
      if (!alias) distinct.push(option);
      else if (this._info(option.address).specificity > this._info(alias.address).specificity) {
        distinct[distinct.indexOf(alias)] = option;
      }
    }
    return distinct;
  }

  _curve(cue, records) {
    const points = records.map((r) => ({ dt: Math.max(0, r.t - cue.startMs),
      ms: Math.max(0, r.t - cue.startMs), value: r.valueIndex == null ? r.value : r.args[r.valueIndex],
      ...(r.args ? { args: copy(r.args), t: r.t, seq: r.seq } : {}) }));
    // Count only available samples entering this action's RDP pass, never stream history.
    cue.keyframesRaw = records.length;
    cue.keyframes = rdp(points, this.config.FLOAT_RDP_EPSILON);
    cue.keyframesSent = cue.keyframes.length;
  }

  _emitFloat(f, option) {
    const cue = this._base(f, 'float', 'midi', f.last);
    if (option) {
      const records = option.records.filter((r) => r.owner == null);
      cue.startMs = Math.min(f.t, records[0].t);
      cue.endMs = Math.max(f.last, records[records.length - 1].t);
      cue.startFrame = this._frame(cue.startMs);
      cue.durationFrames = Math.max(0, this._frame(cue.endMs) - cue.startFrame);
      cue.holdMs = cue.endMs - cue.startMs;
      cue.address = option.address;
      cue.args = copy(records[records.length - 1].args);
      cue.matched = true;
      cue.unassigned = false;
      cue.score = option.score;
      cue.matchLatencyMs = records[0].t - f.t;
      cue.dataOrigin = 'osc';
      for (const rec of records) {
        rec.owner = f.id;
        for (const stream of this.streams) cue.extras.push(...this._takeAliases(rec, stream.points, f.id));
      }
      this._curve(cue, records);
    } else {
      this._fallback(cue, f.key);
      cue.dataOrigin = 'midi';
      this._curve(cue, f.points);
    }
    this.floats.splice(this.floats.indexOf(f), 1);
    if (this.activeFloats.get(f.key) === f) this.activeFloats.delete(f.key);
    this._publish(cue, f.key);
  }

  tick(now) {
    if (this.phase === 'idle' || !Number.isFinite(now)) return;
    this.now = Math.max(this.now, now);
    // Transport may still deliver pre-cutoff events throughout the drain window.
    if (this.phase === 'finishing' && this.now < this.finishDeadline) return;
    const c = this.config;
    for (const note of this.notes.slice().sort(order)) {
      if (!note.resolved && this.now >= note.t + c.MATCH_WINDOW_MS) this._resolveNote(note);
      if (note.resolved && note.end != null && this.now >= Math.max(note.t, note.end) + c.MATCH_WINDOW_MS) this._emitNote(note);
    }
    const ready = this.floats.filter((f) => this.now >= f.last + Math.max(c.FLOAT_IDLE_TIMEOUT_MS, c.MATCH_WINDOW_MS));
    const choices = new Map(ready.map((f) => [f, this._floatOptions(f)]));
    const proposals = [];
    for (const [f, options] of choices) {
      if (!options.length || (options[1] && options[0].score - options[1].score < c.FLOAT_MATCH_AMBIGUITY)) continue;
      proposals.push({ f, option: options[0] });
    }
    proposals.sort((a, b) => b.option.score - a.option.score || order(a.f, b.f));
    const assigned = new Map();
    for (const proposal of proposals) {
      const { f, option } = proposal;
      const contested = proposals.some((p) => p !== proposal &&
        (p.option.address === option.address || this._alias(p.option.address, option.address)) &&
        this._floatOverlaps(p.f, f.t, f.last) && Math.abs(p.option.score - option.score) < c.FLOAT_MATCH_AMBIGUITY);
      if (contested || option.records.some((r) => r.owner != null)) continue;
      if ([...assigned].some(([other, pick]) => this._alias(pick.address, option.address) &&
          this._floatOverlaps(other, f.t, f.last))) continue;
      // A still-open simultaneous CC can also make this address ambiguous.
      if (this.floats.some((other) => !ready.includes(other) && this._floatOverlaps(other, f.t, f.last) &&
          this._floatOptions(other).some((o) => (o.address === option.address || this._alias(o.address, option.address)) &&
            Math.abs(o.score - option.score) < c.FLOAT_MATCH_AMBIGUITY))) continue;
      assigned.set(f, option);
      for (const rec of option.records) rec.owner = f.id;
    }
    // Reservations above prevent a later proposal from stealing any sample.
    for (const [f, option] of assigned) for (const rec of option.records) if (rec.owner === f.id) rec.owner = null;
    for (const f of ready.sort(order)) this._emitFloat(f, assigned.get(f) || null);
    this.osc = this.osc.filter((r) => r.owner == null);
    for (const stream of this.streams) stream.points = stream.points.filter((r) => r.owner == null);
    this.streams = this.streams.filter((s) => s.points.length);

    for (const rec of this.osc.slice().sort(order)) {
      if (rec.owner != null || this.now < rec.t + c.MATCH_PRE_MS + c.REC_DIRECT_GRACE_MS || this._protected(rec)) continue;
      if (rec.t > this.cutoff || rec.t < this.anchor.anchorEpoch) { rec.owner = 'cutoff'; continue; }
      const candidates = this.osc.filter((r) => r.owner == null && r.t <= this.cutoff &&
        r.t >= this.anchor.anchorEpoch && !this._protected(r));
      const primary = this._primary(candidates.filter((r) => r === rec ||
        (this._alias(r.address, rec.address) && Math.abs(r.t - rec.t) <= c.MATCH_ALIAS_MS)));
      primary.owner = ++this.nextId;
      const cue = this._base({ id: primary.owner, t: primary.t }, 'trigger', 'osc', primary.t);
      cue.address = primary.address;
      cue.args = copy(primary.args);
      cue.extras = this._takeAliases(primary, candidates, primary.owner);
      this._publish(cue);
    }
    this.osc = this.osc.filter((r) => r.owner == null);
    const streams = this.streams.slice().sort((a, b) => {
      if (this._alias(a.address, b.address) && Math.abs(a.start - b.start) <= c.MATCH_ALIAS_MS) {
        return this._info(b.address).specificity - this._info(a.address).specificity || a.start - b.start;
      }
      return a.start - b.start;
    });
    for (const stream of streams) {
      const records = stream.points.filter((r) => r.owner == null && r.t <= this.cutoff &&
        r.t >= this.anchor.anchorEpoch).sort(order);
      if (!records.length) continue;
      if (this.now < Math.min(stream.last, this.cutoff) + c.FLOAT_IDLE_TIMEOUT_MS + c.REC_DIRECT_GRACE_MS ||
          this.floats.some((f) => this._floatOverlaps(f, stream.start, stream.last))) continue;
      const cue = this._base({ id: ++this.nextId, t: records[0].t }, 'float', 'osc', records[records.length - 1].t);
      cue.address = stream.address;
      cue.args = copy(records[records.length - 1].args);
      for (const rec of records) {
        rec.owner = cue.id;
        for (const other of this.streams) cue.extras.push(...this._takeAliases(rec, other.points, cue.id));
      }
      this._curve(cue, records);
      this._publish(cue);
    }
    for (const stream of this.streams) stream.points = stream.points.filter((r) => r.owner == null &&
      ((r.t <= this.cutoff && r.t >= this.anchor.anchorEpoch) || this.floats.some((f) => this._floatOverlaps(f, r.t, r.t))));
    this.streams = this.streams.filter((s) => s.points.length);
    if (this.phase === 'finishing' && this.now >= this.finishDeadline && this.isDrained()) this.phase = 'idle';
  }

  finish(cutoff) {
    if (this.phase === 'idle') return;
    if (!Number.isFinite(cutoff)) throw new TypeError('finish requires an epoch cutoff');
    if (this.phase === 'finishing') return;
    this.cutoff = cutoff;
    this.phase = 'finishing';
    this.finishDeadline = cutoff + Math.max(this.config.MATCH_WINDOW_MS, this.config.FLOAT_IDLE_TIMEOUT_MS) + this.config.REC_DIRECT_GRACE_MS;
    for (const note of this.notes.slice()) {
      if (note.t > cutoff) {
        this.notes.splice(this.notes.indexOf(note), 1);
        if (this.activeNotes.get(note.key) === note) this.activeNotes.delete(note.key);
        for (const rec of this.osc) if (rec.owner === note.id) rec.owner = null;
      } else {
        note.end = Math.min(note.end == null ? cutoff : note.end, cutoff);
        if (!note.primary) note.resolved = false;
      }
    }
    for (const f of this.floats.slice()) {
      f.points = f.points.filter((point) => point.t <= cutoff);
      if (!f.points.length) {
        this.floats.splice(this.floats.indexOf(f), 1);
        if (this.activeFloats.get(f.key) === f) this.activeFloats.delete(f.key);
      } else f.last = f.points[f.points.length - 1].t;
    }
    // Close gestures now, but resolve only after transport has had time to drain.
    this.now = Math.max(this.now, cutoff);
  }

  preview(now) {
    if (this.phase === 'idle' || !Number.isFinite(now)) return [];
    const at = Math.min(now, this.cutoff);
    const result = [];
    const add = (item, kind, source, end, address, args, points) => {
      if (result.length >= this.config.REC_PREVIEW_MAX_ITEMS) return;
      const cue = this._base(item, kind, source, end);
      cue.address = address || '';
      cue.args = copy(args || []);
      cue.unassigned = !cue.address;
      cue.recordingSpeed = this.anchor.speed;
      if (points && points.length) {
        const stride = Math.max(1, Math.ceil((points.length - 1) / (this.config.REC_PREVIEW_MAX_POINTS - 1)));
        const selected = [];
        for (let i = 0; i < points.length - 1; i += stride) selected.push(points[i]);
        selected.push(points[points.length - 1]);
        cue.keyframes = selected.map((point) => ({ dt: Math.max(0, point.t - item.t),
          value: point.value === undefined && point.args ? point.args[point.valueIndex] : point.value }));
      }
      result.push(cue);
    };
    for (const note of this.notes) {
      const end = Math.min(note.end == null ? at : note.end, at);
      const kind = end - note.t >= this.config.PIANO_HOLD_THRESHOLD_S * 1000 ? 'piano' : 'trigger';
      add(note, kind, 'midi', end, note.primary && note.primary.address, note.primary && note.primary.args);
    }
    for (const item of this.floats) {
      const mapping = this.mappings.get(item.key);
      add(item, 'float', 'midi', Math.min(item.last, at), mapping && mapping.address,
        mapping && mapping.args, item.points);
    }
    for (const stream of this.streams) {
      if (this.floats.some((item) => this._floatOverlaps(item, stream.start, stream.last))) continue;
      const points = stream.points.filter((point) => point.owner == null && point.t <= at);
      if (!points.length) continue;
      add({ id: 'osc:' + stream.address, t: points[0].t }, 'float', 'osc', points[points.length - 1].t,
        stream.address, points[points.length - 1].args, points);
    }
    return result;
  }

  isDrained() {
    return !this.notes.length && !this.floats.length && !this.osc.length && !this.streams.length &&
      (this.phase !== 'finishing' || this.now >= this.finishDeadline);
  }

  abort(reason = 'aborted') {
    const report = { session: this.session, reason, notes: this.notes.length, floats: this.floats.length,
      osc: this.osc.length + this.streams.reduce((n, s) => n + s.points.length, 0),
      unmatched: [...this.notes, ...this.floats].map((item) => ({ actionId: item.id, key: item.key })) };
    this._warn('abort', `Recording session ${String(this.session)} aborted with ${report.unmatched.length} pending MIDI actions`);
    this._reset();
    this.phase = 'idle';
    return report;
  }
}

RecordingSession.DEFAULTS = DEFAULTS;
module.exports = RecordingSession;
module.exports.RecordingSession = RecordingSession;
