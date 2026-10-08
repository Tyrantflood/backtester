import { useEffect, useState } from "react";

/** `value`, but only once it has stopped changing for `ms`, so heavy work waits for a slider to settle. */
export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}
