import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import { useOperations } from "../app/useOperations";
import { t } from "../i18n";
import { Icon } from "./Icon";

/** A modal dialog covers the window, so notices move into the topmost open one. */
function useTopDialog() {
  const [dialog, setDialog] = useState<HTMLDialogElement | null>(null);
  useEffect(() => {
    const update = () =>
      setDialog(
        [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")].at(
          -1,
        ) ?? null,
      );
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributeFilter: ["open"],
    });
    return () => observer.disconnect();
  }, []);
  return dialog;
}

/** Success and failure notices share the bottom of the window and never move the page. */
export function Notices() {
  const { error, toast, clearError } = useOperations();
  const dialog = useTopDialog();
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const failure = error?.id;
  useEffect(() => setCopy("idle"), [failure]);
  if (!error && !toast) return null;
  const notices = (
    <div className={`notices ${dialog ? "over-dialog" : ""}`}>
      {error && (
        <div className="failure-notice" role="alert">
          <Icon name="alert" />
          <div className="failure-content">
            <strong>{error.title}</strong>
            <details className="error-details">
              <summary>{t("error.details")}</summary>
              <pre>{error.detail}</pre>
            </details>
            <div className="failure-actions">
              {error.retry && (
                <button onClick={error.retry}>{t("common.retry")}</button>
              )}
              <button
                className="text-button"
                onClick={() =>
                  void api.copyText(`${error.title}\n${error.detail}`).then(
                    () => setCopy("copied"),
                    () => setCopy("failed"),
                  )
                }
              >
                {t(
                  copy === "copied"
                    ? "error.copied"
                    : copy === "failed"
                      ? "error.copyFailed"
                      : "error.copy",
                )}
              </button>
            </div>
          </div>
          <button
            className="icon-button"
            aria-label={t("error.close")}
            title={t("common.close")}
            onClick={clearError}
          >
            <Icon name="close" />
          </button>
        </div>
      )}
      {toast && (
        <div id="toast" className="toast" role="status">
          <Icon name="check" />
          {toast}
        </div>
      )}
    </div>
  );
  return dialog ? createPortal(notices, dialog) : notices;
}
