/* Pure, clock-free playback. The caller owns project isolation and transport time.
 * load(cues, {fps, generation?}) snapshots normalized cues, NOT production flat entries.
 * reconcile(cues, {fps?, generation?, fromFrame?, inclusive=false}) returns true only
 * for unchanged stable-ID cues plus insertions. It retains active snapshots/cursors;
 * new starts before (or at, by default) fromFrame are never chased. False does not mutate.
 * Cue: {id, frame, duration, mode, address, args, valueIndex?, keyframes?,
 *   enabled?, pending?, unassigned?, outputTarget?, curveOrigin?, dataOrigin?, interpolation?,
 *   preserveRecordedEndpoint? (untouched capture, align rounding under one frame only)}.
 * frame/duration and keyframe.tFrame are timeline frames (tFrame is cue-relative).
 * Legacy keyframe.dt/ms is ingress milliseconds, mapped by fps*recordingSpeed/1000
 * (recordingSpeed defaults to 1). Prefer tFrame when the caller has normalized time.
 * Duration never stretches a curve: beyond its last point the last value is held.
 * Moving a cue changes frame only. Trimming/resizing must be normalized by the caller.
 * Hidden lanes/folders are visual only; use enabled:false to suppress output.
 * No chase: initial step, load, reset, seek, generation change and discontinuity
 * exclude earlier starts. Starts exactly at the new position are still eligible.
 * step(frame, cues?, options?) caches cues by identity; mutate -> load explicitly.
 * options: {fps?, playing=true, discontinuity=false, generation?, speed=1}.
 * speed controls wall-time sampling rate; it does NOT rescale cue/curve frames.
 * send(address, args, outputTarget, {cueId, frame, kind, generation, reason?}).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../realtime-config'));
  else root.HSPlayback = factory(root.HSRealtime);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (DEFAULTS) {
  'use strict';

  function copy(value) {
    if (Array.isArray(value)) return value.map(copy);
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return Buffer.from(value);
    if (value instanceof ArrayBuffer) return value.slice(0);
    if (value instanceof DataView) return new DataView(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    if (ArrayBuffer.isView(value)) return value.slice();
    if (value && typeof value === 'object') {
      const out = {};
      for (const key of Object.keys(value)) out[key] = copy(value[key]);
      return out;
    }
    return value;
  }

  function eventOrder(a, b) {
    return a.frame - b.frame || a.priority - b.priority || a.cue.order - b.cue.order;
  }

  function ease(t, interpolation) {
    if (interpolation === 'step') return 0;
    if (interpolation === 'ease' || interpolation === 'ease-in-out') return t * t * (3 - 2 * t);
    if (interpolation === 'ease-in') return t * t;
    if (interpolation === 'ease-out') return 1 - (1 - t) * (1 - t);
    return t;
  }

  class PlaybackScheduler {
    constructor({ send, config } = {}) {
      if (typeof send !== 'function') throw new TypeError('PlaybackScheduler requires send');
      this.send = send;
      this.config = Object.assign({}, DEFAULTS, config);
      if (!(this.config.PLAYBACK_FLOAT_HZ > 0) || !Number.isFinite(this.config.PLAYBACK_FLOAT_HZ)) {
        throw new RangeError('PLAYBACK_FLOAT_HZ must be positive');
      }
      this.events = [];
      this.pianos = new Map();
      this.floats = new Map();
      this.fps = 30;
      this.frame = null;
      this.cursor = 0;
      this.generation = undefined;
      this.cues = null;
      this.snapshots = [];
    }

    _normalize(input, order) {
      if (!input || input.enabled === false || input.pending || input.unassigned ||
          !Number.isFinite(input.frame) || typeof input.address !== 'string' || !input.address.startsWith('/')) return null;
      const cue = Object.assign({}, input, { order, args: copy(Array.isArray(input.args) ? input.args : []),
        outputTarget: copy(input.outputTarget),
        duration: Number.isFinite(input.duration) ? Math.max(0, input.duration) : 0 });
      cue.mode = String(cue.mode || 'trigger').toLowerCase();
      if (!['trigger', 'piano', 'float'].includes(cue.mode)) return null;
      cue.end = cue.frame + cue.duration;
      cue.valueIndex = Number.isInteger(input.valueIndex) && input.valueIndex >= 0 ? input.valueIndex :
        cue.args.findIndex((v) => typeof v === 'number' && Number.isFinite(v));
      if (cue.mode === 'piano') {
        if (!cue.duration) return null;
        if (cue.valueIndex < 0) cue.valueIndex = cue.args.length;
      }
      if (cue.mode !== 'float') return cue;
      // Fallback MIDI CC curves are display-only, even when an address is learned.
      if (cue.curveOrigin === 'midi' || cue.dataOrigin === 'midi') return null;
      const points = (Array.isArray(input.keyframes) ? input.keyframes : []).filter((p) => p &&
        Number.isFinite(p.value) && ((Number.isFinite(p.tFrame) && p.tFrame >= 0) ||
          (Number.isFinite(p.dt) && p.dt >= 0) || (Number.isFinite(p.ms) && p.ms >= 0)));
      if (!points.length) return null;
      if (cue.valueIndex < 0) {
        const args = points.find((p) => Array.isArray(p.args));
        if (args) {
          cue.args = copy(args.args);
          cue.valueIndex = cue.args.findIndex((v) => typeof v === 'number' && Number.isFinite(v));
        }
      }
      if (cue.valueIndex < 0) return null;
      const scale = this.fps * (Number.isFinite(cue.recordingSpeed) && cue.recordingSpeed > 0 ? cue.recordingSpeed : 1) / 1000;
      cue.points = points.map((p) => ({ frame: Number.isFinite(p.tFrame) ? p.tFrame :
        (Number.isFinite(p.dt) ? p.dt : p.ms) * scale, value: p.value,
        args: Array.isArray(p.args) ? copy(p.args) : cue.args })).sort((a, b) => a.frame - b.frame);
      // Only untouched captures may align a rounded-down boundary, never edited trims.
      if (cue.preserveRecordedEndpoint && cue.points.at(-1).frame > cue.duration &&
          cue.points.at(-1).frame - cue.duration < 1) {
        for (const point of cue.points) point.frame = Math.min(point.frame, cue.duration);
      }
      return cue;
    }

    load(cues, { fps = this.fps, generation = this.generation } = {}) {
      if (!Array.isArray(cues)) throw new TypeError('cues must be an array');
      if (!(fps > 0) || !Number.isFinite(fps)) throw new RangeError('fps must be positive');
      this.stop();
      this.fps = fps;
      this.generation = generation;
      this.cues = cues;
      this.configKey = JSON.stringify([this.config.PLAYBACK_FLOAT_HZ, this.config.PIANO_END_ACTION]);
      this.snapshots = cues.map((cue) => ({ id: cue.id, key: JSON.stringify(cue) }));
      this.nextOrder = cues.length;
      this.events = [];
      cues.forEach((input, order) => {
        const cue = this._normalize(input, order);
        if (!cue) return;
        this.events.push({ frame: cue.frame, priority: 2, cue, kind: 'start' });
        if (cue.mode === 'piano') this.events.push({ frame: cue.end, priority: 0, cue, kind: 'piano-off' });
      });
      this.events.sort(eventOrder);
      this._position(this.frame);
      return this;
    }

    reconcile(cues, { fps = this.fps, generation = this.generation,
      fromFrame = this.frame, inclusive = false } = {}) {
      if (!Array.isArray(cues) || fps !== this.fps || generation !== this.generation ||
          this.configKey !== JSON.stringify([this.config.PLAYBACK_FLOAT_HZ, this.config.PIANO_END_ACTION])) return false;
      const snapshots = cues.map((cue) => ({ id: cue.id, key: JSON.stringify(cue) }));
      const ids = new Set(snapshots.map((cue) => cue.id));
      if (ids.has(undefined) || ids.size !== snapshots.length || snapshots.length < this.snapshots.length) return false;
      const oldIds = new Set(this.snapshots.map((cue) => cue.id));
      if (oldIds.size !== this.snapshots.length) return false;
      const retained = snapshots.filter((cue) => oldIds.has(cue.id));
      if (retained.length !== this.snapshots.length || retained.some((cue, index) =>
        cue.id !== this.snapshots[index].id || cue.key !== this.snapshots[index].key)) return false;
      const additions = [];
      let order = this.nextOrder;
      cues.forEach((input) => {
        if (oldIds.has(input.id)) return;
        const cue = this._normalize(input, order++);
        if (!cue || (fromFrame !== null && (cue.frame < fromFrame || (!inclusive && cue.frame === fromFrame)))) return;
        additions.push({ frame: cue.frame, priority: 2, cue, kind: 'start' });
        if (cue.mode === 'piano') additions.push({ frame: cue.end, priority: 0, cue, kind: 'piano-off' });
      });
      const pending = this.events.slice(this.cursor).concat(additions).sort(eventOrder);
      this.events = this.events.slice(0, this.cursor).concat(pending);
      this.nextOrder = order;
      this.snapshots = snapshots;
      this.cues = cues;
      return true;
    }

    _position(frame) {
      this.frame = frame;
      let lo = 0, hi = this.events.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (frame !== null && this.events[mid].frame < frame) lo = mid + 1;
        else hi = mid;
      }
      this.cursor = lo;
    }

    seek(frame = 0) {
      if (!Number.isFinite(frame)) throw new TypeError('frame must be finite');
      this._release('seek', frame);
      this._position(frame);
      return this;
    }

    reset(frame = 0) { return this.seek(frame); }

    _emit(cue, args, frame, kind, address = cue.address, reason) {
      this.send(address, copy(args), cue.outputTarget, { cueId: cue.id, frame, kind,
        generation: this.generation, ...(reason ? { reason } : {}) });
    }

    _piano(cue, value, frame, reason) {
      const args = copy(cue.args);
      args[cue.valueIndex] = value;
      let address = cue.address;
      if (!value && this.config.PIANO_END_ACTION === 'layerclear' &&
          /\/(?:layers\/[^/]+|selectedlayer)\/clips\/[^/]+\/connect$/.test(address)) {
        address = address.replace(/\/clips\/[^/]+\/connect$/, '/clear');
        this._emit(cue, [1], frame, 'piano-off', address, reason);
      } else {
        // Resolume connect=0 release behavior MUST be tested on the real target.
        this._emit(cue, args, frame, value ? 'piano-on' : 'piano-off', address, reason);
      }
    }

    _release(reason, frame = this.frame) {
      const notes = [...this.pianos.values()];
      this.pianos.clear();
      this.floats.clear();
      let failure;
      for (const cue of notes) {
        try { this._piano(cue, 0, frame, reason); }
        catch (error) { if (!failure) failure = error; }
      }
      if (failure) throw failure;
    }

    stop() {
      this._release('stop');
      return this;
    }

    _sample(active, frame) {
      const cue = active.cue, points = cue.points;
      const local = frame - cue.frame;
      while (active.point + 1 < points.length && points[active.point + 1].frame <= local) active.point++;
      const left = points[active.point], right = points[Math.min(active.point + 1, points.length - 1)];
      let value = left.value;
      if (local >= points[points.length - 1].frame) value = points[points.length - 1].value;
      else if (local > left.frame && right.frame > left.frame) {
        value += (right.value - left.value) * ease((local - left.frame) / (right.frame - left.frame), cue.interpolation);
      }
      const args = copy(left.args);
      args[cue.valueIndex] = value;
      return args;
    }

    step(frame, cues, options = {}) {
      if (!Number.isFinite(frame)) throw new TypeError('frame must be finite');
      const fps = options.fps === undefined ? this.fps : options.fps;
      const generation = options.generation === undefined ? this.generation : options.generation;
      const speed = options.speed === undefined ? 1 : options.speed;
      if (!(speed > 0) || !Number.isFinite(speed)) throw new RangeError('speed must be positive');
      const changed = (cues !== undefined && cues !== this.cues) || fps !== this.fps || generation !== this.generation;
      if (changed) {
        this.load(cues === undefined ? this.cues || [] : cues, { fps, generation });
        this.seek(frame);
      } else if (this.frame === null || options.discontinuity || frame < this.frame) this.seek(frame);
      if (options.playing === false) {
        this.frame = frame;
        this.stop();
        this._position(frame);
        return this;
      }
      const due = [];
      while (this.cursor < this.events.length && this.events[this.cursor].frame <= frame) {
        const event = this.events[this.cursor++];
        if (event.kind === 'start' && event.cue.mode === 'float') {
          this.floats.set(event.cue.order, { cue: event.cue, next: event.frame, point: 0,
            anchor: event.frame, sample: 0, interval: null });
        } else due.push(event);
      }
      const interval = this.fps * speed / this.config.PLAYBACK_FLOAT_HZ;
      for (const [key, active] of this.floats) {
        const cue = active.cue;
        if (active.interval !== interval) {
          active.anchor = active.next;
          active.sample = 0;
          active.interval = interval;
        }
        while (active.next < cue.end - 1e-9 && active.next <= frame) {
          due.push({ frame: active.next, priority: active.next === cue.frame ? 2 : 1,
            cue, kind: 'float', args: this._sample(active, active.next) });
          active.next = active.anchor + ++active.sample * interval;
        }
        if (cue.end <= frame) {
          due.push({ frame: cue.end, priority: 1, cue, kind: 'float', args: this._sample(active, cue.end) });
          this.floats.delete(key);
        }
      }
      due.sort(eventOrder);
      for (const event of due) {
        const cue = event.cue;
        if (event.kind === 'piano-off') {
          if (!this.pianos.delete(cue.order)) continue;
          this._piano(cue, 0, event.frame);
        } else if (event.kind === 'float') this._emit(cue, event.args, event.frame, 'float');
        else if (cue.mode === 'piano') {
          this.pianos.set(cue.order, cue);
          this._piano(cue, 1, event.frame);
        } else this._emit(cue, cue.args, event.frame, 'trigger');
      }
      this.frame = frame;
      return this;
    }
  }

  return { PlaybackScheduler, DEFAULTS };
});
