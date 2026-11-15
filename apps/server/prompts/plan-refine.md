The user reviewed your plan and wants it refined.
{{#answers.length}}

## Answers to your open questions
{{#answers}}

Q: {{question}}
A: {{answer}}
{{/answers}}
{{/answers.length}}
{{#feedback}}

## Feedback
{{feedback}}
{{/feedback}}

Update the plan accordingly.
{{#answers.length}}
Work the answers into the affected tasks and `assumptions`, and remove answered questions from `openQuestions`
(keep the ones that are still open).
{{/answers.length}}
Keep task keys stable for tasks that did not change, use new keys for new tasks, and keep the same rules as
before (no file edits, max {{maxTasks}} tasks).
End your final message with the complete, updated ```t3orchestra-result``` block in the same format as before.
