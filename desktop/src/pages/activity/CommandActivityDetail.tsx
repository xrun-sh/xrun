import { useLayoutEffect, useRef, useState } from "react";
import type { Status } from "../../api";
import { Icon } from "../../components/Icon";
import { ErrorNotice } from "../../components/ErrorNotice";
import { Select } from "../../components/Select";
import { isRunning } from "../../format";
import { t } from "../../i18n";
import { ActivityFacts, ActivityIdentifiers } from "./ActivityFacts";
import { ActivityState } from "./ActivityState";
import { isScript, jobDescription } from "./operation";
import { ScriptPanel } from "./ScriptPanel";
import { useCommandOutput, type CommandSelection } from "./useCommandOutput";
interface DetailProps {
  selection: CommandSelection;
  /** First meaningful line of a script whose body is still kept. */
  scriptTitle?: string;
  active: boolean;
  paused: boolean;
  refreshVersion: number;
  status: Status | null;
  deviceLabel: (id: string) => string;
  onLoading: (value: boolean) => void;
  retry: () => void;
  onClose: () => void;
}

export function CommandActivityDetail({
  selection,
  scriptTitle,
  active,
  paused,
  refreshVersion,
  status,
  deviceLabel,
  onLoading,
  retry,
  onClose,
}: DetailProps) {
  const { job, error, outputStatus, revision, outputBuffer, clearError } =
    useCommandOutput({ selection, active, paused, refreshVersion, onLoading });
  const [stream, setStream] = useState("all");
  const [follow, setFollow] = useState(true);
  const log = useRef<HTMLPreElement>(null);
  const lastScrollTop = useRef(0);
  useLayoutEffect(() => {
    if (follow && log.current) {
      log.current.scrollTop = log.current.scrollHeight;
      lastScrollTop.current = log.current.scrollTop;
    }
  }, [revision, follow, stream]);

  const source = deviceLabel(job.source_device_id);
  const script = isScript(job);
  const warnings = [];
  if (job.error_message) warnings.push(job.error_message);
  if (!job.output_complete) {
    const reasons: Record<string, string> = {
      TRUNCATED: t("output.truncated"),
      LOG_EXPIRED: t("output.expired"),
      DETACHED_OUTPUT: t("output.detached"),
    };
    warnings.push(
      reasons[job.output_loss_reason || ""] ||
        t("output.incomplete", {
          reason: job.output_loss_reason || t("output.unknownReason"),
        }),
    );
  }
  if (job.leftover_possible) warnings.push(t("output.leftover"));
  if (isRunning(job) && status && !status.local.daemon_running)
    warnings.push(t("output.stale"));

  return (
    <section id="command-activity-detail">
      <button
        className="activity-close icon-button"
        aria-label={t("activity.closeDetails")}
        onClick={onClose}
      >
        <Icon name="close" />
      </button>
      <article className="panel command-heading">
        <div className="activity-detail-title">
          <h2 className={script && scriptTitle === undefined ? "" : "mono"}>
            {jobDescription(job, scriptTitle)}
          </h2>
          <ActivityState job={job} />
        </div>
        <ActivityFacts job={job} source={source} />
        <ActivityIdentifiers job={job} />
      </article>
      {!!warnings.length && (
        <p id="command-warning" className="inline-notice" role="status">
          {warnings.join(" ")}
        </p>
      )}
      {script && <ScriptPanel dbId={selection.dbId} job={job} />}
      <section className="panel output-panel">
        <div className="output-toolbar">
          <strong>{t("output.title")}</strong>
          <label className="sr-only" htmlFor="output-stream">
            {t("output.type")}
          </label>
          <Select
            id="output-stream"
            value={stream}
            compact
            onChange={setStream}
            options={[
              { value: "all", label: t("output.all") },
              { value: "stdout", label: t("output.stdout") },
              { value: "stderr", label: t("output.stderr") },
            ]}
          />
          <label className="follow-output">
            <input
              type="checkbox"
              checked={follow}
              onChange={(event) => setFollow(event.target.checked)}
            />
            {t("output.follow")}
          </label>
        </div>
        <pre
          id="command-log"
          ref={log}
          className="command-log"
          data-filter={stream}
          tabIndex={0}
          aria-label={t("output.log")}
          onScroll={(event) => {
            const node = event.currentTarget;
            const movingUp = node.scrollTop < lastScrollTop.current;
            lastScrollTop.current = node.scrollTop;
            if (
              follow &&
              movingUp &&
              node.scrollHeight - node.clientHeight - node.scrollTop > 24
            )
              setFollow(false);
          }}
        >
          {outputBuffer.current.chunks.length ? (
            outputBuffer.current.chunks.map((chunk) => (
              <span
                key={chunk.id}
                data-stream={chunk.stream}
                className={chunk.stream === "stderr" ? "output-stderr" : ""}
              >
                {chunk.text}
              </span>
            ))
          ) : (
            <span className="muted">{t("output.empty")}</span>
          )}
        </pre>
        <div className="output-footer">
          <span>{outputStatus}</span>
          {outputBuffer.current.truncated && (
            <span>{t("output.recentOnly")}</span>
          )}
          {!follow && (
            <button className="text-button" onClick={() => setFollow(true)}>
              {t("output.jumpToLatest")}
            </button>
          )}
        </div>
      </section>
      {error && (
        <ErrorNotice
          title={t("output.failed")}
          detail={error}
          retry={retry}
          dismiss={clearError}
        />
      )}
    </section>
  );
}
