# IRA Project Overview

This file consolidates the most useful context from:

- [plan.md](file:///c:/Development/IRA/plan.md)
- [progress.md](file:///c:/Development/IRA/progress.md)
- [README.md](file:///c:/Development/IRA/README.md)

## Current Implementation (What Runs Locally)

- `apps/admin-portal` provisions a website and manages documents in the website knowledge base.
- `apps/web-chat` routes text requests through the orchestrator and displays the selected agent + prompt package.
- `apps/voice-console` prepares a voice route and connects to the backend Gemini Live proxy over WebSocket.
- `services/orchestrator` provides:
  - website provisioning
  - document upsert/query/list/delete
  - orchestration routing (`text_chat` vs `voice_processing`)
  - Gemini Live backend WebSocket proxy

## Current Runtime Diagram (What Exists Today)

```mermaid
flowchart TD
  subgraph Frontend
    Admin[Admin Portal :3000]
    Chat[Web Chat :3001]
    Voice[Voice Console :3002]
  end

  subgraph Backend
    API[Orchestrator API :8000]
    Router[OrchestratorService.route_conversation]
    LiveProxy[LiveProxyService /api/live/ws]
    Prompts[Prompt Builder\nrouter + agent + grounding + website]
  end

  subgraph Data
    Chroma[(Chroma :8001)]
  end

  Admin -->|/api/auth/login| API
  Admin -->|/api/orchestration/websites| API
  Admin -->|/api/orchestration/documents*| API
  Chat -->|/api/orchestration/route| API
  Voice -->|/api/orchestration/route| API
  Voice -->|WebSocket /api/live/ws| LiveProxy

  API --> Router
  Router --> Prompts
  API --> Chroma
  LiveProxy --> Prompts
  LiveProxy -->|RAG metadata lookup| Chroma

  subgraph Google
    GeminiLive[Gemini Live API]
    GeminiEmbed[Embeddings API]
  end

  LiveProxy -->|WebSocket upstream| GeminiLive
  API -->|embed on upsert/query when enabled| GeminiEmbed
```

## Target Multi-Agent Diagram (Planned)

This is the planned multi-agent architecture described in [plan.md](file:///c:/Development/IRA/plan.md#L82-L145).

```mermaid
flowchart TD
    U[End User]
    UI[Voice Chat UI / Text Chat UI]
    AR[Admin User]
    AP[Admin Portal]

    OR[Orchestration Router]
    VP[Voice Processing Agent]
    TC[Text Chat Agent]
    WS[Web Scraping Agent]
    RAG[RAG Management Agent]
    AUTH[Authentication Agent]
    OBS[Observability Agent]

    GM[Google Models\nGemini Live / Gemini Text / Embeddings]
    KB[Vector Database / RAG Store]
    WEB[Target Websites]
    CFG[Agent Config / Prompts / Access Policies]
    MON[Conversation Logs / Metrics / Traces]

    U --> UI
    UI --> OR
    OR --> VP
    OR --> TC
    VP --> GM
    TC --> GM
    VP --> RAG
    TC --> RAG
    RAG --> KB
    VP --> OBS
    TC --> OBS
    OR --> OBS
    RAG --> OBS
    OBS --> MON

    AR --> AP
    AP --> AUTH
    AP --> OR
    AP --> OBS
    OR --> AUTH
    OR --> WS
    WS --> WEB
    WS --> RAG
    AP --> CFG
    CFG --> OR
    CFG --> TC
    CFG --> VP
    AUTH --> CFG
```

## Git Workflow Diagram (For GitHub/Git)

This is a recommended Git flow for this repository that works well with a fast-moving monorepo.

```mermaid
gitGraph
  commit id: "main"
  branch feature/prompt-arch
  checkout feature/prompt-arch
  commit id: "work"
  commit id: "tests"
  checkout main
  merge feature/prompt-arch tag: "PR merge"
  branch feature/voice-audio
  checkout feature/voice-audio
  commit id: "backend proxy"
  commit id: "frontend playback"
  checkout main
  merge feature/voice-audio tag: "PR merge"
```

## Roadmap Highlights

- Voice-to-voice UX: touch-first UI, realtime state animations, barge-in, streamed audio output.
- RAG: website crawl ingestion, chunking, retrieval evaluation, citations, and incremental refresh.
- Admin: onboarding that provisions crawl/RAG/agent/observability defaults per website.
- Observability: trace/metrics capture for routing, retrieval, model usage, and live session health.
