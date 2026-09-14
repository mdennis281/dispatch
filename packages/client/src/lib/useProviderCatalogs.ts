/**
 * The provider list and each provider's model catalog, fetched when a pane
 * mounts — the same two reads the app-wide Chat defaults make, and for the same
 * reason: a provider installed since the last visit should show up without a
 * reload, and "not installed" is worth saying before someone points a chat at
 * it and waits for a turn that fails on its first message.
 *
 * Shared by the Reviewer pane and the project Chat-defaults pane; a second copy
 * is where one of them stops refreshing.
 */
import { useEffect, useState } from "react";
import { PROVIDER_IDS, type HarnessKind, type ModelOption } from "@dispatch/shared";
import { api, type HarnessInfo } from "./api.js";

export function useProviderCatalogs() {
  const [harnesses, setHarnesses] = useState<HarnessInfo[]>([]);
  const [catalogs, setCatalogs] = useState<Partial<Record<HarnessKind, ModelOption[]>>>({});
  useEffect(() => {
    let live = true;
    void api.harnesses
      .list()
      .then((h) => live && setHarnesses(h))
      .catch(() => {});
    for (const kind of PROVIDER_IDS) {
      void api.models
        .list(kind)
        .then((models) => live && setCatalogs((current) => ({ ...current, [kind]: models })))
        .catch(() => {});
    }
    return () => {
      live = false;
    };
  }, []);
  return { harnesses, catalogs };
}
