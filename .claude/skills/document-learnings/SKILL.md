---
name: document-learnings
description: After resolving a tricky issue, prompt the user about documenting the learnings
---

## When to Use

After spending significant time debugging an issue (generally 15+ minutes of troubleshooting, or 5+ attempts at different solutions), ask the user if they want to document what was learned.

## What to Ask

Simply ask: "Want me to write up the learnings from this session to AGENTS.md?"

## Why This Matters

- Documents obscure issues that might recur
- Helps future sessions avoid repeating debugging steps
- Captures workarounds specific to the user's environment
- Creates institutional knowledge even for quick projects

## What to Document

For Cloudflare Workers issues specifically:
- Error messages and what they mean
- Workarounds that didn't work vs. what did
- Environment-specific quirks (macOS, VPN, firewall)
- Version numbers of tools tried
- Links to relevant GitHub issues
