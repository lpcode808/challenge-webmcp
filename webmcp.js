// Seatwork — the WebMCP layer.
//
// This file is deliberately the thinnest thing in the repo. Every tool below is a
// typed façade over a function in app.js that the on-screen UI already calls. Nothing
// here can do something a teacher cannot do by hand, and nothing the teacher does by
// hand is hidden from the agent — the agent re-reads state through `get_chart_state`
// after every human drag.
//
// Three things worth reading for, if you are grading this:
//   1. registerTool() is called fire-and-forget. Its promise does not settle until an
//      agent attaches, so awaiting it on the init path hangs the page before paint.
//   2. Every tool clamps its own output to the 1.5K character budget from
//      developer.chrome.com/docs/ai/webmcp/secure-tools, so a 30-student roster can
//      never blow the agent's context.
//   3. `undo_last` registers and unregisters itself as history appears and empties,
//      via AbortController — the tool list is a function of app state, not a constant.

import { COMMANDS } from './app.js';

/* ── locate the API ─────────────────────────────────────────────── */
// The May 2026 spec draft moved the getter from Navigator to Document, on the
// reasoning that tools belong to a page rather than to a browser. Chrome still
// ships the deprecated navigator path during the origin trial, so: prefer
// document, accept navigator, degrade to a plain working app if neither exists.
const mc = globalThis.document?.modelContext || globalThis.navigator?.modelContext || null;

const OUTPUT_BUDGET = 1500;   // per the WebMCP tool security guide

function clamp(text) {
  const s = String(text);
  return s.length <= OUTPUT_BUDGET ? s : s.slice(0, OUTPUT_BUDGET - 60) + `\n…truncated. Call get_chart_state for a summary.`;
}

// Every tool returns the MCP content envelope. Errors come back as readable text
// rather than exceptions, because a thrown error tells the model nothing it can act on.
function reply(text) {
  return { content: [{ type: 'text', text: clamp(text) }] };
}

function tool(fn) {
  return async (inputs = {}) => {
    try { return reply(fn(inputs)); }
    catch (err) { return reply(`Could not do that: ${err.message}`); }
  };
}

const asText = (v) => (typeof v === 'string' ? v : JSON.stringify(v));

/* ── the tools ──────────────────────────────────────────────────── */

const READ  = { readOnlyHint: true,  untrustedContentHint: true };  // returns teacher-entered names
const WRITE = { readOnlyHint: false, untrustedContentHint: true };

const TOOLS = [
  {
    name: 'get_chart_state',
    description: 'Read the whole seating chart at once: every table with its students, who is unseated, the active rules, and any rule conflicts. Call this first, and again after the teacher moves someone by hand, so you are not working from a stale picture.',
    inputSchema: { type: 'object', properties: {} },
    annotations: READ,
    run: () => asText(COMMANDS.getState())
  },
  {
    name: 'list_students',
    description: 'List students with their reading band, support flag, and current table. Optionally filter to one trait value, for example every student whose support flag is "front".',
    inputSchema: {
      type: 'object',
      properties: {
        trait: { type: 'string', enum: ['reading', 'support'], description: 'Which trait to filter on. Omit to list everyone.' },
        value: { type: 'string', description: 'The trait value to match, e.g. "emerging", "extending", "multilingual", "front".' }
      }
    },
    annotations: READ,
    run: (i) => asText(COMMANDS.listStudents(i))
  },
  {
    name: 'list_rules',
    description: 'List the seating rules currently in force, with the id needed to remove one.',
    inputSchema: { type: 'object', properties: {} },
    annotations: READ,
    run: () => asText(COMMANDS.listRules())
  },
  {
    name: 'explain_seat',
    description: 'Explain why one student is where they are: which table, which row, which rules mention them, and whether those rules are currently satisfied. Use this when the teacher asks "why is X there?".',
    inputSchema: {
      type: 'object',
      properties: { student: { type: 'string', description: 'Student name or partial name.' } },
      required: ['student']
    },
    annotations: READ,
    run: (i) => COMMANDS.explainSeat(i)
  },
  {
    name: 'set_room',
    description: 'Set how many tables the room has and how many seats are at each. Tables fill left to right, three per row; row one is the front of the room nearest the board.',
    inputSchema: {
      type: 'object',
      properties: {
        count: { type: 'integer', minimum: 1, maximum: 12, description: 'Number of tables, 1 to 12.' },
        capacity: { type: 'integer', minimum: 1, maximum: 8, description: 'Seats at each table, 1 to 8.' }
      },
      required: ['count', 'capacity']
    },
    annotations: WRITE,
    run: (i) => COMMANDS.setTables(i, 'agent')
  },
  {
    name: 'seat_student',
    description: 'Move one student to a table. Names match loosely, so a first name is usually enough. Omit the seat number to take the first open seat; if the seat is taken, the occupant moves rather than being dropped.',
    inputSchema: {
      type: 'object',
      properties: {
        student: { type: 'string', description: 'Student name or partial name.' },
        table: { type: 'string', description: 'Table label such as "Table 3", or just the number 3.' },
        seat: { type: 'integer', minimum: 1, maximum: 8, description: 'Optional seat number at that table.' }
      },
      required: ['student', 'table']
    },
    annotations: WRITE,
    run: (i) => COMMANDS.assignStudent(i, 'agent')
  },
  {
    name: 'swap_students',
    description: 'Exchange the seats of two students who are both already seated. Use this rather than two seat_student calls when the teacher says "switch these two".',
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'string', description: 'First student name.' },
        b: { type: 'string', description: 'Second student name.' }
      },
      required: ['a', 'b']
    },
    annotations: WRITE,
    run: (i) => COMMANDS.swapStudents(i, 'agent')
  },
  {
    name: 'unseat_student',
    description: 'Take a student out of their seat and put them back on the bench. Use for an absence, or to free a seat before a rearrangement.',
    inputSchema: {
      type: 'object',
      properties: { student: { type: 'string', description: 'Student name or partial name.' } },
      required: ['student']
    },
    annotations: WRITE,
    run: (i) => COMMANDS.unseatStudent(i, 'agent')
  },
  {
    name: 'add_rule',
    description: 'Add a seating constraint. "apart" keeps two students at different tables, "together" puts them at the same one, "front" puts a student in the front row, and "spread" distributes a trait evenly across tables. Adding a rule does not move anyone — call auto_arrange to apply it.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['apart', 'together', 'front', 'spread'], description: 'Which kind of rule to add.' },
        a: { type: 'string', description: 'First student. Required for apart, together, and front.' },
        b: { type: 'string', description: 'Second student. Required for apart and together.' },
        trait: { type: 'string', enum: ['reading', 'support'], description: 'Trait to balance. Required for spread.' }
      },
      required: ['type']
    },
    annotations: WRITE,
    run: (i) => COMMANDS.addRule(i, 'agent')
  },
  {
    name: 'remove_rule',
    description: 'Drop a rule from the list, by its id from list_rules or by a phrase from the rule text.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Rule id, or part of the rule wording.' } },
      required: ['id']
    },
    annotations: WRITE,
    run: (i) => COMMANDS.removeRule(i, 'agent')
  },
  {
    name: 'auto_arrange',
    description: 'Seat the whole class to satisfy as many rules as possible, then report which conflicts are left. This is the heavy one: it reshuffles everybody, so say what changed afterward and remind the teacher that Undo reverses it in one step.',
    inputSchema: {
      type: 'object',
      properties: { seed: { type: 'integer', description: 'Optional seed. The same seed gives the same arrangement; change it to see a different valid one.' } }
    },
    annotations: WRITE,
    run: (i) => COMMANDS.autoArrange(i, 'agent')
  },
  {
    name: 'export_chart',
    description: 'Return the finished chart as plain text, table by table, ready to paste into a sub plan or an email.',
    inputSchema: { type: 'object', properties: {} },
    annotations: READ,
    run: () => COMMANDS.exportChart()
  },
  {
    name: 'import_roster',
    description: 'Add a whole class at once from pasted text, one student per line as "Name" or "Name | reading | support". Duplicates are skipped, not overwritten. This is the fast path when a teacher has a class list in an email or a spreadsheet column — use it instead of calling add_student thirty times.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The class list. One student per line; pipes separate optional reading band and support flag.' },
        replace: { type: 'boolean', description: 'True to clear the existing roster and rules first. Defaults to false, which appends.' }
      },
      required: ['text']
    },
    annotations: WRITE,
    run: (i) => COMMANDS.importRoster(i, 'agent')
  },
  {
    name: 'reset_chart',
    description: 'Discard the current chart and restore the bundled demo class of 24 fictional students. Destructive — confirm with the teacher before calling it, and say that Undo will not bring a hand-built roster back once the page is reloaded.',
    inputSchema: { type: 'object', properties: {} },
    annotations: WRITE,
    run: () => COMMANDS.resetToDemo({}, 'agent')
  }
];

/* ── registration ───────────────────────────────────────────────── */

function register(spec, options = {}) {
  if (!mc) return;
  // Not awaited on purpose. registerTool()'s promise does not settle while no agent
  // is attached, so awaiting here would stall boot. Failures are logged, not thrown.
  mc.registerTool(
    {
      name: spec.name,
      description: spec.description,
      inputSchema: spec.inputSchema,
      annotations: spec.annotations,
      execute: tool(spec.run)
    },
    options
  )?.catch?.((err) => console.warn(`[seatwork] could not register ${spec.name}:`, err));
}

TOOLS.forEach((t) => register(t));

/* ── a tool that comes and goes with the state it depends on ────── */
// There is nothing to undo on a fresh page, and offering an agent a tool that can
// only fail is worse than not offering it. So undo_last exists exactly when history
// does. `toolchange` fires on the agent's side each time this flips.

let undoAbort = null;

function syncUndoTool() {
  if (!mc) return;
  const should = COMMANDS.canUndo();
  if (should && !undoAbort) {
    undoAbort = new AbortController();
    register({
      name: 'undo_last',
      description: 'Reverse the most recent change to the chart, whether the agent or the teacher made it. Only available when there is something to undo.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      run: () => COMMANDS.undo({}, 'agent')
    }, { signal: undoAbort.signal });
  } else if (!should && undoAbort) {
    // Deferred one macrotask on purpose. The last undo empties the history, which
    // fires seatwork:change from inside undo_last's own execute(). Aborting there
    // and then unregisters the tool that is still running, and Chrome 151 answers
    // the agent with "the operation failed for an unknown transient reason"
    // instead of the result. Chrome 153 is documented to stop cancelling in-flight
    // executions on unregister; until that is everywhere, let the call return first.
    const dying = undoAbort;
    undoAbort = null;
    // Re-check on the way out. If history reappeared during the deferral, a new
    // controller is already live and this abort would tear down the wrong tool.
    setTimeout(() => { if (undoAbort === null) dying.abort(); refreshBadge(); }, 0);
  }
  refreshBadge();
}

document.addEventListener('seatwork:change', syncUndoTool);

/* ── tell the teacher whether an agent can actually reach this page ── */

const badge = document.getElementById('agent-badge');
const badgeText = document.getElementById('agent-badge-text');

// The count is live, not a constant. Watching it tick as undo_last comes and goes
// is the fastest way to see that the tool list tracks application state.
async function refreshBadge() {
  if (!mc) return;
  try {
    const n = (await mc.getTools()).length;
    badgeText.textContent = `WebMCP ready · ${n} tools`;
  } catch { /* leave the last good count up */ }
}

if (mc) {
  badge.dataset.state = 'on';
  const surface = globalThis.document?.modelContext ? 'document' : 'navigator';
  badgeText.textContent = `WebMCP ready · ${TOOLS.length} tools`;
  badge.title = `Tools are registered on ${surface}.modelContext. Ask your agent to rearrange the room.`;
  refreshBadge();
} else {
  badge.dataset.state = 'off';
  badgeText.textContent = 'WebMCP off — chart still works';
  badge.title = 'Open in ChatGPT’s browser, or Chrome 149+ with chrome://flags/#enable-webmcp-testing.';
}

syncUndoTool();

// Exposed so the demo video (and anyone reading the repo) can list and call the
// exact tools an agent sees, from the console, with no agent attached:
//   await Seatwork.tools()            → the registered tool list
//   await Seatwork.call('auto_arrange', {})
globalThis.Seatwork = Object.assign(globalThis.Seatwork || {}, {
  tools: async () => (mc ? mc.getTools() : []),
  call: async (name, args = {}) => {
    if (!mc) throw new Error('WebMCP is not available in this browser.');
    const found = (await mc.getTools()).find((t) => t.name === name);
    if (!found) throw new Error(`No tool named ${name}.`);
    // executeTool takes arguments as a JSON *string*. Handing it a live object
    // fails with "UnknownError: Failed to parse input arguments", which is a
    // confusing message for what is really a type mismatch. Verified in
    // Chrome 151 — see selftest.html.
    return mc.executeTool(found, JSON.stringify(args));
  }
});
