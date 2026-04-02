# Workflow Agents — Deterministic Orchestration Primitives

Date: 2026-04-02
Status: design approved

## Summary

Workflow agents bring deterministic, composable orchestration on top of the
Kaku kernel. Where a `ReAct` agent decides at runtime which tools to call, a
workflow agent executes a fixed plan: steps run in a declared order, may fork
into parallel branches, may loop until a condition is met, and the whole
execution can be inspected, replayed, and resumed.

This builds on the Kaku middleware pipeline that already exists. The kernel
itself is not changed — workflow agents are a higher-level construct that
wraps kernel runs or delegates to sub-agents via the existing `DelegationEvent`.

### Design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Definition form | TypeScript code (not YAML/JSON DSL) | Deno-native, type-safe, composable with existing abstractions |
| Execution model | Workflow runner drives a sequence of `StepRunner`s | Parallels how `AgentRunner` drives the kernel; same event model |
| Each step | One `AgentRunner.run()` call or a direct `StepFn` | Re-uses the full Kaku middleware pipeline per step |
| Step output routing | Explicit `inputs` mapping function | No magic — caller decides what flows between steps |
| Parallel branches | `Promise.all` over `StepRunner`s | Deno-native, no concurrency library needed |
| Loop condition | Predicate on previous step output | Deterministic; no LLM decides when to stop |
| Error handling | `onError` per step + workflow-level `onError` | Granular recovery without tangling the happy path |
| Partial completion | Steps committed to `WorkflowEventStore` as they complete | Enables resume without re-running finished steps |
| A2A delegation | Workflow emits `DelegationEvent` for remote-agent steps | Re-uses existing event type; `DelegationResolution` carries step result |
| Middleware sharing | Each step gets its own pipeline (from factory fn) | Isolation; avoids shared state bugs across steps |

## Architecture overview

```
WorkflowRunner
   │
   ├─ WorkflowEventStore     (tracks which steps completed)
   │
   ├─ Step 1: StepRunner ──► AgentRunner (full Kaku pipeline)
   │                              └─ local kernel or A2A delegation
   │
   ├─ Step 2: StepRunner (parallel or sequential)
   │
   └─ Step N ...
```

A `Workflow` is a pure value — a descriptor of steps. `WorkflowRunner` executes
it. The same pattern mirrors `KernelInput` (pure value) versus `AgentRunner`
(executor).

## Workflow definition

### Primitives

```typescript
// src/agent/workflow/types.ts

/** A step result carries structured output and a success flag. */
interface StepResult {
  stepId: string;
  success: boolean;
  output: unknown;
  error?: { code: string; context?: Record<string, unknown>; recovery?: string };
}

/** A step function: receives previous results, returns a promise of StepResult. */
type StepFn = (context: StepContext) => Promise<StepResult>;

interface StepContext {
  stepId: string;
  /** Results of all previously completed steps (keyed by stepId). */
  previous: Record<string, StepResult>;
  /** Session state from the workflow runner (app/user scoped). */
  session: SessionState;
}

interface StepDef {
  id: string;
  /** Human-readable label for tracing. */
  label?: string;
  /** Either a direct function or an agent invocation config. */
  run: StepFn | AgentStepConfig;
  /** Override error handling for this step. Default: "fail". */
  onError?: "fail" | "skip" | StepErrorHandler;
}

type StepErrorHandler = (err: unknown, ctx: StepContext) => Promise<StepResult>;
```

### AgentStepConfig

A step can invoke an agent (local Kaku run) or delegate via A2A:

```typescript
interface AgentStepConfig {
  type: "agent";
  /** Build the input message for the agent from previous step results. */
  buildInput: (context: StepContext) => string;
  /** Factory that creates the AgentRunner for this step. */
  runnerFactory: (deps: StepRunnerFactoryDeps) => RunnerBundle;
}

interface AgentStepConfig {
  type: "a2a";
  targetAgent: string;                               // A2A agent URL or ID
  buildInput: (context: StepContext) => string;
}
```

### Workflow primitives

```typescript
// src/agent/workflow/primitives.ts

/** Sequential: steps run in declared order. */
interface SequentialWorkflow {
  type: "sequential";
  steps: StepDef[];
}

/** Parallel: all branches start simultaneously; workflow waits for all. */
interface ParallelWorkflow {
  type: "parallel";
  branches: StepDef[][];            // each branch is an array of sequential steps
  /** Optional merge step runs after all branches complete. */
  merge?: StepDef;
}

/** Loop: step (or sub-workflow) runs until condition returns false. */
interface LoopWorkflow {
  type: "loop";
  step: StepDef;
  /** Return true to continue looping. */
  condition: (result: StepResult, iteration: number) => boolean;
  maxIterations?: number;           // safety cap, default 10
}

/** Custom: caller provides the execution function directly. */
interface CustomWorkflow {
  type: "custom";
  execute: (runner: WorkflowRunner) => Promise<WorkflowResult>;
}

type Workflow =
  | SequentialWorkflow
  | ParallelWorkflow
  | LoopWorkflow
  | CustomWorkflow;
```

## WorkflowRunner

```typescript
// src/agent/workflow/runner.ts

interface WorkflowResult {
  success: boolean;
  steps: StepResult[];
  output?: unknown;       // last step output (sequential) or merge output (parallel)
}

class WorkflowRunner {
  constructor(
    private workflow: Workflow,
    private store: WorkflowEventStore,
    private session: SessionState,
  ) {}

  async run(): Promise<WorkflowResult> {
    switch (this.workflow.type) {
      case "sequential": return this.runSequential(this.workflow);
      case "parallel":   return this.runParallel(this.workflow);
      case "loop":       return this.runLoop(this.workflow);
      case "custom":     return this.workflow.execute(this);
    }
  }

  private async runSequential(wf: SequentialWorkflow): Promise<WorkflowResult> {
    const completed: Record<string, StepResult> = {};
    const results: StepResult[] = [];

    for (const step of wf.steps) {
      // Skip if already completed (crash recovery)
      const existing = await this.store.getStepResult(step.id);
      if (existing) {
        completed[step.id] = existing;
        results.push(existing);
        continue;
      }

      const result = await this.executeStep(step, { stepId: step.id, previous: completed, session: this.session });
      await this.store.commitStep(result);
      completed[step.id] = result;
      results.push(result);

      if (!result.success && this.resolveOnError(step) === "fail") {
        return { success: false, steps: results };
      }
    }

    return { success: true, steps: results, output: results.at(-1)?.output };
  }

  private async runParallel(wf: ParallelWorkflow): Promise<WorkflowResult> {
    // Each branch is a sequential sub-workflow
    const branchResults = await Promise.all(
      wf.branches.map((steps) =>
        new WorkflowRunner(
          { type: "sequential", steps },
          this.store,
          this.session,
        ).run()
      ),
    );

    const allSteps = branchResults.flatMap((r) => r.steps);
    const success = branchResults.every((r) => r.success);

    if (success && wf.merge) {
      const previous = Object.fromEntries(allSteps.map((s) => [s.stepId, s]));
      const mergeResult = await this.executeStep(wf.merge, {
        stepId: wf.merge.id,
        previous,
        session: this.session,
      });
      await this.store.commitStep(mergeResult);
      return { success: mergeResult.success, steps: [...allSteps, mergeResult], output: mergeResult.output };
    }

    return { success, steps: allSteps };
  }

  private async runLoop(wf: LoopWorkflow): Promise<WorkflowResult> {
    const maxIter = wf.maxIterations ?? 10;
    const results: StepResult[] = [];
    let iteration = 0;
    let lastResult: StepResult | undefined;

    while (iteration < maxIter) {
      const stepId = `${wf.step.id}:${iteration}`;
      const existing = await this.store.getStepResult(stepId);
      if (existing) {
        lastResult = existing;
        results.push(existing);
        iteration++;
        if (!wf.condition(existing, iteration)) break;
        continue;
      }

      const result = await this.executeStep(
        { ...wf.step, id: stepId },
        { stepId, previous: {}, session: this.session },
      );
      await this.store.commitStep(result);
      results.push(result);
      lastResult = result;
      iteration++;

      if (!result.success || !wf.condition(result, iteration)) break;
    }

    return { success: lastResult?.success ?? false, steps: results, output: lastResult?.output };
  }

  private async executeStep(step: StepDef, ctx: StepContext): Promise<StepResult> {
    try {
      if (typeof step.run === "function") {
        return await step.run(ctx);
      }
      // Agent step — delegate to AgentRunner or A2A
      return await this.executeAgentStep(step.run, ctx);
    } catch (err) {
      const handler = this.resolveOnError(step);
      if (handler === "skip") return { stepId: step.id, success: false, output: null };
      if (typeof handler === "function") return handler(err, ctx);
      throw err; // "fail"
    }
  }

  private async executeAgentStep(config: AgentStepConfig, ctx: StepContext): Promise<StepResult> {
    if (config.type === "a2a") {
      // Emit DelegationEvent pattern — use A2AClient directly for workflow steps
      // The result comes back as a DelegationResolution
      // (A2AClient wiring is out of scope for this spec)
      throw new Error("A2A step execution: see a2a_task middleware and A2AClient");
    }

    // type: "agent" — full Kaku run
    const message = config.buildInput(ctx);
    const { runner, kernelInput } = config.runnerFactory({
      session: ctx.session,
      message,
    });
    const result = await runner.run(kernelInput);
    return { stepId: ctx.stepId, success: true, output: result.content };
  }

  private resolveOnError(step: StepDef): "fail" | "skip" | StepErrorHandler {
    return step.onError ?? "fail";
  }
}
```

## WorkflowEventStore

```typescript
// src/agent/workflow/event_store.ts

interface WorkflowEventStore {
  commitStep(result: StepResult): Promise<void>;
  getStepResult(stepId: string): Promise<StepResult | null>;
  getAll(): Promise<StepResult[]>;
}

class InMemoryWorkflowEventStore implements WorkflowEventStore {
  private steps: Map<string, StepResult> = new Map();

  async commitStep(result: StepResult) { this.steps.set(result.stepId, result); }
  async getStepResult(id: string) { return this.steps.get(id) ?? null; }
  async getAll() { return [...this.steps.values()]; }
}
```

A persistent `KvWorkflowEventStore` follows the same pattern as
`KvEventStore` in the crash recovery spec: store under
`["workflow", workflowId, "steps", stepId]`.

## Usage example

```typescript
// Define a research + summarise workflow
const workflow: SequentialWorkflow = {
  type: "sequential",
  steps: [
    {
      id: "research",
      run: {
        type: "agent",
        buildInput: (ctx) => `Research: ${ctx.previous["input"]?.output}`,
        runnerFactory: (deps) => createLocalRunner({ ...researchAgentDeps, ...deps }),
      },
    },
    {
      id: "summarise",
      run: {
        type: "agent",
        buildInput: (ctx) => `Summarise this research: ${ctx.previous["research"]?.output}`,
        runnerFactory: (deps) => createLocalRunner({ ...summaryAgentDeps, ...deps }),
      },
    },
  ],
};

const runner = new WorkflowRunner(workflow, new InMemoryWorkflowEventStore(), session);
const result = await runner.run();
```

## A2A delegation in workflow steps

For steps that delegate to a remote agent, the step function wraps an A2AClient
call and packages the response as a `StepResult`. This does not require changes
to the kernel or the `AgentRunner` — A2A invocation happens at the workflow
level, not inside a ReAct loop.

The existing `DelegationEvent` / `DelegationResolution` types in `events.ts`
are reserved for intra-kernel delegation (an agent deciding mid-run to hand off
to another agent). Workflow-level delegation bypasses the kernel entirely.

## Error handling and partial completion

- Each step result is committed to `WorkflowEventStore` immediately after it
  completes (or fails with `onError: "skip"`).
- On restart, `WorkflowRunner.runSequential` checks `getStepResult(step.id)`
  before executing — already-committed steps are skipped.
- If a step fails with `onError: "fail"` (default), the workflow aborts and
  returns `success: false` with the partial `steps` array. The caller can
  inspect which step failed and why.
- Tool-level and LLM-level errors inside an agent step propagate as exceptions
  from `AgentRunner.run()` and are caught by `executeStep`'s try/catch.

## New / modified files

| File | Type | Change |
|---|---|---|
| `src/agent/workflow/types.ts` | New | `StepDef`, `StepResult`, `StepContext`, `AgentStepConfig`, `StepFn` |
| `src/agent/workflow/primitives.ts` | New | `SequentialWorkflow`, `ParallelWorkflow`, `LoopWorkflow`, `CustomWorkflow`, `Workflow` |
| `src/agent/workflow/runner.ts` | New | `WorkflowRunner`, `WorkflowResult` |
| `src/agent/workflow/event_store.ts` | New | `WorkflowEventStore`, `InMemoryWorkflowEventStore` |
| `src/agent/workflow/index.ts` | New | Re-exports |

No existing files are modified. The workflow layer is purely additive.

## What does not change

- `agentKernel` — unmodified; each step that runs an agent gets its own kernel
  invocation via `AgentRunner.run()`.
- `MiddlewarePipeline` — each step runner composes its own pipeline; no sharing.
- `EventStore` — workflow uses a separate `WorkflowEventStore`; per-step event
  stores remain `InMemoryEventStore` until crash recovery spec is implemented.
- Broker, federation, channels, transport — untouched.
- Tool implementations — untouched.

## Future extensions

- **Workflow DSL**: a JSON/YAML schema for declaring workflows as config files,
  compiled to the TypeScript types above at load time.
- **Visual tracing**: emit a `WorkflowSpanEvent` per step for the observability
  middleware to include in trace trees.
- **Conditional branching**: a `ConditionalWorkflow` primitive where the next
  step is chosen by a predicate on the previous result.
- **Checkpoint streaming**: stream intermediate step results to the broker
  channel so clients see progress in real time.
- **Durable workflow store**: `KvWorkflowEventStore` backed by Deno KV or
  Prisma; enables cross-process resume (ties into crash recovery spec).
- **Workflow composition**: a workflow step whose `run` is another `Workflow`;
  nest arbitrary depth.
