import { useCallback, useEffect, useRef, useState } from "react";
import type { Job, Device, Status, ActivityFilter, SearchTerm } from "../api";
import { Icon } from "../components/Icon";
import { ErrorNotice, StaleNotice } from "../components/ErrorNotice";
import { RefreshButton } from "../components/RefreshButton";
import { compactIdentifier } from "../format";
import { formatLocale, t } from "../i18n";
import { CommandActivityDetail } from "./activity/CommandActivityDetail";
import { ActivityDetail } from "./activity/ActivityDetail";
import { ActivityRow } from "./activity/ActivityRow";
import { operationLabel } from "./activity/operation";
import { useActivityFeed } from "./activity/useActivityFeed";

interface Props {
  active: boolean;
  paused: boolean;
  status: Status | null;
  devices: Device[];
}
const KINDS = [
  "exec",
  "stream_exec",
  "push",
  "pull",
  "screenshot",
  "forward",
] as const;
/** Each word must match; names and labels only exist here, so they are resolved here. */
function searchTerms(query: string, names: [string, string][]): SearchTerm[] {
  return query
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .map((text) => {
      const word = text.toLocaleLowerCase();
      return {
        text: text.slice(0, 64),
        devices: names
          .filter(([, name]) => name.toLocaleLowerCase().includes(word))
          .map(([id]) => id),
        kinds: KINDS.filter((kind) =>
          operationLabel(kind).toLocaleLowerCase().includes(word),
        ),
      };
    });
}
function dayLabel(time: number) {
  const date = new Date(time);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return t("activity.today");
  if (date.toDateString() === yesterday.toDateString())
    return t("activity.yesterday");
  return date.toLocaleDateString(formatLocale(), {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}
export function ActivityPage({ active, paused, status, devices }: Props) {
  const [selection, setSelection] = useState<{ job: Job; dbId: string } | null>(
    null,
  );
  const [detailLoading, setDetailLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const names: [string, string][] = devices.map((device) => [
    device.device_id,
    device.name,
  ]);
  if (status?.local.device_id && status.local.name)
    names.push([status.local.device_id, status.local.name]);
  const selectionOrigin = useRef<HTMLButtonElement | null>(null);
  const activityFeed = useActivityFeed(
    active,
    paused,
    selection !== null,
    searchTerms(query, names),
  );
  const {
    filter,
    jobs,
    scriptTitles,
    stale,
    nextCursor,
    dbId,
    loading,
    refreshing,
    loadingMore,
    error,
    moreError,
    refreshVersion,
    loadMore,
    refreshActivities,
  } = activityFeed;
  const panel = useRef<HTMLElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const [nearEnd, setNearEnd] = useState(false);
  useEffect(() => {
    const node = end.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      ([entry]) => setNearEnd(entry.isIntersecting),
      { root: panel.current, rootMargin: "0px 0px 240px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  // Loading continues while the end stays visible, including beside open details.
  useEffect(() => {
    if (
      nearEnd &&
      active &&
      !paused &&
      !stale &&
      nextCursor !== null &&
      !loadingMore &&
      !moreError
    )
      void loadMore();
  }, [
    nearEnd,
    active,
    paused,
    stale,
    nextCursor,
    loadingMore,
    moreError,
    loadMore,
  ]);
  const deviceLabel = useCallback(
    (id: string) => {
      if (id === status?.local.device_id)
        return status.local.name || compactIdentifier(id);
      return (
        devices.find((device) => device.device_id === id)?.name ||
        compactIdentifier(id)
      );
    },
    [status, devices],
  );
  const closeDetails = useCallback(() => {
    setSelection(null);
    setDetailLoading(false);
    selectionOrigin.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (!active || !selection) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !paused &&
        !document.querySelector("dialog[open]")
      )
        closeDetails();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active, selection, paused, closeDetails]);
  const groups: { day: string; jobs: Job[] }[] = [];
  for (const job of jobs) {
    const day = dayLabel(job.created_at_ms);
    const group = groups.at(-1);
    if (group?.day === day) group.jobs.push(job);
    else groups.push({ day, jobs: [job] });
  }
  const selectFilter = (value: ActivityFilter) => {
    closeDetails();
    activityFeed.selectFilter(value);
  };
  const detailProps = {
    active,
    paused,
    refreshVersion,
    deviceLabel,
    onLoading: setDetailLoading,
    retry: refreshActivities,
    onClose: closeDetails,
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>{t("activity.title")}</h1>
          <p>{t("activity.description")}</p>
        </div>
      </div>
      <div className={`activity-layout ${selection ? "has-selection" : ""}`}>
        <div className="activity-list">
          <div className="list-toolbar">
            <div
              className="segmented"
              role="group"
              aria-label={t("activity.activityState")}
            >
              {(["all", "running", "failed"] as const).map((value) => (
                <button
                  key={value}
                  className={filter === value ? "selected" : ""}
                  aria-pressed={filter === value}
                  onClick={() => selectFilter(value)}
                >
                  {t(
                    value === "all"
                      ? "activity.allActivities"
                      : value === "running"
                        ? "activity.running"
                        : "activity.failed",
                  )}
                </button>
              ))}
            </div>
            <div className="list-toolbar-actions">
              <label className="list-search">
                <Icon name="search" />
                <input
                  type="text"
                  value={search}
                  aria-label={t("activity.search")}
                  placeholder={t("activity.search")}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </label>
              <RefreshButton
                compact
                refreshing={selection ? detailLoading : refreshing}
                onClick={refreshActivities}
              />
            </div>
          </div>
          <section
            ref={panel}
            className="activity-record-panel"
            aria-label={t("activity.timeline")}
            aria-busy={refreshing || loadingMore}
          >
            <div id="activity-records" className={stale ? "is-stale" : ""}>
              {groups.map((group) => (
                <div className="timeline-day" key={group.day}>
                  <h2>{group.day}</h2>
                  <ol className="activity-timeline">
                    {group.jobs.map((job) => (
                      <li key={job.job_id}>
                        <ActivityRow
                          job={job}
                          scriptTitle={scriptTitles[job.job_id]}
                          sourceName={deviceLabel(job.source_device_id)}
                          active={active && !paused && !selection}
                          selected={selection?.job.job_id === job.job_id}
                          onSelect={(button) => {
                            selectionOrigin.current = button;
                            activityFeed.clearLoading();
                            activityFeed.clearError();
                            setSelection({ job, dbId: dbId || job.db_id });
                          }}
                        />
                      </li>
                    ))}
                  </ol>
                </div>
              ))}
            </div>
            {!groups.length && !error && (
              <p className="empty-state">
                {loading
                  ? t("activity.loading")
                  : query || filter !== "all"
                    ? t("activity.emptyFiltered")
                    : t("activity.empty")}
              </p>
            )}
            <div ref={end} className="activity-more" role="status">
              {moreError ? (
                <>
                  <span title={moreError}>{t("activity.loadMoreFailed")}</span>
                  <button
                    className="text-button"
                    onClick={activityFeed.retryMore}
                  >
                    {t("common.retry")}
                  </button>
                </>
              ) : loadingMore ? (
                t("activity.loadingMore")
              ) : (
                nextCursor === null && jobs.length >= 50 && t("activity.end")
              )}
            </div>
          </section>
          {error &&
            (jobs.length && !stale ? (
              <StaleNotice
                text={t("activity.refreshFailed")}
                detail={error}
                retry={refreshActivities}
              />
            ) : (
              <ErrorNotice
                title={t("activity.loadFailed")}
                detail={error}
                retry={refreshActivities}
                dismiss={activityFeed.clearError}
              />
            ))}
        </div>
        {selection && (
          <aside className="activity-detail" aria-label={t("activity.details")}>
            {selection.job.kind === "exec" ? (
              <CommandActivityDetail
                key={`${selection.dbId}:${selection.job.job_id}`}
                selection={{ job: selection.job, dbId: selection.dbId }}
                scriptTitle={scriptTitles[selection.job.job_id]}
                status={status}
                {...detailProps}
              />
            ) : (
              <ActivityDetail
                key={`${selection.dbId}:${selection.job.job_id}`}
                selection={selection}
                {...detailProps}
              />
            )}
          </aside>
        )}
      </div>
    </>
  );
}
