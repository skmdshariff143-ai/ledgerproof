import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "./session.jsx";

// Loads a GET path and exposes { data, error, reload }. Pass null to load nothing yet.
export function useLoad(path) {
  const { call } = useSession();
  const [state, setState] = useState({ data: null, error: null });
  const latest = useRef(0);

  const reload = useCallback(async () => {
    if (!path) return;
    const id = ++latest.current;
    try {
      const { data } = await call("GET", path);
      if (id === latest.current) setState({ data, error: null });
    } catch (err) {
      if (id === latest.current) setState({ data: null, error: err.message });
    }
  }, [call, path]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { ...state, reload };
}
