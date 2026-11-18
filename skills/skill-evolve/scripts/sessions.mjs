#!/usr/bin/env node
// List PilotDeck chat sessions and render a session transcript as readable text.
//
//   node sessions.mjs list [--all] [--query <text>] [--limit <n>]
//   node sessions.mjs read <sessionId> [--tool-chars <n>]

import { createReadStream, existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";

const DEFAULT_LIST_LIMIT = 20;
const DEFAULT_TOOL_CHARS = 2000;
const TOOL_ARGS_CHARS = 300;
const FIRST_PROMPT_CHARS = 80;
const INTERNAL_SESSION_PATTERN = /^always-on-/;

function pilotHome() {
  const raw = process.env.PILOT_HOME || "~/.pilotdeck";
  if (raw === "~") return homedir();
  if (raw.startsWith("~/")) return resolve(homedir(), raw.slice(2));
  return resolve(raw);
}

function legacyProjectId(projectRoot) {
  const normalized = projectRoot.replace(/\\/g, "/").replace(/^[A-Za-z]:/, "");
  return normalized.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

// Symlinked paths (for example /var and /private/var on macOS) count as the same project.
function canonicalPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function samePath(a, b) {
  const left = canonicalPath(a);
  const right = canonicalPath(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function sanitizeSessionId(sessionId) {
  const illegal = process.platform === "win32" ? /[\\/:<>"|?*]+/g : /[\\/]+/g;
  return sessionId.replace(illegal, "-").replace(/^-+|-+$/g, "") || "session";
}

// Every project directory under <pilotHome>/projects, with the workspace path
// recorded in its `.cwd` marker when one exists.
function listProjects(home) {
  const projectsDir = join(home, "projects");
  if (!existsSync(projectsDir)) return [];
  const projects = [];
  for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let cwd;
    try {
      cwd = readFileSync(join(projectsDir, entry.name, ".cwd"), "utf8").trim() || undefined;
    } catch {
      cwd = undefined;
    }
    projects.push({ id: entry.name, cwd, chatDir: join(projectsDir, entry.name, "chats") });
  }
  return projects;
}

function projectForCwd(projects, cwd) {
  return projects.find((project) => project.cwd && samePath(project.cwd, cwd))
    ?? projects.find((project) => project.id === legacyProjectId(resolve(cwd)));
}

function sessionFiles(project) {
  if (!existsSync(project.chatDir)) return [];
  return readdirSync(project.chatDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => {
      const path = join(project.chatDir, entry.name);
      return { sessionId: basename(entry.name, ".jsonl"), path, project, modified: statSync(path).mtimeMs };
    })
    .filter((file) => !INTERNAL_SESSION_PATTERN.test(file.sessionId));
}

// Entries on the active history branch. When the user regenerates or restores
// a turn, PilotDeck appends a `restore` boundary listing the sequences that
// stay visible; abandoned entries remain in the append-only file and are
// dropped here, matching `activeTranscriptEntries` in the runtime.
async function readEntries(path) {
  const lines = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
  const entries = [];
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A partially written trailing line is skipped, matching the runtime reader.
    }
  }
  let visible = [];
  for (const entry of entries) {
    const boundary = entry.type === "control_boundary" ? entry.boundary : undefined;
    if (boundary?.kind === "restore" && Array.isArray(boundary.visibleSequences)) {
      const sequences = new Set(boundary.visibleSequences);
      visible = entries.filter((candidate) => candidate.sequence < entry.sequence && sequences.has(candidate.sequence));
    }
    visible.push(entry);
  }
  return visible;
}

// Messages the user saw in the conversation. Synthetic prompts injected by the
// runtime and compaction replacements (summaries of earlier turns) are skipped
// because the original turns are still present earlier in the file.
function visibleMessages(entry) {
  let messages = [];
  if (entry.type === "accepted_input") messages = entry.messages ?? [];
  else if (
    entry.type === "assistant_message" ||
    entry.type === "tool_result_message" ||
    entry.type === "durable_message"
  ) messages = entry.message ? [entry.message] : [];
  return messages.filter((message) =>
    message && Array.isArray(message.content) &&
    !message.metadata?.synthetic && !message.metadata?.compactReplacement,
  );
}

function messageText(message) {
  return message.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function oneLine(text, limit) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

function truncate(text, limit) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… [truncated, ${text.length} chars total]`;
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function summarizeSession(file, query) {
  let title;
  let aiTitle;
  let firstPrompt;
  let matched = !query;
  const needle = query?.toLowerCase();
  for (const entry of await readEntries(file.path)) {
    if (entry.type === "session_metadata" && entry.metadata) {
      if (typeof entry.metadata.title === "string") title = entry.metadata.title;
      if (typeof entry.metadata.aiTitle === "string") aiTitle = entry.metadata.aiTitle;
      if (!firstPrompt && typeof entry.metadata.firstPrompt === "string") firstPrompt = entry.metadata.firstPrompt;
      continue;
    }
    for (const message of visibleMessages(entry)) {
      const text = messageText(message);
      if (!text) continue;
      if (!firstPrompt && message.role === "user") firstPrompt = text;
      if (!matched && text.toLowerCase().includes(needle)) matched = true;
    }
  }
  if (!matched) return undefined;
  return {
    sessionId: file.sessionId,
    title: title || aiTitle || oneLine(firstPrompt ?? "", 40) || "(untitled)",
    project: file.project.cwd ?? file.project.id,
    modified: file.modified,
    firstPrompt: oneLine(firstPrompt ?? "", FIRST_PROMPT_CHARS),
  };
}

async function listCommand(options) {
  const home = pilotHome();
  const projects = listProjects(home);
  if (projects.length === 0) {
    console.log(`No PilotDeck sessions found under ${join(home, "projects")}.`);
    return;
  }
  let scope = projects;
  if (!options.all) {
    const current = projectForCwd(projects, process.cwd());
    if (!current) {
      console.log(`No sessions recorded for ${process.cwd()}. Use --all to list sessions from every project.`);
      return;
    }
    scope = [current];
  }
  const files = scope.flatMap(sessionFiles).sort((a, b) => b.modified - a.modified);
  const sessions = [];
  for (const file of files) {
    if (sessions.length >= options.limit) break;
    const summary = await summarizeSession(file, options.query);
    if (summary) sessions.push(summary);
  }
  if (sessions.length === 0) {
    console.log(options.query ? `No sessions contain "${options.query}".` : "No sessions found.");
    return;
  }
  sessions.forEach((session, index) => {
    console.log(
      `${index + 1}. ${session.sessionId} | ${session.title} | ${formatTime(session.modified)} | ${session.project} | ${session.firstPrompt}`,
    );
  });
}

// Accepts the full id (`web:s_<uuid>`) or the id without its channel prefix
// (`s_<uuid>`), which models often pass along.
function findSessionFile(sessionId) {
  const wanted = sanitizeSessionId(sessionId);
  const files = listProjects(pilotHome()).flatMap(sessionFiles);
  const exact = files.filter((file) => file.sessionId === wanted);
  const matches = exact.length > 0
    ? exact
    : files.filter((file) => /[:-]$/.test(file.sessionId.slice(0, -wanted.length)) && file.sessionId.endsWith(wanted));
  matches.sort((a, b) => b.modified - a.modified);
  return matches[0];
}

function renderBlock(block, role, toolChars) {
  switch (block.type) {
    case "text":
      return block.text?.trim() ? `[${role}] ${block.text.trim()}` : undefined;
    case "tool_call":
      return `[tool_call] ${block.name} ${oneLine(JSON.stringify(block.input ?? {}), TOOL_ARGS_CHARS)}`;
    case "tool_result": {
      const text = (block.content ?? [])
        .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
        .join("\n")
        .trim();
      const label = block.isError ? "[tool_result error]" : "[tool_result]";
      return `${label} ${truncate(text, toolChars)}`;
    }
    case "tool_result_reference":
      return `[tool_result] ${truncate(block.preview ?? "", toolChars)}\n(full output: ${block.path})`;
    case "media_reference":
      return `[${block.mediaType ?? "media"}: ${block.path}]`;
    case "image":
    case "pdf":
    case "audio":
      return `[${block.type}]`;
    default:
      return undefined;
  }
}

function renderMessage(message, toolChars) {
  const parts = message.content
    .map((block) => renderBlock(block, message.role, toolChars))
    .filter(Boolean);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

async function readCommand(sessionId, options) {
  const file = findSessionFile(sessionId);
  if (!file) {
    console.error(`Session "${sessionId}" not found. Run "list" (or "list --all") to see available session ids.`);
    process.exitCode = 1;
    return;
  }
  let title;
  let aiTitle;
  let firstPrompt;
  let createdAt;
  const turns = [];
  const turnIndex = new Map();
  const subagentPrompts = new Map();
  for (const entry of await readEntries(file.path)) {
    createdAt ??= entry.createdAt;
    if (entry.type === "session_metadata" && entry.metadata) {
      if (typeof entry.metadata.title === "string") title = entry.metadata.title;
      if (typeof entry.metadata.aiTitle === "string") aiTitle = entry.metadata.aiTitle;
      continue;
    }
    let lines = [];
    if (entry.type === "subagent_started") {
      subagentPrompts.set(entry.subagentId, entry.promptPreview ?? "");
      continue;
    }
    if (entry.type === "subagent_completed") {
      const prompt = oneLine(subagentPrompts.get(entry.subagentId) ?? "", TOOL_ARGS_CHARS);
      lines = [`[subagent ${entry.subagentType}] ${prompt}\n→ ${truncate(entry.summaryPreview ?? "", options.toolChars)}`];
    } else {
      const messages = visibleMessages(entry);
      firstPrompt ??= messages.filter((message) => message.role === "user").map(messageText).find(Boolean);
      lines = messages
        .map((message) => renderMessage(message, options.toolChars))
        .filter(Boolean);
    }
    if (lines.length === 0 || !entry.turnId) continue;
    let turn = turnIndex.get(entry.turnId);
    if (!turn) {
      turn = { createdAt: entry.createdAt, lines: [] };
      turnIndex.set(entry.turnId, turn);
      turns.push(turn);
    }
    turn.lines.push(...lines);
  }

  const output = [
    `# ${title || aiTitle || oneLine(firstPrompt ?? "", 40) || "(untitled)"}`,
    `session: ${basename(file.path, ".jsonl")}`,
    `project: ${file.project.cwd ?? file.project.id}`,
    `created: ${formatTime(createdAt)}  turns: ${turns.length}`,
  ];
  turns.forEach((turn, index) => {
    output.push("", `## Turn ${index + 1} · ${formatTime(turn.createdAt)}`, ...turn.lines);
  });
  console.log(output.join("\n"));
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { all: false, query: undefined, limit: DEFAULT_LIST_LIMIT, toolChars: DEFAULT_TOOL_CHARS };
  const positional = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--all") options.all = true;
    else if (arg === "--query") options.query = rest[++i];
    else if (arg === "--limit") options.limit = Number(rest[++i]);
    else if (arg === "--tool-chars") options.toolChars = Number(rest[++i]);
    else positional.push(arg);
  }
  if (!Number.isInteger(options.limit) || options.limit < 1) throw new Error("--limit must be a positive integer.");
  if (!Number.isInteger(options.toolChars) || options.toolChars < 0) throw new Error("--tool-chars must be a non-negative integer.");
  if (options.query !== undefined && !options.query) throw new Error("--query needs a value.");
  return { command, options, positional };
}

const USAGE = [
  "Usage:",
  "  node sessions.mjs list [--all] [--query <text>] [--limit <n>]",
  "  node sessions.mjs read <sessionId> [--tool-chars <n>]",
].join("\n");

try {
  const { command, options, positional } = parseArgs(process.argv.slice(2));
  if (command === "list") {
    await listCommand(options);
  } else if (command === "read" && positional[0]) {
    await readCommand(positional[0], options);
  } else {
    console.error(USAGE);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(USAGE);
  process.exitCode = 1;
}
