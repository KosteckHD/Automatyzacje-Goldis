FROM python:3.12.9-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONPATH=/app/src

RUN groupadd --system --gid 10001 goldis \
    && useradd --system --uid 10001 --gid goldis --home-dir /app --shell /usr/sbin/nologin goldis

WORKDIR /app
COPY services/commission-engine/requirements.lock ./requirements.lock
RUN python -m pip install --no-cache-dir -r requirements.lock
COPY services/commission-engine/src ./src

USER 10001:10001
EXPOSE 8000
CMD ["uvicorn", "goldis_commissions.transport.app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
