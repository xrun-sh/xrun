import type { DeploymentProgress as Progress, DeploymentStage } from "../api";
import { t, type PlainMessageKey } from "../i18n";
import { Icon } from "./Icon";

/** The core's stages, grouped into the steps a person recognizes; each ends at its last stage. */
const STEPS: { label: PlainMessageKey; stages: DeploymentStage[] }[] = [
  {
    label: "deployment.step.authorization",
    stages: [
      "authorization",
      "authorization_received",
      "token_exchange",
      "accounts",
      "account_selection",
    ],
  },
  {
    label: "deployment.step.relay",
    stages: [
      "subdomain",
      "worker_check",
      "worker_upload",
      "address_activation",
      "deployed",
    ],
  },
  {
    label: "deployment.step.network",
    stages: ["relay_check", "network_creation"],
  },
  {
    label: "deployment.step.service",
    stages: ["service_start", "service_connection"],
  },
];
const ENDS: DeploymentStage[] = [
  "accounts",
  "deployed",
  "network_creation",
  "service_connection",
];

/**
 * Cleanup and final events belong to no step. A stage that failed and was retried does
 * not count; only an operation that failed marks a step red.
 */
export function deploymentSteps(events: Progress[], failed: boolean) {
  const latest = new Map<DeploymentStage, Progress>();
  const operations: string[] = [];
  let reached = -1;
  for (const event of events) {
    if (!operations.includes(event.operation_id))
      operations.push(event.operation_id);
    const previous = latest.get(event.stage);
    if (
      previous?.operation_id === event.operation_id &&
      previous.sequence > event.sequence
    )
      continue;
    latest.set(event.stage, event);
    const step = STEPS.findIndex(({ stages }) => stages.includes(event.stage));
    reached = Math.max(reached, step);
  }
  if (latest.has("authorization_received")) latest.delete("authorization");
  const complete = latest.get("complete");
  const finished =
    complete?.operation === "create_cloudflare_network" &&
    complete.status === "completed";
  const done = STEPS.map(
    ({ stages }, index) =>
      finished ||
      index < reached ||
      (latest.get(ENDS[index])?.status === "completed" &&
        !stages.some((stage) =>
          ["running", "waiting"].includes(latest.get(stage)?.status ?? ""),
        )),
  );
  const next = done.indexOf(false);
  const failedStep = [...latest.values()]
    .filter((event) => event.status === "failed")
    .sort(
      (a, b) =>
        operations.indexOf(a.operation_id) -
          operations.indexOf(b.operation_id) || a.sequence - b.sequence,
    )
    .map((event) =>
      STEPS.findIndex(({ stages }) => stages.includes(event.stage)),
    )
    .filter((step) => step >= 0)
    .at(-1);
  const failure = failed ? (failedStep ?? next) : -1;
  const position = failure >= 0 ? failure : next;
  let fraction = 1;
  if (position >= 0) {
    const { stages } = STEPS[position];
    const completed = stages.filter(
      (stage) => latest.get(stage)?.status === "completed",
    ).length;
    fraction =
      (position + Math.min(completed / stages.length, 0.9)) / STEPS.length;
  }
  return { done, next, failure, fraction };
}

function StageTimes({ events }: { events: Progress[] }) {
  return (
    <details className="setup-advanced">
      <summary>{t("deployment.details")}</summary>
      <ol className="deployment-steps">
        {events
          .filter(
            (event) =>
              event.status === "completed" && event.stage !== "complete",
          )
          .map((event) => (
            <li key={`${event.operation_id}:${event.sequence}`}>
              <span>{t(`deployment.${event.stage}`)}</span>
              <span>{(event.stage_elapsed_ms / 1000).toFixed(1)} s</span>
            </li>
          ))}
      </ol>
    </details>
  );
}

export function DeploymentProgress({
  current,
  events,
  seconds,
}: {
  current?: Progress;
  events: Progress[];
  seconds: number;
}) {
  if (!events.length) return null;
  return (
    <div className="deployment-progress">
      {current && (
        <p role="status" className="setup-help">
          {t(`deployment.${current.stage}`)} ·{" "}
          {t("deployment.elapsed", { seconds })}
        </p>
      )}
      <StageTimes events={events} />
    </div>
  );
}

/** Network creation keeps its steps after it ends, so a failure shows where it stopped. */
export function DeploymentSteps({
  current,
  events,
  seconds,
  running,
  failed,
}: {
  current?: Progress;
  events: Progress[];
  seconds: number;
  running: boolean;
  failed: boolean;
}) {
  if (!events.length) return null;
  const { done, next, failure, fraction } = deploymentSteps(events, failed);
  const percent = Math.round(fraction * 100);
  const state = (index: number) =>
    index === failure
      ? "failed"
      : done[index]
        ? "done"
        : running && index === next
          ? "current"
          : "pending";
  return (
    <div
      className={`deployment-progress deployment-stepper ${failure >= 0 ? "failed" : running ? "running" : ""}`}
    >
      <p role="status" className="deployment-status">
        {failure >= 0
          ? t("deployment.failed", { step: t(STEPS[failure].label) })
          : current
            ? `${t(`deployment.${current.stage}`)} · ${t("deployment.elapsed", { seconds })}`
            : next < 0
              ? t("deployment.complete")
              : null}
      </p>
      <div
        className="deployment-bar"
        role="progressbar"
        aria-label={t("deployment.progress")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <span style={{ width: `${percent}%` }} />
      </div>
      <ol className="deployment-step-list">
        {STEPS.map((step, index) => (
          <li
            key={step.label}
            className={state(index)}
            aria-current={state(index) === "current" ? "step" : undefined}
          >
            <span className="step-marker" aria-hidden="true">
              {state(index) === "done" ? (
                <Icon name="check" />
              ) : state(index) === "failed" ? (
                <Icon name="close" />
              ) : (
                index + 1
              )}
            </span>
            <span className="step-label">{t(step.label)}</span>
            {(state(index) === "done" || state(index) === "failed") && (
              <span className="sr-only">
                {t(
                  state(index) === "done"
                    ? "deployment.stepDone"
                    : "deployment.stepFailed",
                )}
              </span>
            )}
          </li>
        ))}
      </ol>
      <StageTimes events={events} />
    </div>
  );
}
