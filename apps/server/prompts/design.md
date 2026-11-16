The user looked at your design options for #{{num}}.
{{#build}}They chose what to build:{{/build}}{{#more}}They want another round of options, in this direction:{{/more}}

{{choice}}
{{#build}}

Build this now in the real app.{{#several}} They picked more than one option: combine them, taking from each
option what their notes say.{{/several}} The mock-ups show the look and the behaviour to aim for; build it with
the app's real components, data and styles rather than copying the mock-up code. Follow the task's acceptance
criteria and the rules from the first message, run the relevant tests, and commit on `{{branch}}`
(prefix: `#{{num}}: `).
End with the same ```t3orchestra-result``` block format as before, with `"status": "done"`; its `tldr` covers the
whole task. If you can run the app, save screenshots of the result as before.
{{/build}}
{{#more}}

Make round {{nextRound}}: 2-4 new options that follow this direction. Save them in this design folder (outside the repo, never commit it):
  {{designDir}}
Same rules as before: self-contained HTML pages that look like the real app, clearly different from each other,
and no changes to the repo yet. End with the same ```t3orchestra-result``` block format as before, with
`"status": "options"` and the new files listed in `options`.
{{/more}}
