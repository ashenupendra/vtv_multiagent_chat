# Prompt Architecture

## Overview

IRA now uses a shared prompt architecture for both text and voice routing paths.

The backend composes four prompt layers:

1. `router_prompt`
2. `agent_prompt`
3. `grounding_prompt`
4. `website_prompt`

These are combined into a single `composed_system_prompt` that is used by the runtime.

## Prompt Sources

- `router_prompt`
  - defines the orchestration role and the selected agent mode
- `agent_prompt`
  - defines text-specific or voice-specific assistant behavior
- `grounding_prompt`
  - enforces RAG grounding and anti-hallucination behavior
- `website_prompt`
  - injects website metadata and any configured `prompt_override`

## Runtime Flow

```text
Client Request
    |
    v
OrchestratorService.route_conversation()
    |
    +--> load RAG collection binding + website metadata
    |
    +--> build PromptContext
    |
    +--> build PromptBlueprint
    |       - router_prompt
    |       - agent_prompt
    |       - grounding_prompt
    |       - website_prompt
    |       - composed_system_prompt
    |
    +--> select TextChatAgent or VoiceProcessingAgent
    |
    +--> return route + prompt fields in API response
```

## Voice Runtime Flow

```text
Voice Console
    |
    +--> /api/orchestration/route
    |
    +--> /api/live/ws?website_id=...&model=...
              |
              v
        LiveProxyService
              |
              +--> load website metadata from Chroma
              +--> build PromptContext
              +--> build PromptBlueprint
              +--> send composed_system_prompt to Gemini Live
```

## Website Prompt Override

`prompt_override` is stored during website onboarding and is now injected into:

- text route prompt construction
- voice live prompt construction

This makes website-specific behavior part of the actual runtime prompt instead of passive metadata.
