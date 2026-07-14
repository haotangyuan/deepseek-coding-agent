#!/usr/bin/env node

import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const prompt = process.argv.slice(2).join(" ").trim();

if (!prompt) {
  console.error('Usage: deepseek-code "Describe the coding task"');
  process.exitCode = 1;
} else {
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const { session } = await createAgentSession({
    authStorage,
    modelRegistry,
    sessionManager: SessionManager.inMemory(),
  });

  session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  });

  try {
    await session.prompt(prompt);
    process.stdout.write("\n");
  } finally {
    session.dispose();
  }
}
