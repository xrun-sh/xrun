import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { api, type Status } from "../api";
import { errorText } from "../errors";
import type { InteractionState } from "./useOperations";

export function useStatus(
  interactionState: RefObject<InteractionState>,
  visible: boolean,
) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const loading = useRef(false);
  const refresh = useCallback(async () => {
    const token = ++request.current;
    loading.current = true;
    try {
      const value = await api.status();
      if (token !== request.current) return null;
      setStatus(value);
      setError(value.error ? errorText(value.error) : null);
      return value;
    } catch (failure) {
      if (token === request.current) setError(errorText(failure));
      return null;
    } finally {
      if (token === request.current) loading.current = false;
    }
  }, []);
  useEffect(() => {
    if (!visible) return;
    void refresh();
    const timer = setInterval(() => {
      if (
        !loading.current &&
        !interactionState.current.busy &&
        !interactionState.current.confirming
      )
        void refresh();
    }, 3000);
    return () => {
      request.current++;
      loading.current = false;
      clearInterval(timer);
    };
  }, [interactionState, refresh, visible]);
  const clearError = useCallback(() => setError(null), []);
  return { status, error, refresh, clearError };
}
