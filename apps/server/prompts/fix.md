An AI reviewer found issues with your work on #{{num}} (round {{round}}).
Fix every blocker and major finding; address minor ones if cheap. Commit the fixes.
{{#findings}}

- [{{severity}}] {{file}}{{#line}}:{{line}}{{/line}}: {{title}}
  {{detail}}
  {{#suggestion}}Suggested: {{suggestion}}{{/suggestion}}
{{/findings}}

End with the same ```t3orchestra-result``` block format as before; its `tldr` covers the whole task, not just
this round. If you saved screenshots and changed what they show, replace them.
