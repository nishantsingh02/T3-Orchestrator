T3 Orchestra's "Run project" ({{label}}) failed in {{where}}. Find out why and fix it, so that it starts.

How T3 Orchestra ran it:
{{#parts}}
- in `{{cwd}}`: {{commands}}
{{/parts}}

What went wrong: {{error}}

The end of its output:

````text
{{log}}
````

- Reproduce it by running the same commands yourself, and run them again after your fix to check that it
  starts. Stop whatever you start: dev servers keep running otherwise.
- If the cause is outside the repo (a broken cache or tool on this machine, such as a corrupted package
  store), fix that if it is safe (for example `pnpm store prune`), say exactly what you did in your summary,
  and commit nothing for it.
- If T3 Orchestra ran it the wrong way (wrong command or folder), say the right command in your summary. The
  user can save it under Run → Change how it runs.
{{#note}}

From the user: {{note}}
{{/note}}
