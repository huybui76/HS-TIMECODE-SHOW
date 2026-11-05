(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../realtime-config'));
  else root.HSCurveTools = factory(root.HSRealtime);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (config) {
  'use strict';

  function copy(value) {
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return Buffer.from(value);
    if (value instanceof ArrayBuffer) return value.slice(0);
    if (ArrayBuffer.isView(value)) {
      const buffer = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
      return value instanceof DataView ? new DataView(buffer) : new value.constructor(buffer);
    }
    if (Array.isArray(value)) return value.map(copy);
    if (value && typeof value === 'object') {
      const out = {};
      for (const key of Object.keys(value)) {
        Object.defineProperty(out, key, { value: copy(value[key]), enumerable: true, writable: true, configurable: true });
      }
      return out;
    }
    return value;
  }

  function pointsCopy(points, relative) {
    return (Array.isArray(points) ? points : [])
      .filter((p) => p && Number.isFinite(p.value) && (Number.isFinite(p.dt) || Number.isFinite(p.ms)))
      .map((p, index) => {
        const point = copy(p);
        point.dt = point.ms = Math.max(0, Number.isFinite(p.dt) ? p.dt : p.ms);
        if (relative) delete point.t;
        return { point, index };
      })
      .sort((a, b) => a.point.dt - b.point.dt || a.index - b.index)
      .map((item) => item.point);
  }

  function epsilonValue(epsilon) {
    const value = epsilon === undefined ? config.FLOAT_RDP_EPSILON : epsilon;
    if (!Number.isFinite(value) || value < 0) throw new RangeError('epsilon must be finite and nonnegative');
    return value;
  }

  function pointLimit(options) {
    const value = options.maxPoints === undefined ? config.FLOAT_MAX_POINTS : options.maxPoints;
    if (!Number.isInteger(value) || value < 2) throw new RangeError('maxPoints must retain at least two endpoints');
    return value;
  }

  // Vertical (value-at-time) error, not perpendicular distance in mixed ms/value units.
  function reduce(points, epsilon) {
    if (points.length < 3) return points;
    const keep = new Uint8Array(points.length);
    keep[0] = keep[points.length - 1] = 1;
    const stack = [[0, points.length - 1]];
    while (stack.length) {
      const [first, last] = stack.pop();
      if (last - first < 2) continue;
      const a = points[first], b = points[last];
      let greatest = epsilon, selected = -1;
      for (let i = first + 1; i < last; i++) {
        const ratio = b.dt === a.dt ? 0 : (points[i].dt - a.dt) / (b.dt - a.dt);
        const error = Math.abs(points[i].value - (a.value + (b.value - a.value) * ratio));
        if (error > greatest) { greatest = error; selected = i; }
      }
      if (selected !== -1) {
        keep[selected] = 1;
        stack.push([first, selected], [selected, last]);
      }
    }
    return points.filter((_, i) => keep[i]);
  }

  function simplify(points, epsilon) {
    return reduce(pointsCopy(points, false), epsilonValue(epsilon));
  }

  function normalize(points, options = {}) {
    const limit = pointLimit(options);
    const out = simplify(points, options.epsilon);
    // Some curves cannot satisfy both constraints. Never silently widen epsilon.
    if (out.length > limit) throw new RangeError('Curve exceeds maxPoints at the requested epsilon');
    return out;
  }

  function interpolationRatio(ratio, interpolation) {
    if (interpolation === 'step') return 0;
    if (interpolation === 'ease') return ratio * ratio * (3 - 2 * ratio);
    if (interpolation !== 'linear') throw new RangeError('Unknown interpolation');
    return ratio;
  }

  function numericIndex(point, options) {
    const args = point.args;
    if (!Array.isArray(args)) return -1;
    const explicit = options.numericIndex === undefined ? point.numericIndex : options.numericIndex;
    if (Number.isInteger(explicit)) return explicit >= 0 && explicit < args.length ? explicit : -1;
    const matching = args.findIndex((v) => typeof v === 'number' && v === point.value);
    return matching >= 0 ? matching : args.findIndex((v) => typeof v === 'number' && Number.isFinite(v));
  }

  function setValue(point, value, options) {
    const index = numericIndex(point, options);
    point.value = value;
    if (index >= 0) point.args[index] = value;
    return point;
  }

  function sample(points, dt, options = {}) {
    if (!points.length) return null;
    const interpolation = options.interpolation || 'linear';
    interpolationRatio(0, interpolation);
    if (!Number.isFinite(dt)) throw new RangeError('dt must be finite milliseconds');
    let low = 0, high = points.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (points[mid].dt <= dt) low = mid + 1;
      else high = mid;
    }
    const a = points[Math.max(0, low - 1)];
    const out = copy(a);
    if (low > 0 && low < points.length && dt !== a.dt) {
      const b = points[low];
      const ratio = interpolationRatio((dt - a.dt) / (b.dt - a.dt), interpolation);
      setValue(out, a.value + (b.value - a.value) * ratio, options);
    }
    out.dt = out.ms = dt;
    return out;
  }

  function valueAt(points, dt, interpolation = 'linear') {
    const point = sample(pointsCopy(points, false), dt, { interpolation });
    return point ? point.value : null;
  }

  function durationValue(duration) {
    if (!Number.isFinite(duration) || duration < 0) throw new RangeError('duration must be finite nonnegative milliseconds');
    return duration;
  }

  function trim(points, startMs, endMs, options = {}) {
    durationValue(startMs);
    durationValue(endMs);
    if (endMs < startMs) throw new RangeError('endMs must not precede startMs');
    const sorted = pointsCopy(points, true);
    if (!sorted.length) return [];
    const start = sample(sorted, startMs, options);
    const out = [start];
    if (endMs > startMs) {
      for (const point of sorted) {
        if (point.dt > startMs && point.dt < endMs) out.push(point);
      }
      out.push(sample(sorted, endMs, options));
    }
    for (const point of out) point.dt = point.ms = point.dt - startMs;
    return out;
  }

  function stretch(points, newDurationMs, options = {}) {
    durationValue(newDurationMs);
    const sorted = pointsCopy(points, true);
    if (!sorted.length) return [];
    const oldDuration = options.durationMs === undefined ? sorted[sorted.length - 1].dt : durationValue(options.durationMs);
    const out = trim(sorted, 0, oldDuration, options);
    if (newDurationMs === 0) return trim(out, 0, 0, options);
    if (oldDuration === 0) {
      const end = copy(out[0]);
      end.dt = end.ms = newDurationMs;
      return [out[0], end];
    }
    for (const point of out) point.dt = point.ms = point.dt * newDurationMs / oldDuration;
    return out;
  }

  function split(points, atMs, options = {}) {
    const sorted = pointsCopy(points, true);
    const duration = options.durationMs === undefined ? (sorted.length ? sorted[sorted.length - 1].dt : 0) : durationValue(options.durationMs);
    durationValue(atMs);
    const at = Math.min(atMs, duration);
    return { left: trim(sorted, 0, at, options), right: trim(sorted, at, duration, options) };
  }

  function cloneCueMetadata(metadata) {
    const out = copy(metadata);
    if (out && Array.isArray(out.keyframes)) out.keyframes = pointsCopy(out.keyframes, true);
    return out;
  }

  function editPoints(points, duration, options) {
    durationValue(duration);
    const out = pointsCopy(points, true);
    for (const point of out) point.dt = point.ms = Math.min(point.dt, duration);
    if (out.length && duration === 0) return [sample(out, 0, options)];
    if (out.length && out[0].dt > 0) out.unshift(sample(out, 0, options));
    if (out.length && out[out.length - 1].dt < duration) out.push(sample(out, duration, options));
    if (out.length > pointLimit(options)) throw new RangeError('Curve exceeds maxPoints before editing');
    return out;
  }

  function insertPoint(points, point, durationMs, options = {}) {
    const out = editPoints(points, durationMs, options);
    const incoming = pointsCopy([point], true)[0];
    if (!incoming) return out;
    incoming.dt = incoming.ms = Math.min(incoming.dt, durationMs);
    setValue(incoming, incoming.value, options);
    const existing = out.findIndex((p) => p.dt === incoming.dt);
    if (existing >= 0) out[existing] = incoming;
    else if (out.length < pointLimit(options)) out.push(incoming);
    if (!out.length || (out.length === 1 && durationMs > 0)) return editPoints(out, durationMs, options);
    return pointsCopy(out, true);
  }

  function movePoint(points, index, patch, durationMs, options = {}) {
    const out = editPoints(points, durationMs, options);
    if (!Number.isInteger(index) || index < 0 || index >= out.length || !patch) return out;
    const point = out[index];
    const dt = Number.isFinite(patch.dt) ? patch.dt : patch.ms;
    if (index > 0 && index < out.length - 1 && Number.isFinite(dt)) point.dt = point.ms = Math.max(0, Math.min(dt, durationMs));
    if (Number.isFinite(patch.value)) setValue(point, patch.value, options);
    return pointsCopy(out, true);
  }

  function deletePoint(points, index, durationMs, options = {}) {
    const out = editPoints(points, durationMs, options);
    if (Number.isInteger(index) && index > 0 && index < out.length - 1 && out.length > 2) out.splice(index, 1);
    return out;
  }

  return { normalize, valueAt, trim, stretch, split, simplify, cloneCueMetadata, insertPoint, movePoint, deletePoint };
});
