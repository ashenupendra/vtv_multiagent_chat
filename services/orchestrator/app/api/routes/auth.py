from fastapi import APIRouter, Depends

from app.api.deps import get_auth_service, get_current_admin_session
from app.schemas.auth import LoginRequest, LoginResponse, SessionResponse
from app.services.auth import AdminSession, AuthService

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=LoginResponse)
def login(
    request: LoginRequest,
    auth_service: AuthService = Depends(get_auth_service),
) -> LoginResponse:
    session = auth_service.login(request.username, request.password)
    return LoginResponse(
        status="authenticated",
        access_token=session.token,
        username=session.username,
        expires_in=auth_service.token_ttl_seconds,
    )


@router.get("/session", response_model=SessionResponse)
def get_session(
    session: AdminSession = Depends(get_current_admin_session),
) -> SessionResponse:
    return SessionResponse(status="active", username=session.username)
