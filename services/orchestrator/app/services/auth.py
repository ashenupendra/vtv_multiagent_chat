import base64
import hashlib
import hmac
import json
from dataclasses import dataclass
from time import time

from fastapi import HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials

from app.core.config import Settings


@dataclass(frozen=True)
class AdminSession:
    username: str
    token: str


class AuthService:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self.token_ttl_seconds = settings.auth.token_ttl_seconds

    def login(self, username: str, password: str) -> AdminSession:
        if (
            username != self._settings.auth.default_username
            or password != self._settings.admin_default_password
        ):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid admin credentials.",
            )

        return AdminSession(username=username, token=self._issue_token(username))

    def require_session(
        self,
        credentials: HTTPAuthorizationCredentials | None,
    ) -> AdminSession:
        if credentials is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Authentication is required.",
            )

        username = self._verify_token(credentials.credentials)
        return AdminSession(username=username, token=credentials.credentials)

    def _issue_token(self, username: str) -> str:
        header = {"alg": "HS256", "typ": "JWT"}
        payload = {
            "sub": username,
            "iss": self._settings.auth.token_issuer,
            "iat": int(time()),
            "exp": int(time()) + self.token_ttl_seconds,
        }
        encoded_header = self._encode_segment(header)
        encoded_payload = self._encode_segment(payload)
        signing_input = f"{encoded_header}.{encoded_payload}".encode("utf-8")
        signature = hmac.new(
            self._settings.admin_token_secret.encode("utf-8"),
            signing_input,
            hashlib.sha256,
        ).digest()
        encoded_signature = self._encode_bytes(signature)
        return f"{encoded_header}.{encoded_payload}.{encoded_signature}"

    def _verify_token(self, token: str) -> str:
        try:
            encoded_header, encoded_payload, encoded_signature = token.split(".")
        except ValueError as exc:
            raise self._unauthorized("Session is invalid or expired.") from exc

        try:
            signing_input = f"{encoded_header}.{encoded_payload}".encode("utf-8")
            expected_signature = hmac.new(
                self._settings.admin_token_secret.encode("utf-8"),
                signing_input,
                hashlib.sha256,
            ).digest()
            provided_signature = self._decode_bytes(encoded_signature)

            if not hmac.compare_digest(expected_signature, provided_signature):
                raise self._unauthorized("Session is invalid or expired.")

            payload = self._decode_segment(encoded_payload)
        except (ValueError, json.JSONDecodeError) as exc:
            raise self._unauthorized("Session is invalid or expired.") from exc

        if payload.get("iss") != self._settings.auth.token_issuer:
            raise self._unauthorized("Session issuer is invalid.")

        if int(payload.get("exp", 0)) <= int(time()):
            raise self._unauthorized("Session is invalid or expired.")

        username = payload.get("sub")
        if not isinstance(username, str) or not username:
            raise self._unauthorized("Session subject is invalid.")

        return username

    def _unauthorized(self, detail: str) -> HTTPException:
        return HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=detail)

    def _encode_segment(self, payload: dict[str, object]) -> str:
        return self._encode_bytes(
            json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
        )

    def _decode_segment(self, payload: str) -> dict[str, object]:
        return json.loads(self._decode_bytes(payload).decode("utf-8"))

    @staticmethod
    def _encode_bytes(payload: bytes) -> str:
        return base64.urlsafe_b64encode(payload).decode("utf-8").rstrip("=")

    @staticmethod
    def _decode_bytes(payload: str) -> bytes:
        padding = "=" * (-len(payload) % 4)
        return base64.urlsafe_b64decode(f"{payload}{padding}")
