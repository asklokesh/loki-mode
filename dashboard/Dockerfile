# Loki Mode Dashboard - Docker Image
# Python backend with the repository-tracked/npm-shipped static frontend
#
# Build:
#   docker build -f dashboard/Dockerfile -t loki-dashboard .
#
# Run:
#   docker run -p 57374:57374 -v ~/.loki:/home/appuser/.loki loki-dashboard
#
# Enterprise mode:
#   docker run -p 57374:57374 \
#     -e LOKI_ENTERPRISE_AUTH=true \
#     -e LOKI_ENTERPRISE_AUDIT=true \
#     -v ~/.loki:/home/appuser/.loki \
#     loki-dashboard

FROM python:3.11-slim-bookworm

# Set labels
LABEL org.opencontainers.image.title="Loki Mode Dashboard"
LABEL org.opencontainers.image.description="Multi-project task management dashboard for Loki Mode"
LABEL org.opencontainers.image.source="https://github.com/asklokesh/loki-mode"

# Environment
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
ENV LOKI_DASHBOARD_HOST=0.0.0.0
ENV LOKI_DASHBOARD_PORT=57374
ENV LOKI_DATA_DIR=/home/appuser/.loki

# Create non-root user for security
RUN useradd --create-home --shell /bin/bash appuser

WORKDIR /app

# Install Python dependencies
COPY dashboard/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy the complete backend package.  dashboard.server imports several sibling
# modules at import time, and some route modules import further siblings.  A
# hand-maintained filename list drifted from that graph (and even named the
# removed secrets.py), producing an image whose configured ASGI app could not
# import.  Keeping every tracked package module in custody makes the standalone
# image layout match the package we test and ship.
COPY dashboard/*.py ./dashboard/

# dashboard.build_supervisor imports the shared deadline runner at module load.
# Keep this one proven external dependency in its real package path rather than
# stubbing or duplicating it inside the dashboard package.
COPY autonomy/lib/deadline.py ./autonomy/lib/

# Copy the same repository-tracked static frontend shipped by the npm package.
# This standalone image is therefore deterministic and does not depend on the
# separate legacy frontend source tree or a registry-backed build at image time.
COPY dashboard/static/ ./dashboard/static/

# Create data directories with correct ownership
RUN mkdir -p /home/appuser/.loki/dashboard/audit && \
    chown -R appuser:appuser /home/appuser/.loki && \
    chown -R appuser:appuser /app

# Switch to non-root user
USER appuser

# Set HOME for the app user
ENV HOME=/home/appuser

# Health check using Python (curl not available in slim image)
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:57374/health')" || exit 1

# Expose port
EXPOSE 57374

# Run server with correct module path
CMD ["python", "-m", "uvicorn", "dashboard.server:app", "--host", "0.0.0.0", "--port", "57374"]
