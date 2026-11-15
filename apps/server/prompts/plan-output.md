## Output
End your final message with exactly one block:

```t3orchestra-result
{
  "summary": "2-5 sentence overview of the approach",
  "assumptions": ["…"],
  "openQuestions": ["… (non-blocking questions for the user, one per item, not numbered)"],
  "milestones": [
    { "title": "Short name, < 60 chars", "goal": "What works once this milestone is done" }
  ],
  "tasks": [
    {
      "key": "T1",
      "title": "Imperative, < 70 chars",
      "description": "Markdown. What to build and why, key decisions, pointers to relevant files.",
      "acceptanceCriteria": ["Observable, testable statements"],
      "complexity": "trivial | small | medium | large",
      "category": "feature | bug | refactor | test | docs | infra | design",
      "priority": "high | medium | low",
      "dependsOn": ["T0"],
      "touches": ["src/auth/", "src/routes/login.tsx"],
      "milestone": "Title of one of the milestones"
    }
  ]
}
```
