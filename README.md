# Seatwork

**A classroom seating chart that an AI agent can rearrange while the teacher watches.**

Built for [The WebMCP Challenge](https://webmcp.devpost.com/). No build step, no
dependencies, no backend. Four files and a stylesheet.

---

## The problem it actually solves

Making a seating chart is a constraint problem that teachers solve by hand, weekly,
by dragging names around a grid. The constraints are easy to *say* and tedious to
*click*:

> "Six tables of four. Split up Bennett and Talia. Isabel needs the front row for
> her accommodation. And spread the emerging readers out — don't put them all
> together again."

That is thirty seconds of speech and twenty minutes of dragging. Every existing
tool makes you do the dragging, because there was no way for a page to accept the
sentence.

WebMCP is that way. The teacher says the sentence to their agent; the agent calls
`set_room`, three `add_rule`s and `auto_arrange`; the chart rearranges on screen.
Then the teacher drags one student, because they know something about that student
that no constraint captured — and the agent picks the change up on its next read.

**Neither party is driving. Both are working on the same chart.** That is the part
of WebMCP worth building for, and it is why this is a seating chart rather than a
shopping cart: seating is a task where the human's tacit knowledge is genuinely
irreplaceable, so a UI the agent *replaces* would be worse than useless.

---

## The tools

Thirteen at rest, fourteen once there is something to undo.

| Tool | Kind | What it does |
|---|---|---|
| `get_chart_state` | read | The whole chart as prose: tables, students, rules, conflicts |
| `list_students` | read | Roster with traits and current table; filterable by trait |
| `list_rules` | read | Active constraints, with ids for removal |
| `explain_seat` | read | Why one student is where they are, and which rules bind them |
| `set_room` | write | Number of tables and seats each |
| `seat_student` | write | Move one student to a table (displaces rather than drops) |
| `swap_students` | write | Exchange two seated students |
| `unseat_student` | write | Send a student to the bench |
| `add_rule` | write | `apart` · `together` · `front` · `spread` |
| `remove_rule` | write | Drop a constraint |
| `auto_arrange` | write | Solve the whole room against every rule; report what it could not satisfy |
| `export_chart` | read | Plain-text chart for a sub plan or an email |
| `add_student` | write | **Declarative** — registered from HTML attributes, zero JavaScript |
| `undo_last` | write | **Dynamic** — exists only while there is history |

---

## Three things in here worth reading the source for

**1. Parity, not a side door.** `app.js` exposes one `COMMANDS` object. The buttons
call it; `webmcp.js` wraps the same functions in JSON Schema for the agent. Every
command takes a `source` of `"you"` or `"agent"`, which is why the Activity panel
can tell you who did what. There is no agent-only capability and no human-only
capability. A tool layer that can reach past the UI is a second, untested
application hiding behind the first one.

**2. Both APIs.** Twelve tools are imperative (`document.modelContext.registerTool`).
The thirteenth, `add_student`, is declarative — `toolname`, `tooldescription` and
`toolparamdescription` attributes on the roster `<form>`, and the browser derives
the schema from the markup. Same handler serves the human clicking Submit and the
agent invoking the tool.

**3. The tool list is a function of app state.** `undo_last` registers itself when
history appears and unregisters via `AbortController` when it empties. Offering an
agent a tool that can only fail is worse than not offering it. Watch the badge
count go 13 → 14 the first time anything changes.

---

## Three API behaviours that cost us time

Verified in Chrome 151 on 31 Aug 2026, in case they save you an afternoon:

- **`registerTool()`'s promise does not settle** while no agent is attached. Await
  it on your init path and the page hangs before first paint. Fire and forget, and
  attach a `.catch()`.
- **`executeTool` is JSON-in, JSON-out.** Arguments go in as a *string*; the content
  envelope comes back as a *string*. Passing a live object fails with
  `UnknownError: Failed to parse input arguments`, which reads like a bug in your
  tool rather than the type mismatch it is.
- **Unregistering a tool cancels its own in-flight execution** (before Chrome 153).
  `undo_last` empties the history, which triggers the unregister, which killed the
  call that was still returning. Defer the `abort()` by one macrotask.

---

## Run it

```
python3 -m http.server 8000      # or any static server; it is all static files
```

Then open `http://localhost:8000`.

For the agent half you need **ChatGPT's in-app browser**, which supports WebMCP out
of the box, or **Chrome 149+** with `chrome://flags/#enable-webmcp-testing`. The
badge in the top right tells you which surface it found. Without WebMCP the chart
is still a working seating chart — the tool layer degrades to nothing.

## Verify it

Open **`/?selftest`**. It drives the page through the same tool interface an agent
uses — registration, the character budgets from the WebMCP security guide, the
dynamic `undo_last` lifecycle, the error path, and a real `auto_arrange` — and
prints a pass/fail table. 14/14 on Chrome 151.

You can also drive it from the console with no agent attached:

```js
await Seatwork.tools()                          // what an agent sees
await Seatwork.call('add_rule', { type: 'apart', a: 'Bennett', b: 'Talia' })
await Seatwork.call('auto_arrange', {})
```

## Privacy

The roster never leaves the page. There is no server, no analytics, and no network
call after the fonts load. The bundled class is fictional — real student names
should stay that way, and this design is why they can.

## License

MIT. See [LICENSE](LICENSE).
