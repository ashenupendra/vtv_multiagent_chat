from typing import Literal

from pydantic import BaseModel, Field

from app.schemas.orchestration import CitationRecord


class LiveConfigResponse(BaseModel):
    status: Literal["available", "unavailable"]
    websocket_path: str
    default_model: str
    api_mode: Literal["backend_proxy"]
    input_audio_mime_type: str
    output_mode: Literal["text"]
    reason: str | None = None


class GroundingMatchResponse(BaseModel):
    id: str
    document: str
    metadata: dict[str, str] = Field(default_factory=dict)


class GroundingHistoryEntryResponse(BaseModel):
    type: Literal["grounding"]
    source: str
    query: str
    turn_id: str
    recorded_at: str
    website_id: str
    session_id: str
    matches: list[GroundingMatchResponse] = Field(default_factory=list)
    citations: list[CitationRecord] = Field(default_factory=list)


class GroundingHistoryResponse(BaseModel):
    status: Literal["loaded"]
    website_id: str
    session_id: str | None = None
    entries: list[GroundingHistoryEntryResponse] = Field(default_factory=list)
