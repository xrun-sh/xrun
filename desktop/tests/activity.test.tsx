import { expect, test } from "bun:test";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  fixture,
  commandJob,
  event,
  activityJob,
  findActivity,
  historyArgs,
  revealOlderActivity,
  selectOption,
} from "./fixtures";
import type { Attachment, SearchTerm } from "../src/api";
import { dateTime, duration } from "../src/format";

const retained: Attachment = {
  mime: "image/png",
  id: "capture-one",
  name: "screenshot.png",
  size: 68,
  sha256: "a".repeat(64),
  created_at_ms: Date.now(),
  status: "available",
  expires_at_ms: Date.now() + 30 * 86400000,
};
const image =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8JkAAAAASUVORK5CYII=";

test("an unsupported database stops automatic output reads but permits an explicit retry", async () => {
  let reads = 0;
  const { page, poll } = await fixture({
    activity_history: () => ({
      db_id: "db-original",
      entries: [commandJob()],
      next_cursor: null,
    }),
    job_output: () => {
      reads++;
      throw { code: "DB_SCHEMA_MISMATCH", message: "unsupported schema" };
    },
  });
  await page("活动");
  fireEvent.click(await findActivity("ABC123"));
  await screen.findByText("DB_SCHEMA_MISMATCH: unsupported schema");
  expect(reads).toBe(1);
  await poll();
  expect(reads).toBe(1);
  fireEvent.click(screen.getByRole("button", { name: "刷新" }));
  await waitFor(() => expect(reads).toBe(2));
});
test("command output deduplicates sequences, decodes split UTF-8 and renders failures as text", async () => {
  let reads = 0;
  const { calls, page, poll } = await fixture({
    activity_history: () => ({
      db_id: "db-original",
      entries: [commandJob()],
      next_cursor: null,
    }),
    job_output: () =>
      ++reads === 1
        ? {
            job: commandJob(),
            has_more: false,
            events: [
              event(1, "stdout", [0xe4, 0xb8]),
              event(2, "stderr", "<img id=log-injected>\n"),
              event(3, "stdout", [0xad]),
            ],
          }
        : {
            job: commandJob("ABC123", {
              state: "failed",
              result: {
                exit_code: 7,
                signal: null,
                duration_ms: 1234,
                input_bytes: null,
                stdout_bytes: null,
                stderr_bytes: null,
              },
              last_log_seq: 4,
              output_complete: false,
              output_loss_reason: "TRUNCATED",
            }),
            has_more: false,
            events: [
              event(3, "stdout", [0xad]),
              event(4, "stderr", "\u001b[31mfailed\u001b[0m\n"),
            ],
          },
  });
  await page("活动");
  fireEvent.click(await findActivity("ABC123"));
  await waitFor(() =>
    expect(document.getElementById("command-log")?.textContent).toContain("中"),
  );
  expect(document.getElementById("command-log")?.textContent).not.toContain(
    "�",
  );
  expect(document.getElementById("command-injected")).toBeNull();
  expect(document.getElementById("log-injected")).toBeNull();
  await poll();
  expect(
    document.getElementById("command-log")?.textContent?.match(/中/g)?.length,
  ).toBe(1);
  expect(screen.getByText("异常退出")).toBeTruthy();
  expect(screen.getByText("退出码 7")).toBeTruthy();
  expect(document.getElementById("command-warning")?.textContent).toContain(
    "输出已被截断",
  );
  expect(document.getElementById("command-log")?.textContent).not.toContain(
    "\u001b",
  );
  expect(calls.filter((call) => call.command === "job_output")[1].args).toEqual(
    { dbId: "db-original", job: "ABC123", after: 3 },
  );
  await selectOption(screen.getByLabelText("输出类型"), "stderr");
  expect(document.getElementById("command-log")?.dataset.filter).toBe("stderr");
  await poll();
  expect(reads).toBe(2);
});

test("file records show interrupted transfers safely without requesting other devices", async () => {
  const { page, calls } = await fixture({
    activity_history: () => ({
      db_id: "db-original",
      entries: [
        activityJob("push", {
          path: '<img id="file-injected">',
          size: 2048,
          state: "lost",
        }),
      ],
      next_cursor: null,
    }),
  });
  await page("活动");
  await screen.findByText("结果丢失");
  expect(screen.getByText("接收文件")).toBeTruthy();
  expect(screen.getByText(/2.0 KiB/)).toBeTruthy();
  expect(document.getElementById("file-injected")).toBeNull();
  expect(screen.getByLabelText("活动状态")).toBeTruthy();
  expect(
    calls.find((call) => call.command === "activity_history")?.args,
  ).toEqual({
    before: null,
    filter: "all",
    search: [],
  });
});

test("late output cannot replace another command and database reset stops automatic reads", async () => {
  let completeOld!: (value: unknown) => void;
  let reads = 0;
  const pending = new Promise((resolve) => {
    completeOld = resolve;
  });
  const { page, poll } = await fixture({
    activity_history: () => ({
      db_id: "db-original",
      entries: [commandJob("OLD"), commandJob("NEW")],
      next_cursor: null,
    }),
    job_output: ({ job }) => {
      reads++;
      if (job === "OLD") return pending;
      throw { code: "DB_RESET", message: "database replaced" };
    },
  });
  await page("活动");
  fireEvent.click(await findActivity("OLD"));
  fireEvent.click(screen.getByRole("button", { name: "关闭活动详情" }));
  fireEvent.click(await findActivity("NEW"));
  await screen.findByText("DB_RESET: database replaced");
  await act(async () => {
    completeOld({
      job: commandJob("OLD"),
      events: [event(1, "stdout", "old output")],
      has_more: false,
    });
  });
  expect(screen.getByText("NEW")).toBeTruthy();
  expect(document.getElementById("command-log")?.textContent).not.toContain(
    "old output",
  );
  const previous = reads;
  await poll();
  expect(reads).toBe(previous);
});

const pages = (before: unknown) => {
  const older = Date.now() - 60_000;
  return {
    db_id: "db-original",
    entries: [
      before
        ? commandJob("PAGE2", { created_at_ms: older })
        : commandJob("PAGE1", { created_at_ms: older + 1000 }),
    ],
    next_cursor: before ? null : "page-2",
  };
};

test("older activity loads at the end of the list, also beside open details", async () => {
  const { page, calls, poll } = await fixture({
    activity_history: ({ before }) => pages(before),
    job_output: () => ({
      job: commandJob("PAGE1"),
      has_more: false,
      events: [],
    }),
  });
  await page("活动");
  fireEvent.click(await findActivity("PAGE1"));
  await screen.findByRole("complementary", { name: "活动详情" });
  expect(screen.queryByRole("button", { name: "下一页" })).toBeNull();
  await revealOlderActivity();
  await findActivity("PAGE2");
  expect(historyArgs(calls).at(-1)).toEqual({
    before: "page-2",
    filter: "all",
    search: [],
  });
  fireEvent.click(screen.getByRole("button", { name: "关闭活动详情" }));
  await poll();
  await findActivity("PAGE1");
  expect(document.querySelector('[data-job-id="PAGE2"]')).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "失败" }));
  await waitFor(() =>
    expect(historyArgs(calls).at(-1)).toEqual({
      before: null,
      filter: "failed",
      search: [],
    }),
  );
  await page("设置");
  const count = historyArgs(calls).length;
  await poll();
  expect(historyArgs(calls).length).toBe(count);
});

test("an older page failure stays at the end of the list and retries in place", async () => {
  let fail = true;
  await fixture({
    activity_history: ({ before }) => {
      if (before && fail) throw { code: "DB_BUSY", message: "locked" };
      return pages(before);
    },
  }).then(({ page }) => page("活动"));
  await findActivity("PAGE1");
  await revealOlderActivity();
  await screen.findByText("更早的活动未能读取。");
  expect(screen.queryByRole("alert")).toBeNull();
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await findActivity("PAGE2");
  expect(screen.queryByText("更早的活动未能读取。")).toBeNull();
});

test("database replacement discards the old cursor and reloads even with an open detail", async () => {
  let replaced = false;
  let oldCursorReads = 0;
  const selected = commandJob("SELECTED");
  const { page, calls } = await fixture({
    activity_history: ({ before }) => {
      if (before) {
        oldCursorReads++;
        // Bound the failing implementation so a regression cannot spin this test.
        if (oldCursorReads > 1)
          throw { code: "DB_BUSY", message: "obsolete cursor was reused" };
        throw { code: "DB_RESET", message: "database replaced" };
      }
      return {
        db_id: replaced ? "db-replaced" : "db-original",
        entries: [replaced ? commandJob("REPLACED") : selected],
        next_cursor: replaced ? null : "old-cursor",
        script_titles: {},
      };
    },
    job_output: () => ({ job: selected, events: [], has_more: false }),
  });
  await page("活动");
  fireEvent.click(await findActivity("SELECTED"));
  await screen.findByRole("complementary", { name: "活动详情" });
  replaced = true;
  await revealOlderActivity();
  await findActivity("REPLACED");
  expect(oldCursorReads).toBe(1);
  expect(
    historyArgs(calls).filter(({ before }) => before === null),
  ).toHaveLength(2);
  expect(document.querySelector('[data-job-id="SELECTED"]')).toBeNull();
});

test("a late pagination reset cannot discard a newly selected activity filter", async () => {
  let rejectOlder!: (error: unknown) => void;
  const pending = new Promise((_, reject) => {
    rejectOlder = reject;
  });
  const { page, calls } = await fixture({
    activity_history: ({ before, filter }) =>
      before
        ? pending
        : {
            db_id: "db-original",
            entries: [commandJob(filter === "failed" ? "FAILED" : "RECENT")],
            next_cursor: filter === "failed" ? null : "older",
            script_titles: {},
          },
  });
  await page("活动");
  await findActivity("RECENT");
  await revealOlderActivity();
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "失败" })),
  );
  const row = await findActivity("FAILED");
  const count = historyArgs(calls).length;
  await act(async () =>
    rejectOlder({ code: "DB_RESET", message: "old database replaced" }),
  );
  expect(await findActivity("FAILED")).toBe(row);
  expect(historyArgs(calls)).toHaveLength(count);
  expect(screen.queryByText("更早的活动未能读取。")).toBeNull();
});

for (const filter of ["all", "running"] as const) {
  test(`refresh updates older completed commands in the ${filter} activity filter`, async () => {
    const now = Date.now();
    const newest = Array.from({ length: 50 }, (_, index) =>
      commandJob(`NEW${index}`, { created_at_ms: now - index }),
    );
    const older = Array.from({ length: 10 }, (_, index) =>
      commandJob(`OLD${index}`, { created_at_ms: now - 1000 - index }),
    );
    let completed = false;
    const { page, poll } = await fixture({
      activity_history: ({ before, filter }) => {
        const entries = completed
          ? older.map((job, index) =>
              index === 0
                ? { ...job, state: "succeeded", finished_at_ms: now }
                : job,
            )
          : older;
        return {
          db_id: "db-original",
          entries: before
            ? entries.filter(
                (job) => filter !== "running" || job.state === "running",
              )
            : newest,
          next_cursor: before ? null : "older",
          script_titles: {},
        };
      },
    });
    await page("活动");
    if (filter === "running")
      await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: "进行中" })),
      );
    await revealOlderActivity();
    const row = await findActivity("OLD0");
    expect(row.querySelector(".activity-state")?.textContent).toBe("运行中");
    completed = true;
    await poll();
    if (filter === "running")
      expect(document.querySelector('[data-job-id="OLD0"]')).toBeNull();
    else {
      expect(await findActivity("OLD0")).toBe(row);
      expect(row.querySelector(".activity-state")?.textContent).toBe("已完成");
    }
    expect(await findActivity("OLD9")).toBeTruthy();
  });
}

test("refresh clears expired script titles on every loaded activity page", async () => {
  const now = Date.now();
  const params = {
    ...commandJob().params,
    program: "",
    shell: "sh",
    input_size: 20,
  };
  const newest = commandJob("SCRIPT1", { params, created_at_ms: now });
  const older = commandJob("SCRIPT2", { params, created_at_ms: now - 1000 });
  let expired = false;
  const { page, poll } = await fixture({
    activity_history: ({ before }) => ({
      db_id: "db-original",
      entries: [before ? older : newest],
      next_cursor: before ? null : "older",
      script_titles: expired
        ? {}
        : before
          ? { SCRIPT2: "echo old-script" }
          : { SCRIPT1: "echo new-script" },
    }),
  });
  await page("活动");
  await revealOlderActivity();
  const rows = [await findActivity("SCRIPT1"), await findActivity("SCRIPT2")];
  expect(rows[0].textContent).toContain("echo new-script");
  expect(rows[1].textContent).toContain("echo old-script");
  expired = true;
  await poll();
  for (const row of rows) {
    expect(row.querySelector(".activity-row-title")?.textContent).toBe(
      "sh 脚本 · 20 B",
    );
    expect(row.querySelector(".activity-row-title")?.className).not.toContain(
      "mono",
    );
  }
});

test("a failed background refresh keeps the list and only says it may be outdated", async () => {
  let fail = false;
  const { poll, page } = await fixture({
    activity_history: ({ before }) => {
      if (fail) throw { code: "DB_BUSY", message: "locked" };
      return pages(before);
    },
  });
  await page("活动");
  await findActivity("PAGE1");
  fail = true;
  await poll();
  const stale = await screen.findByText(
    "活动记录未能刷新，已保留上次读取的结果。",
  );
  expect(stale.title).toContain("DB_BUSY");
  expect(screen.queryByRole("alert")).toBeNull();
  await findActivity("PAGE1");
  fail = false;
  fireEvent.click(
    within(stale.parentElement!).getByRole("button", { name: "重试" }),
  );
  await waitFor(() =>
    expect(
      screen.queryByText("活动记录未能刷新，已保留上次读取的结果。"),
    ).toBeNull(),
  );
});

test("search covers every record, resolving device names and operation labels per word", async () => {
  const { page, calls } = await fixture({
    activity_history: ({ search }) => ({
      db_id: "db-original",
      entries: [
        commandJob((search as SearchTerm[]).length ? "FOUND" : "RECENT"),
      ],
      next_cursor: null,
    }),
  });
  await page("活动");
  await findActivity("RECENT");
  fireEvent.click(screen.getByRole("button", { name: "失败" }));
  fireEvent.change(screen.getByRole("textbox", { name: "搜索活动" }), {
    target: { value: "  mac1   截图 cargo " },
  });
  await findActivity("FOUND");
  expect(historyArgs(calls).at(-1)).toEqual({
    before: null,
    filter: "failed",
    search: [
      { text: "mac1", devices: ["self"], kinds: [] },
      { text: "截图", devices: [], kinds: ["screenshot"] },
      { text: "cargo", devices: [], kinds: [] },
    ],
  });
  expect(document.querySelector('[data-job-id="RECENT"]')).toBeNull();
});

test("details show how an activity ran and fold localized, copyable IDs", async () => {
  const script = commandJob("FACTS1", {
    state: "failed",
    params: {
      ...commandJob().params,
      program: "",
      args: [],
      shell: "zsh",
      cwd: "/Users/test/project",
    },
    result: {
      exit_code: 2,
      signal: null,
      duration_ms: 1500,
      input_bytes: 12,
      stdout_bytes: 0,
      stderr_bytes: 0,
    },
  });
  const upload = activityJob("push", { path: "/repo/notes.txt" });
  const { page, calls } = await fixture({
    activity_history: () => ({
      db_id: "db-original",
      entries: [script, upload],
      next_cursor: null,
    }),
    job_output: () => ({ job: script, has_more: false, events: [] }),
    activity_job: () => upload,
  });
  await page("活动");
  fireEvent.click(await findActivity("FACTS1"));
  const detail = await screen.findByRole("complementary", {
    name: "活动详情",
  });
  const fact = (label: string) =>
    within(detail.querySelector(".activity-facts") as HTMLElement).getByText(
      label,
    ).nextElementSibling?.textContent;
  expect(fact("来源")).toBe('<img id="injected" src=x onerror=alert(1)>');
  expect(fact("开始时间")).toBe(dateTime(script.started_at_ms!));
  expect(fact("耗时")).toBe(duration(1500));
  expect(fact("结果")).toBe("退出码 2");
  expect(fact("工作目录")).toBe("/Users/test/project");
  expect(fact("解释器")).toBe("zsh");
  const more = detail.querySelector<HTMLDetailsElement>(
    "details.activity-detail-facts",
  )!;
  expect(more.open).toBe(false);
  expect(detail.textContent).not.toMatch(/技术详情|Job ID|request_id/);
  fireEvent.click(within(more).getByText("更多信息"));
  expect(
    within(more).getByRole("button", { name: "复制任务 ID" }).textContent,
  ).toBe("FACTS1");
  expect(
    within(more).getByRole("button", { name: "复制来源设备 ID" }),
  ).toBeTruthy();
  fireEvent.click(within(more).getByRole("button", { name: "复制请求 ID" }));
  await screen.findByText("完整 ID 已复制");
  expect(
    calls.find((call) => call.command === "copy_identifier")?.args,
  ).toEqual({ value: "request-FACTS1" });
  fireEvent.click(screen.getByRole("button", { name: "关闭活动详情" }));
  fireEvent.click(await findActivity(upload.job_id));
  const file = await screen.findByRole("complementary", { name: "活动详情" });
  const facts = file.querySelector(".activity-facts")!.textContent;
  expect(facts).toContain("结束时间");
  expect(facts).not.toContain("结果");
  expect(facts).not.toContain("解释器");
});

test("scripts are listed by their first line and details show and copy the kept body", async () => {
  const params = {
    ...commandJob().params,
    program: "",
    args: [],
    shell: "sh",
    input_size: 2048,
    input_sha256: "b".repeat(64),
  };
  const titled = commandJob("SCRIPT1", { params });
  const expired = commandJob("SCRIPT2", {
    params: { ...params, input_size: 70000 },
  });
  const piped = commandJob("PIPED1", {
    params: { ...commandJob().params, input_size: 12 },
  });
  const jobs = [titled, expired, piped];
  const body = "#!/bin/sh\nset -e\ncargo test --workspace\n";
  const { page, calls } = await fixture({
    activity_history: () => ({
      db_id: "db-original",
      entries: jobs,
      script_titles: { SCRIPT1: "cargo test --workspace" },
      next_cursor: null,
    }),
    job_output: ({ job }) => ({
      job: jobs.find((candidate) => candidate.job_id === job),
      has_more: false,
      events: [],
    }),
    activity_script: ({ id }) =>
      id === "SCRIPT1"
        ? { text: body, truncated: true }
        : { text: null, truncated: false },
  });
  await page("活动");
  const title = async (id: string) =>
    (await findActivity(id)).querySelector(".activity-row-title")!;
  expect((await title("SCRIPT1")).textContent).toBe("cargo test --workspace");
  expect((await title("SCRIPT1")).className).toContain("mono");
  expect((await title("SCRIPT2")).textContent).toBe("sh 脚本 · 68.4 KiB");
  expect((await title("SCRIPT2")).className).not.toContain("mono");

  fireEvent.click(await findActivity("SCRIPT1"));
  let detail = await screen.findByRole("complementary", { name: "活动详情" });
  expect(within(detail).getByRole("heading", { level: 2 }).textContent).toBe(
    "cargo test --workspace",
  );
  await waitFor(() =>
    expect(detail.querySelector(".script-body")?.textContent).toBe(body),
  );
  expect(detail.querySelector(".script-meta")?.textContent).toBe(
    "sh · 2.0 KiB",
  );
  expect(detail.textContent).toContain("脚本超过 64 KiB");
  expect(
    calls.find((call) => call.command === "activity_script")?.args,
  ).toEqual({ dbId: "db-original", id: "SCRIPT1" });
  fireEvent.click(within(detail).getByRole("button", { name: "复制脚本" }));
  await screen.findByText("脚本已复制");
  expect(
    calls.find((call) => call.command === "copy_identifier")?.args,
  ).toEqual({ value: body });
  fireEvent.click(within(detail).getByText("更多信息"));
  expect(
    within(detail).getByRole("button", { name: "复制脚本 SHA-256" }),
  ).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "关闭活动详情" }));
  fireEvent.click(await findActivity("SCRIPT2"));
  detail = await screen.findByRole("complementary", { name: "活动详情" });
  await within(detail).findByText(
    "脚本内容已随附件保留期限清除，只保留了大小和 SHA-256。",
  );
  expect(within(detail).getByRole("heading", { level: 2 }).textContent).toBe(
    "sh 脚本 · 68.4 KiB",
  );
  expect(within(detail).queryByRole("button", { name: "复制脚本" })).toBeNull();

  // Program input is never kept, so only its size and digest are shown.
  fireEvent.click(screen.getByRole("button", { name: "关闭活动详情" }));
  fireEvent.click(await findActivity("PIPED1"));
  detail = await screen.findByRole("complementary", { name: "活动详情" });
  const facts = detail.querySelector(".activity-facts")!;
  expect(
    within(facts as HTMLElement).getByText("输入").nextElementSibling
      ?.textContent,
  ).toBe("12 B");
  expect(detail.querySelector(".script-panel")).toBeNull();
  fireEvent.click(within(detail).getByText("更多信息"));
  expect(
    within(detail).getByRole("button", { name: "复制输入 SHA-256" }),
  ).toBeTruthy();
  expect(
    calls.some(
      (call) => call.command === "activity_script" && call.args.id === "PIPED1",
    ),
  ).toBe(false);
});
test("scrolling up pauses automatic scrolling while new output continues to arrive", async () => {
  let reads = 0;
  const { page, poll } = await fixture({
    activity_history: () => ({
      db_id: "db-original",
      entries: [commandJob()],
      next_cursor: null,
    }),
    job_output: () => ({
      job: commandJob(),
      has_more: false,
      events: [event(++reads, "stdout", `output ${reads}\n`)],
    }),
  });
  await page("活动");
  fireEvent.click(await findActivity("ABC123"));
  await waitFor(() =>
    expect(document.getElementById("command-log")?.textContent).toContain(
      "output 1",
    ),
  );
  const log = document.getElementById("command-log")!;
  Object.defineProperty(log, "scrollHeight", {
    configurable: true,
    value: 1000,
  });
  Object.defineProperty(log, "clientHeight", {
    configurable: true,
    value: 200,
  });
  log.scrollTop = 800;
  fireEvent.scroll(log);
  log.scrollTop = 500;
  fireEvent.scroll(log);
  const follow = screen.getByLabelText("自动滚动到底部") as HTMLInputElement;
  expect(follow.checked).toBe(false);
  await poll();
  expect(log.textContent).toContain("output 2");
  expect(log.scrollTop).toBe(500);
  fireEvent.click(screen.getByRole("button", { name: "回到最新输出" }));
  expect(follow.checked).toBe(true);
  expect(log.scrollTop).toBeGreaterThanOrEqual(800);
});

test("returning from command details keeps loaded older activity and the list scroll position", async () => {
  const { page } = await fixture({
    activity_history: ({ before }) => pages(before),
    job_output: () => ({
      job: commandJob("PAGE2"),
      has_more: false,
      events: [],
    }),
  });
  await page("活动");
  await findActivity("PAGE1");
  await revealOlderActivity();
  const row = await findActivity("PAGE2");
  const list = document.querySelector(".activity-record-panel")!;
  list.scrollTop = 120;
  fireEvent.click(row);
  fireEvent.click(await screen.findByRole("button", { name: "关闭活动详情" }));
  await findActivity("PAGE2");
  expect(list.scrollTop).toBe(120);
  expect(document.querySelector('[data-job-id="PAGE1"]')).not.toBeNull();
});

test("one activity timeline mixes commands, transfers and screenshots and previews and saves retained attachments", async () => {
  const now = Date.now();
  const { page, calls } = await fixture({
    activity_history: () => ({
      db_id: "db-original",
      next_cursor: null,
      entries: [
        activityJob("screenshot", { attachment: retained, created_at_ms: now }),
        commandJob("MIXED", { created_at_ms: now - 60000 }),
        activityJob("pull", {
          path: "/tmp/report.txt",
          created_at_ms: now - 86400000,
        }),
      ],
    }),
    activity_attachment: () => ({ attachment: retained, image, text: null }),
    save_activity_attachment: () => "/Users/test/Downloads/screenshot.png",
  });
  await page("活动");
  await findActivity("MIXED");
  const rows = [...document.querySelectorAll(".activity-row")];
  expect(rows).toHaveLength(3);
  expect(rows[0].textContent).toContain("截图");
  expect(rows[1].textContent).toContain("执行命令");
  expect(rows[2].textContent).toContain("发送文件");
  expect(screen.getByText("今天")).toBeTruthy();
  expect(screen.getByText("昨天")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "文件与截图" })).toBeNull();
  fireEvent.click(rows[0]);
  const preview = await screen.findByAltText("附件预览：screenshot.png");
  expect(preview.getAttribute("src")).toBe(image);
  fireEvent.click(screen.getByRole("button", { name: "另存为…" }));
  await screen.findByText("附件已保存至 /Users/test/Downloads/screenshot.png");
  expect(
    calls.find((call) => call.command === "save_activity_attachment")?.args,
  ).toEqual({ id: retained.id });
});

test("expiry is checked when opening an attachment and the summary remains visible", async () => {
  const { page } = await fixture({
    activity_history: () => ({
      db_id: "db-original",
      next_cursor: null,
      entries: [
        activityJob("push", {
          path: "/repo/report.txt",
          attachment: retained,
        }),
      ],
    }),
    activity_attachment: () => ({
      attachment: { ...retained, status: "expired" },
      image: null,
      text: null,
    }),
  });
  await page("活动");
  fireEvent.click(await screen.findByRole("button", { name: /接收文件/ }));
  await screen.findByText("附件已到保留期限，活动摘要仍可查看。");
  expect(screen.queryByRole("button", { name: "另存为…" })).toBeNull();
  expect(document.getElementById("activity-job-detail")?.textContent).toContain(
    "/repo/report.txt",
  );
});

test("late attachment previews cannot replace another activity and UTF-8 files remain plain text", async () => {
  let resolveOld!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    resolveOld = resolve;
  });
  const textAttachment = { ...retained, id: "text-two", name: "report.txt" };
  const { page } = await fixture({
    activity_history: () => ({
      db_id: "db-original",
      next_cursor: null,
      entries: [
        activityJob("screenshot", { attachment: retained }),
        activityJob("pull", {
          attachment: textAttachment,
          path: "report.txt",
        }),
      ],
    }),
    activity_attachment: ({ id }) =>
      id === retained.id
        ? pending
        : {
            attachment: textAttachment,
            image: null,
            text: '<img id="attachment-injected"> file content',
          },
  });
  await page("活动");
  fireEvent.click(await screen.findByRole("button", { name: /截图/ }));
  fireEvent.click(screen.getByRole("button", { name: "关闭活动详情" }));
  fireEvent.click(await screen.findByRole("button", { name: /发送文件/ }));
  await screen.findByText('<img id="attachment-injected"> file content');
  await act(async () => {
    resolveOld({ attachment: retained, image, text: null });
  });
  expect(screen.queryByAltText("附件预览：screenshot.png")).toBeNull();
  expect(document.getElementById("attachment-injected")).toBeNull();
});

test("a running file job updates its original detail and reveals the retained attachment", async () => {
  let job = activityJob("push", { state: "running", finished_at_ms: null });
  const { page, poll } = await fixture({
    activity_history: () => ({
      db_id: job.db_id,
      entries: [job],
      next_cursor: null,
    }),
    activity_job: () => structuredClone(job),
    activity_attachment: () => ({
      attachment: retained,
      image: null,
      text: "finished file",
    }),
  });
  await page("活动");
  const row = await findActivity(job.job_id);
  fireEvent.click(row);
  await waitFor(() =>
    expect(
      document.getElementById("activity-job-detail")?.textContent,
    ).toContain("运行中"),
  );
  expect(screen.queryByText("finished file")).toBeNull();
  const id = job.job_id;
  job = activityJob("push", { job_id: id, attachment: retained });
  await poll();
  await screen.findByText("finished file");
  expect(row.querySelector(".activity-state")?.textContent).toBe("已完成");
  expect(
    within(screen.getByRole("complementary", { name: "活动详情" })).getByText(
      "已完成",
    ),
  ).toBeTruthy();
  expect(document.getElementById("activity-job-detail")?.textContent).toContain(
    "/repo/report.txt",
  );
});

test("a database replacement stops automatic file detail reads and explicit retry remains available", async () => {
  let reads = 0;
  const job = activityJob("forward", {
    state: "running",
    finished_at_ms: null,
  });
  const { page, poll } = await fixture({
    activity_history: () => ({
      db_id: job.db_id,
      entries: [job],
      next_cursor: null,
    }),
    activity_job: () => {
      reads++;
      throw { code: "DB_RESET", message: "database replaced" };
    },
  });
  await page("活动");
  fireEvent.click(await screen.findByRole("button", { name: /端口转发/ }));
  await screen.findByText("DB_RESET: database replaced");
  expect(reads).toBe(1);
  await poll();
  expect(reads).toBe(1);
  fireEvent.click(screen.getByRole("button", { name: "刷新" }));
  await waitFor(() => expect(reads).toBe(2));
});
