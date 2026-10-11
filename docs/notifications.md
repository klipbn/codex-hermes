# Notification examples

These examples use fictional data. The README preview is generated from the actual renderer
with a substitute transport; it is an illustrative document, not a screenshot of a real chat.

## Completed turn

```text
📝 Fix retry handling
Completed · Codex · demo-worker

🧠 Summary
Fixed retry handling and verified the worker.

📦 Diff: unavailable
🧪 Tests: 1 passed · 0 failed · 0 unknown
```

Rich completion messages have an open Summary section and collapsible Diff, Tests, and
Details sections where available. Dynamic HTML is escaped. A transport/method failure uses
the equivalent expandable-blockquote fallback through Hermes.

## Attention and errors

- **Permission:** asks you to return to the agent terminal to approve or deny the action.
- **Reminder:** reports continued waiting; reminder counts are bounded.
- **Error/interrupted:** describes the observed failed/interrupted turn, not a successful task.

Codex does not invent retry events. Daemon discovery can observe model errors;
hooks alone do not guarantee such events. A turn's final answer is preserved verbatim.

## What stays original

Project/session names, original answers, external errors, paths, and test commands keep their
original language. The English interface does not rewrite user content or historical state.
OpenCode AI summaries request English; the factual fallback preserves an answer excerpt.
Codex does not add a summarization/translation model call.

Footers use English dates, 24-hour Moscow time, and the MSK label. Acceptance by Telegram
or a successful Hermes process exit does not prove that someone read a notification.

Full stored turn details are available with `/cxsum` and `/cxtests`, subject to
the documented retention and truncation limits. No real Telegram message is sent by the test suite.
