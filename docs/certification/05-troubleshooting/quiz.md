# Module 5 Quiz: Troubleshooting

Answer each question by selecting the best option (A, B, C, or D).

---

**Question 1:** What are the three states of the circuit breaker system?

A) Active, Inactive, Standby
B) Closed, Open, Half-Open
C) Running, Paused, Stopped
D) Green, Yellow, Red

---

**Question 2:** How many failures within 60 seconds trigger a circuit breaker to OPEN?

A) 1
B) 2
C) 3
D) 5

---

**Question 3:** What is the default cooldown period when a circuit breaker is in the OPEN state?

A) 30 seconds
B) 60 seconds
C) 300 seconds (5 minutes)
D) 600 seconds (10 minutes)

---

**Question 4:** After how many failures is a task moved to the dead-letter queue?

A) 3
B) 5
C) 7
D) 10

---

**Question 5:** What happens when 3 or more DRIFT_DETECTED signals accumulate?

A) The session terminates immediately
B) A context clear is triggered and state is reloaded from scratch
C) The task is moved to the dead-letter queue
D) All agents are stopped and restarted

---

**Question 6:** Which file should an agent read first when recovering from context loss?

A) `.loki/queue/pending.json`
B) `.loki/CONTINUITY.md`
C) `.loki/session.json`
D) `.loki/memory/index.json`

---

**Question 7:** What does the `loki reset retries` command do?

A) Deletes all tasks from the queue
B) Restarts the AI provider CLI
C) Resets retry counters only
D) Removes the entire `.loki/` directory

---

**Question 8:** Which environment variable disables Gate 5 (Mock Integrity Detector)?

A) `LOKI_GATE_MOCK=false`
B) `LOKI_GATE_MOCK_DETECTOR=false`
C) `LOKI_DISABLE_GATE_5=true`
D) `LOKI_NO_MOCK_DETECTION=true`

---

**Question 9:** When should a dead-letter task be permanently abandoned?

A) After 3 failed attempts
B) After 5 failed attempts
C) After 10+ total attempts, or same error with 3 different approaches
D) Only when manually deleted by the user

---

**Question 10:** What is a red flag indication that an agent is rationalizing a failure?

A) The agent requests a model upgrade
B) The agent uses language like "probably", "should be fine", or "just a small change"
C) The agent creates a new branch for the fix
D) The agent runs additional tests
