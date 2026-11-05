(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HSCueLayout = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DOT = '\u00b7';
  const PALETTE = Object.freeze([
    '#4682cf', '#cb655a', '#52a477', '#ac72c7', '#b58a37', '#44a3aa', '#c46997', '#829c40',
    '#797bd1', '#ce8650', '#42a18e', '#b76ab6', '#6692ba', '#b39a49', '#d16f7c', '#69a263',
    '#9677c9', '#b67c51', '#4f9bb0', '#bb749f', '#8d9c54', '#667fbe', '#c47b68', '#59a095',
    '#a17bb4', '#a98d55', '#7196a8', '#c16c89', '#7e9e69', '#897fb2', '#ba895e', '#629b8b'
  ]);

  function beautify(text) {
    return String(text).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ')
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function addressParts(address) {
    const parts = String(address || '').split('/').filter(Boolean);
    const lower = parts.map((part) => part.toLowerCase());
    const numberAfter = (word) => {
      const index = lower.indexOf(word);
      return index >= 0 && /^[1-9]\d*$/.test(parts[index + 1] || '') ? parts[index + 1] : null;
    };
    const group = numberAfter('groups');
    const layer = numberAfter('layers');
    const clip = numberAfter('clips');
    const column = numberAfter('columns');
    const final = lower[lower.length - 1] || '';
    const parameter = ({ playmode: 'Playmode', opacity: 'Opacity', speed: 'Speed', volume: 'Volume', clear: 'Clear' })[final]
      || beautify(parts[parts.length - 1] || '');
    return { parts, group, layer, clip, column, final, parameter };
  }

  function midiParts(desc) {
    const cc = desc.cc != null || desc.source === 'cc' || desc.kind === 'cc' || desc.kind === 'float';
    return { cc, num: desc.num == null ? (cc ? desc.cc : desc.note) : desc.num, ch: desc.ch || 1 };
  }

  function resolveCueName(address, midiInfo) {
    if (!address) {
      const midi = midiParts(midiInfo || {});
      if (midi.num == null) return 'OSC';
      if (midi.cc) return `MIDI CC${midi.num} ${DOT}ch${midi.ch}`;
      const notes = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
      const note = notes[midi.num % 12] + (Math.floor(midi.num / 12) - 1);
      return `MIDI ${note}(${midi.num}) ${DOT}ch${midi.ch}`;
    }
    const p = addressParts(address);
    const name = [];
    if (p.group) name.push('Group' + p.group);
    if (p.layer) name.push('Layer' + p.layer);
    if (p.clip) name.push('Column' + p.clip, 'Clip' + p.clip);
    else if (p.column) name.push('Column' + p.column);
    if (!p.layer && !p.clip && !p.column && !p.group) return p.parts.map(beautify).join(DOT) || 'OSC';
    if (p.final !== 'connect' && !/^\d+$/.test(p.final)) name.push(p.parameter);
    return name.join(DOT);
  }

  function laneKeyFor(desc, mode = 'layer+type') {
    if (!desc.address) {
      const midi = midiParts(desc);
      return 'midi:' + JSON.stringify([String(desc.device || ''), midi.ch, midi.cc ? 'cc' : 'note', midi.num == null ? null : midi.num]);
    }
    if (mode === 'address') return 'address:' + desc.address;
    const p = addressParts(desc.address);
    const prefix = p.group ? 'group:' + p.group + '/' : '';
    if (p.layer) {
      return prefix + 'layer:' + p.layer + '/' + (p.clip && p.final === 'connect' ? 'clips' : 'param:' + p.final);
    }
    if (p.column && p.final === 'connect') return prefix + 'columns';
    return 'address:' + desc.address;
  }

  function labelFor(desc, mode = 'layer+type') {
    if (!desc.address || mode === 'address') return resolveCueName(desc.address, desc);
    const p = addressParts(desc.address);
    const prefix = p.group ? 'Group' + p.group + DOT : '';
    if (p.layer) return prefix + 'Layer' + p.layer + DOT + (p.clip && p.final === 'connect' ? 'Clips' : p.parameter);
    if (p.column && p.final === 'connect') return prefix + 'Columns';
    return resolveCueName(desc.address, desc);
  }

  function groupColor(key, previousColor) {
    let hash = 2166136261;
    for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
    let index = (hash >>> 0) % PALETTE.length;
    if (PALETTE[index] === previousColor) index = (index + 13) % PALETTE.length;
    return PALETTE[index];
  }

  // Persist the returned mapping; existing assignments win over adjacency preferences.
  function assignGroupColors(keys, persisted = {}) {
    const colors = { ...persisted };
    let previous;
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(colors, key)) colors[key] = groupColor(key, previous);
      previous = colors[key];
    }
    return colors;
  }

  function textColor(color) {
    const rgb = color.replace('#', '').match(/../g).map((part) => {
      const value = parseInt(part, 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722 > 0.179 ? '#000000' : '#ffffff';
  }

  function manual(lane) { return !!(lane.manual || lane.manualLane || lane.locked); }
  function onLane(event, lane) { return event.laneId != null ? event.laneId === lane.id : event.lane === lane.name; }

  // Descriptor times must already be folder-local. index is an insertion index,
  // after removing a reused spare; the caller owns all IDs and model updates.
  function planLane({ descriptor, lanes = [], events = [], config = {} }) {
    const mode = config.LANE_GROUP_MODE || 'layer+type';
    const groupKey = laneKeyFor(descriptor, mode);
    const groupLabel = labelFor(descriptor, mode);
    const siblings = lanes.filter((lane) => lane.kind === 'R' && lane.recGroup === groupKey);
    const lastSibling = siblings[siblings.length - 1];
    const root = siblings[0];
    const persisted = config.groupColors || {};
    const previous = lanes.length ? lanes[lanes.length - 1].color : undefined;
    const color = (root && root.color) || persisted[groupKey] || groupColor(groupKey, previous);
    const cue = descriptor.cue || descriptor.__cue;
    const choose = (lane, extra) => ({ laneId: lane.id, laneName: lane.name, create: false,
      groupKey, groupLabel, color: lane.color || color, ...extra });
    if (cue && cue.manualLane && !config.regroup && !descriptor.pendingRemap && !descriptor.firstAssignment) {
      const held = lanes.find((lane) => onLane(cue, lane));
      if (held) return choose(held, { preserveManual: true });
    }
    const start = descriptor.frame == null ? descriptor.startFrame : descriptor.frame;
    const duration = descriptor.durationFrames == null ? (descriptor.duration || 0) : descriptor.durationFrames;
    const end = start + Math.max(0, duration);
    const occupied = (lane) => events.some((event) => {
      if (event === cue || (cue && cue.id != null && event.id === cue.id)) return false;
      if (!onLane(event, lane)) return false;
      const eventEnd = event.frame + Math.max(0, event.duration || 0);
      return start < end && event.frame < eventEnd && start < eventEnd && event.frame < end;
    });
    for (const lane of siblings) {
      if (!lane.locked && (descriptor.kind === 'trigger' || !occupied(lane))) return choose(lane);
    }
    const index = lastSibling ? lanes.indexOf(lastSibling) + 1 : lanes.length;
    // An empty user-created +R lane is not a spare auto-rec lane.
    const spare = root && lanes.find((lane) => lane.kind === 'R' && lane.autoRec === true
      && !lane.recGroup && !manual(lane) && !events.some((event) => onLane(event, lane)));
    if (spare) return choose(spare, { color, index: index - (lanes.indexOf(spare) < index ? 1 : 0), auxiliary: true });
    return { create: true, groupKey, groupLabel, color, index, auxiliary: !!root };
  }

  // recGroup/autoRec marks ownership. A bare user-created +R is never removed.
  function normalizeLanes(lanes, events, { removeEmpty = true, manual: preserveEmpty = false } = {}) {
    const kept = lanes.filter((lane) => !(removeEmpty && !preserveEmpty && lane.kind === 'R'
      && (lane.recGroup || lane.autoRec === true) && !manual(lane)
      && !events.some((event) => onLane(event, lane))));
    const renames = {};
    const names = new Map();
    const groups = {};
    let number = 0;
    const normalized = kept.map((lane) => {
      const name = lane.kind === 'R' ? 'R' + (++number) : lane.name;
      names.set(lane.name, name);
      if (name !== lane.name) renames[lane.name] = name;
      if (lane.kind === 'R' && lane.recGroup) {
        if (!groups[lane.recGroup]) groups[lane.recGroup] = [];
        groups[lane.recGroup].push(lane.id);
      }
      return { ...lane, name };
    });
    return { lanes: normalized, events: events.map((event) => ({ ...event,
      lane: names.has(event.lane) ? names.get(event.lane) : event.lane })), renames, groups };
  }

  return { resolveCueName, laneKeyFor, labelFor, groupColor, assignGroupColors, textColor,
    planLane, normalizeLanes, PALETTE };
});
