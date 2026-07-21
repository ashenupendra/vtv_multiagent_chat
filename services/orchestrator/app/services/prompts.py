from dataclasses import dataclass
from typing import Literal


AgentKind = Literal["text_chat", "voice_processing"]


@dataclass(frozen=True)
class PromptContext:
    agent: AgentKind
    website_id: str
    session_id: str
    message: str
    model: str
    rag_collection: str
    rag_status: str | None
    display_name: str | None = None
    website_url: str | None = None
    allowed_domains: tuple[str, ...] = ()
    crawl_depth: int | None = None
    prompt_override: str | None = None
    language_hint: str | None = None


@dataclass(frozen=True)
class PromptBlueprint:
    router_prompt: str
    agent_prompt: str
    grounding_prompt: str
    website_prompt: str
    composed_system_prompt: str
    website_prompt_override_applied: bool


def build_prompt_blueprint(context: PromptContext) -> PromptBlueprint:
    router_prompt = _build_router_prompt(context)
    agent_prompt = _build_agent_prompt(context)
    grounding_prompt = _build_grounding_prompt(context)
    website_prompt = _build_website_prompt(context)

    composed_sections = [
        "ROLE AND ROUTING",
        router_prompt,
        "",
        "AGENT RESPONSIBILITIES",
        agent_prompt,
        "",
        "GROUNDING POLICY",
        grounding_prompt,
        "",
        "WEBSITE CONTEXT",
        website_prompt,
    ]

    return PromptBlueprint(
        router_prompt=router_prompt,
        agent_prompt=agent_prompt,
        grounding_prompt=grounding_prompt,
        website_prompt=website_prompt,
        composed_system_prompt="\n".join(composed_sections).strip(),
        website_prompt_override_applied=bool(context.prompt_override),
    )


def _build_router_prompt(context: PromptContext) -> str:
    return (
        "You are the IRA orchestration layer. Choose and execute the assigned agent mode only. "
        f"Current agent mode: {context.agent}. "
        f"Use model {context.model}. "
        f"Website scope: {context.website_id}. Session scope: {context.session_id}."
    )


def _build_agent_prompt(context: PromptContext) -> str:
    if context.agent == "voice_processing":
        prompt = (
            "You are IRA's live voice support assistant. "
            "Keep replies concise, speak naturally, and optimize for realtime interaction. "
            "Acknowledge interruptions cleanly and stay useful during partial transcripts."
        )
        if context.language_hint:
            prompt += f" Prefer responding in {context.language_hint} when appropriate."
        return prompt

    prompt = (
        "You are IRA's text support assistant. "
        "Provide precise, grounded website support answers with short, scannable wording. "
        "Prefer direct answers first, then brief supporting detail when needed."
    )
    if context.language_hint:
        prompt += f" Prefer responding in {context.language_hint} when appropriate."
    return prompt


def _build_grounding_prompt(context: PromptContext) -> str:
    return (
        "Stay grounded in the configured website knowledge base and known website metadata. "
        f"RAG collection: {context.rag_collection}. "
        f"RAG status: {context.rag_status or 'unknown'}. "
        "If the knowledge base does not support a claim, say that clearly instead of inventing details."
    )


def _build_website_prompt(context: PromptContext) -> str:
    parts = [
        f"Website ID: {context.website_id}.",
        f"Display name: {context.display_name or 'unknown'}.",
        f"Website URL: {context.website_url or 'unknown'}.",
    ]

    if context.allowed_domains:
        parts.append(f"Allowed domains: {', '.join(context.allowed_domains)}.")
    if context.crawl_depth is not None:
        parts.append(f"Configured crawl depth: {context.crawl_depth}.")
    if context.prompt_override:
        parts.append(f"Website-specific prompt override: {context.prompt_override}.")
    else:
        parts.append("No website-specific prompt override is configured.")

    return " ".join(parts)
