import { t } from "../i18n";
import { Icon } from "./Icon";

/** Content that failed to load reports it in place, with a retry. */
export function ErrorNotice({
  title,
  detail,
  retry,
  dismiss,
}: {
  title: string;
  detail: string;
  retry?: () => void;
  dismiss?: () => void;
}) {
  return (
    <div className="error-notice" role="alert">
      <div className="error-heading">
        <strong>{title}</strong>
        {dismiss && (
          <button
            className="text-button"
            onClick={dismiss}
            aria-label={t("error.close")}
          >
            {t("common.close")}
          </button>
        )}
      </div>
      <details className="error-details">
        <summary>{t("error.details")}</summary>
        <pre>{detail}</pre>
      </details>
      {retry && <button onClick={retry}>{t("common.retry")}</button>}
    </div>
  );
}

/** A failed background refresh keeps the last data and only says it may be outdated. */
export function StaleNotice({
  text,
  detail,
  retry,
}: {
  text: string;
  detail: string;
  retry: () => void;
}) {
  return (
    <p className="stale-notice" role="status">
      <Icon name="alert" />
      <span title={detail}>{text}</span>
      <button className="text-button" onClick={retry}>
        {t("common.retry")}
      </button>
    </p>
  );
}
