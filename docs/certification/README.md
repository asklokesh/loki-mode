# Autonomi Certified Developer Program

## Overview

The Autonomi Certified Developer certification validates your knowledge of Loki Mode, the multi-agent autonomous system by [Autonomi](https://www.autonomi.dev/). This program covers core concepts, enterprise features, advanced patterns, production deployment, and troubleshooting.

## Program Structure

| Module | Topic | Questions |
|--------|-------|-----------|
| 1 | Core Concepts | 10 |
| 2 | Enterprise Features | 10 |
| 3 | Advanced Patterns | 10 |
| 4 | Production Deployment | 10 |
| 5 | Troubleshooting | 10 |
| **Final Exam** | **All Modules** | **50** |

## Passing Criteria

- **Score required:** 80% (40 out of 50 questions)
- **Format:** Multiple choice (A/B/C/D)
- **Open book:** You may reference the Loki Mode documentation during the exam
- **Self-paced:** No time limit

## Prerequisites

- Familiarity with command-line tools (bash, git, npm)
- Basic understanding of AI/LLM concepts (prompts, models, tokens)
- Node.js 18+ installed
- A supported AI provider CLI installed (Claude Code, Codex CLI, or Gemini CLI)

## How to Use This Program

1. Work through each module in order (Module 1 through Module 5)
2. Read the `lesson.md` in each module directory
3. Complete the `quiz.md` to test your understanding
4. Do the hands-on `lab.md` exercise
5. When ready, take the final `certification-exam.md`
6. Check your answers against `answer-key.md`

## Directory Structure

```
docs/certification/
  README.md                          # This file
  01-core-concepts/
    lesson.md                        # RARV cycle, agents, quality gates, memory
    quiz.md                          # 10 questions
    lab.md                           # Hands-on: install and run Loki Mode
  02-enterprise-features/
    lesson.md                        # Audit, OTEL, auth, SIEM integration
    quiz.md                          # 10 questions
    lab.md                           # Configure enterprise features
  03-advanced-patterns/
    lesson.md                        # Agent composition, quality plugins
    quiz.md                          # 10 questions
    lab.md                           # Create a custom quality gate
  04-production-deployment/
    lesson.md                        # Docker, deployment, security hardening
    quiz.md                          # 10 questions
    lab.md                           # Deploy with Docker Compose
  05-troubleshooting/
    lesson.md                        # Debugging, recovery, circuit breakers
    quiz.md                          # 10 questions
    lab.md                           # Diagnose failures
  sample-prds/
    todo-app.md                      # Simple tier example
    saas-dashboard.md                # Standard tier example
    microservices-platform.md        # Complex tier example
  certification-exam.md              # 50-question final exam
  answer-key.md                      # Answers for all quizzes and exam
```

## Cost and Licensing

This certification program is **free and open source**, released under the same license as Loki Mode. No registration or payment is required.

## Version

This certification is based on **Loki Mode v5.52.0**. Content may be updated as new versions are released.
