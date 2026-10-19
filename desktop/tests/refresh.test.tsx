import { expect, test } from "bun:test";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  commandJob,
  findActivity,
  fixture,
  revealOlderActivity,
} from "./fixtures";
import type { ActivityPage, TrafficReport } from "../src/api";
import { t } from "../src/i18n";

test("empty devices stay readable during polling and slow requests do not overlap", async () => {
  let delay = false;
  let complete: ((value: unknown) => void) | undefined;
  const result = { devices: [], server_error: null };
  const { poll, calls } = await fixture({
    devices: () =>
      delay ? new Promise((resolve) => (complete = resolve)) : result,
  });
  const page = document.getElementById("page-devices")!;
  const refresh = within(page).getByRole("button", { name: "刷新" });
  await screen.findByText(t("devices.empty"));
  refresh.focus();
  delay = true;
  await poll();
  expect(screen.getByText(t("devices.empty"))).toBeTruthy();
  expect(screen.queryByText(t("devices.reading"))).toBeNull();
  expect(refresh.getAttribute("aria-label")).toBe("刷新");
  expect(refresh.getAttribute("aria-busy")).toBe("true");
  expect(document.activeElement).toBe(refresh);
  const count = calls.filter((call) => call.command === "devices").length;
  fireEvent.click(refresh);
  await poll();
  expect(calls.filter((call) => call.command === "devices")).toHaveLength(
    count,
  );
  await act(async () => complete?.(result));
  await waitFor(() =>
    expect((refresh as HTMLButtonElement).disabled).toBe(false),
  );
});

test("older activity loads during a slow refresh and the late refresh keeps it", async () => {
  let delay = false;
  let complete: ((value: unknown) => void) | undefined;
  const now = Date.now();
  const result = {
    db_id: "db-original",
    entries: [commandJob("PAGE1", { created_at_ms: now - 1000 })],
    next_cursor: "page-2",
  };
  const { page, poll } = await fixture({
    activity_history: ({ before }) =>
      before
        ? {
            ...result,
            entries: [commandJob("PAGE2", { created_at_ms: now - 5000 })],
            next_cursor: null,
          }
        : delay
          ? new Promise((resolve) => (complete = resolve))
          : result,
  });
  await page("活动");
  const first = await findActivity("PAGE1");
  const refresh = screen.getByRole("button", { name: "刷新" });
  delay = true;
  await poll();
  expect(await findActivity("PAGE1")).toBe(first);
  expect(refresh.getAttribute("aria-label")).toBe("刷新");
  expect(refresh.getAttribute("aria-busy")).toBe("true");
  await revealOlderActivity();
  await findActivity("PAGE2");
  await act(async () => complete?.(result));
  expect(await findActivity("PAGE1")).toBe(first);
  expect(await findActivity("PAGE2")).toBeTruthy();
});

test("a refreshed script loses its old title while a concurrent older page is preserved", async () => {
  const now = Date.now();
  const params = {
    ...commandJob().params,
    program: "",
    shell: "sh",
    input_size: 20,
  };
  const first = commandJob("SCRIPT1", { params, created_at_ms: now });
  const second = commandJob("SCRIPT2", { params, created_at_ms: now - 1000 });
  const third = commandJob("PAGE3", { created_at_ms: now - 2000 });
  let expired = false;
  let completeOlder!: (page: ActivityPage) => void;
  let completeRefresh!: (page: ActivityPage) => void;
  const firstPage = (): ActivityPage => ({
    db_id: "db-original",
    entries: [first],
    next_cursor: "page-2",
    script_titles: expired ? {} : { SCRIPT1: "echo first-script" },
  });
  const secondPage = (): ActivityPage => ({
    ...firstPage(),
    entries: [second],
    next_cursor: "page-3",
    script_titles: expired ? {} : { SCRIPT2: "echo second-script" },
  });
  const { page, poll } = await fixture({
    activity_history: ({ before }) => {
      if (before === "page-3")
        return new Promise<ActivityPage>(
          (resolve) => (completeOlder = resolve),
        );
      if (before === "page-2")
        return expired
          ? new Promise<ActivityPage>((resolve) => (completeRefresh = resolve))
          : secondPage();
      return firstPage();
    },
  });
  await page("活动");
  await revealOlderActivity();
  await findActivity("SCRIPT2");
  await waitFor(() => expect(completeOlder).toBeDefined());
  expired = true;
  await poll();
  await waitFor(() => expect(completeRefresh).toBeDefined());
  await act(async () =>
    completeOlder({
      db_id: "db-original",
      entries: [third],
      next_cursor: null,
      script_titles: {},
    }),
  );
  const older = await findActivity("PAGE3");
  await act(async () => completeRefresh(secondPage()));
  expect(await findActivity("PAGE3")).toBe(older);
  for (const id of ["SCRIPT1", "SCRIPT2"])
    expect(
      (await findActivity(id)).querySelector(".activity-row-title")
        ?.textContent,
    ).toBe("sh 脚本 · 20 B");
});

test("an empty activity timeline stays empty while it updates", async () => {
  let delay = false;
  let complete: ((value: unknown) => void) | undefined;
  const result = { db_id: null, entries: [], next_cursor: null };
  const { page, poll } = await fixture({
    activity_history: () =>
      delay ? new Promise((resolve) => (complete = resolve)) : result,
  });
  await page("活动");
  await screen.findByText(t("activity.empty"));
  delay = true;
  await poll();
  expect(screen.getByText(t("activity.empty"))).toBeTruthy();
  expect(screen.queryByText(t("activity.loading"))).toBeNull();
  await act(async () => complete?.(result));
});

test("traffic retains totals and its chart during a slow automatic update", async () => {
  let delay = false;
  let complete: ((value: TrafficReport) => void) | undefined;
  const result = (period: TrafficReport["period"]): TrafficReport => ({
    network_id: "net-test",
    device_id: "self",
    period,
    start_ms: 0,
    end_ms: Date.now(),
    recorded_since_ms: Date.now(),
    complete: true,
    totals: { ingress_bytes: 1024, egress_bytes: 2048 },
    devices: [],
    daily: [{ start_ms: Date.now(), ingress_bytes: 1024, egress_bytes: 2048 }],
    next_offset: null,
  });
  const { poll } = await fixture({
    traffic: ({ query }) =>
      delay
        ? new Promise<TrafficReport>((resolve) => (complete = resolve))
        : result((query as { period: TrafficReport["period"] }).period),
  });
  fireEvent.click(screen.getByRole("button", { name: "详情" }));
  const dialog = screen.getByRole("dialog", { name: "流量统计" });
  await within(dialog).findByText("1.0 KiB");
  const chart = within(dialog).getByRole("img", {
    name: t("traffic.dailyTrend"),
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "本月" }));
  expect(within(dialog).getByText("1.0 KiB")).toBeTruthy();
  expect(within(dialog).getByRole("img")).toBe(chart);
  delay = true;
  await poll();
  expect(within(dialog).getByText("1.0 KiB")).toBeTruthy();
  expect(within(dialog).getByRole("img")).toBe(chart);
  expect(within(dialog).queryByText(t("traffic.loading"))).toBeNull();
  expect(
    within(dialog)
      .getByRole("button", { name: "刷新" })
      .getAttribute("aria-busy"),
  ).toBe("true");
  await act(async () => complete?.(result("month")));
});
