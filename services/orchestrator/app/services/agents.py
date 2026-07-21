from dataclasses import dataclass
from typing import Literal, Protocol

from app.services.prompts import PromptBlueprint


@dataclass(frozen=True)
class AgentContext:
    website_id: str
    session_id: str
    message: str
    language_hint: str | None = None


@dataclass(frozen=True)
class AgentPlan:
    agent_name: Literal["text_chat", "voice_processing"]
    default_model: str
    fallback_message: str
    prompt_blueprint: PromptBlueprint


class Agent(Protocol):
    def build_plan(self, context: AgentContext, prompt_blueprint: PromptBlueprint) -> AgentPlan:
        """Prepare the initial routing decision for a request."""


class TextChatAgent:
    def __init__(self, default_model: str) -> None:
        self.default_model = default_model

    def build_plan(self, context: AgentContext, prompt_blueprint: PromptBlueprint) -> AgentPlan:
        return AgentPlan(
            agent_name="text_chat",
            default_model=self.default_model,
            fallback_message=(
                "I can answer only from the configured knowledge base for this website."
            ),
            prompt_blueprint=prompt_blueprint,
        )


class VoiceProcessingAgent:
    def __init__(self, default_model: str) -> None:
        self.default_model = default_model

    def build_plan(self, context: AgentContext, prompt_blueprint: PromptBlueprint) -> AgentPlan:
        return AgentPlan(
            agent_name="voice_processing",
            default_model=self.default_model,
            fallback_message=(
                "Voice mode is active. I will stay grounded in the configured website knowledge base."
            ),
            prompt_blueprint=prompt_blueprint,
        )
