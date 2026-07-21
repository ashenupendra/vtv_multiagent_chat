from pydantic import BaseModel, Field


class LoginRequest(BaseModel):
    username: str = Field(min_length=1)
    password: str = Field(min_length=1)


class LoginResponse(BaseModel):
    status: str
    access_token: str
    token_type: str = "bearer"
    username: str
    expires_in: int


class SessionResponse(BaseModel):
    status: str
    username: str
