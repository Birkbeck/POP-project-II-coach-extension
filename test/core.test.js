// Unit tests for the pure helpers in index.js.
// Run from the repository root with:  node --test
// Needs GNU `patch` on the PATH: every diff is checked by applying it with `patch`.
"use strict"

const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { execFileSync } = require("node:child_process")
const core = require("../index.js")

const ROLES = { USER: "user", ASSISTANT: "assistant" }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coach-test-"))
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }))

function applyPatch(original, diff) {
  const src = path.join(tmp, "src.txt")
  const patchFile = path.join(tmp, "change.diff")
  const out = path.join(tmp, "out.txt")
  fs.writeFileSync(src, original)
  fs.writeFileSync(patchFile, diff + "\n")
  fs.rmSync(out, { force: true })
  execFileSync("patch", ["--quiet", "--force", "--fuzz=0", "--no-backup-if-mismatch", "-o", out, src, patchFile])
  return fs.readFileSync(out, "utf8")
}

// Small deterministic PRNG so failures are reproducible.
function rng(seed) {
  let s = seed >>> 0
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 }
}
const WORDS = ["def", "return", "x", "y", "pass", "", "    if B:", "print(x)", "for p in B:", "# comment"]
const pick = (rand, arr) => arr[Math.floor(rand() * arr.length)]

function randomText(rand, nLines) {
  const lines = []
  for (let i = 0; i < nLines; i++) lines.push(pick(rand, WORDS) + (rand() < 0.5 ? "" : " " + pick(rand, WORDS)))
  return lines.join("\n") + (rand() < 0.8 ? "\n" : "")
}

function mutate(rand, text) {
  const { lines, noEol } = core.splitLines(text)
  const edits = 1 + Math.floor(rand() * 6)
  for (let e = 0; e < edits; e++) {
    const r = rand()
    const at = Math.floor(rand() * (lines.length + 1))
    if (r < 0.35) lines.splice(at, 0, pick(rand, WORDS) + " new")
    else if (r < 0.65 && lines.length) lines.splice(Math.min(at, lines.length - 1), 1)
    else if (lines.length) lines[Math.min(at, lines.length - 1)] = pick(rand, WORDS) + " changed"
  }
  const eol = rand() < 0.1 ? !noEol : noEol
  if (lines.length === 0) return ""
  return lines.join("\n") + (eol ? "" : "\n")
}

test("identical texts give an empty diff", () => {
  assert.equal(core.unifiedDiff("a\nb\n", "a\nb\n", "old", "new"), "")
})

test("format matches diff -u for a simple change", () => {
  assert.equal(
    core.unifiedDiff("a\nb\nc\n", "a\nB\nc\n", "old", "new"),
    "--- old\n+++ new\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c"
  )
})

test("insertion into and deletion of a whole file", () => {
  assert.equal(core.unifiedDiff("", "x\n", "old", "new"), "--- old\n+++ new\n@@ -0,0 +1 @@\n+x")
  assert.equal(core.unifiedDiff("x\ny\n", "", "old", "new"), "--- old\n+++ new\n@@ -1,2 +0,0 @@\n-x\n-y")
})

test("missing newline at end of file is reported and round-trips", () => {
  const d = core.unifiedDiff("a\nb", "a\nb\n", "old", "new")
  assert.match(d, /\\ No newline at end of file/)
  assert.equal(applyPatch("a\nb", d), "a\nb\n")
  assert.equal(applyPatch("a\nb\n", core.unifiedDiff("a\nb\n", "a\nb", "old", "new")), "a\nb")
})

test("distant changes give separate hunks, close ones are merged", () => {
  const base = Array.from({ length: 30 }, (_, i) => `line ${i}`)
  const far = [...base]; far[2] = "X"; far[25] = "Y"
  const near = [...base]; near[2] = "X"; near[8] = "Y"
  const count = (d) => (d.match(/^@@ /gm) || []).length
  assert.equal(count(core.unifiedDiff(base.join("\n") + "\n", far.join("\n") + "\n", "o", "n")), 2)
  assert.equal(count(core.unifiedDiff(base.join("\n") + "\n", near.join("\n") + "\n", "o", "n")), 1)
})

test("random edits: every diff applied with patch reproduces the target", () => {
  const rand = rng(12345)
  for (let c = 0; c < 400; c++) {
    const from = randomText(rand, Math.floor(rand() * 40))
    let to = from
    const rounds = 1 + Math.floor(rand() * 3)
    for (let r = 0; r < rounds; r++) to = mutate(rand, to)
    const d = core.unifiedDiff(from, to, "from", "to")
    if (from === to) { assert.equal(d, ""); continue }
    assert.equal(applyPatch(from, d), to, `case ${c}\nFROM:\n${from}\nTO:\n${to}\nDIFF:\n${d}`)
  }
})

test("too many edits returns null and the file is then sent in full", () => {
  const a = Array.from({ length: 50 }, (_, i) => `a${i}`).join("\n") + "\n"
  const b = Array.from({ length: 50 }, (_, i) => `b${i}`).join("\n") + "\n"
  assert.equal(core.unifiedDiff(a, b, "o", "n", 3, 10), null)
  assert.match(core.renderFile("f.py", b, a), /format="full"/)    // diff longer than the file
})

function parseFiles(content) {
  const re = /<student_file path="([^"]*)" format="([^"]*)">\n([\s\S]*?)\n<\/student_file>/g
  const files = {}
  let m
  while ((m = re.exec(content)) !== null) files[m[1]] = { format: m[2], body: m[3] }
  return files
}

test("message chain: roles alternate and every earlier version can be rebuilt", () => {
  const rand = rng(777)
  const v = []
  let hive = randomText(rand, 30)
  let tests = randomText(rand, 10)
  for (let i = 0; i < 6; i++) {
    hive = mutate(rand, hive)
    if (i % 2 === 0) tests = mutate(rand, tests)
    const files = { "hive.py": hive }
    if (i !== 3) files["test_hive.py"] = tests            // closed in turn 3
    v.push({ request: `question ${i}`, files, omitted: [], terminal: i === 0 ? "" : `out ${i}`, terminalOffset: i * 10, answer: `answer ${i}` })
  }
  const messages = core.buildMessages(v, ROLES)
  assert.equal(messages.length, 2 * v.length - 1)
  messages.forEach((msg, i) => assert.equal(msg.role, i % 2 === 0 ? "user" : "assistant"))
  assert.equal(messages[1].content, "answer 0")

  const user = messages.filter((msg) => msg.role === "user").map((msg) => parseFiles(msg.content))
  const last = user[user.length - 1]
  for (const [p, f] of Object.entries(last)) {
    assert.equal(f.format, "full")
    assert.equal(f.body, v[v.length - 1].files[p])
  }
  // walk backwards: resolve each earlier message against the version in the next one
  let current = { ...v[v.length - 1].files }
  for (let k = v.length - 2; k >= 0; k--) {
    const rebuilt = {}
    for (const [p, f] of Object.entries(user[k])) {
      if (f.format === "full") rebuilt[p] = f.body
      else if (f.format === "unchanged") rebuilt[p] = current[p]
      else if (f.format === "diff") rebuilt[p] = applyPatch(current[p], f.body)
      else assert.fail(`unexpected format ${f.format}`)
    }
    assert.deepEqual(rebuilt, v[k].files, `turn ${k}`)
    current = rebuilt
  }
  // test_hive.py is missing from turn 3, so turn 2 must carry it in full
  assert.equal(user[2]["test_hive.py"].format, "full")
})

test("terminal and request sections", () => {
  const msg = core.renderUserMessage({ request: "Why?", files: {}, omitted: ["big.txt"], terminal: "$ pytest\n1 failed" }, undefined)
  assert.match(msg, /^<request>\nWhy\?\n<\/request>/)
  assert.match(msg, /<student_file path="big.txt" format="omitted">/)
  assert.match(msg, /<terminal>\n\$ pytest\n1 failed\n<\/terminal>$/)
  assert.match(core.renderUserMessage({ request: "q", files: {}, terminal: "" }), /no new terminal input or output/)
  assert.match(core.renderUserMessage({ request: "q", files: {}, terminal: null }), /terminal history unavailable/)
  assert.match(core.renderUserMessage({ request: "q", files: {}, terminal: "" }), /no files open/)
})

test("parseTerminalOutput", () => {
  assert.deepEqual(core.parseTerminalOutput("120\nhello\nworld\n", 5), { text: "hello\nworld", offset: 120 })
  assert.deepEqual(core.parseTerminalOutput("120", 5), { text: "", offset: 120 })
  assert.deepEqual(core.parseTerminalOutput("bash: no such file", 5), { text: null, offset: 5 })
  assert.deepEqual(core.parseTerminalOutput(undefined, 7), { text: null, offset: 7 })
})

test("selectFiles keeps student files only", () => {
  const big = "x".repeat(core.MAX_FILE_CHARS + 1)
  const { files, omitted } = core.selectFiles([
    { path: "hive.py", content: "code" },
    { path: "/home/codio/workspace/test_hive.py", content: "tests" },
    { path: ".guides/secure/hive_solution.py", content: "secret" },
    { path: ".guides/coach/turns/1.json", content: "{}" },
    { path: "hive.py", content: "duplicate tab" },
    { path: "huge.txt", content: big },
    { path: "image.png", content: "\u0000\u0001" }
  ])
  assert.deepEqual(files, { "hive.py": "code", "test_hive.py": "tests" })
  assert.deepEqual(omitted, ["huge.txt", "image.png"])
})

test("isValidTurn", () => {
  const ok = { request: "q", answer: "a", files: {}, terminalOffset: 0 }
  assert.equal(core.isValidTurn(ok), true)
  assert.equal(core.isValidTurn({ ...ok, answer: "  " }), false)
  assert.equal(core.isValidTurn({ ...ok, terminalOffset: "3" }), false)
  assert.equal(core.isValidTurn(null), false)
})
