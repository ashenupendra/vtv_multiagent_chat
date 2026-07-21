from typing import Literal

from pydantic import BaseModel


class LiveConfigResponse(BaseModel):
    status: Literal["available", "unavailable"]
    websocket_path: str
    default_model: str
    api_mode: Literal["backend_proxy"]
    input_audio_mime_type: str
    output_mode: Literal["text"]
    reason: str | None = None
