The user is happy with the spec. Now turn it into a set of independent, well-scoped
implementation tasks for coding agents. Each task will be executed by a separate agent in its
own git worktree, branched from `{{baseBranch}}`, and merged back before dependent tasks start.
{{#answers.length}}

## Last answers
{{#answers}}

Q: {{question}}
A: {{answer}}
{{/answers}}
{{/answers.length}}
{{#feedback}}

## Note from the user
{{feedback}}
{{/feedback}}

## The agreed spec
{{#edited}}
The user edited it; this version is the one that counts.

{{/edited}}
{{spec}}

## Rules
- Do NOT edit, create, or delete files.
- Follow the spec{{#answers.length}} and the last answers{{/answers.length}}. Where it is silent,
  decide and say so in `assumptions`. Unanswered spec questions: decide them the same way.
- Put what each task needs from the spec in its description: the part it builds and the
  decisions that apply to it.
{{> plan-rules}}

## Milestones on this board
{{milestones}}

{{> plan-output}}
