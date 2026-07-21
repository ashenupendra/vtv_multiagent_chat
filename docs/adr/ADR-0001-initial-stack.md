# ADR-0001: Initial Implementation Stack

## Status
Accepted

## Decision
Use FastAPI for the initial backend service implementation and npm workspaces for the initial monorepo bootstrap.

## Rationale
- FastAPI fits the Python AI ecosystem and works well for orchestration, RAG, and observability services.
- Node is available locally, and npm workspaces are sufficient for the first scaffold.
- This keeps the initial setup simple while preserving room for future tooling changes.
