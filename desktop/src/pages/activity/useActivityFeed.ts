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
  /** Older refreshes must not overwrite the latest first-page snapshot. */
  newestPageEnd: Job | null;
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
    newestPageEnd: page.entries.at(-1) ?? null,
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
        newestPageEnd: oldest,
      }
    : { ...replaced, generation: feed.generation };
}

/** Replace one older page's time range, preserving newer reads and loaded history. */
function mergeOlderPage(
  feed: Feed,
  key: string,
  generation: number,
  before: Job,
  page: ActivityPage,
): Feed {
  if (
    feed.key !== key ||
    feed.dbId !== page.db_id ||
    feed.generation !== generation ||
    !feed.newestPageEnd
  )
    return feed;
  const upper = newer(before, feed.newestPageEnd) ? feed.newestPageEnd : before;
  const last = page.entries.at(-1);
  if (last && !newer(upper, last)) return feed;
  const newerJobs = feed.jobs.filter((job) => !newer(upper, job));
  const olderJobs =
    page.next_cursor !== null && last
      ? feed.jobs.filter((job) => newer(last, job))
      : [];
  const entries = page.entries.filter((job) => newer(upper, job));
  const titles: Record<string, string> = {};
  for (const job of [...newerJobs, ...olderJobs]) {
    const title = feed.titles[job.job_id];
    if (title !== undefined) titles[job.job_id] = title;
  }
  for (const job of entries) {
    const title = page.script_titles?.[job.job_id];
    if (title !== undefined) titles[job.job_id] = title;
  }
  const nextCursor = olderJobs.length ? feed.nextCursor : page.next_cursor;
  return {
    ...feed,
    jobs: [...newerJobs, ...entries, ...olderJobs],
    titles,
    nextCursor,
    generation: feed.generation + Number(nextCursor !== feed.nextCursor),
  };
}

export function useActivityFeed(
  active: boolean,
  paused: boolean,
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
    newestPageEnd: null,
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
    let olderPending = false;
    const query = latestQuery.current;
    const refreshOlder = async (page: ActivityPage, loaded: Feed) => {
      if (olderPending || !overlaps(loaded, key, page)) return;
      const oldest = loaded.jobs.at(-1);
      olderPending = true;
      try {
        let before = page.entries.at(-1);
        let cursor = page.next_cursor;
        while (oldest && before && cursor !== null && newer(before, oldest)) {
          const older = await api.activity(cursor, query.filter, query.search);
          if (
            disposed ||
            current.current.key !== key ||
            current.current.dbId !== page.db_id ||
            current.current.generation !== loaded.generation
          )
            return;
          const upper = before;
          setFeed((feed) =>
            mergeOlderPage(feed, key, loaded.generation, upper, older),
          );
          before = older.entries.at(-1);
          cursor = older.next_cursor;
        }
      } catch (e) {
        if (
          !disposed &&
          current.current.key === key &&
          current.current.dbId === page.db_id &&
          current.current.generation === loaded.generation
        )
          setError(errorText(e));
      } finally {
        olderPending = false;
      }
    };
    const load = async () => {
      if (pending || disposed) return;
      pending = true;
      const token = ++request.current;
      const changed = current.current.key !== key;
      setLoading(changed);
      setRefreshing(true);
      try {
        const page = await api.activity(null, query.filter, query.search);
        if (disposed || token !== request.current) return;
        const loaded = current.current;
        // Publish the latest page first. Older reads run independently so a slow
        // history page cannot hold up the next poll or an explicit refresh.
        setFeed((feed) => mergeNewest(feed, key, query, page));
        setError(null);
        if (changed) setMoreError(null);
        void refreshOlder(page, loaded);
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
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => {
      disposed = true;
      request.current++;
      setLoading(false);
      setRefreshing(false);
      clearInterval(timer);
    };
  }, [active, paused, key, refreshVersion]);

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
                newestPageEnd: null,
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
    clearError: () => setError(null),
    retryMore: () => {
      setMoreError(null);
      void loadMore();
    },
    refreshActivities: () => setRefreshVersion((value) => value + 1),
  };
}
