# POP-project-II-coach-extension
Multi-turn chat Codio Coach extension to assist with development of Project II assessment

The student presses **I have a question** in Coach and chats with the assistant. The
conversation is kept in the student's project, so it can be resumed after days of
inactivity. With every request the assistant receives the files the student has open
in tabs and the new part of their terminal history.

## How it works

| Piece | Where | What it does |
|---|---|---|
| `index.js` | this repo | the Coach extension |
| `POP_PROJECT_2_SYSTEM` | stored prompt in the Codio organization | system prompt; Codio resolves `{% prompt 'POP_PROJECT_2_SYSTEM' %}` on its server, so the model solution never reaches the browser |
| `.guides/coach/install_hook.sh` | assessment repo (`POP-project-bbk`) | run by the extension at every IDE load: creates `.guides/coach/turns/`, adds a terminal-recording hook to `~/.bashrc`, trims `terminal.log` above 5 MB |
| `.guides/coach/start_terminal_log.sh` | assessment repo | sourced by the hook: runs each new interactive terminal inside `script`, appending everything shown to `.guides/coach/terminal.log` |
| `.guides/coach/terminal_since.sh` | assessment repo | prints the terminal text written since a byte offset, cleaned of colour codes etc. |

`.guides` is not shown in the Codio file tree, which is why the data lives there.

### Stored conversation

Each completed exchange is written once to `.guides/coach/turns/<timestamp>.json`
(`codioIDE.files.add` cannot overwrite files, so nothing is ever rewritten):

```json
{ "format": 1, "id": 1768041720000, "time": "...", "request": "...",
  "files": { "hive.py": "...full content..." }, "omitted": [],
  "terminal": "...text sent with this request...", "terminalOffset": 48213,
  "answer": "..." }
```

A failed request is not saved. A turn that cannot be saved is kept for the current session.

### Messages sent to `ask`

On every request the messages are rebuilt from the last 20 turns, in the format the
system prompt describes: user and assistant messages alternate, and each user message is

```
<request>
...the student's question...
</request>

<student_file path="hive.py" format="full|diff|unchanged|omitted">
...
</student_file>

<terminal>
...terminal input/output since the previous message (at most 8 KB)...
</terminal>
```

- The **latest** message has the full content of every open file.
- Each **earlier** message has, per file, the unified diff that turns the version in the
  *next* message back into its own version (`--- hive.py (version in the next message)`,
  `+++ hive.py (version in this message)`). A file missing from the next message, or whose
  diff would be longer than the file itself, is sent in full instead.
- Open files under `.guides/` are never sent; files over 100 KB or binary files are listed as `omitted`.

Limits are constants at the top of `index.js` (`MAX_TURNS`, `MAX_TERMINAL_CHARS`, `MAX_FILE_CHARS`).

## Tests

```
node --test
```

Needs Node 18+ and GNU `patch`. `test/core.test.js` checks the diff and message building
(every diff is applied with `patch`); `test/extension.test.js` loads `index.js` as a browser
script with a mock `codioIDE` that runs the real scripts from `../POP-project-bbk/.guides/coach`
(or `COACH_SCRIPTS_DIR`); it is skipped if they are not found.

## Checks to do on Codio after deploying

1. In a fresh student project: type a command in the terminal opened by the guide page, ask
   a question, and confirm the command appears in `.guides/coach/terminal.log`. That terminal
   may start before the hook is installed on the very first load; any terminal opened later is recorded.
2. Restart the box and check `grep coach ~/.bashrc` still shows the hook (it is re-added at
   every IDE load anyway).
3. Run a program with the **Run** button and check whether its output reaches the log.
4. Republish the assignment and check that an existing student's `.guides/coach/turns/` survives.
