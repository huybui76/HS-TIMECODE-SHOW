(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./curve-tools'), require('../realtime-config'));
  else root.HSCurveEditor = factory(root.HSCurveTools, root.HSRealtime);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (tools, config) {
  'use strict';

  const UI = Object.freeze({ width: 480, height: 180, padding: 16, samples: 128, defaultFps: 30, valueSteps: 100, shiftMultiplier: 10 });
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MODES = Object.freeze(['linear', 'ease', 'step']);
  const STYLE = Object.freeze({
    panel: { display: 'grid', gap: '8px', padding: '10px', boxSizing: 'border-box', width: '100%', minWidth: '0', maxWidth: '100%', border: '1px solid var(--line, #303038)', borderRadius: '8px', background: 'var(--panel, #16161a)', color: 'var(--text, #d8d8de)', fontFamily: 'inherit', fontSize: '12px' },
    row: { display: 'flex', flexWrap: 'wrap', alignItems: 'end', gap: '8px', minWidth: '0' },
    field: { display: 'grid', gap: '4px', flex: '1 1 90px', minWidth: '0', color: 'var(--dim, #85858f)' },
    control: { width: '100%', minWidth: '0', boxSizing: 'border-box', height: '30px', padding: '4px 6px', border: '1px solid var(--line, #303038)', borderRadius: '5px', background: 'var(--panel2, #1c1c21)', color: 'var(--text, #d8d8de)', font: 'inherit' }
  });

  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function copy(points) { return tools.cloneCueMetadata(points); }

  function mount(container, options = {}) {
    if (!container || !container.ownerDocument) throw new TypeError('A DOM container is required');
    const doc = container.ownerDocument, win = doc.defaultView;
    const removers = [];
    let destroyed = false, points = [], selected = 0, durationMs = 0, interpolation = 'linear';
    let fps = UI.defaultFps, valueMin, valueMax, range = [0, 1], onChange;
    let drag = null, sliderStart = null;

    function element(tag, parent, className, style, svg) {
      const node = svg ? doc.createElementNS(SVG_NS, tag) : doc.createElement(tag);
      if (className) node.setAttribute('class', className);
      if (style) Object.assign(node.style, style);
      if (parent) parent.appendChild(node);
      return node;
    }
    function listen(node, type, handler) {
      node.addEventListener(type, handler);
      removers.push(() => node.removeEventListener(type, handler));
    }
    function field(parent, title, tag, type) {
      const label = element('label', parent, 'hs-curve-field', STYLE.field);
      element('span', label).textContent = title;
      const input = element(tag, label, 'hs-curve-control', STYLE.control);
      if (type) input.type = type;
      input.setAttribute('aria-label', title);
      return input;
    }
    function option(parent, value, title) {
      const node = element('option', parent);
      node.value = value;
      node.textContent = title;
    }

    const panel = element('section', container, 'hs-curve-editor', STYLE.panel);
    panel.setAttribute('aria-label', 'Curve editor');
    const toolbar = element('div', panel, 'hs-curve-toolbar', STYLE.row);
    const mode = field(toolbar, 'Interpolation', 'select');
    MODES.forEach((value) => option(mode, value, value[0].toUpperCase() + value.slice(1)));
    const pointSelect = field(toolbar, 'Point', 'select');
    const svg = element('svg', panel, 'hs-curve-chart', {
      display: 'block', width: '100%', height: UI.height + 'px', minWidth: '0',
      background: 'var(--bg, #0d0d0f)', borderRadius: '5px', touchAction: 'none'
    }, true);
    svg.setAttribute('viewBox', `0 0 ${UI.width} ${UI.height}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('tabindex', '0');
    svg.setAttribute('role', 'group');
    svg.setAttribute('aria-label', 'Curve points. Arrow keys edit selected point; Shift moves faster; Delete removes interior points; Enter adds a point.');
    const grid = element('path', svg, '', null, true);
    grid.setAttribute('d', `M${UI.padding} ${UI.padding}V${UI.height - UI.padding}H${UI.width - UI.padding} M${UI.padding} ${UI.height / 2}H${UI.width - UI.padding}`);
    grid.setAttribute('stroke', 'var(--line, #303038)');
    grid.setAttribute('fill', 'none');
    grid.setAttribute('aria-hidden', 'true');
    const curve = element('polyline', svg, 'hs-curve-line', null, true);
    curve.setAttribute('stroke', 'var(--accent, #ff8a00)');
    curve.setAttribute('stroke-width', '2');
    curve.setAttribute('fill', 'none');
    curve.setAttribute('vector-effect', 'non-scaling-stroke');
    curve.setAttribute('aria-hidden', 'true');
    const handles = element('g', svg, 'hs-curve-handles', null, true);
    const numbers = element('div', panel, 'hs-curve-numbers', STYLE.row);
    const timeInput = field(numbers, 'Time (ms)', 'input', 'number');
    const valueInput = field(numbers, 'Value', 'input', 'number');
    const slider = field(panel, 'Value slider', 'input', 'range');
    slider.style.accentColor = 'var(--accent, #ff8a00)';
    slider.style.padding = '0';
    const actions = element('div', panel, 'hs-curve-actions', STYLE.row);
    const add = element('button', actions, 'hs-curve-add', { ...STYLE.control, width: 'auto', cursor: 'pointer' });
    add.type = 'button';
    add.textContent = 'Add point';
    const remove = element('button', actions, 'hs-curve-delete', { ...STYLE.control, width: 'auto', cursor: 'pointer' });
    remove.type = 'button';
    remove.textContent = 'Delete point';
    const status = element('span', actions, 'hs-curve-status', { color: 'var(--dim, #85858f)', flex: '1 1 120px' });
    status.setAttribute('role', 'status');
    const hint = element('div', panel, 'hs-curve-hint', { color: 'var(--dim, #85858f)', fontSize: '11px' });
    hint.textContent = 'Double-click the chart to add on the curve. Arrows edit; Shift accelerates. Endpoint times are fixed.';

    function x(dt) { return UI.padding + (durationMs ? dt / durationMs : 0) * (UI.width - UI.padding * 2); }
    function y(value) { return UI.height - UI.padding - (clamp(value, range[0], range[1]) - range[0]) / (range[1] - range[0]) * (UI.height - UI.padding * 2); }
    function emit(commit) {
      if (!destroyed && typeof onChange === 'function') onChange(copy(points), { interpolation, commit });
    }
    function deriveRange() {
      let min = points[0].value, max = min;
      for (const point of points) { min = Math.min(min, point.value); max = Math.max(max, point.value); }
      const normalized = min >= 0 && max <= 1;
      let low = valueMin === undefined ? (normalized ? 0 : min) : valueMin;
      let high = valueMax === undefined ? (normalized ? 1 : max) : valueMax;
      if (low >= high) {
        const padding = Math.max(1, Math.abs(low) / UI.shiftMultiplier);
        if (valueMin === undefined) low = high - padding;
        if (valueMax === undefined) high = low + padding;
      }
      range = [low, high];
    }
    function render() {
      if (destroyed) return;
      const hadFocus = handles.contains(doc.activeElement);
      const samples = Math.round(clamp(Number(config && config.UI_CHART_SAMPLES) || UI.samples, 2, UI.samples));
      const vertices = [];
      // Only two scalar points enter valueAt; do not clone full OSC payloads per chart sample.
      let segment = 0, previousY;
      for (let i = 0; i < samples; i++) {
        const dt = durationMs * i / (samples - 1);
        while (segment + 1 < points.length && points[segment + 1].dt <= dt) segment++;
        const pair = [points[segment], points[Math.min(points.length - 1, segment + 1)]].map((point) => ({ dt: point.dt, value: point.value }));
        const py = y(tools.valueAt(pair, dt, interpolation));
        if (interpolation === 'step' && i) vertices.push(x(dt) + ',' + previousY);
        vertices.push(x(dt) + ',' + py);
        previousY = py;
      }
      curve.setAttribute('points', vertices.join(' '));
      while (handles.children.length > points.length) handles.removeChild(handles.lastChild);
      while (pointSelect.children.length > points.length) pointSelect.removeChild(pointSelect.lastChild);
      points.forEach((point, index) => {
        const handle = handles.children[index] || element('circle', handles, 'hs-curve-point', { cursor: 'grab' }, true);
        handle.setAttribute('cx', x(point.dt));
        handle.setAttribute('cy', y(point.value));
        handle.setAttribute('r', index === selected ? '6' : '4');
        handle.setAttribute('fill', index === selected ? 'var(--accent, #ff8a00)' : 'var(--panel, #16161a)');
        handle.setAttribute('stroke', 'var(--text, #d8d8de)');
        handle.setAttribute('stroke-width', index === selected ? '2' : '1');
        handle.setAttribute('data-index', index);
        handle.setAttribute('tabindex', index === selected ? '0' : '-1');
        handle.setAttribute('role', 'button');
        handle.setAttribute('aria-pressed', index === selected ? 'true' : 'false');
        handle.setAttribute('aria-label', `Point ${index + 1}: ${point.dt} ms, value ${point.value}`);
        const opt = pointSelect.children[index] || element('option', pointSelect);
        opt.value = String(index);
        opt.textContent = String(index + 1) + ' / ' + points.length;
      });
      if (hadFocus) handles.children[selected].focus();
      const point = points[selected];
      mode.value = interpolation;
      pointSelect.value = String(selected);
      timeInput.min = '0';
      timeInput.max = String(durationMs);
      timeInput.step = String(1000 / fps);
      timeInput.value = String(point.dt);
      timeInput.disabled = selected === 0 || selected === points.length - 1;
      valueInput.min = slider.min = String(range[0]);
      valueInput.max = slider.max = String(range[1]);
      valueInput.step = 'any';
      slider.step = String((range[1] - range[0]) / UI.valueSteps);
      valueInput.value = slider.value = String(point.value);
      remove.disabled = selected === 0 || selected === points.length - 1;
      add.disabled = durationMs === 0 || points.length >= config.FLOAT_MAX_POINTS;
      status.textContent = `${points.length} point${points.length === 1 ? '' : 's'} | ${durationMs} ms`;
    }
    function move(patch, commit) {
      if (destroyed) return false;
      const before = points[selected];
      const dt = selected === 0 || selected === points.length - 1 || !Number.isFinite(patch.dt) ? before.dt : clamp(patch.dt, 0, durationMs);
      const value = Number.isFinite(patch.value) ? clamp(patch.value, range[0], range[1]) : before.value;
      if (dt === before.dt && value === before.value) { render(); return false; }
      const index = points.reduce((count, point, i) => count + ((i !== selected && (point.dt < dt || (point.dt === dt && i < selected))) ? 1 : 0), 0);
      points = tools.movePoint(points, selected, { dt, value }, durationMs, { interpolation });
      selected = index;
      if (drag) drag.changed = true;
      render();
      emit(commit);
      return true;
    }
    function insert(dt) {
      if (destroyed || drag || add.disabled) return;
      const at = clamp(dt, 0, durationMs);
      const existing = points.findIndex((point) => point.dt === at);
      if (existing !== -1) { selected = existing; render(); return; }
      const point = tools.trim(points, at, at, { interpolation })[0];
      point.dt = point.ms = at;
      points = tools.insertPoint(points, point, durationMs, { interpolation });
      selected = points.findIndex((p) => p.dt === at);
      render();
      emit(true);
    }
    function addBetween() {
      const left = points[Math.min(selected, points.length - 2)];
      const right = points[Math.min(selected + 1, points.length - 1)];
      if (left && right) insert((left.dt + right.dt) / 2);
    }
    function deleteSelected() {
      if (destroyed || drag || remove.disabled) return;
      points = tools.deletePoint(points, selected, durationMs, { interpolation });
      selected = Math.min(selected, points.length - 1);
      render();
      emit(true);
    }
    function chartPosition(event) {
      const rect = svg.getBoundingClientRect();
      if (!rect.width || !rect.height || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return null;
      const px = (event.clientX - rect.left) * UI.width / rect.width;
      const py = (event.clientY - rect.top) * UI.height / rect.height;
      return { dt: clamp((px - UI.padding) / (UI.width - UI.padding * 2), 0, 1) * durationMs,
        value: range[0] + clamp((UI.height - UI.padding - py) / (UI.height - UI.padding * 2), 0, 1) * (range[1] - range[0]) };
    }
    function finishDrag(cancel, notify = true) {
      if (!drag) return;
      const prior = drag;
      drag = null;
      doc.removeEventListener('pointermove', pointerMove);
      doc.removeEventListener('pointerup', pointerUp);
      doc.removeEventListener('pointercancel', pointerCancel);
      if (win) win.removeEventListener('blur', pointerCancel);
      if (svg.hasPointerCapture && svg.hasPointerCapture(prior.pointerId)) svg.releasePointerCapture(prior.pointerId);
      if (cancel) { points = prior.points; selected = prior.selected; render(); }
      if (notify && prior.changed) emit(!cancel);
    }
    function pointerMove(event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const position = chartPosition(event);
      if (position) { event.preventDefault(); move(position, false); }
    }
    function pointerUp(event) { if (drag && event.pointerId === drag.pointerId) finishDrag(false); }
    function pointerCancel(event) {
      if (drag && (event.type === 'blur' || event.pointerId === undefined || event.pointerId === drag.pointerId)) finishDrag(true);
    }
    function finishSlider(cancel, notify = true) {
      if (!sliderStart) return;
      const prior = sliderStart;
      sliderStart = null;
      if (cancel) { points = prior; render(); }
      if (notify) emit(!cancel);
    }

    listen(svg, 'pointerdown', (event) => {
      if (event.button !== 0 || drag) return;
      const raw = event.target.getAttribute('data-index');
      if (raw === null) return;
      finishSlider(false);
      selected = Number(raw);
      render();
      handles.children[selected].focus();
      event.preventDefault();
      drag = { points: copy(points), selected, pointerId: event.pointerId, changed: false };
      doc.addEventListener('pointermove', pointerMove);
      doc.addEventListener('pointerup', pointerUp);
      doc.addEventListener('pointercancel', pointerCancel);
      if (win) win.addEventListener('blur', pointerCancel);
      if (svg.setPointerCapture) svg.setPointerCapture(event.pointerId);
    });
    listen(svg, 'lostpointercapture', pointerCancel);
    listen(svg, 'dblclick', (event) => {
      const position = chartPosition(event);
      if (position) { event.preventDefault(); insert(position.dt); }
    });
    listen(svg, 'keydown', (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (drag) {
        if (event.key === 'Escape') finishDrag(true);
        if (['Escape', 'Delete', 'Backspace', 'Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      const factor = event.shiftKey ? UI.shiftMultiplier : 1;
      const point = points[selected];
      let patch;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') patch = { dt: point.dt + (event.key === 'ArrowRight' ? 1 : -1) * factor * 1000 / fps };
      else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') patch = { value: point.value + (event.key === 'ArrowUp' ? 1 : -1) * factor * (range[1] - range[0]) / UI.valueSteps };
      else if (event.key === 'Delete' || event.key === 'Backspace') deleteSelected();
      else if (event.key === 'Enter') addBetween();
      else return;
      event.preventDefault();
      event.stopPropagation();
      if (patch && !drag) move(patch, true);
    });
    listen(panel, 'keydown', (event) => {
      if (event.target !== svg && !handles.contains(event.target) && event.key !== 'Tab') event.stopPropagation();
    });
    listen(pointSelect, 'change', () => {
      finishSlider(false);
      selected = clamp(Number(pointSelect.value) || 0, 0, points.length - 1);
      render();
    });
    listen(mode, 'change', () => {
      if (!MODES.includes(mode.value) || mode.value === interpolation) return;
      finishSlider(false);
      interpolation = mode.value;
      render();
      emit(true);
    });
    listen(timeInput, 'change', () => {
      if (timeInput.value.trim() && Number.isFinite(Number(timeInput.value))) move({ dt: Number(timeInput.value) }, true);
      else render();
    });
    listen(valueInput, 'change', () => {
      if (valueInput.value.trim() && Number.isFinite(Number(valueInput.value))) move({ value: Number(valueInput.value) }, true);
      else render();
    });
    listen(slider, 'input', () => {
      if (!Number.isFinite(Number(slider.value))) return;
      if (!sliderStart) sliderStart = copy(points);
      move({ value: Number(slider.value) }, false);
    });
    listen(slider, 'change', () => finishSlider(false));
    listen(slider, 'blur', () => finishSlider(false));
    listen(slider, 'pointercancel', () => finishSlider(true));
    listen(add, 'click', addBetween);
    listen(remove, 'click', deleteSelected);

    function set(next = {}) {
      if (destroyed) return;
      const nextMode = next.interpolation === undefined ? interpolation : next.interpolation;
      if (!MODES.includes(nextMode)) throw new RangeError('Unknown interpolation');
      const source = next.points === undefined ? copy(drag ? drag.points : (sliderStart || points)) : tools.cloneCueMetadata({ keyframes: next.points }).keyframes;
      const duration = next.durationMs === undefined ? durationMs : next.durationMs;
      if (!Number.isFinite(duration) || duration < 0) throw new RangeError('durationMs must be finite and nonnegative');
      const nextFps = next.fps === undefined ? fps : next.fps;
      if (!Number.isFinite(nextFps) || nextFps <= 0) throw new RangeError('fps must be finite and positive');
      const low = Object.hasOwn(next, 'valueMin') ? next.valueMin : valueMin;
      const high = Object.hasOwn(next, 'valueMax') ? next.valueMax : valueMax;
      if ((low !== undefined && !Number.isFinite(low)) || (high !== undefined && !Number.isFinite(high)) || (low !== undefined && high !== undefined && low >= high)) throw new RangeError('Invalid value range');
      const initial = source && source.length ? source : [{ dt: 0, ms: 0, value: low === undefined ? (high === undefined ? 0 : Math.min(0, high)) : low }];
      const prepared = tools.deletePoint(tools.trim(initial, 0, duration, { interpolation: nextMode }), -1, duration, { interpolation: nextMode });
      finishDrag(true, false);
      finishSlider(true, false);
      durationMs = duration;
      interpolation = nextMode;
      fps = nextFps;
      valueMin = low;
      valueMax = high;
      points = prepared;
      selected = clamp(selected, 0, points.length - 1);
      if (Object.hasOwn(next, 'onChange')) onChange = next.onChange;
      deriveRange();
      render();
    }
    function destroy() {
      if (destroyed) return;
      destroyed = true;
      finishDrag(true, false);
      finishSlider(true, false);
      removers.forEach((removeListener) => removeListener());
      if (panel.parentNode) panel.parentNode.removeChild(panel);
    }
    try { set(options); }
    catch (error) { destroy(); throw error; }
    return {
      destroy, set,
      setPoints(nextPoints) { set({ points: nextPoints }); },
      getState() { return { points: copy(points), durationMs, interpolation, fps, valueMin: range[0], valueMax: range[1], selectedIndex: selected }; }
    };
  }

  return { mount };
});
