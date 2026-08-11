from dataclasses import dataclass
from typing import Literal


AgentKind = Literal["text_chat", "voice_processing"]


@dataclass(frozen=True)
class RetrievedSnippet:
    id: str
    document: str
    source: str | None = None
    page_url: str | None = None
    page_title: str | None = None


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
    retrieval_matches: tuple[RetrievedSnippet, ...] = ()


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
    language_policy = (
        "Language policy: silently detect the language of every new user message on its own "
        "merits, independent of what language any earlier turn used - including your own "
        "opening greeting. Any scripted greeting you are asked to say is delivered in a fixed "
        "language for branding reasons only and never establishes or locks the conversation's "
        "language; the moment the user's very first reply uses a different language, treat that "
        "as the start of the real conversation and respond in that language from then on, even "
        "though your greeting was in a different language. Reply in the same language the user "
        "just used for every subsequent turn too, and switch immediately whenever the user "
        "switches languages, without being asked and without announcing the switch. Never "
        "translate a reply into a different language than the user just used unless the user "
        "explicitly asks for a translation. Do not default to, or drift back toward, English or "
        "any other single fixed language just because it was used earlier in the conversation. "
        "Only when a message is too short or ambiguous to confidently identify a language (for "
        "example a single word, a name, a number, or an interjection) should you keep using the "
        "language you most recently used, instead of guessing a new one."
    )

    if context.agent == "voice_processing":
        prompt = (
            "You are IRA's live voice support assistant. "
            "Keep replies concise, speak naturally, and optimize for realtime interaction. "
            "Acknowledge interruptions cleanly and stay useful during partial transcripts. "
            f"{language_policy} "
            "When retrieved evidence supports your answer, reference the citation labels like [1] or [2] naturally."
        )
        return prompt

    prompt = (
        "You are IRA's text support assistant. "
        "Provide precise, grounded website support answers with short, scannable wording. "
        "Prefer direct answers first, then brief supporting detail when needed. "
        f"{language_policy} "
        "When retrieved evidence supports your answer, include citation labels like [1] or [2]."
    )
    return prompt


def _build_grounding_prompt(context: PromptContext) -> str:
    prompt = (
        "Stay grounded in the configured website knowledge base and known website metadata. "
        f"RAG collection: {context.rag_collection}. "
        f"RAG status: {context.rag_status or 'unknown'}. "
        "If the knowledge base does not support a claim, say that clearly instead of inventing details. "
        "When citing retrieved evidence, use the numbered labels exactly as provided."
    )
    if context.retrieval_matches:
        prompt += " Retrieved evidence for this turn:"
        for index, match in enumerate(context.retrieval_matches, start=1):
            prompt += (
                f" [{index}] id={match.id};"
                f" source={match.source or 'unknown'};"
                f" page_title={match.page_title or 'unknown'};"
                f" page_url={match.page_url or 'unknown'};"
                f" excerpt={_truncate(match.document)}"
            )
    else:
        prompt += " No retrieved supporting excerpts were found for this turn."
    return prompt


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
    if context.retrieval_matches:
        parts.append(f"Retrieved excerpts available for this turn: {len(context.retrieval_matches)}.")
    else:
        parts.append("No retrieved excerpts are available for this turn.")

    return " ".join(parts)


def _truncate(value: str, limit: int = 280) -> str:
    compact = " ".join(value.split())
    if len(compact) <= limit:
        return compact
    return f"{compact[: limit - 3]}..."
