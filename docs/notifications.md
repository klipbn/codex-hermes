# Notification examples

These examples use fictional data. The README preview is a simulated dark-theme Telegram Desktop screenshot
using actual renderer output; the chat list and message context are fictional.

## Completed turn

```text
Codex · 📝 Fix retry handling
✅ Completed · demo-worker

🧠 Summary
Fixed retry handling and verified the worker.

⏱ 42 s · Model: gpt-5-codex
```

The heading uses the Codex session name (the name shown by Codex, or the first prompt
when the session has no name). Rich completion messages have an open Summary section and a
collapsible Details section. Recorded tests remain available through `/cxtests`. Dynamic HTML is escaped. A transport/method failure uses
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
