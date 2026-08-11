from functools import lru_cache

from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class GoogleRuntimeSettings(BaseModel):
    api_key_configured: bool
    text_model: str
    live_model: str
    embedding_model: str
    embedding_dimensions: int
    tts_voice: str
    stt_model: str


class RAGSettings(BaseModel):
    provider: str
    host: str
    port: int
    collection_prefix: str
    tenant: str
    database: str
    use_ssl: bool
    allow_stub_fallback: bool


class AuthSettings(BaseModel):
    default_username: str
    default_password_configured: bool
    token_ttl_seconds: int
    token_issuer: str


class ObservabilitySettings(BaseModel):
    otel_endpoint: str
    service_name: str


class TelegramSettings(BaseModel):
    bot_token_configured: bool
    webhook_secret_configured: bool
    website_id: str


class WhatsAppSettings(BaseModel):
    auth_token_configured: bool
    account_sid_configured: bool
    website_id: str


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_name: str = "IRA Orchestrator"
    environment: str = Field(default="local", alias="IRA_ENV")
    log_level: str = Field(default="INFO", alias="IRA_LOG_LEVEL")
    cors_origins_raw: str = Field(
        default="http://localhost:3000,http://localhost:3001,http://localhost:3002",
        alias="IRA_CORS_ORIGINS",
    )
    default_agent_name: str = Field(default="ira-default", alias="IRA_DEFAULT_AGENT_NAME")
    google_api_key: str = Field(default="", alias="GOOGLE_API_KEY")
    google_text_model: str = Field(default="gemini-3.5-flash", alias="GOOGLE_TEXT_MODEL")
    google_live_model: str = Field(
        default="gemini-live-2.5-flash-preview",
        alias="GOOGLE_LIVE_MODEL",
    )
    google_embedding_model: str = Field(
        default="gemini-embedding-2",
        alias="GOOGLE_EMBEDDING_MODEL",
    )
    google_embedding_dimensions: int = Field(
        default=768,
        alias="GOOGLE_EMBEDDING_DIMENSIONS",
    )
    google_tts_voice: str = Field(default="en-US-Chirp3-HD-Kore", alias="GOOGLE_TTS_VOICE")
    google_stt_model: str = Field(default="chirp_3", alias="GOOGLE_STT_MODEL")
    rag_provider: str = Field(default="chroma", alias="RAG_PROVIDER")
    chroma_host: str = Field(default="localhost", alias="CHROMA_HOST")
    chroma_port: int = Field(default=8001, alias="CHROMA_PORT")
    chroma_collection_prefix: str = Field(default="ira", alias="CHROMA_COLLECTION_PREFIX")
    chroma_tenant: str = Field(default="default_tenant", alias="CHROMA_TENANT")
    chroma_database: str = Field(default="default_database", alias="CHROMA_DATABASE")
    chroma_use_ssl: bool = Field(default=False, alias="CHROMA_USE_SSL")
    chroma_allow_stub_fallback: bool = Field(default=True, alias="CHROMA_ALLOW_STUB_FALLBACK")
    otel_exporter_otlp_endpoint: str = Field(
        default="http://localhost:4317",
        alias="OTEL_EXPORTER_OTLP_ENDPOINT",
    )
    otel_service_name: str = Field(default="ira-orchestrator", alias="OTEL_SERVICE_NAME")
    admin_default_username: str = Field(default="admin", alias="ADMIN_DEFAULT_USERNAME")
    admin_default_password: str = Field(default="change-me", alias="ADMIN_DEFAULT_PASSWORD")
    admin_token_secret: str = Field(
        default="ira-local-dev-secret",
        alias="ADMIN_TOKEN_SECRET",
    )
    admin_token_ttl_seconds: int = Field(default=3600, alias="ADMIN_TOKEN_TTL_SECONDS")
    admin_token_issuer: str = Field(default="ira-orchestrator", alias="ADMIN_TOKEN_ISSUER")
    telegram_bot_token: str = Field(default="", alias="TELEGRAM_BOT_TOKEN")
    telegram_webhook_secret: str = Field(default="", alias="TELEGRAM_WEBHOOK_SECRET")
    telegram_website_id: str = Field(default="", alias="TELEGRAM_WEBSITE_ID")
    twilio_account_sid: str = Field(default="", alias="TWILIO_ACCOUNT_SID")
    twilio_auth_token: str = Field(default="", alias="TWILIO_AUTH_TOKEN")
    whatsapp_website_id: str = Field(default="", alias="WHATSAPP_WEBSITE_ID")
    rate_limit_requests_per_minute: int = Field(
        default=30,
        alias="RATE_LIMIT_REQUESTS_PER_MINUTE",
    )

    @property
    def google_runtime(self) -> GoogleRuntimeSettings:
        return GoogleRuntimeSettings(
            api_key_configured=bool(self.google_api_key),
            text_model=self.google_text_model,
            live_model=self.google_live_model,
            embedding_model=self.google_embedding_model,
            embedding_dimensions=self.google_embedding_dimensions,
            tts_voice=self.google_tts_voice,
            stt_model=self.google_stt_model,
        )

    @property
    def rag(self) -> RAGSettings:
        return RAGSettings(
            provider=self.rag_provider,
            host=self.chroma_host,
            port=self.chroma_port,
            collection_prefix=self.chroma_collection_prefix,
            tenant=self.chroma_tenant,
            database=self.chroma_database,
            use_ssl=self.chroma_use_ssl,
            allow_stub_fallback=self.chroma_allow_stub_fallback,
        )

    @property
    def auth(self) -> AuthSettings:
        return AuthSettings(
            default_username=self.admin_default_username,
            default_password_configured=bool(self.admin_default_password),
            token_ttl_seconds=self.admin_token_ttl_seconds,
            token_issuer=self.admin_token_issuer,
        )

    @property
    def observability(self) -> ObservabilitySettings:
        return ObservabilitySettings(
            otel_endpoint=self.otel_exporter_otlp_endpoint,
            service_name=self.otel_service_name,
        )

    @property
    def cors_origins(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins_raw.split(",") if origin.strip()]

    @property
    def telegram(self) -> TelegramSettings:
        return TelegramSettings(
            bot_token_configured=bool(self.telegram_bot_token),
            webhook_secret_configured=bool(self.telegram_webhook_secret),
            website_id=self.telegram_website_id,
        )

    @property
    def whatsapp(self) -> WhatsAppSettings:
        return WhatsAppSettings(
            auth_token_configured=bool(self.twilio_auth_token),
            account_sid_configured=bool(self.twilio_account_sid),
            website_id=self.whatsapp_website_id,
        )


@lru_cache
def get_settings() -> Settings:
    return Settings()
