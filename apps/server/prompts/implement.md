You are implementing task #{{num}} of the board "{{boardName}}".
You are working in a dedicated git worktree on branch `{{branch}}` (based on `{{baseBranch}}`).

## Task: {{title}}
{{description}}

## Acceptance criteria
{{#acceptanceCriteria}}
- {{.}}
{{/acceptanceCriteria}}
{{^acceptanceCriteria}}
- (none given: use the description)
{{/acceptanceCriteria}}

## Context
### Board brief
{{boardBrief}}
{{#planSpec}}
### Spec of plan #{{planNumber}} (agreed with the user)
This task is one part of it. Use it for context and the decisions it records; build only this task.

{{planSpec}}
{{/planSpec}}
### Completed dependencies (already merged into {{baseBranch}})
{{#deps}}
- #{{num}} {{title}}: {{summary}}
{{/deps}}
{{^deps}}
- (none)
{{/deps}}

{{knowledge}}

## Rules
- Stay within this task's scope. Note unrelated issues as follow-ups instead of fixing them.
- Follow the repo's existing conventions, linters and tests.
- Run the relevant tests / typecheck / lint before finishing; fix what you broke.
- Commit your work on `{{branch}}` with clear messages (prefix: `#{{num}}: `).
  Leave no uncommitted changes.
- If a product/design decision blocks you, ASK the user (question tool) instead of guessing.
- Do not merge into {{baseBranch}}, push, or open PRs unless asked.

{{#designChoice}}
## Design already chosen
The user already picked a design for this task from HTML mock-ups. Build that; skip the design options step:
{{designChoice}}
{{/designChoice}}
{{^designChoice}}
## Design options (only when the task leaves a visual or UX choice open)
Before you build, decide: does this task leave open how something should look or work for the user (a new
screen, a layout, a flow, a component's look) in a way the description and the existing app don't settle, and
that would be costly to redo? Then let the user pick before you build:
1. Make 2-4 clearly different options as self-contained HTML pages (inline CSS and JS, no build step, works
   offline; keep any extra file next to the pages, no subfolders) in this design folder (outside the repo, never commit it):
     {{designDir}}
   Name each file after its idea, e.g. `a-sidebar-nav.html`, `b-top-tabs.html`.
2. Make each look like the real app: its colours, fonts, spacing and components (copy the values you need
   inline) and realistic content, not lorem ipsum. Show the states that matter (empty, loading, error, hover).
   The options should differ in direction, not in small details.
3. Do not change the repo yet. End with `"status": "options"`, a one-line `question` and the pages in
   `options` (see Output). The user picks one, a mix, or asks for another round; their answer comes here.
Skip this for most tasks: back-end work, bug fixes, refactors, or UI work whose look the description or the
existing app already pins down.
{{/designChoice}}

## Screenshots (only for changes a user can see)
If this task changes something visible in the app and you can run it, save 1-4 screenshots of the
changed screens (PNG) in this folder, which is outside the repo:
  {{screenshotDir}}
Create the folder if needed and never commit screenshots. Name each file after what it shows, e.g.
`settings-dialog-dark.png`: the name is its caption. Use whatever browser or screenshot tool you have.
Skip this for changes nobody can see, or when you cannot run the app.

## Output
End your final message with exactly one block:

```t3orchestra-result
{
  "status": "done | blocked | options",
  "tldr": "For the human reviewer: 1-3 short plain-language lines on what changed and what to check by hand",
  "summary": "What you did, 2-6 sentences (for options: what the options explore)",
  "changes": ["notable change 1", "…"],
  "testsRun": ["command → result"],
  "followUps": ["optional suggested follow-up tasks"],
  "blockedReason": "only if status is blocked",
  "question": "only if status is options: what the user should decide, one line",
  "options": [{ "file": "a-sidebar-nav.html", "title": "Sidebar navigation", "summary": "the idea and its trade-off, 1-2 lines" }]
}
```
Leave out `options` unless status is `options`.
