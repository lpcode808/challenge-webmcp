// Seatwork — live verification of the WebMCP layer. Open /?selftest in a browser
// that has WebMCP on. It drives the page through the same tool interface an agent
// uses, so a pass here means an agent can actually operate this chart.
//
// It mutates the chart while it runs, then undoes its own work.

const mc = document.modelContext || navigator.modelContext;

const LIMITS = { name: 30, description: 500, paramDescription: 150, output: 1500 };

const results = [];
const check = (label, ok, detail = '') => results.push({ label, ok: !!ok, detail });

// executeTool is JSON-in, JSON-out: arguments go in as a string and the content
// envelope comes back as a string. Hand it a live object and Chrome 151 reports
// "UnknownError: Failed to parse input arguments", which reads like a tool bug
// rather than the type mismatch it is.
const exec = async (name, args = {}) => {
  const tools = await mc.getTools();
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  const raw = await mc.executeTool(t, JSON.stringify(args));
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return parsed?.content?.[0]?.text ?? String(raw);
};

async function run() {
  if (!mc) {
    check('WebMCP available', false, 'Neither document.modelContext nor navigator.modelContext exists. Chrome 149+ with chrome://flags/#enable-webmcp-testing, or ChatGPT’s browser.');
    return;
  }
  check('WebMCP available', true, document.modelContext ? 'document.modelContext' : 'navigator.modelContext (deprecated path)');

  // registerTool() is fire-and-forget by design (its promise does not settle until an
  // agent attaches), so tools appear a tick or two after webmcp.js runs. Poll briefly.
  let tools = [];
  for (let i = 0; i < 40 && tools.length < 13; i++) {
    tools = await mc.getTools();
    if (tools.length < 13) await new Promise((r) => setTimeout(r, 50));
  }
  check('Tools registered', tools.length >= 13, `${tools.length} tools: ${tools.map((t) => t.name).join(', ')}`);

  check('Declarative form tool registered', tools.some((t) => t.name === 'add_student'),
    'add_student comes from markup attributes on the roster form, not from JavaScript.');

  const longName = tools.filter((t) => t.name.length > LIMITS.name);
  check(`Tool names ≤ ${LIMITS.name} chars`, longName.length === 0, longName.map((t) => t.name).join(', ') || 'all within budget');

  const longDesc = tools.filter((t) => (t.description || '').length > LIMITS.description);
  check(`Descriptions ≤ ${LIMITS.description} chars`, longDesc.length === 0,
    longDesc.map((t) => `${t.name} (${t.description.length})`).join(', ') || `longest is ${Math.max(...tools.map((t) => (t.description || '').length))}`);

  const longParams = [];
  tools.forEach((t) => {
    const props = t.inputSchema?.properties || {};
    Object.entries(props).forEach(([k, v]) => {
      if ((v.description || '').length > LIMITS.paramDescription) longParams.push(`${t.name}.${k}`);
    });
  });
  check(`Param descriptions ≤ ${LIMITS.paramDescription} chars`, longParams.length === 0, longParams.join(', ') || 'all within budget');

  const state = await exec('get_chart_state');
  check(`get_chart_state output ≤ ${LIMITS.output} chars`, state.length <= LIMITS.output, `${state.length} chars`);
  check('get_chart_state names the tables', /Table 1/.test(state), state.split('\n')[0]);

  const roster = await exec('list_students', { trait: 'support', value: 'front' });
  check('list_students filters by trait', /front/.test(roster) && !/extending reading — unseated/.test(roster), roster.split('\n')[0]);

  const before = (await mc.getTools()).length;
  const arranged = await exec('auto_arrange', { seed: 3 });
  check('auto_arrange seats the class', /Seated \d+ students/.test(arranged), arranged);

  const after = (await mc.getTools()).length;
  check('undo_last registers itself after a change', after > before,
    `${before} tools before, ${after} after — the tool list is a function of app state.`);

  const bad = await exec('seat_student', { student: 'Not A Real Student', table: '3' });
  check('Bad input returns readable text, not an exception', /Could not do that/.test(bad), bad);

  const why = await exec('explain_seat', { student: 'Ada' });
  check('explain_seat answers in prose', why.length > 20 && /Ada/.test(why), why);

  const undone = await exec('undo_last');
  check('undo_last reverses the change', /Reverted/.test(undone), undone);
}

function paint() {
  const pass = results.filter((r) => r.ok).length;
  const panel = document.createElement('section');
  panel.id = 'selftest-panel';
  panel.innerHTML = `
    <h2>WebMCP self-test <span>${pass}/${results.length} passing</span></h2>
    <ol>${results.map((r) => `
      <li data-ok="${r.ok}">
        <b>${r.ok ? 'PASS' : 'FAIL'}</b>
        <span class="lbl">${r.label}</span>
        <span class="detail">${r.detail.replace(/</g, '&lt;')}</span>
      </li>`).join('')}</ol>
    <p>Close this panel by removing <code>?selftest</code> from the URL.</p>`;
  document.body.prepend(panel);

  const css = document.createElement('style');
  css.textContent = `
    #selftest-panel { padding: 1rem 1.5rem; border-bottom: 2px solid var(--ink); background: var(--paper-sunk); }
    #selftest-panel h2 { font-size: .75rem; text-transform: uppercase; letter-spacing: .1em; margin: 0 0 .75rem; }
    #selftest-panel h2 span { font-family: var(--mono); text-transform: none; letter-spacing: 0; color: var(--ink-soft); margin-left: .5rem; }
    #selftest-panel ol { list-style: none; margin: 0; padding: 0; display: grid; gap: .2rem; }
    #selftest-panel li { display: grid; grid-template-columns: 3rem 18rem 1fr; gap: .75rem; font-size: .75rem; align-items: baseline; padding: .2rem 0; border-bottom: 1px solid var(--rule); }
    #selftest-panel b { font-family: var(--mono); font-size: .625rem; letter-spacing: .05em; }
    #selftest-panel li[data-ok="true"] b { color: var(--teal); }
    #selftest-panel li[data-ok="false"] b { color: var(--brick); }
    #selftest-panel .detail { font-family: var(--mono); color: var(--ink-faint); overflow-wrap: anywhere; }
    #selftest-panel p { font-family: var(--prose); font-size: .75rem; font-style: italic; color: var(--ink-faint); margin: .75rem 0 0; }
    @media (max-width: 60rem) { #selftest-panel li { grid-template-columns: 3rem 1fr; } #selftest-panel .detail { grid-column: 2; } }`;
  document.head.append(css);
}

run().catch((e) => check('Self-test completed', false, e.message)).finally(paint);
