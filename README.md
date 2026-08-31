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

Fifteen at rest, sixteen once there is something to undo.

| Tool | Kind | What it does |
|---|---|---|
| `get_chart_state` | read | The whole chart as prose: tables, students, rules, conflicts |
| `list_students` | read | Roster with traits and current table; filterable by trait |
| `list_rules` | read | Active constraints, with ids for removal |
| `explain_seat` | read | Why one student is where they are, and which rules bind them |
| `set_room` | write | Number of tables and seats each |
| `seat_student` | write | Move one student to a table |
| `swap_students` | write | Exchange two seated students |
| `unseat_student` | write | Send a student to the bench |
| `add_rule` | write | `apart` · `together` · `front` · `spread` |
| `remove_rule` | write | Drop a constraint |
| `auto_arrange` | write | Solve the whole room against every rule; report what it could not satisfy |
| `import_roster` | write | Add a whole class from pasted text, one student per line |
| `export_chart` | read | Plain-text chart for a sub plan or an email |
| `reset_chart` | write | Restore the bundled demo class |
| `add_student` | write | **Declarative** — registered from HTML attributes, zero JavaScript |
| `undo_last` | write | **Dynamic** — exists only while there is history |

---

## Three things in here worth reading the source for

**1. Parity, not a side door.** `app.js` exposes one `COMMANDS` object. The buttons
call it; `webmcp.js` wraps the same functions in JSON Schema for the agent. Every
command takes a `source` of `"you"` or `"agent"`, which is why the Activity panel
can tell you who did what. There is no agent-only capability and no human-only
capability — when the agent got `import_roster`, the teacher got a paste box in the
same commit. A tool layer that can reach past the UI is a second, untested
application hiding behind the first one.

**2. Both APIs.** Fourteen tools are imperative (`document.modelContext.registerTool`).
`add_student` is declarative — `toolname`, `tooldescription` and
`toolparamdescription` attributes on the roster `<form>`, and the browser derives
the schema from the markup. The same handler serves the human clicking Submit and
the agent invoking the tool, told apart by `SubmitEvent.agentInvoked`.

**3. The tool list is a function of app state.** `undo_last` registers itself when
history appears and unregisters via `AbortController` when it empties. Offering an
agent a tool that can only fail is worse than not offering it. The badge count is
live — watch it go 15 → 16 the first time anything changes.

---

## Five API behaviours that cost us time

Verified in Chrome 151 on 31 Aug 2026. Four of the five were found by the
self-test, not by reading the docs, and none of them are documented.

- **`registerTool()`'s promise does not settle** while no agent is attached. Await
  it on your init path and the page hangs before first paint. Fire and forget, and
  attach a `.catch()`.
- **`executeTool` is JSON-in, JSON-out.** Arguments go in as a *string*; the content
  envelope comes back as a *string*. Passing a live object fails with
  `UnknownError: Failed to parse input arguments`, which reads like a bug in your
  tool rather than the type mismatch it is.
- **The two APIs are not symmetric on the way out.** An imperative `execute()`
  result arrives JSON-encoded; a declarative form's `respondWith()` value arrives
  exactly as you passed it. Parse defensively or a plain string will throw.
- **`form.reset()` during a tool-invoked submit aborts the execution.** The write
  still lands, but the agent is told `Tool execution cancelled by a form reset` — a
  silent success reported as a failure, which makes an agent retry and then trip
  your duplicate guard. Clear the fields only for a human.
- **Unregistering a tool cancels its own in-flight execution** (before Chrome 153).
  `undo_last` empties the history, which triggers the unregister, which killed the
  call that was still returning. Defer the `abort()` by one macrotask. The general
  shape: any tool whose side effect changes the tool list can abort itself.

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

Students move by drag, and by keyboard: focus a student, **Enter** to pick up,
**arrows** to walk the seats, **Enter** to place, **Escape** to cancel. HTML5 drag
events never fire on touch, and a chart whose subject is seating accommodations
should not be unusable on a tablet.

The chart saves to `localStorage` on every change. Nothing is sent anywhere.

## Verify it

Open **`/?selftest`**. It drives the page through the same tool interface an agent
uses — registration *and execution*, the character budgets from the WebMCP security
guide, the dynamic `undo_last` lifecycle, agent-vs-human attribution, and the error
path — then resets the chart it disturbed. **23/23 on Chrome 151.**

An earlier version of that file checked only that `add_student` was *registered*.
It reported 14/14 while every agent call to that tool failed. Registration is not
execution; a wall of green is not evidence.

You can also drive it from the console with no agent attached:

```js
await Seatwork.tools()                          // what an agent sees
await Seatwork.call('add_rule', { type: 'apart', a: 'Bennett', b: 'Talia' })
await Seatwork.call('auto_arrange', {})
```

## Known gaps

- The declarative `add_student` tool carries **no annotations**. The declarative API
  has attributes for name, description and parameter descriptions, but none for
  `readOnlyHint` or `untrustedContentHint`, so an agent cannot tell from the tool
  list that it mutates. The description says so in words instead.
- `apart(A, B)` does not deduplicate against an existing `apart(B, A)`.
- The solver is hill-climbing with restarts, not exhaustive. It reports the
  conflicts it could not resolve rather than pretending they are gone.

## Privacy

The roster never leaves the page. There is no server, no analytics, and no network
call after the fonts load; the chart persists only to this browser's
`localStorage`. **The bundled class is fictional** — the chip beside the title says
so, and it disappears the moment the roster stops being the demo. Real student
names should stay off the internet, and this design is why they can.

## License

MIT. See [LICENSE](LICENSE).
