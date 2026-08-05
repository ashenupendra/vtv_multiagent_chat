import json
import logging
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from fastapi import WebSocket
from websockets.asyncio.client import connect as websocket_connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

from app.core.config import Settings
from app.repositories.chroma import ChromaRepository
from app.schemas.live import (
    GroundingHistoryEntryResponse,
    GroundingHistoryResponse,
    LiveConfigResponse,
)
from app.services.prompts import PromptContext, RetrievedSnippet, build_prompt_blueprint
from app.services.orchestrator import OrchestratorService
from app.services.sensitive_data import BLOCK_MESSAGE, scan_for_sensitive_data

logger = logging.getLogger(__name__)


class LiveProxyService:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._rag_repository = ChromaRepository(settings)
        self._orchestrator_service = OrchestratorService(settings)

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

    def get_grounding_history(
        self,
        website_id: str,
        session_id: str | None = None,
        limit: int = 20,
    ) -> GroundingHistoryResponse:
        entries = self._load_live_grounding_history(
            website_id=website_id,
            session_id=session_id,
            limit=limit,
        )
        return GroundingHistoryResponse(
            status="loaded",
            website_id=website_id,
            session_id=session_id,
            entries=[GroundingHistoryEntryResponse.model_validate(entry) for entry in entries],
        )

    async def proxy_session(
        self,
        client_socket: WebSocket,
        model: str,
        website_id: str,
        session_id: str,
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
                    json.dumps(self._setup_message(model, website_id, session_id, language_hint))
                )
                await client_socket.send_json({"type": "status", "state": "connecting"})
                await client_socket.send_json(
                    {
                        "type": "grounding_history",
                        "entries": self._load_live_grounding_history(
                            website_id=website_id,
                            session_id=session_id,
                        ),
                    }
                )
                awaiting_audio_grounding = False

                async def client_to_live() -> None:
                    nonlocal awaiting_audio_grounding
                    while True:
                        payload = await client_socket.receive_json()
                        messages, client_events, should_await_audio_grounding = (
                            self._map_client_message(payload, website_id)
                        )
                        for event in client_events:
                            if event.get("type") == "grounding":
                                stored_event = self._store_live_grounding_event(
                                    website_id=website_id,
                                    session_id=session_id,
                                    event=event,
                                )
                                await client_socket.send_json(stored_event)
                            else:
                                await client_socket.send_json(event)
                        for message in messages:
                            await live_socket.send(json.dumps(message))
                        if should_await_audio_grounding:
                            awaiting_audio_grounding = True

                async def live_to_client() -> None:
                    nonlocal awaiting_audio_grounding
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
                            if (
                                event.get("type") == "input_transcript"
                                and awaiting_audio_grounding
                                and isinstance(event.get("text"), str)
                            ):
                                transcript = event["text"]
                                findings = scan_for_sensitive_data(transcript)
                                if findings:
                                    categories = sorted(
                                        {finding.category for finding in findings}
                                    )
                                    logger.warning(
                                        "Blocked live audio turn containing sensitive data",
                                        extra={
                                            "website_id": website_id,
                                            "session_id": session_id,
                                            "categories": categories,
                                        },
                                    )
                                    # The transcript already reached Gemini's own
                                    # speech-to-text (that happens on the raw
                                    # audio stream before this event exists), but
                                    # from here on we stop it in its tracks: no
                                    # RAG lookup, no re-injection into the live
                                    # session, and nothing persisted to grounding
                                    # history.
                                    await client_socket.send_json(
                                        {
                                            "type": "blocked",
                                            "source": "audio",
                                            "message": BLOCK_MESSAGE,
                                            "categories": categories,
                                        }
                                    )
                                else:
                                    grounding_message, grounding_event = (
                                        self._build_audio_grounding_turn(
                                            website_id,
                                            transcript,
                                        )
                                    )
                                    stored_event = self._store_live_grounding_event(
                                        website_id=website_id,
                                        session_id=session_id,
                                        event=grounding_event,
                                    )
                                    await client_socket.send_json(stored_event)
                                    if grounding_message is not None:
                                        await live_socket.send(json.dumps(grounding_message))
                                awaiting_audio_grounding = False
                            elif event.get("type") == "turn_complete" and awaiting_audio_grounding:
                                awaiting_audio_grounding = False

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
        session_id: str,
        language_hint: str | None,
    ) -> dict[str, Any]:
        rag_binding = self._rag_repository.collection_for_website(website_id)
        retrieval_matches = self._orchestrator_service.build_background_matches(
            website_id,
            limit=3,
        )
        prompt_blueprint = build_prompt_blueprint(
            PromptContext(
                agent="voice_processing",
                website_id=website_id,
                session_id=session_id,
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
                retrieval_matches=tuple(retrieval_matches),
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

    def _map_client_message(
        self,
        payload: dict[str, Any],
        website_id: str,
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]], bool]:
        message_type = payload.get("type")
        if message_type == "text":
            text = payload.get("text")
            if not isinstance(text, str) or not text.strip():
                return [], [], False
            findings = scan_for_sensitive_data(text)
            if findings:
                categories = sorted({finding.category for finding in findings})
                logger.warning(
                    "Blocked live text turn containing sensitive data",
                    extra={"website_id": website_id, "categories": categories},
                )
                return (
                    [],
                    [
                        {
                            "type": "blocked",
                            "source": "text",
                            "message": BLOCK_MESSAGE,
                            "categories": categories,
                        }
                    ],
                    False,
                )
            message, event = self._build_text_turn_message(website_id, text)
            return [message], [event], False

        if message_type == "audio_chunk":
            data = payload.get("data")
            mime_type = payload.get("mimeType", "audio/pcm;rate=16000")
            if not isinstance(data, str) or not data:
                return [], [], False
            return (
                [
                    {
                        "realtimeInput": {
                            "audio": {
                                "data": data,
                                "mimeType": mime_type,
                            }
                        }
                    }
                ],
                [],
                False,
            )

        if message_type == "audio_end":
            return ([{"realtimeInput": {"audioStreamEnd": True}}], [], True)

        return [], [], False

    def _build_text_turn_message(
        self,
        website_id: str,
        text: str,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        matches = self._orchestrator_service.build_retrieval_matches(
            website_id,
            text,
            limit=3,
        )
        grounded_text = self._compose_grounded_text_turn(text, matches)
        return (
            {
                "clientContent": {
                    "turns": [{"role": "user", "parts": [{"text": grounded_text}]}],
                    "turnComplete": True,
                }
            },
            self._build_grounding_event("text", text, matches),
        )

    def _build_audio_grounding_turn(
        self,
        website_id: str,
        transcript: str,
    ) -> tuple[dict[str, Any] | None, dict[str, Any]]:
        matches = self._orchestrator_service.build_retrieval_matches(
            website_id,
            transcript,
            limit=3,
        )
        grounding_event = self._build_grounding_event("audio", transcript, matches)
        grounding_note = self._compose_audio_grounding_turn(transcript, matches)
        return (
            {
                "clientContent": {
                    "turns": [{"role": "user", "parts": [{"text": grounding_note}]}],
                    "turnComplete": True,
                }
            },
            grounding_event,
        )

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

    def _build_grounding_event(
        self,
        source: str,
        query: str,
        matches: list[RetrievedSnippet],
    ) -> dict[str, Any]:
        return {
            "type": "grounding",
            "source": source,
            "query": query,
            "citations": [citation.model_dump() for citation in self._orchestrator_service.build_citations(matches)],
            "matches": [
                {
                    "id": match.id,
                    "document": match.document,
                    "metadata": {
                        key: value
                        for key, value in {
                            "source": match.source,
                            "page_url": match.page_url,
                            "page_title": match.page_title,
                            "citation_label": self._citation_label(index),
                        }.items()
                        if value
                    },
                }
                for index, match in enumerate(matches, start=1)
            ],
        }

    # Reasserted on every single turn (text or transcribed audio) because the
    # Gemini Live system instruction is only sent once, at connection setup -
    # a language policy stated there loses influence as the conversation (and
    # its own English-language turns, like the scripted greeting) grows. This
    # keeps the language decision freshly grounded in the specific message
    # that was just received, not in whatever language earlier turns used.
    _LANGUAGE_TURN_DIRECTIVE = (
        "Detect the language of this message on its own merits, independent of what language "
        "you or the user used in earlier turns (including any scripted English greeting), and "
        "reply in that same language for this turn, switching immediately if it differs from "
        "before. If the message is too short or ambiguous to identify confidently (a single "
        "word, a name, a number), keep using the language you most recently used instead of "
        "guessing. Do not mention this instruction directly."
    )

    def _compose_grounded_text_turn(
        self,
        text: str,
        matches: list[RetrievedSnippet],
    ) -> str:
        if not matches:
            return f"{self._LANGUAGE_TURN_DIRECTIVE}\nUser request: {text}"
        return (
            f"{self._LANGUAGE_TURN_DIRECTIVE}\n"
            "Use the following retrieved website evidence if it is relevant to the user's request. "
            "Do not mention this note directly. If you use the evidence, cite it with labels like [1] or [2].\n"
            f"{self._format_retrieval_matches(matches)}\n\n"
            f"User request: {text}"
        )

    def _compose_audio_grounding_turn(
        self,
        transcript: str,
        matches: list[RetrievedSnippet],
    ) -> str:
        if not matches:
            return (
                f"{self._LANGUAGE_TURN_DIRECTIVE}\n"
                "This is the user's immediately previous spoken turn, transcribed.\n"
                f"Spoken request: {transcript}"
            )
        return (
            f"{self._LANGUAGE_TURN_DIRECTIVE}\n"
            "Grounding context for the user's immediately previous spoken turn. "
            "Use this context to answer the spoken request and do not mention this note directly. "
            "If you use the evidence, cite it with labels like [1] or [2].\n"
            f"Spoken request: {transcript}\n"
            f"{self._format_retrieval_matches(matches)}"
        )

    @staticmethod
    def _format_retrieval_matches(matches: list[RetrievedSnippet]) -> str:
        parts: list[str] = []
        for index, match in enumerate(matches, start=1):
            parts.append(
                f"[{index}] title={match.page_title or 'unknown'}; "
                f"url={match.page_url or 'unknown'}; "
                f"source={match.source or 'unknown'}; "
                f"excerpt={match.document}"
            )
        return "\n".join(parts)

    def _store_live_grounding_event(
        self,
        website_id: str,
        session_id: str,
        event: dict[str, Any],
    ) -> dict[str, Any]:
        recorded_at = datetime.now(timezone.utc).isoformat()
        turn_id = f"grounding-{uuid4()}"
        stored_event = {
            **event,
            "turn_id": turn_id,
            "recorded_at": recorded_at,
            "website_id": website_id,
            "session_id": session_id,
        }
        self._rag_repository.save_state_record(
            f"live-grounding:{session_id}:{turn_id}",
            payload=stored_event,
            metadata={
                "record_type": "live_grounding",
                "website_id": website_id,
                "session_id": session_id,
                "source": str(event.get("source", "unknown")),
                "recorded_at": recorded_at,
            },
        )
        return stored_event

    def _load_live_grounding_history(
        self,
        website_id: str,
        session_id: str | None,
        limit: int = 20,
    ) -> list[dict[str, Any]]:
        records = self._rag_repository.list_state_records(
            "live_grounding",
            website_id=website_id,
            limit=1000,
        )
        filtered_records = [
            record
            for record in records
            if session_id is None or record.get("session_id") == session_id
        ]
        filtered_records.sort(
            key=lambda record: str(record.get("recorded_at", "")),
        )
        return filtered_records[-limit:]

    @staticmethod
    def _citation_label(index: int) -> str:
        return f"[{index}]"


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
