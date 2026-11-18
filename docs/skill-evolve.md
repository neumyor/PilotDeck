# Skill evolve

`skills/skill-evolve` is a bundled skill that turns selected past conversations
into reusable skills. It captures the corrections and preferences a user gave in
those conversations, tests each draft on real requests from them, and installs a
skill only after the user confirms. It has no dedicated UI; it runs inside an
ordinary chat session.

## Usage

Start a new session in the project whose conversations should be used, then ask
for it in plain words ("use my recent paper-editing sessions for skill evolve")
or pick `skill-evolve` from the composer's skill menu. Full Access avoids a
confirmation for every script run and draft write. The assistant asks three
times: which sessions to use, which task types to keep, and how to install each
result (new, merge into an existing skill, or discard; project or user level).

## Flow

1. List sessions with `sessions.mjs list` and let the user choose.
2. Start one `general-purpose` subagent per session. Each saves the transcript
   text to the working directory, reads it with `read_file`, and reports every
   subtask: request, input, background, corrections, preferences, accepted
   result and external actions.
3. Group subtasks into at most five task types. Keep a type only when it has a
   correction or preference, or appears in two or more sessions.
4. Write one draft per type plus one to three test cases taken from real
   requests. Criteria come from the user's corrections. Requests with external
   actions (sending messages, pushing code, deleting files) are not test cases.
5. Run each test case in a subagent that reads the draft and answers without
   modifying files; check every criterion. A failure caused by a test case
   missing information from the original session is fixed in the test case;
   any other failure revises the draft and reruns all of that type's cases. Stop
   when all criteria pass or after three versions; keep the version that passed
   the most criteria, preferring the shorter one on ties. The kept version is
   installed exactly as tested.
6. After confirmation, write to `~/.pilotdeck/skills/<slug>/` or
   `<project>/.pilotdeck/skills/<slug>/`. A merged skill's previous SKILL.md is
   copied to the working directory first; merging into a bundled skill writes a
   user-level skill with the same name.

Drafts, test cases, transcript copies and backups stay in
`<project>/.pilotdeck/skill-evolve/<timestamp>/`, which skill discovery ignores.

## Transcript reader

`skills/skill-evolve/scripts/sessions.mjs` uses only Node built-ins and resolves
`$PILOT_HOME` (default `~/.pilotdeck`).

- `list [--all] [--query <text>] [--limit <n>]` lists the current project's
  sessions, or every project's with `--all`, newest first. Always-On internal
  sessions are hidden. `--query` keeps sessions whose user or assistant text
  contains the text.
- `read <sessionId> [--tool-chars <n>]` prints the active history branch turn by
  turn: full user and assistant text, one line per tool call, tool results cut to
  `--tool-chars` (default 2000) and subagent summaries. It keeps turns from
  before compaction, skips compaction summaries, thinking and synthetic
  messages, and drops turns discarded by a `restore` boundary. The id may omit
  its channel prefix.

The script reads the on-disk transcript format directly instead of importing
`src/session`. Changes to the transcript path or `.cwd` marker
(`src/pilot/paths.ts`), `sanitizeSessionIdForPath`, transcript entry types,
`restore` boundaries (`activeTranscriptEntries`), message `synthetic` and
`compactReplacement` metadata, or content block types need a matching update
here and in `tests/skill-evolve/sessions.spec.ts`.

## Limits

- Skills and test cases come from the same sessions, so passing shows that the
  corrections are written clearly enough to follow, not that the skill
  generalizes to new tasks.
- The main session grades the test runs it designed.
- Test subagents have the full tool set; external actions are prevented only by
  test-case selection and the directive.
- PilotDeck memory also records corrections and is visible to the main session
  and test subagents, so it can contribute to passing tests and overlap with the
  generated skill.
