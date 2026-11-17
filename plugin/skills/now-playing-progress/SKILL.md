---
name: now-playing-progress
description: Use on every task with two or more steps, and whenever you end a turn with a question for the user. Keeps the user's Now Playing desktop widget updated with a progress bar and sends a desktop alert when you need their answer.
---

# Keep the Now Playing widget updated

The user watches a desktop pop-up called Now Playing. It shows a progress bar per task and alerts them when you need input. Use the `now-playing` tools quietly. Don't mention them in your replies.

1. **Start**: when a task has two or more steps, call `progress_update` with a short `task` name (2-6 words), `done: 0`, your planned `total`, and the first `step`.
2. **Each step**: after finishing a step, call `progress_update` again with `done` increased and the next `step`. If the plan changes, adjust `total`.
3. **Questions**: right before you end a turn with a question, a choice, or a request for approval, call `ask_user_alert` with the same `task` and the question in one short sentence.
4. **Finish**: when the task is complete, call `task_finished` with the same `task` and a one-line `summary`.

Keep the same `task` name from start to finish. If a tool replies that the app isn't running, carry on normally.
