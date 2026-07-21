# IRA

Initial monorepo scaffold for the IRA multi-agent voice and chat platform.

## Workspace Layout
- `apps/`: frontend applications
- `services/`: backend services
- `packages/`: shared packages and configuration
- `infra/`: Docker, compose, and observability assets
- `docs/`: architecture and ADRs
- `tests/`: cross-cutting test suites

## Current Service
- `services/orchestrator`: FastAPI baseline for orchestration APIs and service health

## Documentation
- Roadmap and target architecture: [plan.md](file:///c:/Development/IRA/plan.md)
- Running project log: [progress.md](file:///c:/Development/IRA/progress.md)
- Prompt architecture (router/agent/grounding/website prompts): [prompt-architecture.md](file:///c:/Development/IRA/docs/prompt-architecture.md)
- System diagrams (current runtime, target multi-agent, Git workflow): [project-overview.md](file:///c:/Development/IRA/docs/project-overview.md)

## Local Testing Setup
1. Copy `.env.example` to `.env`
2. Set a valid Google AI Studio key in `.env` if you want to test Gemini Live voice flows
3. Install workspace dependencies:

```bash
npm ci
python -m venv .venv
.venv\\Scripts\\activate
pip install -r services/orchestrator/requirements.txt
```

4. Start infrastructure services:

```bash
docker compose up -d chroma otel-collector prometheus grafana
```

5. Run the orchestrator locally:

```bash
npm run dev:orchestrator
```

6. Run the frontend apps locally in separate terminals:

```bash
npm run dev:admin
npm run dev:web-chat
npm run dev:voice-console
```

## Local URLs
- Admin portal: `http://localhost:3000`
- Web chat: `http://localhost:3001`
- Voice console: `http://localhost:3002`
- Orchestrator API: `http://localhost:8000`
- Health check: `http://localhost:8000/api/health`
- Readiness check: `http://localhost:8000/api/ready`
- Grafana: `http://localhost:3003`

## Test Credentials
- Admin username: `admin`
- Admin password: `change-me`

## Frontend Environment
- Each Vite app expects `VITE_IRA_API_BASE_URL`
- For local host-based development, use `http://localhost:8000`

## Docker Option
- To run the whole stack in Docker, use:

```bash
docker compose up --build
```

## What Exists Today
- Admin portal provisions per-website IDs and RAG collections, and supports document seed/query/list/delete.
- Orchestrator returns a route plan (`text_chat` or `voice_processing`) plus a composed system prompt for inspection.
- Voice console connects to a backend WebSocket proxy for Gemini Live sessions; the browser streams microphone audio without exposing the Google API key.

## What Is Planned
- A broader multi-agent runtime (router + voice + text + crawler + RAG management + auth + observability agents) per [plan.md](file:///c:/Development/IRA/plan.md#L82-L145).
- Admin-driven website crawling + chunking + incremental RAG updates, plus conversation monitoring and observability dashboards.
