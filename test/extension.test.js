// Integration test: loads index.js the way Codio does (as a browser script, in a fresh
// global context) with a mock codioIDE. The mock's remoteCommand runs the REAL bash
// scripts from the assessment repo against a temporary workspace, and its files API
// behaves like Codio's (files.add refuses to overwrite).
//
// Run from the repository root with:  node --test
// Expects the assessment repo checked out next to this one (../POP-project-bbk), or
// COACH_SCRIPTS_DIR pointing at its .guides/coach folder; skipped otherwise.
"use strict"

const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const vm = require("node:vm")
const { spawnSync } = require("node:child_process")

const SCRIPTS = process.env.COACH_SCRIPTS_DIR ||
  path.join(__dirname, "..", "..", "POP-project-bbk", ".guides", "coach")
const SOURCE = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8")
const CODIO_WS = "/home/codio/workspace"
const haveScripts = fs.existsSync(path.join(SCRIPTS, "terminal_since.sh"))

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coach-ext-"))
  const ws = path.join(root, "workspace")
  const coach = path.join(ws, ".guides", "coach")
  fs.mkdirSync(coach, { recursive: true })
  fs.mkdirSync(path.join(root, "home"))
  for (const f of ["install_hook.sh", "start_terminal_log.sh", "terminal_since.sh"]) {
    fs.copyFileSync(path.join(SCRIPTS, f), path.join(coach, f))
  }
  return { root, ws, coach, log: path.join(coach, "terminal.log") }
}

// A fresh "IDE load": new global context, new extension state, same files on disk.
function loadExtension(env, script) {
  const calls = { asks: [], writes: [], menus: 0 }
  let callback = null
  const mapPath = (p) => (p.startsWith(CODIO_WS) ? env.ws + p.slice(CODIO_WS.length) : p)
  const codioIDE = {
    coachBot: {
      MESSAGE_ROLES: { USER: "user", ASSISTANT: "assistant" },
      register: (id, name, cb) => { callback = cb },
      write: (text) => calls.writes.push(text),
      showMenu: () => { calls.menus++ },
      getContext: async () => ({ files: Object.entries(script.openFiles()).map(([p, c]) => ({ path: p, content: c })) }),
      input: async () => {
        const next = script.inputs.shift()
        if (next === undefined) throw new Error("Cancelled")
        if (typeof next === "function") return next()
        return next
      },
      ask: async (data, options) => {
        const roles = data.messages.map((m) => m.role)
        assert.equal(roles[0], "user")
        roles.forEach((r, i) => i && assert.notEqual(r, roles[i - 1], "roles must alternate"))
        assert.equal(data.systemPrompt, "{% prompt 'POP_PROJECT_2_SYSTEM' %}")
        assert.equal(options.preventMenu, true)
        calls.asks.push(data.messages)
        if (script.failAsk && script.failAsk()) throw new Error("LLM unavailable")
        return { result: `answer ${calls.asks.length}` }
      }
    },
    remoteCommand: {
      run: async (argv) => {
        assert.ok(Array.isArray(argv), "commands are passed in the array form")
        const r = spawnSync(argv[0], argv.slice(1).map(mapPath), {
          cwd: env.ws, encoding: "utf8",
          env: { ...process.env, HOME: path.join(env.root, "home"), POP_COACH_DIR: env.coach }
        })
        // Codio returns stdout and stderr merged in `stdout`, trailing whitespace trimmed
        return { code: r.status, stdout: (r.stdout + r.stderr).replace(/\s+$/, ""), stderr: r.stderr.replace(/\s+$/, "") }
      }
    },
    files: {
      add: async (p, content) => {
        const full = path.join(env.ws, p)
        if (fs.existsSync(full)) throw new Error("file already exists")
        fs.writeFileSync(full, content)          // no mkdir: the folder must already exist
      },
      getContent: async (p) => fs.readFileSync(path.join(env.ws, p), "utf8")
    }
  }
  vm.runInNewContext(SOURCE, { window: { codioIDE }, console: { log() {}, warn() {}, error() {} } })
  assert.ok(callback, "the extension registered its button")
  return { press: () => callback(), calls }
}

const turnFiles = (env) => fs.readdirSync(path.join(env.coach, "turns")).filter((n) => /^\d+\.json$/.test(n)).sort()
const fileTag = (content, p) => {
  const m = content.match(new RegExp(`<student_file path="${p.replace(/\./g, "\\.")}" format="(\\w+)">\\n([\\s\\S]*?)\\n</student_file>`))
  return m && { format: m[1], body: m[2] }
}
const terminalOf = (content) => content.match(/<terminal>\n([\s\S]*?)\n<\/terminal>/)[1]

test("conversation is stored, resumed after a reload, and messages follow the chain format", { skip: !haveScripts && `scripts not found in ${SCRIPTS}` }, async () => {
  const env = makeWorkspace()
  try {
    // long enough that a diff is shorter than the file (otherwise a full copy is sent)
    const rest = Array.from({ length: 40 }, (_, i) => `def f${i}(B):\n    '''implement according to specification'''\n`).join("\n")
    let hive = "def piece_at(x, y, B):\n    pass\n\n" + rest
    fs.writeFileSync(env.log, "Script started on 2027-01-10 [TERM=xterm]\n$ python hive.py\r\nTraceback: \u001b[31mNameError\u001b[0m\r\n")

    // --- first IDE session: two questions, then Back
    const s1 = loadExtension(env, {
      openFiles: () => ({ "hive.py": hive, ".guides/secure/hive_solution.py": "SECRET" }),
      inputs: [
        "Why do I get a NameError?",
        () => {
          hive = "def piece_at(x, y, B):\n    for p in B:\n        pass\n\n" + rest
          fs.appendFileSync(env.log, "$ pytest\r\n1 failed\r\n")
          return "And now?"
        }
      ]
    })
    await s1.press()
    assert.equal(s1.calls.asks.length, 2)
    assert.equal(s1.calls.menus, 0, "Back at the input prompt needs no showMenu")
    assert.ok(fs.readFileSync(path.join(env.root, "home", ".bashrc"), "utf8").includes("start_terminal_log.sh"))
    assert.equal(turnFiles(env).length, 2)

    const first = s1.calls.asks[0]
    assert.equal(first.length, 1)
    assert.match(first[0].content, /^<request>\nWhy do I get a NameError\?\n<\/request>/)
    assert.equal(fileTag(first[0].content, "hive.py").format, "full")
    assert.ok(!first[0].content.includes("SECRET"), ".guides files are never sent")
    assert.equal(terminalOf(first[0].content), "$ python hive.py\nTraceback: NameError")

    const second = s1.calls.asks[1]
    assert.equal(second.length, 3)
    assert.equal(second[1].content, "answer 1")
    assert.equal(fileTag(second[0].content, "hive.py").format, "diff")
    assert.match(fileTag(second[0].content, "hive.py").body, /^--- hive\.py\t\(version in the next message\)\n\+\+\+ hive\.py\t\(version in this message\)\n@@ /)
    assert.equal(fileTag(second[2].content, "hive.py").body, hive)
    assert.equal(terminalOf(second[2].content), "$ pytest\n1 failed", "only the terminal text since the previous message")

    // --- days later: a new IDE load reads the stored turns
    fs.appendFileSync(env.log, "$ python hive.py\r\nok\r\n")
    const s2 = loadExtension(env, { openFiles: () => ({ "hive.py": hive }), inputs: ["Third question"] })
    await s2.press()
    const third = s2.calls.asks[0]
    assert.equal(third.length, 5)
    assert.match(third[0].content, /Why do I get a NameError/)
    assert.equal(third[3].content, "answer 2")
    assert.equal(fileTag(third[2].content, "hive.py").format, "unchanged")
    assert.equal(terminalOf(third[4].content), "$ python hive.py\nok")
    assert.equal(turnFiles(env).length, 3)

    // --- a failed request is reported, not saved, and the student can ask again
    let fail = true
    const s3 = loadExtension(env, {
      openFiles: () => ({ "hive.py": hive }),
      inputs: ["This one fails", "Retry"],
      failAsk: () => { const f = fail; fail = false; return f }
    })
    await s3.press()
    assert.ok(s3.calls.writes.some((w) => /could not get an answer/.test(w)))
    assert.equal(s3.calls.asks.length, 2)
    assert.equal(s3.calls.asks[1].length, 7, "the failed request is not part of the history")
    assert.equal(turnFiles(env).length, 4)
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true })
  }
})

test("works without terminal scripts (e.g. a project created before they were published)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coach-ext-"))
  const env = { root, ws: path.join(root, "workspace"), coach: path.join(root, "workspace", ".guides", "coach") }
  fs.mkdirSync(env.coach, { recursive: true })
  fs.mkdirSync(path.join(root, "home"))
  try {
    const s = loadExtension(env, { openFiles: () => ({ "hive.py": "x = 1\n" }), inputs: ["Hello?"] })
    await s.press()
    assert.equal(s.calls.asks.length, 1)
    assert.equal(terminalOf(s.calls.asks[0][0].content), "(terminal history unavailable)")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
