---
title: Privacy and our data promise
description: The complete deskfleet client and server are open source. The official service will not use your work data to train models.
---

# Your work is not training data

**The official deskfleet service will not use your code, conversations, or work records to train models.**

## Open from client to server

The complete [deskfleet source](https://github.com/yet-another-ai/deskfleet) is available under Apache-2.0, including the desktop client, web client, machine daemon, and central backend. You can inspect how data moves and how the service handles it, or run your own deployment.

## Where data lives

Agents execute on the machines you enroll. Their CLI credentials stay on those machines. The central service stores account and team information, machine and workspace catalogs, and synchronized conversation and tool history so teammates can collaborate and read history when a machine is offline. Tool history may contain code or other task content.

Live agent, Git, terminal, and desktop connections use authenticated WebRTC. Terminal transcripts are stored on the executing machine; desktop streams are not stored as conversation history.

## Agents you connect

The agent and model providers you choose have their own data policies and account settings. The deskfleet promise describes the official deskfleet service; it does not change how those providers process requests sent to them.

## Website demos

The interactive examples on this website use sample data and browser-local state. They do not connect to a real agent, run shell commands, or control a remote computer. Reloading the page resets the examples.
