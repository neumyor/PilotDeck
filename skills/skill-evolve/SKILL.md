---
name: skill-evolve
description: Turn the user's past PilotDeck conversations into reusable skills that capture how they want recurring tasks done, including their corrections and preferences. Use when the user asks for skill evolve, or wants to learn, distill, or extract skills from earlier sessions, chats, or conversation history.
---

# Skill Evolve

Read the conversations the user picks, find the kinds of subtasks that recur in them, and write one skill per kind that captures how this user wants it done. The user's corrections are the most valuable material: a good skill means they never have to give the same correction again. Test each skill on real requests from those conversations, revise it, and install it only after the user confirms.

Talk to the user in the language they use.

```bash
SKILL_ROOT={{SKILL_ROOT_SHELL}}
SESSIONS="$SKILL_ROOT/scripts/sessions.mjs"
```

Create a working directory `<project root>/.pilotdeck/skill-evolve/<YYYYMMDD-HHmmss>/` for drafts and test inputs. Below it is called `<work>`.

## 1. Choose sessions

If the user already named sessions, use them. Otherwise run `node "$SESSIONS" list`, adding `--query <words>` when the user described a topic and `--all` when the sessions may belong to other projects. Show the numbered list and ask which ones to use. Leave out sessions that were themselves skill evolve runs.

## 2. Extract subtasks

Start one `general-purpose` subagent per session, all in the same message. Give each this directive, with the absolute script path and the session id filled in:

```text
Read a past PilotDeck conversation and list the subtasks in it.
Run: node "<absolute path to sessions.mjs>" read <sessionId>
If a tool result you need is truncated, run it again with --tool-chars 20000.
A subtask is one piece of work the user asked for, such as revising the introduction of a paper.
For each subtask report:
- Request: the user's original words.
- Input: the material the work started from (file content, pasted text), quoted from the transcript, or "not recoverable".
- Background: facts from anywhere in the conversation that the work relied on but that are not in the input, such as what the user's own method or product is.
- Skills used: skills the assistant read for this subtask.
- Corrections: every place the user corrected or redirected the assistant, quoted verbatim with the turn number.
- Preferences: preferences the user stated.
- Accepted result: what the user finally accepted.
- External actions: messages sent, code pushed, files deleted, or "none".
Do not modify any files. Put everything in your final reply.
```

## 3. Group into task types

Group the subtasks from all sessions into task types. For each type write down:

- the goal;
- the situation in which the task starts;
- inputs and outputs;
- success criteria;
- the user's preferences and corrections, quoted.

Keep a type only if it has a correction or an explicit preference, or appears in two or more sessions. Keep at most 5 types. Check `<available-skills>` for skills that already cover a type, and read the overlapping ones.

Show the user a short table with each type, its source sessions, the key corrections, and any related existing skill. Ask them to confirm before you continue.

## 4. Write skills and test cases

For each type, write `<work>/<slug>/v1/SKILL.md`:

- **Frontmatter:** put `name` and `description` each on a single line. PilotDeck does not read multi-line YAML values. The description says what the skill does and when to use it, based on the situation in which the task starts.
- **Body:** the goal, inputs and outputs, the steps, and the user's preferences and corrections written as rules, each with its reason.
- **Reusable practices only:** never copy content that belongs to one task, such as a paper title, a paragraph, or a file name. A skill that contains the answers to its test cases proves nothing.
- **No sensitive data:** no secrets, account names, or personal data.
- **Slug:** lowercase letters, digits, and hyphens.

Write `<work>/<slug>/cases.md` with 1 to 3 test cases. Each test case is a real request from the sessions whose input is recoverable:

- **Request:** the user's original words.
- **Input:** the input together with the background it relies on. Short inputs go inline; long inputs are saved to `<work>/<slug>/inputs/<case>.md`.
- **Criteria:** one per correction, preference, or success criterion that applies. Each criterion must be checkable from a written reply.

Do not use requests that involve external actions (sending messages, pushing code, deleting files) as test cases. A type with no usable test case is marked "untested" and skips step 5.

## 5. Test and revise

Run at most 3 rounds per type. In each round:

1. Start one `general-purpose` subagent per test case. Put the test cases of all types in the same message, at most 6 subagents per message. Use this directive:

   ```text
   You are testing a skill. Read <absolute path to the skill version under test> with read_file and follow it while completing the request below.
   Request: <the user's original words>
   Input: <inline input, or "read <absolute path>">
   Do not modify files, run commands that change anything, send messages, or push code.
   Give the complete deliverable in your reply. If the request asks for a file, put the file's content in your reply.
   Then list which parts of the skill you followed.
   ```

2. Check every criterion against the reply and note pass or fail.
3. If every criterion passes, stop testing this type. Otherwise, work out the cause of each failure:
   - **The test case lacked information the real session had:** for example, the reply left a placeholder because the input did not say what the user's method is. Add that information to the test case and run only that test case again. Leave the skill unchanged.
   - **The skill was missing the information, was vague, or was wrong:** fix only those parts, write `<work>/<slug>/v<k+1>/SKILL.md`, and run all of this type's test cases again.

When a type stops, keep the version that passed the most criteria. On a tie, keep the shorter one.

## 6. Decide and install

For each type, show the user:

- the description;
- the main rules;
- the test result (passed criteria of the kept version, or "untested");
- the path of the draft;
- a recommendation, with the reason: create a new skill, merge into an existing skill, or do not save.

Ask the user to confirm each recommendation with `ask_user_question` (at most 4 questions per call). Then:

- **New skill:** write it to `${PILOT_HOME:-~/.pilotdeck}/skills/<slug>/SKILL.md` for all projects, or to `<project root>/.pilotdeck/skills/<slug>/SKILL.md` for this project only, as the user chooses.
- **Merge into a user or project skill:** copy the existing SKILL.md to `<work>/backup/<slug>/SKILL.md` first. Then write the merged skill: keep the existing content, add the new rules, and when the two conflict, follow the user's corrections.
- **Merge into a built-in skill:** built-in skills are read-only. Write the merged skill as a user-level skill with the same name; it overrides the built-in one.

Finish by telling the user:

- which skills were written and where;
- where any backups are;
- that the new skills take effect from their next message.
