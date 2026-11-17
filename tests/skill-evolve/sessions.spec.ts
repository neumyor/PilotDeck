import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const SCRIPT = join(process.cwd(), "skills", "skill-evolve", "scripts", "sessions.mjs");

type Fixture = { home: string; paperProject: string; otherProject: string; cleanup: () => void };

function entry(type: string, turnId: string, sequence: number, fields: Record<string, unknown>) {
  return JSON.stringify({
    type,
    sessionId: "web:s_paper",
    turnId,
    sequence,
    createdAt: `2026-11-02T10:0${sequence % 10}:00.000Z`,
    ...fields,
  });
}

function writeSession(chatDir: string, fileName: string, lines: string[], mtime: Date) {
  mkdirSync(chatDir, { recursive: true });
  const path = join(chatDir, fileName);
  writeFileSync(path, `${lines.join("\n")}\n`);
  utimesSync(path, mtime, mtime);
}

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "skill-evolve-sessions-"));
  const home = join(root, "pilot-home");
  const paperProject = join(root, "paper");
  const otherProject = join(root, "other");
  mkdirSync(paperProject);
  mkdirSync(otherProject);

  const paperDir = join(home, "projects", "paper-id");
  mkdirSync(paperDir, { recursive: true });
  writeFileSync(join(paperDir, ".cwd"), paperProject);
  const otherDir = join(home, "projects", "other-id");
  mkdirSync(otherDir, { recursive: true });
  writeFileSync(join(otherDir, ".cwd"), otherProject);

  const longResult = "x".repeat(5000);
  writeSession(join(paperDir, "chats"), "web:s_paper.jsonl", [
    entry("accepted_input", "t1", 1, {
      messages: [{ role: "user", content: [{ type: "text", text: "Revise the introduction of paper.tex" }] }],
    }),
    entry("assistant_message", "t1", 2, {
      message: {
        role: "assistant",
        content: [
          { type: "thinking", text: "private reasoning" },
          { type: "text", text: "Reading the file first." },
          { type: "tool_call", id: "c1", name: "read_file", input: { file_path: "paper.tex" } },
        ],
      },
    }),
    entry("tool_result_message", "t1", 3, {
      message: { role: "user", content: [{ type: "tool_result", toolCallId: "c1", content: [{ type: "text", text: longResult }] }] },
    }),
    entry("subagent_started", "t1", 4, {
      subagentId: "sub-1", subagentType: "explore", promptPreview: "Find related work",
      promptTruncated: false, transcriptRelativePath: "subagents/sub-1.jsonl",
    }),
    entry("subagent_completed", "t1", 5, {
      subagentId: "sub-1", subagentType: "explore", summaryPreview: "Found three papers",
      summaryTruncated: false, turns: 2, durationMs: 1000,
    }),
    entry("turn_result", "t1", 6, { result: { type: "success" } }),
    entry("control_boundary", "t2", 7, {
      boundary: { kind: "compact", subtype: "compact_boundary", compactMetadata: { trigger: "auto", preTokens: 1 } },
    }),
    entry("durable_message", "t2", 8, {
      message: { role: "user", content: [{ type: "text", text: "COMPACT SUMMARY" }], metadata: { compactReplacement: true } },
    }),
    entry("accepted_input", "t2", 9, {
      messages: [
        { role: "user", content: [{ type: "text", text: "SYNTHETIC REMINDER" }], metadata: { synthetic: true } },
        { role: "user", content: [{ type: "text", text: "Do not open paragraphs with 'In recent years'." }] },
      ],
    }),
    entry("session_metadata", "t2", 10, { metadata: { title: "Paper intro revision" } }),
  ], new Date("2026-11-02T12:00:00Z"));

  writeSession(join(paperDir, "chats"), "web:s_older.jsonl", [
    entry("accepted_input", "t1", 1, {
      messages: [{ role: "user", content: [{ type: "text", text: "Format the bibliography" }] }],
    }),
  ], new Date("2026-11-01T12:00:00Z"));

  writeSession(join(paperDir, "chats"), "always-on-discovery-1.jsonl", [
    entry("accepted_input", "t1", 1, {
      messages: [{ role: "user", content: [{ type: "text", text: "internal discovery" }] }],
    }),
  ], new Date("2026-11-03T12:00:00Z"));

  writeSession(join(otherDir, "chats"), "web:s_other.jsonl", [
    entry("accepted_input", "t1", 1, {
      messages: [{ role: "user", content: [{ type: "text", text: "Plan the weekly report" }] }],
    }),
  ], new Date("2026-11-02T08:00:00Z"));

  return { home, paperProject, otherProject, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function run(fixture: Fixture, cwd: string, args: string[]) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    env: { ...process.env, PILOT_HOME: fixture.home },
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("list shows the current project's sessions, newest first, without internal sessions", () => {
  const fixture = createFixture();
  try {
    const { status, stdout } = run(fixture, fixture.paperProject, ["list"]);
    assert.equal(status, 0);
    const lines = stdout.trim().split("\n");
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^1\. web:s_paper \| Paper intro revision \|/);
    assert.match(lines[0], /Revise the introduction of paper\.tex$/);
    assert.match(lines[1], /^2\. web:s_older \| Format the bibliography \|/);
    assert.doesNotMatch(stdout, /always-on|web:s_other/);
  } finally {
    fixture.cleanup();
  }
});

test("list --all spans projects and --query filters by message text", () => {
  const fixture = createFixture();
  try {
    const all = run(fixture, fixture.paperProject, ["list", "--all"]);
    assert.equal(all.stdout.trim().split("\n").length, 3);
    assert.match(all.stdout, new RegExp(`web:s_other \\| .* \\| ${fixture.otherProject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\|`));

    const queried = run(fixture, fixture.paperProject, ["list", "--all", "--query", "in recent years"]);
    assert.equal(queried.stdout.trim().split("\n").length, 1);
    assert.match(queried.stdout, /web:s_paper/);

    const none = run(fixture, fixture.paperProject, ["list", "--query", "nothing matches"]);
    assert.equal(none.status, 0);
    assert.match(none.stdout, /No sessions contain "nothing matches"/);
  } finally {
    fixture.cleanup();
  }
});

test("list explains when the current directory has no sessions or PilotDeck has no data", () => {
  const fixture = createFixture();
  try {
    const unknown = run(fixture, tmpdir(), ["list"]);
    assert.equal(unknown.status, 0);
    assert.match(unknown.stdout, /Use --all/);

    const emptyHome = mkdtempSync(join(tmpdir(), "skill-evolve-empty-"));
    try {
      const result = spawnSync(process.execPath, [SCRIPT, "list"], {
        cwd: fixture.paperProject,
        env: { ...process.env, PILOT_HOME: emptyHome },
        encoding: "utf8",
      });
      assert.match(result.stdout, /No PilotDeck sessions found/);
    } finally {
      rmSync(emptyHome, { recursive: true, force: true });
    }
  } finally {
    fixture.cleanup();
  }
});

test("read renders every turn, including content before compaction", () => {
  const fixture = createFixture();
  try {
    const { status, stdout } = run(fixture, fixture.otherProject, ["read", "web:s_paper", "--tool-chars", "100"]);
    assert.equal(status, 0);
    assert.match(stdout, /^# Paper intro revision\nsession: web:s_paper\nproject: .*paper\ncreated: .*turns: 2/);
    assert.match(stdout, /## Turn 1 · .*\n\[user\] Revise the introduction of paper\.tex\n\[assistant\] Reading the file first\.\n\[tool_call\] read_file \{"file_path":"paper\.tex"\}/);
    assert.match(stdout, /\[tool_result\] x{100}\n… \[truncated, 5000 chars total\]/);
    assert.match(stdout, /\[subagent explore\] Find related work\n→ Found three papers/);
    assert.match(stdout, /## Turn 2 · .*\n\[user\] Do not open paragraphs with 'In recent years'\./);
    assert.doesNotMatch(stdout, /private reasoning|COMPACT SUMMARY|SYNTHETIC REMINDER/);
  } finally {
    fixture.cleanup();
  }
});

test("read reports unknown sessions and invalid options", () => {
  const fixture = createFixture();
  try {
    const missing = run(fixture, fixture.paperProject, ["read", "web:s_missing"]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Session "web:s_missing" not found/);

    const badOption = run(fixture, fixture.paperProject, ["read", "web:s_paper", "--tool-chars", "-1"]);
    assert.equal(badOption.status, 1);
    assert.match(badOption.stderr, /--tool-chars must be a non-negative integer/);

    const noCommand = run(fixture, fixture.paperProject, []);
    assert.equal(noCommand.status, 1);
    assert.match(noCommand.stderr, /Usage:/);
  } finally {
    fixture.cleanup();
  }
});
