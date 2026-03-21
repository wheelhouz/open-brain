import { useState, useEffect, useRef } from "preact/hooks";
import { api, type Entity } from "../api";
import { selectedEntityName } from "../state";
import { EntityDetailPanel } from "./EntityDetailPanel";

let cachedEntities: Entity[] | null = null;

export function PersonOverlay() {
  const name = selectedEntityName.value;
  const [entityId, setEntityId] = useState<string | null>(null);
  const prevName = useRef<string | null>(null);

  useEffect(() => {
    if (!name) {
      setEntityId(null);
      prevName.current = null;
      return;
    }

    if (name === prevName.current) return;
    prevName.current = name;

    const resolve = (entities: Entity[]) => {
      const match = entities.find(
        (e) =>
          e.canonical_name.toLowerCase() === name.toLowerCase() ||
          e.aliases.some((a) => a.toLowerCase() === name.toLowerCase()),
      );
      setEntityId(match?.id ?? null);
    };

    if (cachedEntities) {
      resolve(cachedEntities);
    } else {
      api.entities("person").then((r) => {
        cachedEntities = r.entities;
        resolve(r.entities);
      }).catch(() => setEntityId(null));
    }
  }, [name]);

  if (!name || !entityId) return null;

  return (
    <EntityDetailPanel
      entityId={entityId}
      onClose={() => { selectedEntityName.value = null; }}
      onEntityChanged={() => { cachedEntities = null; }}
      noScrim
    />
  );
}
