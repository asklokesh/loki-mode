{{- define "loki-mode.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "loki-mode.fullname" -}}
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

{{- define "loki-mode.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "loki-mode.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "loki-mode.selectorLabels" -}}
app.kubernetes.io/name: {{ include "loki-mode.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "loki-mode.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "loki-mode.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "loki-mode.image" -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) }}
{{- end }}

{{/* Name of the Secret holding every credential. Either the one we create or
     one the operator manages out of band. */}}
{{- define "loki-mode.secretName" -}}
{{- if .Values.secrets.existingSecret }}
{{- .Values.secrets.existingSecret }}
{{- else }}
{{- printf "%s-secrets" (include "loki-mode.fullname" .) }}
{{- end }}
{{- end }}

{{/* Redis URL: an explicit queue.url wins, else the in-chart Redis service.
     Must match the Service name in templates/redis.yaml. */}}
{{- define "loki-mode.redisURL" -}}
{{- if .Values.queue.url }}
{{- .Values.queue.url }}
{{- else if .Values.redis.enabled }}
{{- printf "redis://%s-redis:6379" (include "loki-mode.fullname" .) }}
{{- end }}
{{- end }}

{{/* Queue env shared by receiver and worker so the two halves can never
     disagree about which queue they are talking to. */}}
{{- define "loki-mode.queueEnv" -}}
- name: LOKI_QUEUE_BACKEND
  value: {{ .Values.queue.backend | quote }}
- name: LOKI_QUEUE_KEY
  value: {{ .Values.queue.key | quote }}
{{- with (include "loki-mode.redisURL" .) }}
- name: LOKI_QUEUE_URL
  value: {{ . | quote }}
{{- end }}
- name: LOKI_QUEUE_DIR
  value: {{ .Values.queue.dir | quote }}
- name: LOKI_QUEUE_POLL_SEC
  value: {{ .Values.queue.pollSec | quote }}
- name: LOKI_QUEUE_BLOCK_SEC
  value: {{ .Values.queue.blockSec | quote }}
{{- end }}
