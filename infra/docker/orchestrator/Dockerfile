FROM python:3.13-slim

WORKDIR /app

COPY services/orchestrator/requirements.txt /tmp/requirements.txt
RUN apt-get update \
    && apt-get install -y --no-install-recommends wget gnupg \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir -r /tmp/requirements.txt \
    && python -m playwright install --with-deps chromium

COPY services/orchestrator /app/services/orchestrator

EXPOSE 8000

CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--app-dir", "/app/services/orchestrator"]
