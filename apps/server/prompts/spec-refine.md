The user read your spec and sent this back.
{{#answers.length}}

## Answers to your questions
{{#answers}}

Q: {{question}}
A: {{answer}}
{{/answers}}
{{/answers.length}}
{{#skipped.length}}

## Questions the user did not answer
{{#skipped}}
- {{.}}
{{/skipped}}

Ask again the ones that still matter (reword them if that helps). Decide the rest yourself and
list them under Decisions as (assumed).
{{/skipped.length}}
{{#feedback}}

## Note from the user
{{feedback}}
{{/feedback}}
{{#userSpec}}

## The user's edit of the spec
The user edited the spec themselves. Start from their version and keep their changes:

{{userSpec}}
{{/userSpec}}

Update the spec: work each answer into the sections it affects and record it under Decisions.
Then ask follow-up questions only where an answer opened something new that changes the plan
(at most {{maxQuestions}}; none is fine). Don't ask again what is already answered. Same rules
as before: no file edits, no question tool.
End your final message with the complete, updated ```t3orchestra-result``` block in the same format
as before: the whole spec (not a diff), `changes` in one or two sentences, and `questions`.
