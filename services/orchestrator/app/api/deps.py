from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core.config import get_settings
from app.services.auth import AdminSession, AuthService
from app.services.live import LiveProxyService

bearer_scheme = HTTPBearer(auto_error=False)


def get_auth_service() -> AuthService:
    return AuthService(get_settings())


def get_current_admin_session(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
) -> AdminSession:
    return get_auth_service().require_session(credentials)


def get_live_proxy_service() -> LiveProxyService:
    return LiveProxyService(get_settings())
