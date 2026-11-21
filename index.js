// POP Project II Coach extension: a multi-turn chat in which the student discusses
// the assessment with an AI assistant.
//
// Every exchange is stored as one write-once file in the student's project,
// .guides/coach/turns/<timestamp>.json, so the conversation survives days of inactivity.
// Each file holds the request, the open files at that moment, the terminal text sent
// with it, and the answer. The messages for `ask` are rebuilt from these files on every
// request, in the format described in the stored system prompt POP_PROJECT_2_SYSTEM:
//   - the latest user message contains the full content of the open files;
//   - every earlier user message contains, per file, the unified diff that turns the
//     version in the NEXT message back into its own version (a backwards chain).
//
// Terminal history is recorded by the bash scripts in .guides/coach/ of the assessment
// repo (POP-project-bbk): install_hook.sh, start_terminal_log.sh, terminal_since.sh.
//
// The pure helpers are exported for the unit tests when this file is loaded by Node
// (see test/core.test.js); in the browser everything stays inside this function.

(function (codioIDE, window, nodeModule) {
  "use strict"

  // ---------------------------------------------------------------- configuration

  const WORKSPACE = "/home/codio/workspace"
  const COACH_DIR = ".guides/coach"                    // relative path, for codioIDE.files
  const COACH_DIR_ABS = `${WORKSPACE}/${COACH_DIR}`    // absolute path, for remoteCommand
  const TURNS_DIR = `${COACH_DIR}/turns`
  const TURN_FILE_RE = /^\d+\.json$/

  const MAX_TURNS = 20                 // exchanges sent to the assistant, including the new one
  const MAX_TERMINAL_CHARS = 8192      // terminal text attached to one message
  const MAX_FILE_CHARS = 100 * 1024    // larger open files are not attached
  const MAX_DIFF_EDITS = 1000          // beyond this a full copy is sent instead of a diff
  const EXCLUDED_PREFIXES = [".guides/"]
  const TURN_FORMAT = 1

  // ---------------------------------------------------------------- pure helpers

  // Splits text into lines; `noEol` is true when the last line has no trailing newline.
  function splitLines(text) {
    if (text === "") return { lines: [], noEol: false }
    const lines = text.split("\n")
    const noEol = lines[lines.length - 1] !== ""
    if (!noEol) lines.pop()
    return { lines, noEol }
  }

  // Myers' O(ND) shortest edit script between arrays a and b (compared with ===).
  // Returns ops [{t: " ", i, j} | {t: "-", i} | {t: "+", j}], or null when more than
  // maxEdits insertions + deletions are needed. Points never leave the edit grid.
  function myersOps(a, b, maxEdits) {
    const n = a.length
    const m = b.length
    const limit = Math.min(n + m, maxEdits)
    const off = m + 1                                  // v[off + k] is diagonal k, k in [-m-1, n+1]
    const v = new Int32Array(n + m + 3).fill(-1)       // furthest x on each diagonal, -1 = none
    const trace = []                                   // trace[d]: v before step d (k in [lo, hi])

    // The predecessor of diagonal k at step d, from the furthest points of step d-1:
    // down from k+1 (insert b[y-1]) or right from k-1 (delete a[x-1]). Returns [prevK, x].
    function choose(get, k) {
      let best = null
      const xd = get(k + 1)
      if (xd >= 0 && xd - k <= m) best = [k + 1, xd]
      const xr = get(k - 1)
      if (xr >= 0 && xr + 1 <= n && (best === null || xr + 1 > best[1])) best = [k - 1, xr + 1]
      return best
    }

    function snapshot(d) {
      const lo = Math.max(-d, -m) - 1
      const hi = Math.min(d, n) + 1
      const data = v.slice(off + lo, off + hi + 1)
      return (k) => (k < lo || k > hi ? -1 : data[k - lo])
    }

    function backtrack(dEnd) {
      const ops = []
      let x = n
      let y = m
      for (let d = dEnd; d > 0; d--) {
        const k = x - y
        const [prevK, xStart] = choose(trace[d], k)
        const yStart = xStart - k
        while (x > xStart) { ops.push({ t: " ", i: x - 1, j: y - 1 }); x--; y-- }
        if (prevK === k + 1) { ops.push({ t: "+", j: yStart - 1 }); y = yStart - 1 }
        else { ops.push({ t: "-", i: xStart - 1 }); x = xStart - 1 }
      }
      while (x > 0 && y > 0) { ops.push({ t: " ", i: x - 1, j: y - 1 }); x--; y-- }
      if (x !== 0 || y !== 0) return null              // cannot happen; refuse rather than mislead
      return ops.reverse()
    }

    for (let d = 0; d <= limit; d++) {
      if (d === 0) {
        trace.push(null)
        let x = 0
        while (x < n && x < m && a[x] === b[x]) x++
        v[off] = x
        if (x >= n && x >= m) return backtrack(0)
        continue
      }
      trace.push(snapshot(d))
      const get = (k) => v[off + k]
      for (let k = Math.max(-d, -m); k <= Math.min(d, n); k++) {
        if (((k - d) & 1) !== 0) continue
        const c = choose(get, k)
        if (c === null) { v[off + k] = -1; continue }
        let x = c[1]
        let y = x - k
        while (x < n && y < m && a[x] === b[y]) { x++; y++ }
        v[off + k] = x
        if (x >= n && y >= m) return backtrack(d)
      }
    }
    return null
  }

  // Edit script with the common prefix and suffix handled outside Myers (fast for small edits).
  function diffOps(a, b, maxEdits) {
    const n = a.length
    const m = b.length
    let pre = 0
    while (pre < n && pre < m && a[pre] === b[pre]) pre++
    let suf = 0
    while (suf < n - pre && suf < m - pre && a[n - 1 - suf] === b[m - 1 - suf]) suf++
    const core = myersOps(a.slice(pre, n - suf), b.slice(pre, m - suf), maxEdits)
    if (core === null) return null
    const ops = []
    for (let p = 0; p < pre; p++) ops.push({ t: " ", i: p, j: p })
    for (const op of core) {
      ops.push({ t: op.t, i: op.i === undefined ? undefined : op.i + pre, j: op.j === undefined ? undefined : op.j + pre })
    }
    for (let s = suf; s > 0; s--) ops.push({ t: " ", i: n - s, j: m - s })
    return ops
  }

  // Unified diff (as `diff -u`, `patch`-compatible) turning oldText into newText.
  // Returns "" when the texts are identical and null when they are too different.
  function unifiedDiff(oldText, newText, oldLabel, newLabel, context = 3, maxEdits = MAX_DIFF_EDITS) {
    if (oldText === newText) return ""
    const A = splitLines(oldText)
    const B = splitLines(newText)
    const ids = new Map()
    const id = (line, last) => {
      const s = last ? line + "\u0000" : line            // a last line without newline differs
      let v = ids.get(s)
      if (v === undefined) { v = ids.size; ids.set(s, v) }
      return v
    }
    const a = A.lines.map((l, i) => id(l, A.noEol && i === A.lines.length - 1))
    const b = B.lines.map((l, j) => id(l, B.noEol && j === B.lines.length - 1))
    const ops = diffOps(a, b, maxEdits)
    if (ops === null) return null

    const changes = []
    ops.forEach((op, p) => { if (op.t !== " ") changes.push(p) })
    if (changes.length === 0) return ""

    const aBefore = []
    const bBefore = []
    let ca = 0
    let cb = 0
    for (const op of ops) {
      aBefore.push(ca); bBefore.push(cb)
      if (op.t !== "+") ca++
      if (op.t !== "-") cb++
    }
    const range = (before, len) => (len === 0 ? `${before},0` : len === 1 ? `${before + 1}` : `${before + 1},${len}`)

    const out = [`--- ${oldLabel}`, `+++ ${newLabel}`]
    let g = 0
    while (g < changes.length) {
      let last = changes[g]
      let h = g + 1
      while (h < changes.length && changes[h] - last - 1 <= 2 * context) { last = changes[h]; h++ }
      const start = Math.max(0, changes[g] - context)
      const end = Math.min(ops.length - 1, last + context)
      let aLen = 0
      let bLen = 0
      for (let p = start; p <= end; p++) {
        if (ops[p].t !== "+") aLen++
        if (ops[p].t !== "-") bLen++
      }
      out.push(`@@ -${range(aBefore[start], aLen)} +${range(bBefore[start], bLen)} @@`)
      for (let p = start; p <= end; p++) {
        const op = ops[p]
        if (op.t === "+") {
          out.push("+" + B.lines[op.j])
          if (B.noEol && op.j === B.lines.length - 1) out.push("\\ No newline at end of file")
        } else {
          out.push(op.t + A.lines[op.i])
          if (A.noEol && op.i === A.lines.length - 1) out.push("\\ No newline at end of file")
        }
      }
      g = h
    }
    return out.join("\n")
  }

  const escapeAttr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")
  const fileTag = (path, format, body) =>
    `<student_file path="${escapeAttr(path)}" format="${format}">\n${body}\n</student_file>`

  // One file of a user message. nextContent is the file in the next message (undefined for
  // the latest message, or when the next message does not have this file).
  function renderFile(path, content, nextContent) {
    if (typeof nextContent === "string") {
      if (nextContent === content) return fileTag(path, "unchanged", "(identical to the version in the next message)")
      const diff = unifiedDiff(nextContent, content, `${path}\t(version in the next message)`, `${path}\t(version in this message)`)
      if (diff && diff.length < content.length) return fileTag(path, "diff", diff)
    }
    return fileTag(path, "full", content)
  }

  function renderUserMessage(turn, next) {
    const parts = [`<request>\n${turn.request}\n</request>`]
    const files = turn.files || {}
    const omitted = turn.omitted || []
    const nextFiles = next ? next.files || {} : {}
    for (const path of Object.keys(files)) {
      const nextContent = Object.prototype.hasOwnProperty.call(nextFiles, path) ? nextFiles[path] : undefined
      parts.push(renderFile(path, files[path], nextContent))
    }
    for (const path of omitted) {
      parts.push(fileTag(path, "omitted", `(not attached: larger than ${Math.round(MAX_FILE_CHARS / 1024)} KB or not a text file)`))
    }
    if (Object.keys(files).length === 0 && omitted.length === 0) {
      parts.push("(The student had no files open in tabs.)")
    }
    let terminal
    if (typeof turn.terminal !== "string") terminal = "(terminal history unavailable)"
    else if (turn.terminal.trim() === "") terminal = "(no new terminal input or output)"
    else terminal = turn.terminal
    parts.push(`<terminal>\n${terminal}\n</terminal>`)
    return parts.join("\n\n")
  }

  // turnList: oldest first; the last turn is the new request (its answer is not used).
  function buildMessages(turnList, roles) {
    const messages = []
    turnList.forEach((turn, i) => {
      messages.push({ role: roles.USER, content: renderUserMessage(turn, turnList[i + 1]) })
      if (i < turnList.length - 1) messages.push({ role: roles.ASSISTANT, content: turn.answer })
    })
    return messages
  }

  function normalizePath(p) {
    let s = String(p || "").replace(/\\/g, "/")
    if (s.startsWith(WORKSPACE + "/")) s = s.slice(WORKSPACE.length + 1)
    return s.replace(/^(\.\/)+/, "").replace(/^\/+/, "")
  }

  // The open tabs from getContext().files that are attached to a message.
  function selectFiles(contextFiles) {
    const files = {}
    const omitted = []
    for (const f of contextFiles || []) {
      const path = normalizePath(f && f.path)
      if (!path || EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix))) continue
      if (Object.prototype.hasOwnProperty.call(files, path) || omitted.includes(path)) continue
      const content = typeof f.content === "string" ? f.content : ""
      if (content.length > MAX_FILE_CHARS || content.includes("\u0000")) { omitted.push(path); continue }
      files[path] = content
    }
    return { files, omitted }
  }

  // stdout of terminal_since.sh: the new log size on the first line, then the text.
  // text is null when the output cannot be understood (the offset is then kept).
  function parseTerminalOutput(stdout, fallbackOffset) {
    const out = String(stdout === undefined || stdout === null ? "" : stdout)
    const nl = out.indexOf("\n")
    const head = (nl < 0 ? out : out.slice(0, nl)).trim()
    if (!/^\d+$/.test(head)) return { text: null, offset: fallbackOffset }
    return { text: nl < 0 ? "" : out.slice(nl + 1).replace(/\s+$/, ""), offset: Number(head) }
  }

  function isValidTurn(t) {
    return !!t && typeof t === "object" &&
      typeof t.request === "string" &&
      typeof t.answer === "string" && t.answer.trim() !== "" &&
      !!t.files && typeof t.files === "object" &&
      Number.isFinite(t.terminalOffset)
  }

  if (nodeModule) {
    nodeModule.exports = {
      splitLines, diffOps, unifiedDiff, renderFile, renderUserMessage, buildMessages,
      normalizePath, selectFiles, parseTerminalOutput, isValidTurn,
      MAX_TURNS, MAX_FILE_CHARS
    }
    return
  }
  if (!codioIDE) return

  // ---------------------------------------------------------------- Codio side

  const bot = codioIDE.coachBot
  const ROLES = Object.assign({ USER: "user", ASSISTANT: "assistant" }, bot.MESSAGE_ROLES)

  // Resolved by Codio on its server; in the browser this stays a literal tag.
  const systemPrompt = "{% prompt 'POP_PROJECT_2_SYSTEM' %}"

  let turns = null        // the last MAX_TURNS completed exchanges, oldest first
  let session = 0         // incremented on every button press; older loops stop
  let setupPromise = null

  const log = (...args) => console.log("[coach]", ...args)
  const runScript = (name, ...args) =>
    codioIDE.remoteCommand.run(["bash", `${COACH_DIR_ABS}/${name}`, ...args.map(String)])

  // Terminal recording hook + turns folder; repeated until it succeeds once per IDE load.
  function ensureSetup() {
    if (!setupPromise) {
      setupPromise = runScript("install_hook.sh").then((r) => {
        if (!r || r.code !== 0) throw new Error(`install_hook.sh failed: ${JSON.stringify(r)}`)
      })
      setupPromise.catch(() => { setupPromise = null })
    }
    return setupPromise
  }

  async function loadTurns() {
    const r = await codioIDE.remoteCommand.run(["ls", "-1", `${COACH_DIR_ABS}/turns`])
    const names = String((r && r.stdout) || "")
      .split("\n").map((s) => s.trim()).filter((s) => TURN_FILE_RE.test(s))
      .sort((x, y) => parseInt(x, 10) - parseInt(y, 10))
      .slice(-MAX_TURNS)
    const contents = await Promise.all(names.map((name) =>
      Promise.resolve().then(() => codioIDE.files.getContent(`${TURNS_DIR}/${name}`))
        .catch((e) => { log("could not read", name, e); return null })))
    const loaded = []
    contents.forEach((c, i) => {
      if (c === null) return
      try {
        const t = JSON.parse(c)
        if (isValidTurn(t)) loaded.push(t)
        else log("ignoring malformed turn", names[i])
      } catch (e) {
        log("ignoring unreadable turn", names[i], e)
      }
    })
    return loaded
  }

  // files.add never overwrites, so each exchange gets a new file name.
  async function saveTurn(turn) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await codioIDE.files.add(`${TURNS_DIR}/${turn.id + attempt}.json`, JSON.stringify(turn))
        return
      } catch (e) {
        if (!/exist/i.test(String(e && e.message))) throw e
      }
    }
    throw new Error("could not find a free file name for the turn")
  }

  async function readTerminal(offset) {
    try {
      const r = await runScript("terminal_since.sh", offset, MAX_TERMINAL_CHARS)
      const parsed = parseTerminalOutput(r && r.stdout, offset)
      if (parsed.text === null) log("unexpected terminal_since.sh output", r)
      return parsed
    } catch (e) {
      log("could not read the terminal history", e)
      return { text: null, offset }
    }
  }

  async function askAndSave(request) {
    const context = await bot.getContext()
    const { files, omitted } = selectFiles(context && context.files)
    const previous = turns[turns.length - 1]
    const terminal = await readTerminal(previous ? previous.terminalOffset : 0)

    const turn = {
      format: TURN_FORMAT,
      id: Date.now(),
      time: new Date().toISOString(),
      request,
      files,
      omitted,
      terminal: terminal.text,
      terminalOffset: terminal.offset,
      answer: null
    }
    const messages = buildMessages([...turns.slice(-(MAX_TURNS - 1)), turn], ROLES)

    const result = await bot.ask({ systemPrompt, messages }, { preventMenu: true })
    const answer = result && result.result
    if (typeof answer !== "string" || answer.trim() === "") {
      throw new Error(`no answer in the result of ask: ${JSON.stringify(result)}`)
    }

    turn.answer = answer
    turns.push(turn)
    if (turns.length > MAX_TURNS) turns.splice(0, turns.length - MAX_TURNS)
    try {
      await saveTurn(turn)
    } catch (e) {
      log("could not save this exchange; it is kept for this session only", e)
    }
  }

  async function onButtonPress() {
    const mySession = ++session
    const stale = () => mySession !== session

    bot.write("Please type or paste your question about this assessment. " +
      "I can see the files you have open in tabs and what you have typed and printed in the terminal.")

    try { await ensureSetup() } catch (e) { log("setup failed", e) }
    if (turns === null) {
      try {
        turns = await loadTurns()
      } catch (e) {
        log("could not load the earlier conversation", e)
        turns = []
      }
    }
    if (stale()) return

    while (true) {
      let input
      try {
        input = await bot.input()
      } catch (e) {
        if (!stale() && !(e && e.message === "Cancelled")) {
          log("input failed", e)
          bot.showMenu()
        }
        return
      }
      if (stale()) return

      const request = String(input === undefined || input === null ? "" : input).trim()
      if (request === "") continue

      try {
        await askAndSave(request)
      } catch (e) {
        log("request failed", e)
        if (stale()) return
        bot.write("Sorry, I could not get an answer just now. Please try asking again.")
      }
      if (stale()) return
    }
  }

  ensureSetup().catch((e) => log("setup at load failed; will retry when Coach is used", e))

  // register(id, name, callback): id must be unique among the organization's assistants.
  bot.register("popProject2CoachChat", "I have a question", onButtonPress)
})(
  typeof window !== "undefined" ? window.codioIDE : undefined,
  typeof window !== "undefined" ? window : undefined,
  typeof module !== "undefined" && typeof process !== "undefined" && process.versions && process.versions.node ? module : undefined
)
