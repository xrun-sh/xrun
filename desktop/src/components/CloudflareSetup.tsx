import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, type CloudflareAccount, type RelayDeployment } from "../api";
import { useKeepWindow, useOperations } from "../app/useOperations";
import { t } from "../i18n";
import { errorText } from "../errors";
import { useDeploymentProgress } from "../app/useDeploymentProgress";
import { DeploymentSteps } from "./DeploymentProgress";
import { ErrorNotice } from "./ErrorNotice";
import { Select } from "./Select";

export function CloudflareSetup({
  name,
  nameField,
  onCreated,
  onRetry,
}: {
  name: string;
  nameField: ReactNode;
  onCreated: () => void;
  onRetry: () => void;
}) {
  const { busy, operate, notify, error, fail } = useOperations();
  const [relayRegion, setRelayRegion] = useState("auto");
  const [workerName, setWorkerName] = useState("xrun-relay");
  const [accounts, setAccounts] = useState<CloudflareAccount[] | null>(null);
  const [account, setAccount] = useState("");
  const [deployment, setDeployment] = useState<RelayDeployment | null>(null);
  const [phase, setPhase] = useState<
    "idle" | "accounts" | "authorization" | "deploying" | "connecting"
  >("idle");
  const submitting = useRef(false);
  const progress = useDeploymentProgress();
  const [failed, setFailed] = useState(false);
  const [savedRelays, setSavedRelays] = useState<RelayDeployment[]>([]);
  const [savedError, setSavedError] = useState<string | null>(null);
  const [nameConflict, setNameConflict] = useState(false);
  useKeepWindow(
    "cloudflare-account-selection",
    accounts !== null && deployment === null,
  );
  const advanced = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    let active = true;
    void api
      .cloudflareRelays()
      .then((relays) => {
        if (active) setSavedRelays(relays || []);
      })
      .catch((error) => {
        if (active) setSavedError(errorText(error));
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (error?.code === "ALREADY_EXISTS") {
      setNameConflict(true);
      if (advanced.current) advanced.current.open = true;
    }
  }, [error?.id, error?.code]);
  const receiveProgress = (event: Parameters<typeof progress.receive>[0]) => {
    progress.receive(event);
    if (event.stage === "authorization_received") setPhase("accounts");
    if (event.error?.code === "ALREADY_EXISTS") {
      setNameConflict(true);
      if (advanced.current) advanced.current.open = true;
    }
    if (event.deployment) setDeployment(event.deployment);
  };
  const reauthorize = async () => {
    if (busy || submitting.current) return;
    progress.start();
    setFailed(false);
    const authorized = await operate(
      async () => {
        setPhase("accounts");
        try {
          const available = await api.cloudflareAccounts(
            () => setPhase("authorization"),
            true,
            false,
            receiveProgress,
          );
          if (available) {
            setAccounts(available);
            setAccount(available.length === 1 ? available[0].id : "");
          } else progress.clear();
          return true;
        } finally {
          setPhase("idle");
        }
      },
      { name: "cloudflare_accounts", title: "cloudflare.authorizationFailed" },
    );
    setFailed(authorized === undefined);
  };
  const create = async () => {
    if (busy || submitting.current) return;
    submitting.current = true;
    progress.start();
    setFailed(false);
    const success = await operate(
      async () => {
        try {
          let selectedAccount = account;
          if (!deployment && !accounts) {
            setPhase("accounts");
            const available = await api.cloudflareAccounts(
              () => setPhase("authorization"),
              false,
              false,
              receiveProgress,
            );
            // A cancelled authorization leaves nothing to show.
            if (!available) {
              progress.clear();
              return false;
            }
            setAccounts(available);
            if (available.length !== 1) return false;
            selectedAccount = available[0].id;
            setAccount(selectedAccount);
          }
          if (!deployment && !selectedAccount) return false;
          setPhase(deployment ? "connecting" : "deploying");
          const relay = await api.createCloudflareNetwork(
            deployment?.name || workerName.trim(),
            deployment?.account_id || selectedAccount,
            name.trim(),
            relayRegion,
            !!deployment,
            receiveProgress,
          );
          if (!relay) {
            progress.clear();
            return false;
          }
          setDeployment(relay);
          onCreated();
          return true;
        } finally {
          setPhase("idle");
        }
      },
      { name: "create_cloudflare_network", title: "cloudflare.createFailed" },
    );
    if (success === undefined) {
      setFailed(true);
      onRetry();
    }
    submitting.current = false;
  };
  return (
    <>
      <p className="setup-description">{t("cloudflare.description")}</p>
      <form
        className="network-setup-form"
        id="cloudflare-create-form"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        {nameField}
        {savedError && (
          <ErrorNotice
            title={t("cloudflare.listFailed")}
            detail={savedError}
            dismiss={() => setSavedError(null)}
          />
        )}
        {!deployment && savedRelays.length > 0 && (
          <>
            <label htmlFor="saved-cloudflare-relay">
              {t("cloudflare.resumeRelay")}
            </label>
            <Select
              id="saved-cloudflare-relay"
              value=""
              fullWidth
              disabled={busy}
              options={[
                { value: "", label: t("cloudflare.newRelay") },
                ...savedRelays.map((relay) => ({
                  value: relay.name,
                  label: relay.name,
                })),
              ]}
              onChange={(value) => {
                const saved = savedRelays.find((relay) => relay.name === value);
                if (saved) {
                  setDeployment(saved);
                  setWorkerName(saved.name);
                  setAccount(saved.account_id);
                }
              }}
            />
          </>
        )}
        {!deployment && (
          <details className="setup-advanced" ref={advanced}>
            <summary>{t("cloudflare.advanced")}</summary>
            <label htmlFor="worker-name">{t("cloudflare.workerName")}</label>
            <input
              id="worker-name"
              type="text"
              required
              pattern="[a-z0-9](?:[a-z0-9]|-){0,62}"
              maxLength={63}
              onInvalid={(event) => {
                const details = event.currentTarget.closest("details");
                if (details) details.open = true;
              }}
              value={workerName}
              disabled={busy}
              onChange={(event) => {
                setWorkerName(event.target.value);
                setNameConflict(false);
              }}
            />
            <label htmlFor="relay-region">{t("cloudflare.region")}</label>
            <Select
              id="relay-region"
              value={relayRegion}
              onChange={setRelayRegion}
              disabled={busy}
              fullWidth
              options={(
                [
                  "auto",
                  "apac",
                  "apac-ne",
                  "apac-se",
                  "wnam",
                  "enam",
                  "sam",
                  "weur",
                  "eeur",
                  "oc",
                  "afr",
                  "me",
                ] as const
              ).map((value) => ({
                value,
                label: t(`cloudflare.region.${value}`),
              }))}
            />
            <p className="setup-help">{t("cloudflare.regionHint")}</p>
            {nameConflict && (
              <p className="setup-help">{t("cloudflare.nameConflict")}</p>
            )}
          </details>
        )}
        {!deployment && (accounts || error) && (
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() => void reauthorize()}
          >
            {t("cloudflare.reauthorize")}
          </button>
        )}
        {accounts && accounts.length > 1 && !deployment && (
          <>
            <label htmlFor="cloudflare-account">
              {t("cloudflare.account")}
            </label>
            <Select
              id="cloudflare-account"
              value={account}
              required
              fullWidth
              disabled={busy}
              onChange={setAccount}
              options={[
                { value: "", label: t("cloudflare.chooseAccount") },
                ...accounts.map((item) => ({
                  value: item.id,
                  label: item.name,
                })),
              ]}
            />
          </>
        )}
        {deployment && (
          <div className="relay-deployment-result">
            <p>{t("cloudflare.deployedHint")}</p>
            <button
              type="button"
              disabled={busy}
              onClick={() => setDeployment(null)}
            >
              {t("cloudflare.newRelay")}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                const copied = await operate(
                  async () => {
                    await api.copyIdentifier(deployment.link);
                    return true;
                  },
                  { name: "copy_identifier", title: "cloudflare.copyFailed" },
                );
                if (copied) notify("cloudflare.copied");
              }}
            >
              {t("cloudflare.copyLink")}
            </button>
          </div>
        )}
        <DeploymentSteps
          current={progress.current}
          events={progress.events}
          seconds={progress.seconds}
          running={busy}
          failed={failed}
        />
        {phase !== "idle" && !progress.current && (
          <p role="status" className="setup-help">
            {t(`cloudflare.${phase}`)}
          </p>
        )}
        {(progress.current?.stage === "authorization" ||
          (!progress.events.length && phase === "authorization")) && (
          <div className="hero-actions">
            <button
              type="button"
              onClick={() =>
                void api
                  .openCloudflareAuthorization()
                  .catch((error) =>
                    fail("cloudflare.authorizationFailed", error),
                  )
              }
            >
              {t("cloudflare.openBrowser")}
            </button>
            <button
              type="button"
              onClick={() =>
                void api
                  .cancelCloudflareAuthorization()
                  .catch((error) =>
                    fail("cloudflare.authorizationFailed", error),
                  )
              }
            >
              {t("cloudflare.cancel")}
            </button>
          </div>
        )}
        <p className="setup-help">{t("cloudflare.managerHint")}</p>
        <div className="hero-actions">
          <button className="primary" type="submit" disabled={busy}>
            {busy
              ? t("cloudflare.working")
              : deployment
                ? t("setup.retryCreate")
                : t("cloudflare.create")}
          </button>
        </div>
      </form>
    </>
  );
}
