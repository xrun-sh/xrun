import { Fragment, type ReactNode } from "react";
import type { Job } from "../../api";
import { Identifier } from "../../components/Identifier";
import { byteSize, dateTime, duration, isRunning } from "../../format";
import { t } from "../../i18n";
import { isScript, jobDuration } from "./operation";

function FactList({ facts }: { facts: [string, ReactNode][] }) {
  return (
    <dl className="activity-facts">
      {facts.map(([label, value]) => (
        <Fragment key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

/** Where an activity came from, when it ran and how it ended. */
export function ActivityFacts({ job, source }: { job: Job; source: string }) {
  const started = job.started_at_ms ?? job.created_at_ms;
  const elapsed = jobDuration(job);
  const facts: [string, ReactNode][] = [
    [t("activity.source"), source],
    [t("output.startedAt"), dateTime(started)],
  ];
  if (elapsed !== null) facts.push([t("activity.duration"), duration(elapsed)]);
  else if (isRunning(job))
    facts.push([
      t("activity.duration"),
      t("output.elapsed", {
        duration: duration(Math.max(0, Date.now() - started)),
      }),
    ]);
  else if (job.finished_at_ms !== null)
    facts.push([t("activity.endedAt"), dateTime(job.finished_at_ms)]);
  if (job.kind === "exec" || job.kind === "stream_exec") {
    const { result } = job;
    facts.push([
      t("activity.result"),
      result?.signal != null
        ? t("output.signal", { signal: result.signal })
        : result?.exit_code != null
          ? t("output.exitCode", { code: result.exit_code })
          : isRunning(job)
            ? t("output.notFinished")
            : t("output.noExitCode"),
    ]);
  }
  if ("cwd" in job.params && job.params.cwd)
    facts.push([t("output.cwd"), <code>{job.params.cwd}</code>]);
  if ("shell" in job.params && job.params.shell)
    facts.push([t("activity.interpreter"), <code>{job.params.shell}</code>]);
  // Program input is not kept; its size and digest still identify it.
  else if ("input_size" in job.params && job.params.input_size)
    facts.push([t("activity.input"), byteSize(job.params.input_size)]);
  return <FactList facts={facts} />;
}

/** Identifiers matter for support and scripts, so they stay folded. */
export function ActivityIdentifiers({ job }: { job: Job }) {
  const identifiers: [string, string][] = [
    [t("activity.jobId"), job.job_id],
    [t("activity.requestId"), job.request_id],
    [t("output.sourceId"), job.source_device_id],
  ];
  const digest =
    "input_sha256" in job.params && job.params.input_size
      ? job.params.input_sha256
      : null;
  if (digest)
    identifiers.push([
      t(isScript(job) ? "activity.scriptSha256" : "activity.inputSha256"),
      digest,
    ]);
  return (
    <details className="activity-detail-facts">
      <summary>{t("activity.moreInfo")}</summary>
      <FactList
        facts={identifiers.map(([label, value]) => [
          label,
          <Identifier value={value} label={label} />,
        ])}
      />
    </details>
  );
}
