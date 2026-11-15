- Size each task so one agent can finish it in one focused session
  (roughly < 400 changed lines). Split bigger work.
- Prefer tasks that can run in parallel. Only add a dependency when a task truly needs
  another task's code merged first.
- Every task must be verifiable: give concrete acceptance criteria.
- List the paths/areas each task will likely touch in `touches` (directories or files,
  repo-relative, forward slashes). Tasks that touch the same area should usually be
  sequential (dependency) or merged into one task.
- If the project needs scaffolding first, make that task #1 and have others depend on it.
- Group the tasks into milestones: phases that each end in something that works and can
  be checked (for example "Users can sign up and log in"). Use 1-4 milestones, ordered by
  when they should be finished, and give each a one-sentence `goal`. Put the milestone's
  title in each task's `milestone`. When a task belongs to one of the board's existing
  milestones (listed below), use that title exactly and don't list it again.
- Max {{maxTasks}} tasks.
