import json
from typing import Any

from fastapi import WebSocket
from websockets.asyncio.client import connect as websocket_connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

from app.core.config import Settings
from app.repositories.chroma import ChromaRepository
from app.schemas.live import LiveConfigResponse
from app.services.prompts import PromptContext, build_prompt_blueprint


class LiveProxyService:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._rag_repository = ChromaRepository(settings)

    def build_config(self, model: str | None = None) -> LiveConfigResponse:
        if not self._settings.google_runtime.api_key_configured:
            return LiveConfigResponse(
                status="unavailable",
                websocket_path="/api/live/ws",
                default_model=model or self._settings.google_runtime.live_model,
                api_mode="backend_proxy",
                input_audio_mime_type="audio/pcm;rate=16000",
                output_mode="text",
                reason="GOOGLE_API_KEY is not configured for Gemini Live.",
            )

        return LiveConfigResponse(
            status="available",
            websocket_path="/api/live/ws",
            default_model=model or self._settings.google_runtime.live_model,
            api_mode="backend_proxy",
            input_audio_mime_type="audio/pcm;rate=16000",
            output_mode="text",
        )

    async def proxy_session(
        self,
        client_socket: WebSocket,
        model: str,
        website_id: str,
        language_hint: str | None = None,
    ) -> None:
        if not self._settings.google_runtime.api_key_configured:
            await client_socket.send_json(
                {
                    "type": "error",
                    "message": "Gemini Live is unavailable because GOOGLE_API_KEY is not configured.",
                }
            )
            await client_socket.close(code=1008)
            return

        ws_url = (
            "wss://generativelanguage.googleapis.com/ws/"
            "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
            f"?key={self._settings.google_api_key}"
        )

        try:
            async with websocket_connect(ws_url, max_size=None) as live_socket:
                await live_socket.send(
                    json.dumps(self._setup_message(model, website_id, language_hint))
                )
                await client_socket.send_json({"type": "status", "state": "connecting"})

                async def client_to_live() -> None:
                    while True:
                        payload = await client_socket.receive_json()
                        message = self._map_client_message(payload)
                        if message is None:
                            continue
                        await live_socket.send(json.dumps(message))

                async def live_to_client() -> None:
                    async for raw_message in live_socket:
                        try:
                            payload = json.loads(raw_message)
                        except json.JSONDecodeError:
                            await client_socket.send_json(
                                {"type": "status", "state": "non_json_server_message"}
                            )
                            continue

                        for event in self._map_server_message(payload):
                            await client_socket.send_json(event)

                try:
                    await _run_bidirectional(client_to_live, live_to_client)
                except ConnectionClosed as exc:
                    await client_socket.send_json(
                        {
                            "type": "error",
                            "message": (
                                "Gemini Live closed the upstream connection "
                                f"(code={exc.code}, reason={exc.reason or 'no reason provided'})."
                            ),
                        }
                    )
                    await client_socket.send_json({"type": "status", "state": "closed"})
        except InvalidStatus as exc:
            await client_socket.send_json(
                {
                    "type": "error",
                    "message": f"Gemini Live rejected the WebSocket upgrade: {exc}",
                }
            )
            await client_socket.close(code=1011)
        except Exception as exc:
            await client_socket.send_json(
                {
                    "type": "error",
                    "message": f"Unexpected Gemini Live proxy error: {exc}",
                }
            )
            await client_socket.close(code=1011)

    def _setup_message(
        self,
        model: str,
        website_id: str,
        language_hint: str | None,
    ) -> dict[str, Any]:
        rag_binding = self._rag_repository.collection_for_website(website_id)
        prompt_blueprint = build_prompt_blueprint(
            PromptContext(
                agent="voice_processing",
                website_id=website_id,
                session_id="live-session",
                message="Start live voice session.",
                model=model,
                rag_collection=rag_binding.collection_name,
                rag_status=rag_binding.status,
                display_name=rag_binding.metadata.get("display_name"),
                website_url=rag_binding.metadata.get("website_url"),
                allowed_domains=tuple(
                    item.strip()
                    for item in rag_binding.metadata.get("allowed_domains", "").split(",")
                    if item.strip()
                ),
                crawl_depth=(
                    int(rag_binding.metadata["crawl_depth"])
                    if rag_binding.metadata.get("crawl_depth", "").isdigit()
                    else None
                ),
                prompt_override=rag_binding.metadata.get("prompt_override") or None,
                language_hint=language_hint,
            )
        )

        return {
            "setup": {
                "model": f"models/{model}",
                "generationConfig": {
                    "responseModalities": ["AUDIO"],
                    "speechConfig": {
                        "voiceConfig": {
                            "prebuiltVoiceConfig": {
                                "voiceName": self._settings.google_runtime.tts_voice.split("-")[-1],
                            }
                        }
                    },
                },
                "systemInstruction": {
                    "parts": [{"text": prompt_blueprint.composed_system_prompt}],
                },
                "inputAudioTranscription": {},
                "outputAudioTranscription": {},
            }
        }

    @staticmethod
    def _map_client_message(payload: dict[str, Any]) -> dict[str, Any] | None:
        message_type = payload.get("type")
        if message_type == "text":
            text = payload.get("text")
            if not isinstance(text, str) or not text.strip():
                return None
            return {
                "clientContent": {
                    "turns": [{"role": "user", "parts": [{"text": text}]}],
                    "turnComplete": True,
                }
            }

        if message_type == "audio_chunk":
            data = payload.get("data")
            mime_type = payload.get("mimeType", "audio/pcm;rate=16000")
            if not isinstance(data, str) or not data:
                return None
            return {
                "realtimeInput": {
                    "audio": {
                        "data": data,
                        "mimeType": mime_type,
                    }
                }
            }

        if message_type == "audio_end":
            return {"realtimeInput": {"audioStreamEnd": True}}

        return None

    @staticmethod
    def _map_server_message(payload: dict[str, Any]) -> list[dict[str, Any]]:
        events: list[dict[str, Any]] = []
        if "setupComplete" in payload:
            events.append({"type": "ready"})

        server_content = payload.get("serverContent")
        if isinstance(server_content, dict):
            input_transcription = server_content.get("inputTranscription")
            if isinstance(input_transcription, dict) and isinstance(
                input_transcription.get("text"), str
            ):
                events.append(
                    {
                        "type": "input_transcript",
                        "text": input_transcription["text"],
                    }
                )

            output_transcription = server_content.get("outputTranscription")
            if isinstance(output_transcription, dict) and isinstance(
                output_transcription.get("text"), str
            ):
                events.append(
                    {
                        "type": "output_transcript",
                        "text": output_transcription["text"],
                    }
                )

            model_turn = server_content.get("modelTurn")
            if isinstance(model_turn, dict):
                parts = model_turn.get("parts")
                if isinstance(parts, list):
                    text_parts = [
                        part["text"]
                        for part in parts
                        if isinstance(part, dict) and isinstance(part.get("text"), str)
                    ]
                    if text_parts:
                        events.append({"type": "model_text", "text": "".join(text_parts)})

                    for part in parts:
                        if isinstance(part, dict) and "inlineData" in part:
                            inline_data = part["inlineData"]
                            if isinstance(inline_data, dict) and "data" in inline_data:
                                events.append(
                                    {
                                        "type": "audio_chunk",
                                        "data": inline_data["data"],
                                        "mimeType": inline_data.get("mimeType", "audio/pcm;rate=24000"),
                                    }
                                )

            if server_content.get("turnComplete") is True:
                events.append({"type": "turn_complete"})
            if server_content.get("interrupted") is True:
                events.append({"type": "interrupted"})

        go_away = payload.get("goAway")
        if isinstance(go_away, dict):
            events.append({"type": "goaway", "payload": go_away})

        usage = payload.get("usageMetadata")
        if isinstance(usage, dict):
            events.append({"type": "usage", "payload": usage})

        return events


async def _run_bidirectional(client_to_live, live_to_client) -> None:
    import asyncio

    client_task = asyncio.create_task(client_to_live())
    live_task = asyncio.create_task(live_to_client())
    done, pending = await asyncio.wait(
        {client_task, live_task},
        return_when=asyncio.FIRST_EXCEPTION,
    )
    for task in pending:
        task.cancel()
    for task in done:
        exception = task.exception()
        if exception is not None:
            raise exception
