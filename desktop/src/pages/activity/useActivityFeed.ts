import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  type ActivityFilter,
  type ActivityPage,
  type Job,
  type SearchTerm,
} from "../../api";
import { errorCode, errorText } from "../../errors";

interface Query {
  filter: ActivityFilter;
  search: SearchTerm[];
}
interface Feed {
  key: string;
  query: Query;
  dbId: string | null;
  jobs: Job[];
  /** Script titles of the loaded jobs, by job ID. */
  titles: Record<string, string>;
  nextCursor: string | null;
  /** Replacing the list invalidates older pages requested before it. */
  generation: number;
}

/** The core orders activity by creation time, then job ID, newest first. */
const newer = (a: Job, b: Job) =>
  a.created_at_ms !== b.created_at_ms
    ? a.created_at_ms > b.created_at_ms
    : a.job_id > b.job_id;

/** Only overlapping results can preserve previously loaded older records. */
function overlaps(feed: Feed, key: string, page: ActivityPage) {
  const oldest = page.entries.at(-1);
  const first = feed.jobs[0];
  return (
    feed.key === key &&
    feed.dbId === page.db_id &&
    oldest !== undefined &&
    first !== undefined &&
    !newer(oldest, first)
  );
}

/** Refresh the newest page while keeping loaded older pages contiguous. */
function mergeNewest(
  feed: Feed,
  key: string,
  query: Query,
  page: ActivityPage,
) {
  const replaced: Feed = {
    key,
    query,
    dbId: page.db_id,
    jobs: page.entries,
    titles: { ...page.script_titles },
    nextCursor: page.next_cursor,
    generation: feed.generation + 1,
  };
  const oldest = page.entries.at(-1);
  if (!overlaps(feed, key, page) || page.next_cursor === null || !oldest)
    return replaced;
  const fresh = new Set(page.entries.map((job) => job.job_id));
  const older = feed.jobs.filter(
    (job) => !fresh.has(job.job_id) && newer(oldest, job),
  );
  // A missing title means the refreshed script expired, so only untouched rows
  // inherit a cached title.
  const titles = { ...page.script_titles };
  for (const job of older) {
    const title = feed.titles[job.job_id];
    if (title !== undefined) titles[job.job_id] = title;
  }
  return older.length
    ? {
        ...feed,
        jobs: [...page.entries, ...older],
        titles,
      }
    : { ...replaced, generation: feed.generation };
}

export function useActivityFeed(
  active: boolean,
  paused: boolean,
  selected: boolean,
  search: SearchTerm[],
) {
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const query = { filter, search };
  const key = JSON.stringify(query);
  const [feed, setFeed] = useState<Feed>({
    key: "",
    query,
    dbId: null,
    jobs: [],
    titles: {},
    nextCursor: null,
    generation: 0,
  });
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const request = useRef(0);
  const current = useRef(feed);
  current.current = feed;
  const latestQuery = useRef(query);
  latestQuery.current = query;
  const moreRequest = useRef(false);

  useEffect(() => {
    if (!active || paused) return;
    let disposed = false;
    let pending = false;
    const query = latestQuery.current;
    const load = async () => {
      if (pending || disposed) return;
      pending = true;
      const token = ++request.current;
      const changed = current.current.key !== key;
      setLoading(changed);
      setRefreshing(true);
      try {
        let page = await api.activity(null, query.filter, query.search);
        if (disposed || token !== request.current) return;
        const loaded = current.current;
        const oldest = overlaps(loaded, key, page)
          ? loaded.jobs.at(-1)
          : undefined;
        let last = page.entries.at(-1);
        // Refresh the loaded time range as well: older jobs can finish, stop
        // matching a filter or lose their retained script body.
        while (
          oldest &&
          last &&
          page.next_cursor !== null &&
          newer(last, oldest)
        ) {
          const older = await api.activity(
            page.next_cursor,
            query.filter,
            query.search,
          );
          if (disposed || token !== request.current) return;
          last = older.entries.at(-1);
          page = {
            ...older,
            entries: [...page.entries, ...older.entries],
            script_titles: { ...page.script_titles, ...older.script_titles },
          };
        }
        setFeed((feed) => mergeNewest(feed, key, query, page));
        setError(null);
        if (changed) setMoreError(null);
      } catch (e) {
        if (!disposed && token === request.current) setError(errorText(e));
      } finally {
        pending = false;
        if (!disposed) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    };
    // An open detail pauses polling, but a new filter or search still loads once.
    if (!selected || current.current.key !== key) void load();
    const timer = selected ? undefined : setInterval(() => void load(), 3000);
    return () => {
      disposed = true;
      request.current++;
      setLoading(false);
      setRefreshing(false);
      clearInterval(timer);
    };
  }, [active, paused, selected, key, refreshVersion]);

  const loadMore = useCallback(async () => {
    const start = current.current;
    if (start.nextCursor === null || moreRequest.current) return;
    moreRequest.current = true;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await api.activity(
        start.nextCursor,
        start.query.filter,
        start.query.search,
      );
      setFeed((feed) => {
        if (feed.generation !== start.generation || feed.key !== start.key)
          return feed;
        const loaded = new Set(feed.jobs.map((job) => job.job_id));
        return {
          ...feed,
          jobs: [
            ...feed.jobs,
            ...page.entries.filter((job) => !loaded.has(job.job_id)),
          ],
          titles: { ...page.script_titles, ...feed.titles },
          nextCursor: page.next_cursor,
        };
      });
    } catch (e) {
      if (
        current.current.generation !== start.generation ||
        current.current.key !== start.key
      )
        return;
      if (errorCode(e) === "DB_RESET") {
        // Invalidate the old cursor before another intersection can reuse it.
        // The changed key also forces a first-page read beside open details.
        setFeed((feed) =>
          feed.generation !== start.generation || feed.key !== start.key
            ? feed
            : {
                ...feed,
                key: "",
                dbId: null,
                jobs: [],
                titles: {},
                nextCursor: null,
                generation: feed.generation + 1,
              },
        );
        setRefreshVersion((value) => value + 1);
      } else setMoreError(errorText(e));
    } finally {
      moreRequest.current = false;
      setLoadingMore(false);
    }
  }, []);

  return {
    filter,
    jobs: feed.jobs,
    scriptTitles: feed.titles,
    stale: feed.key !== key,
    nextCursor: feed.nextCursor,
    dbId: feed.dbId,
    loading,
    refreshing,
    loadingMore,
    error,
    moreError,
    refreshVersion,
    loadMore,
    selectFilter: (value: ActivityFilter) => {
      setFilter(value);
      setError(null);
      setMoreError(null);
    },
    clearLoading: () => {
      setLoading(false);
      setRefreshing(false);
    },
    clearError: () => setError(null),
    retryMore: () => {
      setMoreError(null);
      void loadMore();
    },
    refreshActivities: () => setRefreshVersion((value) => value + 1),
  };
}
