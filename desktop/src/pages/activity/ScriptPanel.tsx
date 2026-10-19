import { useEffect, useState, type ReactNode } from "react";
import { api, type ActivityScript, type CommandJob } from "../../api";
import { useOperations } from "../../app/useOperations";
import { ErrorNotice } from "../../components/ErrorNotice";
import { Icon } from "../../components/Icon";
import { errorText, fileSize } from "../../format";
import { t } from "../../i18n";

/** What a script ran. A kept body never changes, so it is read once per detail. */
export function ScriptPanel({ dbId, job }: { dbId: string; job: CommandJob }) {
  const { busy, operate, notify } = useOperations();
  const [script, setScript] = useState<ActivityScript | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const id = job.job_id;
  useEffect(() => {
    let current = true;
    setError(null);
    api.script(dbId, id).then(
      (value) => {
        if (current) setScript(value);
      },
      (e) => {
        if (current) setError(errorText(e));
      },
    );
    return () => {
      current = false;
    };
  }, [dbId, id, attempt]);

  const text = script?.text ?? null;
  let body: ReactNode;
  if (text !== null)
    body = (
      <>
        <pre
          className="script-body"
          tabIndex={0}
          aria-label={t("script.title")}
        >
          {text}
        </pre>
        {script?.truncated && (
          <p className="script-note">{t("script.truncated")}</p>
        )}
      </>
    );
  else if (script) body = <p className="script-note">{t("script.expired")}</p>;
  else if (error)
    body = (
      <ErrorNotice
        title={t("script.loadFailed")}
        detail={error}
        retry={() => setAttempt((value) => value + 1)}
      />
    );
  else body = <p className="script-note">{t("script.loading")}</p>;

  return (
    <section className="panel script-panel" aria-labelledby="script-heading">
      <div className="script-toolbar">
        <strong id="script-heading">{t("script.title")}</strong>
        <span className="script-meta">
          {job.params.shell}
          {fileSize(job.params.input_size)}
        </span>
        {text !== null && (
          <button
            className="text-button"
            disabled={busy}
            onClick={async () => {
              const copied = await operate(
                async () => {
                  await api.copyText(text);
                  return true;
                },
                { name: "copy_script", title: "script.copyFailed" },
              );
              if (copied) notify("script.copied");
            }}
          >
            <Icon name="copy" />
            {t("script.copy")}
          </button>
        )}
      </div>
      {body}
    </section>
  );
}
