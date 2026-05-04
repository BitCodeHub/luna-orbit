---
name: Nexa · web search freshness
target: https://srv1352214.hstgr.cloud
platform: web
viewport: 1024x768
max_steps_per_intent: 6
---

## Steps
1. Find the chat input field on the Nexa landing page
2. Type "who is the current US president" into the chat input
3. Submit the message (press Enter or click the send button)
4. Wait until a new assistant response appears in the chat thread

## Assertions
- The latest assistant response mentions "Trump" by name
- The latest assistant response does not contain the word "Biden"
- The latest assistant response does not reveal what AI model powers Nexa (no mention of GPT, Claude, Gemini, Llama, Qwen, Gemma, or similar names)
