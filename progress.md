# IRA Project Progress

## Status
- Phase: Phase 1 foundation and scaffolding
- Overall state: In progress
- Last updated: 2026-07-20

## Detailed Implementation Plan
### Implementation approach
- Start with a code-first monorepo using `FastAPI` for backend services and `React + TypeScript` for frontend applications
- Use `npm` workspaces initially for portability because `Node.js` is available locally and `pnpm` is not currently installed
- Build the first working slice around repository scaffolding, configuration management, local Docker support, and an initial orchestrator service

### Phase 1 execution breakdown
- Repository foundation:
  - Create the monorepo folder structure from `plan.md`
  - Add root workspace configuration, environment template, git ignore rules, and a repository README
  - Add `docker-compose.yml` for local development services
- Backend foundation:
  - Create `services/orchestrator` as the first FastAPI service
  - Implement a health endpoint and configuration loading from environment variables
  - Prepare the service layout so additional agents can be added without restructuring
- Frontend placeholders:
  - Create application folders for `admin-portal`, `web-chat`, and `voice-console`
  - Add minimal package manifests and README placeholders so the monorepo structure is executable and understandable
- Infrastructure baseline:
  - Add Dockerfiles and local compose definitions for the orchestrator and the vector store
  - Define initial environment variables for Google API access, model selection, RAG, auth, and observability
- Documentation and continuity:
  - Keep `progress.md` updated with work completed, decisions, and immediate next steps
  - Use the repository structure and root docs as the coding agent memory baseline for subsequent development sessions

### Initial development sequence
1. Scaffold repository structure and root configuration
2. Implement the orchestrator service baseline
3. Add local Docker support for the orchestrator and Chroma
4. Add frontend app placeholders and shared package placeholders
5. Validate the initial scaffold and record progress

## Recent Progress
- Reviewed `plan.md` against current public guidance for Google low-latency voice and multilingual conversation capabilities
- Updated the plan to use `Gemini Live API` as the primary real-time voice runtime, with `Chirp 3 Transcription` and `Chirp 3 HD voices` as complementary speech services
- Added real-time session runtime requirements for streaming sessions, barge-in, transcript handling, tool use, and fallback behavior
- Expanded the RAG section to include hybrid retrieval, reranking, citations, per-site namespace provisioning, and admin-driven auto-configuration
- Added admin onboarding and auto-provisioning requirements so website setup creates crawl, RAG, agent, and observability resources automatically
- Expanded observability requirements for conversations, token usage, latency, retrieval traces, and safe reasoning summaries
- Added industry-standard monorepo folder structure and clean-code engineering standards to the plan
- Chose `FastAPI` as the initial backend direction for the first implementation slice
- Chose `npm` workspaces for the initial monorepo bootstrap because it is available in the local environment
- Created the initial repository scaffold with root workspace files, Docker Compose, environment template, and ADR documentation
- Implemented the first `services/orchestrator` FastAPI service with configuration loading, root endpoint, health endpoint, and readiness endpoint
- Added initial backend tests and verified the service scaffold with `2` passing tests
- Expanded orchestrator configuration into structured Google runtime, RAG, auth, observability, and CORS settings
- Implemented orchestration contracts for conversation routing and website onboarding, plus placeholder agent planning and a Chroma repository abstraction
- Added API endpoints for routing requests and admin website provisioning
- Scaffolded the `admin-portal` Vite + React app with the first onboarding screen wired to the provisioning endpoint
- Installed Node workspace dependencies and verified the admin portal production build
- Verified the expanded backend test suite with `4` passing tests
- Added basic admin authentication and in-memory session handling, and protected website provisioning behind authenticated admin access
- Created a shared workspace API client in `packages/agents-sdk` so frontend apps use common request contracts
- Updated the admin portal to use the shared client and local admin login flow instead of a hard-coded raw fetch call
- Scaffolded the `web-chat` Vite + React app with environment-aware API usage and orchestration route preview
- Verified the updated backend test suite with `6` passing tests
- Verified production builds for both `admin-portal` and `web-chat`
- Replaced the temporary in-memory admin session store with signed token handling and configurable token lifetime settings
- Upgraded the Chroma repository abstraction to use Chroma HTTP collection APIs with an offline stub fallback for local development without a running vector store
- Added a shared UI primitives package in `packages/ui` and adopted it across `admin-portal`, `web-chat`, and `voice-console`
- Scaffolded the `voice-console` Vite + React app with environment-aware API configuration and voice routing placeholders
- Expanded local Docker assets with OpenTelemetry Collector, Prometheus, and Grafana provisioning files and Compose services
- Verified production builds for `admin-portal`, `web-chat`, and `voice-console`
- Added website document upsert and query flows to the orchestrator backend with Chroma-backed lifecycle handling and offline stub search behavior
- Replaced the admin portal auto-login flow with an explicit login form and persisted browser session validation
- Extended the admin portal with knowledge-base seed and query workflows on top of the shared API client
- Upgraded the `voice-console` scaffold to manage microphone permission, audio capture state, transcript timeline, and transcript routing requests
- Added Google embedding generation (with deterministic local stub fallback) and switched RAG document upsert/query paths to use Chroma vector search when available
- Added OpenTelemetry tracing instrumentation for FastAPI and outbound HTTP calls, exporting spans via OTLP when an exporter endpoint is available
- Added frontend Dockerfiles for `admin-portal`, `web-chat`, and `voice-console` plus Docker Compose services for containerized static hosting
- Added a backend Gemini Live WebSocket proxy and connected `voice-console` to real live text/audio session handling with streamed PCM microphone input
- Added document listing and delete APIs plus admin portal corpus browsing, cleanup actions, and route testing controls
- Hardened website ID generation with stable hashed suffixes and updated tests for deterministic slugs
- Added missing backend `websockets` runtime dependency and refreshed local testing documentation and per-app env examples
- Verified the expanded backend test suite with `9` passing tests
- Re-verified production builds for `admin-portal`, `web-chat`, and `voice-console`
- Added a first-class prompt architecture with shared router/agent/grounding/website prompt composition and refactored route/live flows to consume it
- Injected website metadata and `prompt_override` into runtime prompt construction for text and voice agent paths
- Exposed prompt context fields in orchestration route responses and surfaced prompt visibility in admin and web chat route testers
- Verified the expanded backend test suite with `10` passing tests

## Current Decisions
- Architecture approach: Code-first, clean modular services, framework-assisted where useful
- Primary voice runtime: Google Gemini Live API
- Speech services: Chirp 3 Transcription and Chirp 3 HD voices
- Primary text model: Configurable low-latency Google Gemini text model
- Initial backend implementation: FastAPI
- Initial monorepo tooling: npm workspaces
- Local development: Full stack runs in local Docker / Docker Compose
- Observability baseline: OpenTelemetry, Prometheus, Grafana, Tempo or Jaeger, and structured logs
- First implemented backend service: `services/orchestrator`
- First implemented frontend app: `apps/admin-portal`
- Shared frontend API package: `packages/agents-sdk`
- Shared frontend UI package: `packages/ui`
- Second implemented frontend app: `apps/web-chat`
- Third implemented frontend app: `apps/voice-console`

## Next Steps
- Add streamed assistant audio playback and richer session controls on top of the current backend-proxied Gemini Live text/audio transport
- Add richer admin knowledge-base tooling for batch ingestion, crawl imports, and source management
- Add focused frontend tests for admin and voice user journeys on top of the now-expanded test surface

## Notes
- `progress.md` should be updated whenever major planning, architecture, or implementation milestones are completed
- Keep entries concise and decision-oriented so the file remains useful as a running project log
- Verified locally: `python -m pytest services/orchestrator/tests`
- Ran: `npm install`
- Verified locally: `npm run build:admin`
- Verified locally: `npm run build:web-chat`
- Verified locally: `npm run build:voice-console`
