{{/*
Expand the name of the chart.
*/}}
{{- define "autonomi.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to
this (by the DNS naming spec). If release name contains chart name it will
be used as a full name.
*/}}
{{- define "autonomi.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "autonomi.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "autonomi.labels" -}}
helm.sh/chart: {{ include "autonomi.chart" . }}
{{ include "autonomi.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "autonomi.selectorLabels" -}}
app.kubernetes.io/name: {{ include "autonomi.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Control plane selector labels
*/}}
{{- define "autonomi.controlplane.selectorLabels" -}}
{{ include "autonomi.selectorLabels" . }}
app.kubernetes.io/component: controlplane
{{- end }}

{{/*
Worker selector labels
*/}}
{{- define "autonomi.worker.selectorLabels" -}}
{{ include "autonomi.selectorLabels" . }}
app.kubernetes.io/component: worker
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "autonomi.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "autonomi.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Return the container image reference
*/}}
{{- define "autonomi.image" -}}
{{- $tag := default .Chart.AppVersion .Values.image.tag -}}
{{- printf "%s:%s" .Values.image.repository $tag }}
{{- end }}

{{/*
Return the secret name to use for API keys
*/}}
{{- define "autonomi.secretName" -}}
{{- if .Values.secrets.existingSecret }}
{{- .Values.secrets.existingSecret }}
{{- else }}
{{- include "autonomi.fullname" . }}
{{- end }}
{{- end }}

{{/*
Worker configuration preflight. Fails the render with an honest message on
mutually-exclusive or unknown worker settings, so a misconfiguration surfaces at
`helm template`/`helm install` time instead of as a silently-broken fleet.
Included once by each worker template; the checks are idempotent, so firing from
multiple templates is harmless (the first failing one stops the render).

  L1: unknown worker.mode -> a typo would otherwise render the control plane but
      no worker workload at all (no Job, no Deployment, no ScaledJob) with no error.
  M1: worker.autoscaling.enabled AND keda.enabled together in deployment mode ->
      a plain HPA and a KEDA-owned HPA would both target the same Deployment and
      fight over spec.replicas. Pick one.
*/}}
{{- define "autonomi.worker.preflight" -}}
{{- if not (has .Values.worker.mode (list "job" "deployment" "serverless")) }}
{{- fail (printf "worker.mode must be one of job|deployment|serverless, got %q" .Values.worker.mode) }}
{{- end }}
{{- if and .Values.worker.autoscaling.enabled .Values.keda.enabled }}
{{- fail "Set only one of worker.autoscaling.enabled or keda.enabled (KEDA manages its own HPA)." }}
{{- end }}
{{- end }}

{{/*
Optional init-container that clones a git repo and seeds the spec into
/workspace before the worker runs. Renders nothing unless
workspace.initClone.enabled is true. Shared by the worker Job and the serverless
ScaledJob so the seeding behavior is identical in both. Credentials are pulled
from the secret via secretKeyRef (never inlined into args); when no
tokenSecretKey is set the clone is unauthenticated (public repos only).
*/}}
{{- define "autonomi.workspace.initContainer" -}}
{{- if .Values.workspace.initClone.enabled }}
- name: workspace-clone
  image: {{ .Values.workspace.initClone.image | quote }}
  imagePullPolicy: {{ .Values.image.pullPolicy }}
  securityContext:
    {{- toYaml .Values.security.containerSecurityContext | nindent 4 }}
  env:
    - name: LOKI_CLONE_REPO
      value: {{ .Values.workspace.initClone.repo | quote }}
    - name: LOKI_CLONE_REF
      value: {{ .Values.workspace.initClone.ref | quote }}
    - name: LOKI_CLONE_SPEC_PATH
      value: {{ .Values.workspace.initClone.specPath | quote }}
    {{- if .Values.workspace.initClone.tokenSecretKey }}
    # Git token sourced from the secret (existingSecret or values-created). The
    # key is optional in the Secret: optional=true keeps the init-container from
    # failing when no token was provided (public-repo clones).
    - name: LOKI_CLONE_TOKEN
      valueFrom:
        secretKeyRef:
          name: {{ include "autonomi.secretName" . }}
          key: {{ .Values.workspace.initClone.tokenSecretKey | quote }}
          optional: true
    {{- end }}
    {{- with .Values.workspace.initClone.extraEnv }}
    {{- toYaml . | nindent 4 }}
    {{- end }}
  command:
    - /bin/sh
    - -ec
    - |
      # Idempotent seed: skip when /workspace already holds a checkout, so a Job
      # retry that re-mounts a populated durable volume resumes instead of failing
      # on a non-empty clone target.
      if [ -e /workspace/.git ]; then
        echo "workspace-clone: /workspace already seeded, skipping"
      else
        if [ -z "$LOKI_CLONE_REPO" ]; then
          echo "workspace-clone: workspace.initClone.repo is required" >&2
          exit 1
        fi
        url="$LOKI_CLONE_REPO"
        # Inject the token into the https URL at runtime (env, not a values arg)
        # so it never appears in the rendered manifest or process args list.
        if [ -n "$LOKI_CLONE_TOKEN" ]; then
          case "$url" in
            https://*) url="https://x-access-token:${LOKI_CLONE_TOKEN}@${url#https://}" ;;
            *) echo "workspace-clone: token set but repo is not https, ignoring token" >&2 ;;
          esac
        fi
        git clone "$url" /workspace
        if [ -n "$LOKI_CLONE_REF" ]; then
          git -C /workspace checkout "$LOKI_CLONE_REF"
        fi
        if [ -n "$LOKI_CLONE_SPEC_PATH" ]; then
          cp "/workspace/${LOKI_CLONE_SPEC_PATH}" /workspace/loki-spec || \
            echo "workspace-clone: specPath ${LOKI_CLONE_SPEC_PATH} not found, continuing" >&2
        fi
      fi
  volumeMounts:
    - name: workspace
      mountPath: /workspace
{{- end }}
{{- end }}
