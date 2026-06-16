# Acknowledgements

Loki Mode stands on the shoulders of giants. This project incorporates research, patterns, and insights from the leading AI labs, academic institutions, and practitioners in the field.

---

## Research Labs

### Anthropic

Loki Mode is built for Claude and incorporates Anthropic's cutting-edge research on AI safety and agent development.

| Paper/Resource | Contribution to Loki Mode |
|----------------|---------------------------|
| [Constitutional AI: Harmlessness from AI Feedback](https://www.anthropic.com/research/constitutional-ai-harmlessness-from-ai-feedback) | Self-critique against principles, revision workflow |
| [Building Effective Agents](https://www.anthropic.com/research/building-effective-agents) | Evaluator-optimizer pattern, parallelization, routing |
| [Claude Code Best Practices](https://www.anthropic.com/engineering/claude-code-best-practices) | Explore-Plan-Code workflow, context management |
| [Simple Probes Can Catch Sleeper Agents](https://www.anthropic.com/research/probes-catch-sleeper-agents) | Defection probes, anomaly detection patterns |
| [Alignment Faking in Large Language Models](https://www.anthropic.com/research/alignment-faking) | Monitoring for strategic compliance |
| [Visible Extended Thinking](https://www.anthropic.com/research/visible-extended-thinking) | Thinking levels (think, think hard, ultrathink) |
| [Computer Use Safety](https://www.anthropic.com/news/3-5-models-and-computer-use) | Safe autonomous operation patterns |
| [Sabotage Evaluations](https://www.anthropic.com/research/sabotage-evaluations-for-frontier-models) | Safety evaluation methodology |
| [Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) | One-feature-at-a-time pattern, Playwright MCP for E2E |
| [Claude Agent SDK Overview](https://platform.claude.com/docs/en/agent-sdk/overview) | Task tool, subagents, resume parameter, hooks |

### Google DeepMind

DeepMind's research on world models, hierarchical reasoning, and scalable oversight informs Loki Mode's architecture.

| Paper/Resource | Contribution to Loki Mode |
|----------------|---------------------------|
| [SIMA 2: Generalist AI Agent](https://deepmind.google/blog/sima-2-an-agent-that-plays-reasons-and-learns-with-you-in-virtual-3d-worlds/) | Self-improvement loop, reward model training |
| [Gemini Robotics 1.5](https://deepmind.google/blog/gemini-robotics-15-brings-ai-agents-into-the-physical-world/) | Hierarchical reasoning (planner + executor) |
| [Dreamer 4: World Model Training](https://danijar.com/project/dreamer4/) | Simulation-first testing, safe exploration |
| [Genie 3: World Models](https://deepmind.google/blog/genie-3-a-new-frontier-for-world-models/) | World model architecture patterns |
| [Scalable AI Safety via Doubly-Efficient Debate](https://deepmind.google/research/publications/34920/) | Debate-based verification for critical changes |
| [Human-AI Complementarity for Amplified Oversight](https://deepmindsafetyresearch.medium.com/human-ai-complementarity-a-goal-for-amplified-oversight-0ad8a44cae0a) | AI-assisted human supervision |
| [Technical AGI Safety Approach](https://arxiv.org/html/2504.01849v1) | Safety-first agent design |

### OpenAI

OpenAI's Agents SDK and deep research patterns provide foundational patterns for agent orchestration.

| Paper/Resource | Contribution to Loki Mode |
|----------------|---------------------------|
| [Agents SDK Documentation](https://openai.github.io/openai-agents-python/) | Tracing spans, guardrails, tripwires |
| [A Practical Guide to Building Agents](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf) | Agent architecture best practices |
| [Building Agents Track](https://developers.openai.com/tracks/building-agents/) | Development patterns, handoff callbacks |
| [AGENTS.md Specification](https://agents.md/) | Standardized agent instructions |
| [Introducing Deep Research](https://openai.com/index/introducing-deep-research/) | Adaptive planning, backtracking |
| [Deep Research System Card](https://cdn.openai.com/deep-research-system-card.pdf) | Safety considerations for research agents |
| [Introducing o3 and o4-mini](https://openai.com/index/introducing-o3-and-o4-mini/) | Reasoning model guidance |
| [Reasoning Best Practices](https://platform.openai.com/docs/guides/reasoning-best-practices) | Extended thinking patterns |
| [Chain of Thought Monitoring](https://openai.com/index/chain-of-thought-monitoring/) | Reasoning trace monitoring |
| [Agent Builder Safety](https://platform.openai.com/docs/guides/agent-builder-safety) | Safety patterns for agent builders |
| [Computer-Using Agent](https://openai.com/index/computer-using-agent/) | Computer use patterns |
| [Agentic AI Foundation](https://openai.com/index/agentic-ai-foundation/) | Industry standards, interoperability |

### Amazon Web Services (AWS)

AWS Bedrock's multi-agent collaboration patterns inform Loki Mode's routing and dispatch strategies.

| Paper/Resource | Contribution to Loki Mode |
|----------------|---------------------------|
| [Multi-Agent Orchestration Guidance](https://aws.amazon.com/solutions/guidance/multi-agent-orchestration-on-aws/) | Three coordination mechanisms, architectural patterns |
| [Bedrock Multi-Agent Collaboration](https://docs.aws.amazon.com/bedrock/latest/userguide/agents-multi-agent-collaboration.html) | Supervisor mode, routing mode, 10-agent limit |
| [Multi-Agent Collaboration Announcement](https://aws.amazon.com/blogs/aws/introducing-multi-agent-collaboration-capability-for-amazon-bedrock/) | Intent classification, selective context sharing |
| [AgentCore for SRE](https://aws.amazon.com/blogs/machine-learning/build-multi-agent-site-reliability-engineering-assistants-with-amazon-bedrock-agentcore/) | Gateway, Memory, Identity, Observability components |

**Key Pattern Adopted:** Routing Mode Optimization - Direct dispatch for simple tasks (lower latency), supervisor orchestration for complex tasks (full coordination).

---

## Academic Research

### Multi-Agent Systems

| Paper | Authors/Source | Contribution |
|-------|----------------|--------------|
| [Multi-Agent Collaboration Mechanisms Survey](https://arxiv.org/abs/2501.06322) | arXiv 2501.06322 | Collaboration structures, coopetition |
| [CONSENSAGENT: Anti-Sycophancy Framework](https://aclanthology.org/2025.findings-acl.1141/) | ACL 2025 Findings | Blind review, devil's advocate |
| [GoalAct: Hierarchical Execution](https://arxiv.org/abs/2504.16563) | arXiv 2504.16563 | Global planning, skill decomposition |
| [A-Mem: Agentic Memory System](https://arxiv.org/html/2502.12110v11) | arXiv 2502.12110 | Zettelkasten-style memory linking |
| [Multi-Agent Reflexion (MAR)](https://arxiv.org/html/2512.20845) | arXiv 2512.20845 | Structured debate, persona-based critics |
| [Iter-VF: Iterative Verification-First](https://arxiv.org/html/2511.21734v1) | arXiv 2511.21734 | Answer-only verification, Markovian retry |

### Evaluation & Safety

| Paper | Authors/Source | Contribution |
|-------|----------------|--------------|
| [Assessment Framework for Agentic AI](https://arxiv.org/html/2512.12791v1) | arXiv 2512.12791 | Four-pillar evaluation framework |
| [Measurement Imbalance in Agentic AI](https://arxiv.org/abs/2506.02064) | arXiv 2506.02064 | Multi-dimensional evaluation axes |
| [Demo-to-Deployment Gap](https://www.marktechpost.com/2025/12/24/) | Stanford/Harvard | Tool reliability vs tool selection |

### Verification & Hallucination Reduction

| Paper | Authors/Source | Contribution |
|-------|----------------|--------------|
| [Chain-of-Verification Reduces Hallucination in LLMs](https://arxiv.org/abs/2309.11495) | Dhuliawala et al., Meta AI, 2023 | 4-step verification (Draft -> Plan -> Execute -> Verify), factored execution, significant hallucination reduction (23% F1 improvement, ~77% reduction in hallucinated entities) |

### Memory Systems

| Paper | Authors/Source | Contribution |
|-------|----------------|--------------|
| [MemEvolve: Meta-Evolution of Agent Memory Systems](https://arxiv.org/abs/2512.18746) | Zhang et al., OPPO AI Agent Team, 2025 | Modular design (Encode/Store/Retrieve/Manage), task-aware strategy selection, 17.06% improvement via meta-evolution |
| [A-MEM: Agentic Memory for LLM Agents](https://arxiv.org/abs/2502.12110) | Xu et al., NeurIPS 2025 | Zettelkasten-style atomic notes with keywords, tags, and bidirectional links; ChromaDB indexing |
| [MemGPT: Towards LLMs as Operating Systems](https://arxiv.org/abs/2310.08560) | Packer et al., 2023 | OS-inspired hierarchical memory (Core/Recall/Archival), self-editing memory via tool use, paging policies |
| [Zep: Temporal Knowledge Graph Architecture](https://arxiv.org/abs/2501.13956) | Zep AI, 2025 | Bi-temporal model (event time + ingestion time), knowledge invalidation, 94.8% DMR accuracy |
| [SimpleMem: Efficient Lifelong Memory](https://arxiv.org/abs/2601.02553) | aiming-lab, 2026 | Semantic lossless compression, online semantic synthesis, 30x token reduction, 26.4% F1 improvement |
| [CAM: Constructivist Agentic Memory](https://arxiv.org/abs/2510.05520) | Rui et al., NeurIPS 2025 | Piaget-inspired hierarchical schemata, overlapping clustering, prune-and-grow retrieval |
| [SAGE: Self-evolving Agents with Reflective Memory](https://arxiv.org/abs/2409.00872) | 2024 | Ebbinghaus forgetting curve, usage-based decay, three-agent collaboration for memory refinement |
| [Contextual Retrieval](https://www.anthropic.com/news/contextual-retrieval) | Anthropic, 2024 | Contextual BM25 + embeddings + reranking, 67% retrieval failure reduction |
| [Memory in the Age of AI Agents (Survey)](https://arxiv.org/abs/2512.13564) | Liu et al., 2025 | Forms-Functions-Dynamics taxonomy, comprehensive memory architecture survey |

---

## Industry Resources

### Tools & Frameworks

| Resource | Contribution |
|----------|--------------|
| [Cursor - Scaling Agents](https://cursor.com/blog/scaling-agents) | Hierarchical planner-worker model, optimistic concurrency, recursive sub-planners, judge agents, scale-tested patterns (1M+ LoC projects) |
| [NVIDIA ToolOrchestra](https://github.com/NVlabs/ToolOrchestra) | Efficiency metrics, three-reward signal framework, dynamic agent selection |
| [LerianStudio/ring](https://github.com/LerianStudio/ring) | Subagent-driven-development pattern |
| [Awesome Agentic Patterns](https://github.com/nibzard/awesome-agentic-patterns) | 105+ production patterns catalog |

### Best Practices Guides

| Resource | Contribution |
|----------|--------------|
| [Maxim AI: Production Multi-Agent Systems](https://www.getmaxim.ai/articles/best-practices-for-building-production-ready-multi-agent-systems/) | Correlation IDs, failure handling |
| [UiPath: Agent Builder Best Practices](https://www.uipath.com/blog/ai/agent-builder-best-practices) | Single-responsibility agents |
| [GitHub: Speed Without Control](https://github.blog/) | Static analysis + AI review, guardrails |

---

## Hacker News Community

Battle-tested insights from practitioners deploying agents in production.

### Discussions

| Thread | Key Insight |
|--------|-------------|
| [What Actually Works in Production for Autonomous Agents](https://news.ycombinator.com/item?id=44623207) | "Zero companies without human in the loop" |
| [Coding with LLMs in Summer 2025](https://news.ycombinator.com/item?id=44623953) | Context curation beats automatic RAG |
| [Superpowers: How I'm Using Coding Agents](https://news.ycombinator.com/item?id=45547344) | Sub-agents for context isolation (Simon Willison) |
| [Claude Code Experience After Two Weeks](https://news.ycombinator.com/item?id=44596472) | Fresh contexts yield better results |
| [AI Agent Benchmarks Are Broken](https://news.ycombinator.com/item?id=44531697) | LLM-as-judge has shared blind spots |
| [How to Orchestrate Multi-Agent Workflows](https://news.ycombinator.com/item?id=45955997) | Event-driven, decoupled coordination |
| [Context Engineering vs Prompt Engineering](https://news.ycombinator.com/item?id=44427757) | Manual context selection principles |

### Show HN Projects

| Project | Contribution |
|---------|--------------|
| [Self-Evolving Agents Repository](https://news.ycombinator.com/item?id=45099226) | Self-improvement patterns |
| [Package Manager for Agent Skills](https://news.ycombinator.com/item?id=46422264) | Skills architecture |
| [Wispbit - AI Code Review Agent](https://news.ycombinator.com/item?id=44722603) | Code review patterns |
| [Agtrace - Monitoring for AI Coding Agents](https://news.ycombinator.com/item?id=46425670) | Agent monitoring patterns |

---

## Individual Contributors

Special thanks to thought leaders whose patterns and insights shaped Loki Mode:

| Contributor | Contribution |
|-------------|--------------|
| **Boris Cherny** (Creator of Claude Code) | Self-verification loop (2-3x quality improvement), extended thinking mode, "Less prompting, more systems" philosophy |
| **Ivan Steshov** | Centralized constitution, agent lineage tracking, structured artifacts as contracts |
| **Addy Osmani** | Git checkpoint system, specification-first approach, visual aids (Mermaid diagrams) |
| **Simon Willison** | Sub-agents for context isolation, skills system, context curation patterns |

---

## Production Patterns Summary

Key patterns incorporated from practitioner experience:

| Pattern | Source | Implementation |
|---------|--------|----------------|
| Human-in-the-Loop (HITL) | HN Production Discussions | Confidence-based escalation thresholds |
| Narrow Scope (3-5 steps) | Multiple Practitioners | Task scope constraints |
| Deterministic Validation | Production Teams | Rule-based outer loops (not LLM-judged) |
| Context Curation | Simon Willison | Manual selection, focused context |
| Blind Review + Devil's Advocate | CONSENSAGENT | Anti-sycophancy protocol |
| Hierarchical Reasoning | DeepMind Gemini | Orchestrator + specialized executors |
| Constitutional Self-Critique | Anthropic | Principles-based revision |
| Debate Verification | DeepMind | Critical change verification |
| One Feature at a Time | Anthropic Harness | Single feature per iteration, full verification |
| E2E Browser Testing | Anthropic Harness | Playwright MCP for visual verification |
| Chain-of-Verification | arXiv 2309.11495 | CoVe protocol in quality-gates.md |
| Factored Verification | arXiv 2309.11495 | Independent verification execution |
| Modular Memory Design | arXiv 2512.18746 | Encode/Store/Retrieve/Manage mapping in memory-system.md |
| Task-Aware Memory Strategy | arXiv 2512.18746 | Retrieval weight adjustment by task type |

---

## v3.2.0 Additions

### Parallel Workflows

| Resource | Contribution |
|----------|--------------|
| [Claude Code Git Worktrees](https://code.claude.com/docs/en/common-workflows#run-parallel-claude-code-sessions-with-git-worktrees) | Parallel Claude sessions, worktree isolation pattern |

### Key Patterns Incorporated (v3.2.0)

| Pattern | Source | Implementation |
|---------|--------|----------------|
| Git Worktree Isolation | Claude Code Docs | `skills/parallel-workflows.md`, `run.sh --parallel` |
| Parallel Testing Stream | Claude Code Docs | Testing worktree tracks main, continuous validation |
| Inter-Stream Signals | Custom | `.loki/signals/` for feature/test/docs coordination |
| Auto-Merge Workflow | Custom | Completed features merge back automatically |

---

## v3.0.0 Additions

### Agent Interoperability

| Resource | Contribution |
|----------|--------------|
| [Google A2A Protocol](https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/) | Agent Cards, capability discovery, JSON-RPC 2.0 |
| [A2A Protocol v0.3](https://cloud.google.com/blog/products/ai-machine-learning/agent2agent-protocol-is-getting-an-upgrade) | gRPC support, security card signing, enterprise features |
| [A2A Project GitHub](https://github.com/a2aproject/A2A) | Open protocol specification, SDK implementations |

### Agentic Patterns

| Resource | Contribution |
|----------|--------------|
| [Awesome Agentic Patterns](https://github.com/nibzard/awesome-agentic-patterns) | 105+ production patterns catalog, feedback loops, tool patterns |
| [Agent Orchestration Critique](https://moridinamael.github.io/agent-orchestration/) | "Ralph Wiggum Mode" - simpler orchestration beats complex frameworks |

### Key Patterns Incorporated

| Pattern | Source | Implementation |
|---------|--------|----------------|
| Agent Cards | A2A Protocol | `.loki/state/agents/` capability discovery |
| Structured Handoffs | A2A Protocol | JSON message format for agent-to-agent communication |
| Sub-Agent Spawning | awesome-agentic-patterns | Task tool with focused prompts |
| Dual LLM Pattern | awesome-agentic-patterns | Opus for planning, Haiku for execution |
| CI Feedback Loop | awesome-agentic-patterns | Test results injected into retry prompts |
| Minimal Orchestration | moridinamael | Simple continuation over complex frameworks |

---

## Community Projects (Open Source Claude Code Skills)

The following open-source projects have pioneered patterns that influence or complement Loki Mode. Analyzed January 2026.

### High-Impact Projects

| Project | Stars | Key Patterns | Contribution to Loki Mode |
|---------|-------|--------------|---------------------------|
| [Superpowers (obra)](https://github.com/obra/superpowers) | 35K+ | Two-Stage Review, TDD Iron Law, Rationalization Tables | **ADOPTED**: Two-stage review (spec compliance THEN code quality) |
| [agents (wshobson)](https://github.com/wshobson/agents) | 26K+ | 72 plugins, 108 agents, 129 skills, Four-Tier Model Strategy | Plugin marketplace architecture inspiration |
| [claude-flow (ruvnet)](https://github.com/ruvnet/claude-flow) | 12K+ | Swarm topologies (hierarchical/mesh/ring/star), Consensus algorithms (Raft, Byzantine, CRDT) | Terminal-based orchestration patterns |
| [oh-my-claudecode (Yeachan-Heo)](https://github.com/Yeachan-Heo/oh-my-claudecode) | N/A | 32 agents, 35 skills, Tiered architecture (LOW/MEDIUM/HIGH), Delegation-first | **ADOPTED**: Tiered agent escalation protocols |

### Specialized Skills

| Project | Focus | Key Patterns | Contribution to Loki Mode |
|---------|-------|--------------|---------------------------|
| [claude-mem (thedotmack)](https://github.com/thedotmack/claude-mem) | Memory | Progressive Disclosure (3-layer), SQLite + FTS5, Timeline compression | **ADOPTED**: 3-layer memory (index -> timeline -> full) |
| [planning-with-files (OthmanAdi)](https://github.com/OthmanAdi/planning-with-files) | Planning | Manus-style 3-file pattern, PreToolUse attention hooks | **ADOPTED**: File-based planning persistence |
| [claude-scientific-skills (K-Dense-AI)](https://github.com/K-Dense-AI/claude-scientific-skills) | Scientific | 140 domain-specific skills, modular organization | Domain organization patterns |
| [claude-code-guide (zebbern)](https://github.com/zebbern/claude-code-guide) | Shortcuts | QNEW/QCODE/QCHECK patterns, structured reports | Shortcut command inspiration |

### Key Patterns Adopted from Community

| Pattern | Source | Implementation in Loki Mode |
|---------|--------|----------------------------|
| **Two-Stage Review** | Superpowers | Spec compliance review BEFORE code quality review |
| **Rationalization Tables** | Superpowers | Explicit counters to common agent excuses/rationalizations |
| **Progressive Disclosure Memory** | claude-mem | 3-layer context: index -> timeline -> full details |
| **Tiered Agent Escalation** | oh-my-claudecode | LOW -> MEDIUM -> HIGH with explicit escalation triggers |
| **File-Based Planning** | planning-with-files | Persistent markdown files (task_plan.md, findings.md, progress.md) |
| **PreToolUse Attention** | planning-with-files | Re-read goals before actions to combat context drift |
| **Fresh Subagent Per Task** | Superpowers | Clean context for each major task, prevents cross-contamination |

### Patterns Under Evaluation

| Pattern | Source | Status | Notes |
|---------|--------|--------|-------|
| **Token Economics Tracking** | claude-mem | Evaluating | discovery_tokens vs read_tokens for compression analysis |
| **Delegation Enforcer Middleware** | oh-my-claudecode | Evaluating | Auto-inject model parameters based on task tier |
| **Swarm Topologies** | claude-flow | Not adopted | Adds complexity beyond hierarchical orchestration |
| **Consensus Algorithms** | claude-flow | Not adopted | Byzantine/Raft overkill for single-user autonomous operation |
| **Shortcut Commands** | claude-code-guide | Evaluating | QNEW/QCODE/QCHECK for rapid task switching |

---

## v5.9.0 Additions

### Cross-Project Learning Memory System

The Cross-Project Learning feature (v5.9.0) incorporates research from the following sources:

| Resource | Contribution |
|----------|--------------|
| [A-MEM](https://arxiv.org/abs/2502.12110) | Zettelkasten atomic note pattern - each learning is self-contained with keywords and tags |
| [MemGPT](https://arxiv.org/abs/2310.08560) | Tiered memory architecture (hot/warm/cold) for efficient retrieval |
| [Zep](https://arxiv.org/abs/2501.13956) | Temporal validity tracking (valid_from, valid_until, superseded_by) |
| [SimpleMem](https://arxiv.org/abs/2601.02553) | MD5 hash-based deduplication at write time |
| [SAGE](https://arxiv.org/abs/2409.00872) | Usage tracking with access counts and decay |
| [Anthropic Contextual Retrieval](https://www.anthropic.com/news/contextual-retrieval) | Contextual prefixes for improved retrieval |
| [Agent Memory Paper List](https://github.com/Shichun-Liu/Agent-Memory-Paper-List) | Comprehensive survey of memory architectures |

### Key Patterns Incorporated (v5.9.0)

| Pattern | Source | Implementation |
|---------|--------|----------------|
| JSONL Append-Only Storage | SimpleMem | `~/.loki/learnings/*.jsonl` for efficient writes |
| MD5 Hash Deduplication | SimpleMem | Prevent duplicate entries at write time |
| Keyword/Tag Extraction | A-MEM | Auto-generated tags for filtering (planned v5.10) |
| Usage Tracking | SAGE | Access counts and timestamps (planned v5.10) |
| Temporal Validity | Zep | Track when learnings become outdated (planned v5.11) |
| Cross-Learning Links | A-MEM | Bidirectional knowledge graph (planned v6.0) |
| Memory Consolidation | MemGPT | Periodic deduplication and abstraction (planned v6.0) |

### Implementation Roadmap

Based on research synthesis, the following improvements are planned:

**Phase 1 (v5.10.x):** Deduplication improvements, usage tracking, keyword extraction
**Phase 2 (v5.11.x):** BM25 search, contextual prefixes, temporal validity
**Phase 3 (v6.0.x):** Zettelkasten-style links, memory tiering
**Phase 4 (v7.0.x):** Hierarchical abstraction, consolidation pipeline

---

## License

This acknowledgements file documents the research and resources that influenced Loki Mode's design. All referenced works retain their original licenses and copyrights.

Loki Mode itself is released under the Business Source License 1.1 (BUSL-1.1), a source-available license.

---

*Last updated: v5.9.0*
