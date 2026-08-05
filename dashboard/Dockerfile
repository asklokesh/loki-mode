# Loki Mode Dashboard - Docker Image
# Multi-stage build: frontend build + Python backend
#
# Build:
#   docker build -t loki-dashboard ./dashboard
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

# Stage 1: Build frontend
FROM node:22-alpine AS frontend-builder

WORKDIR /app/frontend

# Install dependencies
COPY frontend/package*.json ./
RUN npm ci --ignore-scripts

# Build frontend
COPY frontend/ ./
RUN npm run build

# Stage 2: Python backend with built frontend
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
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend code as a package (dashboard/)
# This preserves the package structure for relative imports
COPY __init__.py database.py models.py server.py registry.py auth.py audit.py secrets.py control.py run.py build_supervisor.py ./dashboard/

# Copy built frontend to static directory inside package
COPY --from=frontend-builder /app/frontend/dist ./dashboard/static

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
