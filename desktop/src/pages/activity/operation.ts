import type { Attachment, CommandParams, Job } from "../../api";
import { commandText, fileSize } from "../../format";
import { t } from "../../i18n";

export function operationLabel(op: string) {
  const labels: Record<string, string> = {
    exec: t("activity.command"),
    push: t("activity.receiveFile"),
    pull: t("activity.sendFile"),
    screenshot: t("activity.screenshot"),
    stream_exec: t("activity.streamCommand"),
    forward: t("activity.forward"),
  };
  return labels[op] || op;
}

/** A script names an interpreter and sends its body as input instead of a program. */
export function isScript(job: Job) {
  return (
    (job.kind === "exec" || job.kind === "stream_exec") &&
    !!job.params.shell &&
    !job.params.program
  );
}
/** Scripts whose body was not kept are named by their interpreter and size. */
export function scriptLabel(params: CommandParams) {
  return `${t("job.scriptWith", { shell: params.shell ?? "" })}${fileSize(params.input_size)}`;
}
/** A script's title is its first meaningful line, while its body is kept. */
export function jobDescription(job: Job, scriptTitle?: string) {
  if (job.kind === "exec" || job.kind === "stream_exec")
    return isScript(job)
      ? (scriptTitle ?? scriptLabel(job.params))
      : commandText(job.params);
  if (job.kind === "push" || job.kind === "pull")
    return job.result?.path || job.params.path;
  if (job.kind === "forward") return `localhost:${job.params.port}`;
  return "";
}
export function jobSize(job: Job) {
  return job.result && "size" in job.result
    ? job.result.size
    : job.kind === "push"
      ? job.params.size
      : null;
}
export function jobDuration(job: Job) {
  return job.result && "duration_ms" in job.result
    ? job.result.duration_ms
    : null;
}
export function attachmentLabel(attachment: Attachment | null) {
  if (!attachment) return t("attachment.notRetained");
  if (attachment.status === "expired") return t("attachment.expired");
  if (attachment.status === "missing") return t("attachment.missing");
  return attachment.name;
}
