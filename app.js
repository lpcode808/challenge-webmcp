// Seatwork — core application.
//
// Architecture note: every verb a human can perform is a named function on the
// COMMANDS object below, and every one of them takes a `source` ("you" | "agent").
// The UI calls them. webmcp.js wraps the same functions in JSON Schema and hands
// them to the browser's agent. Neither path is privileged, and neither can do
// something the other cannot. That parity is the point.

import { DEMO_ROSTER, READING_LEVELS, SUPPORT_FLAGS } from './data/roster-demo.js';

const COLUMNS = 3;              // tables per row; row 0 is the front of the room
const HISTORY_LIMIT = 40;

/* ── state ──────────────────────────────────────────────────────── */

let uid = 0;
const nextId = (p) => `${p}${++uid}`;

const state = {
  title: 'Period 3 — Biology',
  students: [],   // { id, name, reading, support }
  tables: [],     // { id, label, capacity, seats: [studentId|null] }
  rules: [],      // { id, type, a?, b?, trait? }
  log: []         // { who, text, at }
};

let history = [];

const snapshot = () => JSON.stringify({ students: state.students, tables: state.tables, rules: state.rules });
const restore = (s) => { const p = JSON.parse(s); state.students = p.students; state.tables = p.tables; state.rules = p.rules; };

function checkpoint() {
  history.push(snapshot());
  if (history.length > HISTORY_LIMIT) history.shift();
}

/* ── lookups ────────────────────────────────────────────────────── */

const byId = (id) => state.students.find((s) => s.id === id) || null;

function findStudent(nameOrId) {
  if (!nameOrId) return null;
  const q = String(nameOrId).trim().toLowerCase();
  return state.students.find((s) => s.id.toLowerCase() === q)
      || state.students.find((s) => s.name.toLowerCase() === q)
      || state.students.find((s) => s.name.toLowerCase().startsWith(q))
      || state.students.find((s) => s.name.toLowerCase().includes(q))
      || null;
}

function findTable(ref) {
  if (ref === undefined || ref === null) return null;
  const q = String(ref).trim().toLowerCase();
  return state.tables.find((t) => t.id.toLowerCase() === q)
      || state.tables.find((t) => t.label.toLowerCase() === q)
      || state.tables[Number(q) - 1]
      || null;
}

const tableOf = (sid) => state.tables.find((t) => t.seats.includes(sid)) || null;
const rowOf = (t) => Math.floor(state.tables.indexOf(t) / COLUMNS);
const seated = () => state.students.filter((s) => tableOf(s.id));
const unseated = () => state.students.filter((s) => !tableOf(s.id));

/* ── rules: scoring and human-readable violations ───────────────── */

const RULE_WEIGHT = { apart: 10, together: 8, front: 6, spread: 2, unseated: 4 };

function ruleText(r) {
  const n = (id) => (byId(id) ? byId(id).name : '?');
  if (r.type === 'apart')    return `${n(r.a)} and ${n(r.b)} sit apart`;
  if (r.type === 'together') return `${n(r.a)} and ${n(r.b)} sit together`;
  if (r.type === 'front')    return `${n(r.a)} sits in the front row`;
  if (r.type === 'spread')   return `${r.trait} levels spread evenly across tables`;
  return r.type;
}

// Is this one rule currently broken? The single source of truth for that question.
// evaluate(), conflictedIds() and explainSeat() all defer to it, so the chip badges,
// the Conflicts panel and the agent's explanation can never disagree with each other.
// Only the pairwise rules are decidable per-rule; `spread` is a distribution and is
// judged table by table inside evaluate().
function isBroken(r) {
  if (r.type === 'apart') {
    const ta = tableOf(r.a), tb = tableOf(r.b);
    return !!(ta && tb && ta.id === tb.id);
  }
  if (r.type === 'together') {
    const ta = tableOf(r.a), tb = tableOf(r.b);
    return !ta || !tb || ta.id !== tb.id;
  }
  if (r.type === 'front') {
    const t = tableOf(r.a);
    return !t || rowOf(t) !== 0;
  }
  if (r.type === 'spread') return evaluate().violations.some((v) => v.includes(`" ${r.trait}`));
  return false;
}

// Returns { score, violations: [text] }. Lower score is better; 0 is perfect.
function evaluate() {
  let score = 0;
  const violations = [];

  for (const r of state.rules) {
    if (r.type === 'apart') {
      if (isBroken(r)) {
        score += RULE_WEIGHT.apart;
        violations.push(`${byId(r.a).name} and ${byId(r.b).name} are both at ${tableOf(r.a).label}.`);
      }
    } else if (r.type === 'together') {
      if (isBroken(r)) {
        score += RULE_WEIGHT.together;
        violations.push(`${byId(r.a).name} and ${byId(r.b).name} are not at the same table.`);
      }
    } else if (r.type === 'front') {
      if (isBroken(r)) {
        score += RULE_WEIGHT.front;
        violations.push(`${byId(r.a).name} is not in the front row.`);
      }
    } else if (r.type === 'spread') {
      const trait = r.trait;
      const values = [...new Set(state.students.map((s) => s[trait]).filter(Boolean))];
      for (const v of values) {
        const total = state.students.filter((s) => s[trait] === v && tableOf(s.id)).length;
        if (!total) continue;
        const ideal = total / state.tables.length;
        for (const t of state.tables) {
          const got = t.seats.filter((id) => id && byId(id) && byId(id)[trait] === v).length;
          const dev = Math.abs(got - ideal);
          if (dev > 1) {
            score += RULE_WEIGHT.spread * (dev - 1);
            violations.push(`${t.label} has ${got} "${v}" ${trait} — ideal is about ${ideal.toFixed(1)}.`);
          }
        }
      }
    }
  }

  const off = unseated().length;
  if (off) {
    score += RULE_WEIGHT.unseated * off;
    violations.push(`${off} student${off > 1 ? 's are' : ' is'} still unseated.`);
  }
  return { score, violations };
}

// Which student ids are personally implicated in a broken rule (for the red chips).
function conflictedIds() {
  const out = new Set();
  for (const r of state.rules) {
    if (r.type === 'spread' || !isBroken(r)) continue;
    if (r.a) out.add(r.a);
    if (r.b) out.add(r.b);
  }
  return out;
}

/* ── solver ─────────────────────────────────────────────────────── */

// Seeded RNG so a given click of Auto-arrange is reproducible for demos.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function allSlots() {
  const slots = [];
  state.tables.forEach((t, ti) => t.seats.forEach((_, si) => slots.push([ti, si])));
  return slots;
}

// Hill-climb with restarts over seat swaps. Small enough classes that this is instant.
function solve(seed = 7) {
  const rand = mulberry32(seed);
  const slots = allSlots();
  if (!slots.length) return evaluate();

  const capacity = slots.length;
  const roster = state.students.map((s) => s.id);
  if (roster.length > capacity) {
    // Not enough seats; seat as many as fit and let the unseated penalty report it.
  }

  const write = (assign) => state.tables.forEach((t, ti) => {
    t.seats = t.seats.map((_, si) => {
      const hit = assign.findIndex(([a, b]) => a === ti && b === si);
      return hit === -1 ? null : assign[hit][2];
    });
  });

  // assign is a list of [tableIdx, seatIdx, studentId]
  const seedAssign = () => {
    const shuffled = roster.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled.slice(0, capacity).map((id, i) => [slots[i][0], slots[i][1], id]);
  };

  let bestAssign = null, bestScore = Infinity;
  const before = snapshot();

  for (let restart = 0; restart < 6; restart++) {
    let assign = seedAssign();
    write(assign);
    let cur = evaluate().score;

    for (let step = 0; step < 900; step++) {
      const i = Math.floor(rand() * assign.length);
      const j = Math.floor(rand() * assign.length);
      if (i === j) continue;
      [assign[i][2], assign[j][2]] = [assign[j][2], assign[i][2]];
      write(assign);
      const next = evaluate().score;
      if (next <= cur) { cur = next; }
      else { [assign[i][2], assign[j][2]] = [assign[j][2], assign[i][2]]; }
      if (cur === 0) break;
    }
    if (cur < bestScore) { bestScore = cur; bestAssign = assign.map((a) => a.slice()); }
    if (bestScore === 0) break;
  }

  restore(before);
  if (bestAssign) write(bestAssign);
  return evaluate();
}

/* ── command API — the single surface both the UI and the agent use ── */

function note(who, text) {
  state.log.push({ who, text, at: Date.now() });
  if (state.log.length > 60) state.log.shift();
}

let flashIds = [];

export const COMMANDS = {

  // Prose, not JSON. A model reads this more reliably than a nested object, and it
  // costs roughly a third of the characters — which matters against the 1.5K
  // per-tool output budget once a class gets past about twenty students.
  getState() {
    const { score, violations } = evaluate();
    const cap = state.tables[0]?.capacity ?? 0;
    const lines = [`${state.title} — ${state.tables.length} tables × ${cap} seats.`];
    state.tables.forEach((t) => {
      const names = t.seats.filter(Boolean).map((id) => byId(id).name);
      lines.push(`${t.label}${rowOf(t) === 0 ? ' (front row)' : ''}: ${names.join(', ') || 'empty'}`);
    });
    const off = unseated();
    lines.push(`Unseated: ${off.length ? off.map((s) => s.name).join(', ') : 'nobody'}`);
    lines.push(`Rules: ${state.rules.length ? state.rules.map(ruleText).join('; ') : 'none'}`);
    lines.push(score === 0 ? 'Conflicts: none, every rule is satisfied.' : `Conflicts: ${violations.join(' ')}`);
    return lines.join('\n');
  },

  listStudents({ trait, value } = {}) {
    let list = state.students;
    if (trait && value) list = list.filter((s) => String(s[trait]) === String(value));
    if (!list.length) return `No students match ${trait} = ${value}.`;
    const rows = list.map((s) => {
      const t = tableOf(s.id);
      const flag = s.support === 'none' ? '' : `, ${s.support}`;
      return `${s.name} — ${s.reading}${flag} — ${t ? t.label : 'unseated'}`;
    });
    const head = `${rows.length} student${rows.length === 1 ? '' : 's'}`
      + (trait && value ? ` with ${trait} = ${value}` : '') + ':';
    return [head, ...rows].join('\n');
  },

  listRules() {
    if (!state.rules.length) return 'No rules yet.';
    return state.rules.map((r) => `${r.id} [${r.type}] ${ruleText(r)}`).join('\n');
  },

  addStudent({ name, reading = 'secure', support = 'none' }, source = 'you') {
    name = String(name || '').trim();
    if (!name) throw new Error('A student needs a name.');
    if (name.length > 40) throw new Error('Name is too long (40 characters max).');
    if (!READING_LEVELS.includes(reading)) throw new Error(`reading must be one of: ${READING_LEVELS.join(', ')}`);
    if (!SUPPORT_FLAGS.includes(support)) throw new Error(`support must be one of: ${SUPPORT_FLAGS.join(', ')}`);
    if (state.students.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
      throw new Error(`${name} is already on the roster.`);
    }
    checkpoint();
    const s = { id: nextId('s'), name, reading, support };
    state.students.push(s);
    note(source, `added ${name} to the roster`);
    flashIds = [s.id];
    render();
    return `Added ${name} (${reading} reading, ${support} support). They are unseated.`;
  },

  // The one verb that is genuinely easier to say than to click. A teacher has the
  // class list in an email or a spreadsheet column; adding thirty students one form
  // at a time is the reason nobody adopts tools like this.
  importRoster({ text, replace = false }, source = 'you') {
    const lines = String(text || '').split(/[\n\r]+/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) throw new Error('Nothing to import — give me one student per line.');
    if (lines.length > 60) throw new Error(`That is ${lines.length} lines; 60 is the ceiling for one class.`);

    checkpoint();
    if (replace) { state.students = []; state.rules = []; state.tables.forEach((t) => t.seats = t.seats.map(() => null)); }

    const added = [], skipped = [];
    for (const line of lines) {
      const [rawName, rawReading, rawSupport] = line.split('|').map((p) => p.trim());
      const name = (rawName || '').slice(0, 40);
      if (!name) continue;
      if (state.students.some((s) => s.name.toLowerCase() === name.toLowerCase())) { skipped.push(name); continue; }
      const reading = READING_LEVELS.includes(rawReading) ? rawReading : 'secure';
      const support = SUPPORT_FLAGS.includes(rawSupport) ? rawSupport : 'none';
      state.students.push({ id: nextId('s'), name, reading, support });
      added.push(name);
    }
    note(source, `imported ${added.length} student${added.length === 1 ? '' : 's'}`);
    flashIds = state.students.filter((s) => added.includes(s.name)).map((s) => s.id);
    render();
    return `Added ${added.length} student(s). ${skipped.length ? `Skipped ${skipped.length} already on the roster: ${skipped.slice(0, 5).join(', ')}. ` : ''}`
      + `Roster is now ${state.students.length}, with ${unseated().length} unseated — call auto_arrange to seat them.`;
  },

  setTables({ count, capacity }, source = 'you') {
    count = Math.max(1, Math.min(12, Number(count) || state.tables.length || 6));
    capacity = Math.max(1, Math.min(8, Number(capacity) || state.tables[0]?.capacity || 4));
    checkpoint();
    const keep = state.tables.slice(0, count);
    while (keep.length < count) keep.push({ id: nextId('t'), label: `Table ${keep.length + 1}`, capacity, seats: [] });
    keep.forEach((t, i) => {
      t.label = `Table ${i + 1}`;
      t.capacity = capacity;
      t.seats = t.seats.slice(0, capacity);
      while (t.seats.length < capacity) t.seats.push(null);
    });
    // Anyone who lost a seat goes back to the bench, not into the void.
    const held = new Set(keep.flatMap((t) => t.seats).filter(Boolean));
    state.tables = keep;
    const bumped = state.students.filter((s) => !held.has(s.id) && !tableOf(s.id)).length;
    note(source, `set the room to ${count} tables of ${capacity}`);
    render();
    return `Room is now ${count} tables × ${capacity} seats (${count * capacity} seats for ${state.students.length} students).`
      + (bumped ? ` ${bumped} student(s) are on the bench.` : '');
  },

  assignStudent({ student, table, seat }, source = 'you') {
    const s = findStudent(student);
    if (!s) throw new Error(`No student matching "${student}".`);
    const t = findTable(table);
    if (!t) throw new Error(`No table matching "${table}". Tables are ${state.tables.map((x) => x.label).join(', ')}.`);
    let idx = seat === undefined || seat === null ? t.seats.indexOf(null) : Number(seat) - 1;
    if (idx === -1) throw new Error(`${t.label} is full.`);
    if (idx < 0 || idx >= t.seats.length) throw new Error(`${t.label} has seats 1–${t.seats.length}.`);
    checkpoint();
    const displaced = t.seats[idx];
    const prev = tableOf(s.id);
    if (prev) prev.seats[prev.seats.indexOf(s.id)] = null;
    t.seats[idx] = s.id;

    // The occupant can only take the incoming student's old seat if there was one.
    // When the incoming student comes off the bench there is nowhere to put the
    // occupant, so they go to the bench — and the agent has to be told that, or it
    // will report a swap that did not happen and act on its own false memory.
    let moved = null;
    if (displaced && displaced !== s.id) {
      if (prev) { prev.seats[prev.seats.indexOf(null)] = displaced; moved = prev; }
    }
    note(source, `seated ${s.name} at ${t.label}`);
    flashIds = [s.id, displaced].filter(Boolean);
    render();
    let tail = '';
    if (displaced && displaced !== s.id) {
      tail = moved
        ? ` ${byId(displaced).name} moved to ${moved.label}.`
        : ` ${byId(displaced).name} is now on the bench — there was no seat to trade.`;
    }
    return `${s.name} is at ${t.label}, seat ${idx + 1}.` + tail;
  },

  swapStudents({ a, b }, source = 'you') {
    const sa = findStudent(a), sb = findStudent(b);
    if (!sa) throw new Error(`No student matching "${a}".`);
    if (!sb) throw new Error(`No student matching "${b}".`);
    const ta = tableOf(sa.id), tb = tableOf(sb.id);
    if (!ta || !tb) throw new Error('Both students must already be seated to swap.');
    checkpoint();
    const ia = ta.seats.indexOf(sa.id), ib = tb.seats.indexOf(sb.id);
    ta.seats[ia] = sb.id; tb.seats[ib] = sa.id;
    note(source, `swapped ${sa.name} and ${sb.name}`);
    flashIds = [sa.id, sb.id];
    render();
    return `${sa.name} is now at ${tb.label} and ${sb.name} is at ${ta.label}.`;
  },

  unseatStudent({ student }, source = 'you') {
    const s = findStudent(student);
    if (!s) throw new Error(`No student matching "${student}".`);
    const t = tableOf(s.id);
    if (!t) return `${s.name} was already unseated.`;
    checkpoint();
    t.seats[t.seats.indexOf(s.id)] = null;
    note(source, `moved ${s.name} to the bench`);
    flashIds = [s.id];
    render();
    return `${s.name} is on the bench.`;
  },

  addRule({ type, a, b, trait }, source = 'you') {
    if (!['apart', 'together', 'front', 'spread'].includes(type)) {
      throw new Error('type must be apart, together, front, or spread.');
    }
    const r = { id: nextId('r'), type };
    if (type === 'spread') {
      r.trait = trait === 'support' ? 'support' : 'reading';
    } else {
      const sa = findStudent(a);
      if (!sa) throw new Error(`No student matching "${a}".`);
      r.a = sa.id;
      if (type !== 'front') {
        const sb = findStudent(b);
        if (!sb) throw new Error(`No student matching "${b}".`);
        if (sb.id === sa.id) throw new Error('A rule needs two different students.');
        r.b = sb.id;
      }
    }
    if (state.rules.some((x) => x.type === r.type && x.a === r.a && x.b === r.b && x.trait === r.trait)) {
      return `That rule is already in the list: ${ruleText(r)}.`;
    }
    checkpoint();
    state.rules.push(r);
    note(source, `added rule — ${ruleText(r)}`);
    render();
    return `Rule added: ${ruleText(r)}. It is not applied until you auto-arrange.`;
  },

  removeRule({ id }, source = 'you') {
    const i = state.rules.findIndex((r) => r.id === id || ruleText(r).toLowerCase().includes(String(id).toLowerCase()));
    if (i === -1) throw new Error(`No rule matching "${id}".`);
    checkpoint();
    const [gone] = state.rules.splice(i, 1);
    note(source, `removed rule — ${ruleText(gone)}`);
    render();
    return `Removed: ${ruleText(gone)}.`;
  },

  autoArrange({ seed } = {}, source = 'you') {
    if (!state.tables.length) throw new Error('Set up at least one table first.');
    if (!state.students.length) throw new Error('The roster is empty.');
    checkpoint();
    const { score, violations } = solve(Number(seed) || 7);
    note(source, score === 0 ? 'auto-arranged — every rule satisfied' : `auto-arranged — ${violations.length} conflict(s) left`);
    flashIds = state.students.map((s) => s.id);
    render();
    if (score === 0) return `Seated ${seated().length} students. Every rule is satisfied.`;
    return `Seated ${seated().length} students. ${violations.length} conflict(s) remain: ` + violations.slice(0, 4).join(' ');
  },

  explainSeat({ student }) {
    const s = findStudent(student);
    if (!s) throw new Error(`No student matching "${student}".`);
    const t = tableOf(s.id);
    const where = t ? `${s.name} is at ${t.label} (${rowOf(t) === 0 ? 'front row' : `row ${rowOf(t) + 1}`}).` : `${s.name} is unseated.`;
    const mine = state.rules.filter((r) => r.a === s.id || r.b === s.id);
    if (!mine.length) return `${where} No rule mentions them, so the solver placed them to balance the room.`;
    // Ask each rule about itself. Matching the student's name against the global
    // violation list marks every rule they appear in as broken the moment any one
    // of them is — which is how this tool spent its first day confidently telling
    // a teacher that a satisfied front-row rule was broken.
    const lines = mine.map((r) => `${ruleText(r)} — ${isBroken(r) ? 'currently broken' : 'satisfied'}`);
    return `${where} Rules touching them: ${lines.join('; ')}.`;
  },

  exportChart() {
    const lines = [`# ${state.title}`, ''];
    state.tables.forEach((t) => {
      const names = t.seats.filter(Boolean).map((id) => byId(id).name);
      lines.push(`**${t.label}**${rowOf(t) === 0 ? ' (front row)' : ''}: ${names.join(', ') || '—'}`);
    });
    const off = unseated();
    if (off.length) lines.push('', `Unseated: ${off.map((s) => s.name).join(', ')}`);
    return lines.join('\n');
  },

  undo(_ = {}, source = 'you') {
    if (!history.length) return 'Nothing to undo.';
    restore(history.pop());
    note(source, 'undid the last change');
    render();
    return 'Reverted the last change.';
  },

  canUndo: () => history.length > 0,
  hasStudents: () => state.students.length > 0
};

/* ── rendering ──────────────────────────────────────────────────── */

const $ = (id) => document.getElementById(id);
const TRAIT_LETTER = { emerging: 'E', secure: 'S', extending: 'X', multilingual: 'M', front: 'F', lowdistraction: 'L' };

function chip(s, conflicted) {
  const el = document.createElement('div');
  el.className = 'chip' + (conflicted.has(s.id) ? ' conflict' : '') + (flashIds.includes(s.id) ? ' flash' : '');
  el.draggable = true;
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  if (carrying === s.id) el.setAttribute('aria-grabbed', 'true');
  el.dataset.sid = s.id;
  el.title = `${s.name} — ${s.reading} reading${s.support !== 'none' ? `, ${s.support}` : ''}`;

  const name = document.createElement('span');
  name.className = 'chip-name';
  name.textContent = s.name;
  el.append(name);

  const r = document.createElement('span');
  r.className = 'trait'; r.dataset.t = s.reading; r.textContent = TRAIT_LETTER[s.reading];
  el.append(r);

  if (s.support !== 'none') {
    const sup = document.createElement('span');
    sup.className = 'trait'; sup.dataset.t = s.support; sup.textContent = TRAIT_LETTER[s.support];
    el.append(sup);
  }
  return el;
}

function render() {
  const conflicted = conflictedIds();

  // bench
  const bench = $('bench');
  bench.querySelectorAll('.chip').forEach((n) => n.remove());
  const off = unseated();
  $('bench-empty').hidden = off.length > 0;
  off.forEach((s) => bench.append(chip(s, conflicted)));
  $('roster-count').textContent = `${state.students.length} students · ${off.length} unseated`;

  // room
  const room = $('room');
  room.style.gridTemplateColumns = `repeat(${Math.min(COLUMNS, Math.max(1, state.tables.length))}, minmax(0, 1fr))`;
  room.replaceChildren();
  state.tables.forEach((t) => {
    const card = document.createElement('div');
    card.className = 'table' + (rowOf(t) === 0 ? ' front-row' : '');

    const head = document.createElement('div');
    head.className = 'table-head';
    const lbl = document.createElement('span'); lbl.textContent = t.label;
    const fill = document.createElement('span');
    fill.className = 'fill';
    fill.textContent = `${t.seats.filter(Boolean).length}/${t.capacity}`;
    head.append(lbl, fill);

    const seats = document.createElement('div');
    seats.className = 'seats';
    t.seats.forEach((sid, si) => {
      const seat = document.createElement('div');
      seat.className = 'seat' + (sid ? '' : ' empty');
      seat.dataset.table = t.id; seat.dataset.seat = String(si);
      if (sid && byId(sid)) seat.append(chip(byId(sid), conflicted));
      seats.append(seat);
    });
    card.append(head, seats);
    room.append(card);
  });

  // rules
  const rules = $('rules');
  rules.replaceChildren();
  state.rules.forEach((r) => {
    const li = document.createElement('li');
    const kind = document.createElement('span'); kind.className = 'rule-kind'; kind.textContent = r.type;
    const txt = document.createElement('b'); txt.textContent = ruleText(r);
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'rule-drop'; del.textContent = '×';
    del.setAttribute('aria-label', `Remove rule: ${ruleText(r)}`);
    del.onclick = () => COMMANDS.removeRule({ id: r.id }, 'you');
    const left = document.createElement('span'); left.append(kind, ' ', txt);
    li.append(left, del);
    rules.append(li);
  });
  $('rules-empty').hidden = state.rules.length > 0;
  $('rules-count').textContent = state.rules.length ? `${state.rules.length}` : '';

  // conflicts
  const { violations } = evaluate();
  const vl = $('violations');
  vl.replaceChildren();
  violations.forEach((v) => { const li = document.createElement('li'); li.textContent = v; vl.append(li); });
  $('violations-ok').hidden = violations.length > 0;
  $('violation-count').textContent = violations.length ? String(violations.length) : '';

  // activity
  const log = $('log');
  log.replaceChildren();
  state.log.slice(-40).forEach((e) => {
    const li = document.createElement('li');
    li.dataset.who = e.who;
    const who = document.createElement('span'); who.className = 'who'; who.textContent = e.who === 'agent' ? 'agent' : 'you';
    li.append(who, e.text);
    log.append(li);
  });

  $('btn-undo').disabled = !history.length;
  $('demo-chip').hidden = !isDemoRoster();
  refreshRuleOperands();
  persist();
  flashIds = [];
  document.dispatchEvent(new CustomEvent('seatwork:change'));
}

/* ── drag and drop ──────────────────────────────────────────────── */

let dragId = null;

document.addEventListener('dragstart', (e) => {
  const c = e.target.closest?.('.chip');
  if (!c) return;
  dragId = c.dataset.sid;
  c.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragId);
});

document.addEventListener('dragend', (e) => {
  e.target.closest?.('.chip')?.classList.remove('dragging');
  document.querySelectorAll('.drop-target').forEach((n) => n.classList.remove('drop-target'));
  dragId = null;
});

document.addEventListener('dragover', (e) => {
  const zone = e.target.closest?.('.seat, #bench');
  if (!zone || !dragId) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.drop-target').forEach((n) => n.classList.remove('drop-target'));
  zone.classList.add('drop-target');
});

document.addEventListener('drop', (e) => {
  const zone = e.target.closest?.('.seat, #bench');
  if (!zone || !dragId) return;
  e.preventDefault();
  const s = byId(dragId);
  try {
    if (zone.id === 'bench') COMMANDS.unseatStudent({ student: s.id }, 'you');
    else COMMANDS.assignStudent({ student: s.id, table: zone.dataset.table, seat: Number(zone.dataset.seat) + 1 }, 'you');
  } catch (err) { console.warn(err.message); }
  dragId = null;
});

/* ── UI wiring ──────────────────────────────────────────────────── */

function refreshRuleOperands() {
  const type = $('rule-type').value;
  const box = $('rule-operands');
  const want = type === 'spread' ? ['trait'] : type === 'front' ? ['a'] : ['a', 'b'];
  if (box.dataset.shape === type) return;
  box.dataset.shape = type;
  box.replaceChildren();
  want.forEach((slot) => {
    const label = document.createElement('label'); label.className = 'field';
    const span = document.createElement('span');
    span.textContent = slot === 'trait' ? 'Trait' : slot === 'a' ? 'Student' : 'and';
    const sel = document.createElement('select'); sel.dataset.slot = slot;
    if (slot === 'trait') {
      ['reading', 'support'].forEach((v) => { const o = document.createElement('option'); o.value = v; o.textContent = v; sel.append(o); });
    } else {
      state.students.forEach((s) => { const o = document.createElement('option'); o.value = s.id; o.textContent = s.name; sel.append(o); });
      // Both dropdowns defaulting to the same student makes the only visible
      // default state an invalid rule. Start the second one on someone else.
      if (slot === 'b' && sel.options.length > 1) sel.selectedIndex = 1;
    }
    label.append(span, sel);
    box.append(label);
  });
}

function guard(fn) {
  try { const msg = fn(); if (msg) console.info(msg); }
  catch (err) { note('you', `couldn't do that — ${err.message}`); render(); }
}

$('btn-arrange').onclick = () => guard(() => COMMANDS.autoArrange({}, 'you'));
$('btn-undo').onclick = () => guard(() => COMMANDS.undo({}, 'you'));
$('btn-print').onclick = () => window.print();
$('chart-title').oninput = (e) => { state.title = e.target.value; persist(); };
$('rule-type').onchange = () => { $('rule-operands').dataset.shape = ''; refreshRuleOperands(); };
$('btn-import').onclick = () => guard(() => {
  const msg = COMMANDS.importRoster({ text: $('import-text').value }, 'you');
  $('import-text').value = '';
  return msg;
});
$('btn-reset-demo').onclick = () => guard(() => COMMANDS.resetToDemo({}, 'you'));

['table-count', 'table-capacity'].forEach((id) => {
  $(id).onchange = () => guard(() => COMMANDS.setTables({ count: Number($('table-count').value), capacity: Number($('table-capacity').value) }, 'you'));
});

// The declarative WebMCP form. A human submits it by clicking; an agent submits it
// by calling the `add_student` tool the markup declares. Same handler, same result.
//
// Two details the declarative API gives you that are easy to miss, and that this
// handler got wrong until a probe caught it:
//
//   e.agentInvoked  — true when the submit came from a tool call rather than a
//                     click. It is the only honest way to attribute the change.
//   e.respondWith() — hands the agent a result. Without it the agent gets nothing
//                     back, so it cannot tell you what it just did.
//
// And one trap: form.reset() during a tool-invoked submit aborts the execution.
// The write still lands, but the agent is told "Tool execution cancelled by a form
// reset" — a silent success reported as a failure, which makes an agent retry and
// then trip the duplicate-name guard. Clear the fields only for a human.
$('add-student-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const fromAgent = e.agentInvoked === true;

  let message;
  try {
    message = COMMANDS.addStudent({
      name: f.get('name'), reading: f.get('reading'), support: f.get('support')
    }, fromAgent ? 'agent' : 'you');
  } catch (err) {
    message = `Could not do that: ${err.message}`;
    note(fromAgent ? 'agent' : 'you', `couldn't add that student — ${err.message}`);
    render();
  }

  if (fromAgent) e.respondWith?.(Promise.resolve(message));
  else e.target.reset();
});

$('add-rule-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const type = $('rule-type').value;
  const pick = (slot) => $('rule-operands').querySelector(`[data-slot="${slot}"]`)?.value;
  guard(() => COMMANDS.addRule({ type, a: pick('a'), b: pick('b'), trait: pick('trait') }, 'you'));
});

/* ── keyboard path for moving a student ─────────────────────────── */
// HTML5 drag events never fire on touch, and a chart whose subject is seating
// accommodations should not be unusable on the tablet half the school runs on.
// Enter picks a student up, arrows walk the seats, Enter puts them down, Escape
// cancels. Same COMMANDS calls the mouse makes.

let carrying = null;

function seatList() {
  return [...document.querySelectorAll('.seat')];
}

function highlight(i) {
  seatList().forEach((s, n) => s.classList.toggle('keyboard-target', n === i));
}

let cursor = 0;

document.addEventListener('keydown', (e) => {
  const chip = e.target.closest?.('.chip');

  if (!carrying && chip && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    carrying = chip.dataset.sid;
    chip.setAttribute('aria-grabbed', 'true');
    const seats = seatList();
    cursor = Math.max(0, seats.findIndex((s) => s.contains(chip)));
    highlight(cursor);
    note('you', `picked up ${byId(carrying).name} — arrows to choose a seat, Enter to place`);
    render();
    return;
  }

  if (!carrying) return;

  if (e.key === 'Escape') {
    e.preventDefault();
    carrying = null; highlight(-1); render();
    return;
  }
  if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) {
    e.preventDefault();
    const seats = seatList();
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
    cursor = (cursor + step + seats.length) % seats.length;
    highlight(cursor);
    seats[cursor].scrollIntoView({ block: 'nearest' });
    return;
  }
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    const target = seatList()[cursor];
    const held = carrying;
    carrying = null;
    if (target) {
      guard(() => COMMANDS.assignStudent(
        { student: held, table: target.dataset.table, seat: Number(target.dataset.seat) + 1 }, 'you'));
    }
    highlight(-1);
  }
});

/* ── persistence ────────────────────────────────────────────────── */
// Local only. The roster never goes anywhere — that is the point of the design,
// not a limitation of it.

const STORAGE_KEY = 'seatwork:chart:v1';

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      title: state.title, students: state.students, tables: state.tables, rules: state.rules, uid
    }));
  } catch { /* private window, or storage disabled. The chart still works. */ }
}

function loadSaved() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const p = JSON.parse(raw);
    if (!Array.isArray(p.students) || !Array.isArray(p.tables)) return false;
    state.title = p.title || state.title;
    state.students = p.students;
    state.tables = p.tables;
    state.rules = p.rules || [];
    uid = Number(p.uid) || state.students.length + state.tables.length + 10;
    return true;
  } catch { return false; }
}

// True only while the roster is exactly the bundled demo. Once anyone edits it,
// the "fictional students" chip stops being a true statement, so it goes away.
function isDemoRoster() {
  if (state.students.length !== DEMO_ROSTER.length) return false;
  const mine = state.students.map((s) => s.name).sort().join('|');
  return mine === DEMO_ROSTER.map((s) => s.name).sort().join('|');
}

function seedDemo() {
  state.students = [];
  DEMO_ROSTER.forEach((r) => state.students.push({ id: nextId('s'), name: r.name, reading: r.reading, support: r.support }));
  COMMANDS.setTables({ count: 6, capacity: 4 }, 'you');
  COMMANDS.addRule({ type: 'spread', trait: 'reading' }, 'you');
  COMMANDS.autoArrange({ seed: 7 }, 'you');
}

COMMANDS.resetToDemo = function (_ = {}, source = 'you') {
  checkpoint();
  state.rules = [];
  seedDemo();
  note(source, 'reset to the demo class');
  render();
  return 'Chart reset to the bundled demo class of 24 fictional students.';
};

/* ── boot ───────────────────────────────────────────────────────── */

if (!loadSaved()) seedDemo();
$('chart-title').value = state.title;
$('table-count').value = state.tables.length || 6;
$('table-capacity').value = state.tables[0]?.capacity || 4;
state.log.length = 0;
note('you', 'opened the chart');
history = [];
render();

window.Seatwork = COMMANDS;   // handy in the console, and for the demo video
